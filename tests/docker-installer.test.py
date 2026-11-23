#!/usr/bin/env python3
"""Exercise the Linux installer with fake Docker and a real interactive TTY.

No Docker daemon, root access, network, or host service changes are required.
"""
import fcntl
import os
import pty
import select
import shlex
import subprocess
import tempfile
import termios
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/install-vps.sh"


class ReadmeInstallTest(unittest.TestCase):
    def test_one_click_command_is_prominent_and_links_to_details(self):
        readme = (ROOT / "README.md").read_text()
        heading = "## One-click Docker install"
        command = "curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh | bash"
        self.assertLess(readme.index(heading), readme.index("## Features"))
        top_section = readme.split(heading, 1)[1].split("\n## ", 1)[0]
        self.assertIn(command, top_section)
        self.assertIn("3000", top_section)
        self.assertIn("#quick-start", top_section)
        self.assertIn("HTTPS", top_section)
        self.assertIn("#one-click-docker-install", readme.split("## Quick Start", 1)[1])


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.target = self.root / "sushi"
        self.target.mkdir()
        for name in ("package.json", ".env.example", "docker-compose.yml", "docker-compose.prebuilt.yml"):
            (self.target / name).write_text((ROOT / name).read_text())
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls"
        self.unit = self.root / "unit"
        self.fake("id", 'if [ "$1" = "-u" ]; then echo 0; else echo test; fi')
        # Deterministic addressing: no public IP in the sandbox, so the summary
        # keeps the "<your-vps-ip>" placeholder unless a test supplies one.
        self.fake("ip", '''case "$*" in
  *"route get"*) echo "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0" ;;
esac''')
        self.fake("hostname", 'echo "10.0.0.5"')
        self.fake("getent", "exit 1")
        self.fake("caddy", 'printf "caddy %s\\n" "$*" >> "$TEST_LOG"')
        self.fake("docker", '''printf "docker PORT=%s %s\\n" "${PORT-}" "$*" >> "$TEST_LOG"
if [ "$1" = info ] && [ "${TEST_INFO_FAIL:-0}" = 1 ]; then exit 1; fi
if [ "$1" = inspect ]; then [ "${TEST_RUNNING:-0}" = 1 ] && echo true; exit 0; fi
if [ "$1" = compose ] && [ "$2" = version ] && [ "${TEST_NO_V2:-0}" = 1 ]; then exit 1; fi''')
        self.fake("curl", '''printf "curl %s\\n" "$*" >> "$TEST_LOG"
if [ "${TEST_CURL_IP+x}" ]; then
  case "$*" in
    *ipify*|*ifconfig*|*icanhazip*) printf '%s' "$TEST_CURL_IP"; exit 0 ;;
  esac
fi
if [ "${TEST_CURL_RESPONSE+x}" ]; then printf '%s' "$TEST_CURL_RESPONSE"
else printf '%s' '{"mode":"vps","websocketSsh":true}'; fi''')
        self.fake("sleep", "exit 0")
        self.fake("systemctl", 'printf "systemctl %s\\n" "$*" >> "$TEST_LOG"')
        self.fake("tee", 'cat > "$TEST_UNIT"')
        self.env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                    "TEST_LOG": str(self.log), "TEST_UNIT": str(self.unit)}
        self.env.pop("PORT", None)
        self.env.pop("SUSHI_DIR", None)

    def tearDown(self):
        self.tmp.cleanup()

    def fake(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -e\n" + body + "\n")
        path.chmod(0o755)

    def run_installer(self, *args, env=None):
        return subprocess.run(["bash", str(SCRIPT), "--dir", str(self.target), *args],
                              env=env or self.env, text=True, capture_output=True, timeout=20)

    PROMPT_PATTERNS = (b"Web UI port [", b"Install method [",
                       b"Domain for HTTPS (optional, Enter to skip):",
                       b"Continue and potentially restart it? [y/N]:")

    @staticmethod
    def answer_new_prompts(master, output, answers, sent):
        """Send queued answers for each new prompt that appears, in order."""
        prompts = sum(output.count(pattern) for pattern in InstallerTest.PROMPT_PATTERNS)
        while prompts > sent:
            try:
                answer = next(answers)
            except StopIteration:
                break
            os.write(master, (answer + "\n").encode())
            sent += 1
        return sent

    def run_piped_tty(self, answers, *args, env=None):
        master, slave = pty.openpty()
        cmd = f"cat {shlex.quote(str(SCRIPT))} | bash -s -- --dir {shlex.quote(str(self.target))} " + " ".join(map(shlex.quote, args))
        def setup():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        proc = subprocess.Popen(["bash", "-c", cmd], stdin=slave, stdout=slave, stderr=slave,
                                env=env or self.env, preexec_fn=setup, close_fds=True)
        os.close(slave)
        output = b""
        answers = iter(answers)
        sent = 0
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.1)
                if readable:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                    sent = self.answer_new_prompts(master, output, answers, sent)
                if proc.poll() is not None and not readable:
                    break
            proc.wait(timeout=3)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            os.close(master)
        return proc.returncode, output.decode(errors="replace")

    def test_piped_interactive_prompt_validates_and_persists_port(self):
        code, output = self.run_piped_tty(["0", "8088", "build", ""])
        self.assertEqual(code, 0, output)
        self.assertIn("Web UI port [3000]", output)
        self.assertIn("Enter a port from 1 to 65535", output)
        self.assertIn("Install method [prebuilt]", output)
        self.assertIn("http://<your-vps-ip>:8088", output)
        content = (self.target / ".env").read_text()
        self.assertEqual([x for x in content.splitlines() if x.startswith("PORT=")], ["PORT=8088"])
        self.assertIn("docker PORT=8088 compose up -d --build", self.log.read_text())
        self.assertIn("127.0.0.1:8088/api/system/capabilities", self.log.read_text())
        self.assertEqual((self.target / ".env").stat().st_mode & 0o777, 0o600)

    def test_summary_shows_the_detected_public_ip_link(self):
        result = self.run_installer("--port", "4321", "--build",
                                    env={**self.env, "TEST_CURL_IP": "203.0.113.7"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("http://203.0.113.7:4321", result.stdout)
        self.assertIn("Sushi is up!", result.stdout)
        self.assertNotIn("<your-vps-ip>", result.stdout)
        self.assertIn("curl -fsS -m 4 https://api.ipify.org", self.log.read_text())
        # The direct IP link is still printed when HTTPS is layered on top.
        result = self.run_installer("--port", "4322", "--build", "--domain", "sushi.example.com",
                                    env={**self.env, "TEST_CURL_IP": "203.0.113.7"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("Sushi is up!  https://sushi.example.com", result.stdout)
        self.assertIn("VPS IP link:  http://203.0.113.7:4322", result.stdout)
        self.assertIn("reverse_proxy 127.0.0.1:4322", self.unit.read_text())

    def test_public_ip_override_is_validated_and_private_fallback_is_labelled(self):
        result = self.run_installer("--port", "4321", "--build",
                                    env={**self.env, "SUSHI_PUBLIC_IP": "198.51.100.9"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("http://198.51.100.9:4321", result.stdout)
        result = self.run_installer("--port", "4321", "--build",
                                    env={**self.env, "SUSHI_PUBLIC_IP": "not-an-ip"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("Ignoring SUSHI_PUBLIC_IP=not-an-ip", result.stderr)
        self.assertIn("http://<your-vps-ip>:4321", result.stdout)
        # Without a public lookup the fake host IP (10.0.0.5) is private, not a link.
        self.assertIn("local/private", result.stdout)
        self.assertIn("it is behind NAT", result.stdout)
        self.assertNotIn("http://10.0.0.5:4321 (direct", result.stdout)

    def test_domain_prompt_is_optional_and_skips_https_on_enter(self):
        code, output = self.run_piped_tty(["build", ""], "--port", "8089")
        self.assertEqual(code, 0, output)
        self.assertIn("Domain for HTTPS (optional, Enter to skip):", output)
        self.assertIn("http://<your-vps-ip>:8089", output)
        self.assertNotIn("Configuring Caddy", output)
        self.assertIn("--https your.domain", output)

    def test_domain_prompt_validates_normalizes_and_configures_caddy(self):
        code, output = self.run_piped_tty(["build", "not a domain", "https://Sushi.Example.com/"],
                                          "--port", "8090")
        self.assertEqual(code, 0, output)
        self.assertIn("Enter a domain like sushi.example.com", output)
        self.assertIn("Sushi is up!  https://sushi.example.com", output)
        self.assertIn("VPS IP link:  http://<your-vps-ip>:8090", output)
        self.assertIn("reverse_proxy 127.0.0.1:8090", self.unit.read_text())
        self.assertIn("systemctl reload caddy", self.log.read_text())

    def test_domain_prompt_reports_dns_mismatch(self):
        self.fake("getent", 'echo "192.0.2.99  STREAM sushi.example.com"')
        code, output = self.run_piped_tty(["build", "sushi.example.com"], "--port", "8092",
                                          env={**self.env, "TEST_CURL_IP": "203.0.113.7"})
        self.assertEqual(code, 0, output)
        self.assertIn("sushi.example.com resolves to 192.0.2.99, not 203.0.113.7", output)

    def test_domain_flag_validates_normalizes_and_bypasses_the_prompt(self):
        result = self.run_installer("--port", "8091", "--build", "--domain", "HTTPS://Sushi.Example.com/",
                                    env={**self.env, "TEST_CURL_IP": "203.0.113.7"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertNotIn("Domain for HTTPS", result.stdout)
        self.assertIn("Sushi is up!  https://sushi.example.com", result.stdout)
        self.assertIn("VPS IP link:  http://203.0.113.7:8091", result.stdout)
        for value in ("not a domain", "example", "https://"):
            result = self.run_installer("--port", "8091", "--build", "--domain", value)
            self.assertNotEqual(result.returncode, 0, value)
            self.assertIn("Invalid domain", result.stderr)

    def test_no_domain_flag_skips_the_prompt(self):
        code, output = self.run_piped_tty(["build"], "--port", "8093", "--no-domain")
        self.assertEqual(code, 0, output)
        self.assertNotIn("Domain for HTTPS", output)
        self.assertIn("http://<your-vps-ip>:8093", output)

    def test_existing_port_default_and_credentials_survive_reruns(self):
        env = self.target / ".env"
        env.write_text('SUSHI_AUTH_SECRET=keep-this-secret\nPORT=1234\nexport PORT="8080" # current\nOTHER=value\n')
        code, output = self.run_piped_tty(["", "", ""])
        self.assertEqual(code, 0, output)
        self.assertIn("Web UI port [8080]", output)
        self.assertIn("Install method [prebuilt]", output)
        self.assertIn("SUSHI_AUTH_SECRET=keep-this-secret", env.read_text())
        self.assertIn("OTHER=value", env.read_text())
        self.assertEqual([x for x in env.read_text().splitlines() if x.startswith("PORT=")], ["PORT=8080"])
        result = self.run_installer("--port", "9090", "--prebuilt")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("PORT=9090", env.read_text())
        self.assertIn("SUSHI_AUTH_SECRET=keep-this-secret", env.read_text())
        self.assertIn("PORT=9090 compose -f docker-compose.prebuilt.yml up -d", self.log.read_text())
        self.assertIn("-f docker-compose.prebuilt.yml up -d", self.unit.read_text())
        self.assertIn("docker compose -f docker-compose.prebuilt.yml down", result.stdout)

    def test_no_tty_defaults_and_flags_and_invalid_ports(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("No interactive terminal; using web UI port 3000", result.stdout)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("using web UI port 3000", result.stdout)
        for value in ("0", "65536", "x", "", "-1"):
            result = self.run_installer("--port", value)
            self.assertNotEqual(result.returncode, 0, value)
            self.assertIn("Invalid web UI port", result.stderr)
        env = dict(self.env, PORT="01234")
        result = self.run_installer("--port", "4567", env=env)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("PORT=4567", (self.target / ".env").read_text())
        result = self.run_installer(env=env)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("PORT=1234", (self.target / ".env").read_text())

    def test_existing_bad_port_and_symlink_are_not_overwritten(self):
        env = self.target / ".env"
        env.write_text("PORT=${OTHER_PORT}\nSUSHI_AUTH_SECRET=keep\n")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid PORT", result.stderr)
        self.assertIn("PORT=${OTHER_PORT}", env.read_text())
        env.unlink()
        external = self.root / "external.env"
        external.write_text("PORT=3000\nSUSHI_AUTH_SECRET=keep\n")
        env.symlink_to(external)
        result = self.run_installer("--port", "8081", "--build")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlinked .env", result.stderr)
        self.assertEqual(external.read_text(), "PORT=3000\nSUSHI_AUTH_SECRET=keep\n")

    def test_missing_systemd_uses_docker_restart_policy(self):
        self.fake("systemctl", "exit 1")
        result = self.run_installer("--port", "4321", "--build")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("systemd is unavailable", result.stdout)
        self.assertIn("Sushi is up!", result.stdout)

    def test_running_session_requires_confirmation_before_changes(self):
        env_file = self.target / ".env"
        original = "PORT=3000\nSUSHI_AUTH_SECRET=keep\n"
        env_file.write_text(original)
        self.env["TEST_RUNNING"] = "1"
        result = self.run_installer("--port", "8787", "--build")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No terminal for confirmation", result.stderr)
        self.assertEqual(env_file.read_text(), original)
        self.assertNotIn("compose up", self.log.read_text())
        code, output = self.run_piped_tty(["prebuilt", "", "n"], "--port", "8787")
        self.assertNotEqual(code, 0, output)
        self.assertIn("running container was not changed", output)
        self.assertEqual(env_file.read_text(), original)
        code, output = self.run_piped_tty(["prebuilt", "", "y"], "--port", "8787")
        self.assertEqual(code, 0, output)
        self.assertIn("PORT=8787", env_file.read_text())
        result = self.run_installer("--port", "8788", "--yes")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("PORT=8788", env_file.read_text())
        self.assertIn("SUSHI_AUTH_SECRET=keep", env_file.read_text())

    def test_daemon_or_compose_failure_does_not_modify_environment(self):
        env_file = self.target / ".env"
        original = "PORT=3000\nSUSHI_AUTH_SECRET=keep\n"
        env_file.write_text(original)
        result = self.run_installer("--port", "4444", "--build", env={**self.env, "TEST_INFO_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot access the Docker daemon", result.stderr)
        self.assertEqual(env_file.read_text(), original)
        result = self.run_installer("--port", "4444", "--build", env={**self.env, "TEST_NO_V2": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker Compose is missing", result.stderr)
        self.assertEqual(env_file.read_text(), original)

    def test_compose_v1_fallback_is_used_and_reported(self):
        self.fake("docker-compose", 'printf "v1 PORT=%s %s\\n" "${PORT-}" "$*" >> "$TEST_LOG"')
        result = self.run_installer("--port", "5678", "--build", env={**self.env, "TEST_NO_V2": "1"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("v1 PORT=5678 up -d --build", self.log.read_text())
        self.assertIn("docker-compose down", result.stdout)
        self.assertIn("docker-compose  up -d", self.unit.read_text())

    def test_compose_detection_uses_the_same_privileges_as_start(self):
        self.fake("id", 'if [ "$1" = "-u" ]; then echo 1001; else echo test; fi')
        self.fake("sudo", '''export TEST_SUDO=1
if [ "$1" = "-E" ] || [ "$1" = "-n" ]; then shift; fi
exec "$@"''')
        self.fake("docker", '''printf "docker sudo=%s PORT=%s %s\\n" "${TEST_SUDO:-0}" "${PORT-}" "$*" >> "$TEST_LOG"
if [ "${TEST_SUDO:-0}" != 1 ]; then exit 1; fi
if [ "$1" = inspect ]; then exit 1; fi''')
        result = self.run_installer("--port", "6001", "--build")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("docker sudo=1 PORT=6001 compose up -d --build", self.log.read_text())

    def test_prebuilt_requires_v2_without_modifying_environment(self):
        self.fake("docker-compose", 'exit 0')
        env_file = self.target / ".env"
        original = "PORT=3000\nSUSHI_AUTH_SECRET=keep\n"
        env_file.write_text(original)
        result = self.run_installer("--prebuilt", "--port", "5678", env={**self.env, "TEST_NO_V2": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--prebuilt requires Docker Compose v2", result.stderr)
        self.assertEqual(env_file.read_text(), original)

    def test_dirty_or_non_main_checkout_is_not_pulled(self):
        (self.target / ".git").mkdir()
        self.fake("git", '''printf "git %s\\n" "$*" >> "$TEST_LOG"
case "$*" in
  *branch*) echo "${TEST_BRANCH:-main}" ;;
  *status*) printf '%s' "${TEST_CHANGES:-}" ;;
esac''')
        result = self.run_installer("--port", "5050", env={**self.env, "TEST_BRANCH": "custom"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("not a clean main branch", result.stdout)
        self.assertNotIn("git pull", self.log.read_text())
        result = self.run_installer("--port", "5050", env={**self.env, "TEST_CHANGES": " M file"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("not a clean main branch", result.stdout)
        self.assertNotIn("git pull", self.log.read_text())
        result = self.run_installer("--port", "5050")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("git pull --ff-only", self.log.read_text())

    def test_invalid_timeout_is_rejected(self):
        for value in ("-1", "x", "1.5", ""):
            result = self.run_installer("--timeout", value)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--timeout must be", result.stderr)

    def test_unrelated_http_response_is_not_healthy(self):
        self.fake("sleep", "exit 0")
        result = self.run_installer("--port", "5678", "--timeout", "1",
                                    env={**self.env, "TEST_CURL_RESPONSE": "<html>not sushi</html>"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not become healthy", result.stderr)
        self.assertNotIn("Sushi is up!", result.stdout)

    def test_help_works_when_script_is_piped(self):
        result = subprocess.run(["bash", "-c", f"cat {shlex.quote(str(SCRIPT))} | bash -s -- --help"],
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--yes", result.stdout)
        self.assertIn("--port", result.stdout)

    def test_does_not_report_healthy_when_health_check_times_out(self):
        result = self.run_installer("--port", "3210", "--timeout", "0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not become healthy", result.stderr)
        self.assertNotIn("Sushi is up!", result.stdout)


if __name__ == "__main__":
    unittest.main()
