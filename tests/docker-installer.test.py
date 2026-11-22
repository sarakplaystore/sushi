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
        self.fake("docker", 'printf "docker PORT=%s %s\\n" "${PORT-}" "$*" >> "$TEST_LOG"')
        self.fake("curl", 'printf "curl %s\\n" "$*" >> "$TEST_LOG"')
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

    def run_piped_tty(self, answers, *args):
        master, slave = pty.openpty()
        cmd = f"cat {shlex.quote(str(SCRIPT))} | bash -s -- --dir {shlex.quote(str(self.target))} " + " ".join(map(shlex.quote, args))
        def setup():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        proc = subprocess.Popen(["bash", "-c", cmd], stdin=slave, stdout=slave, stderr=slave,
                                env=self.env, preexec_fn=setup, close_fds=True)
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
                    while output.count(b"Web UI port [") > sent:
                        os.write(master, (next(answers) + "\n").encode())
                        sent += 1
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
        code, output = self.run_piped_tty(["0", "8088"])
        self.assertEqual(code, 0, output)
        self.assertIn("Web UI port [3000]", output)
        self.assertIn("Enter a port from 1 to 65535", output)
        self.assertIn("http://<your-vps-ip>:8088", output)
        content = (self.target / ".env").read_text()
        self.assertEqual([x for x in content.splitlines() if x.startswith("PORT=")], ["PORT=8088"])
        self.assertIn("docker PORT=8088 compose up -d --build", self.log.read_text())
        self.assertIn("127.0.0.1:8088/api/system/capabilities", self.log.read_text())
        self.assertEqual((self.target / ".env").stat().st_mode & 0o777, 0o600)

    def test_existing_port_default_and_credentials_survive_reruns(self):
        env = self.target / ".env"
        env.write_text('SUSHI_AUTH_SECRET=keep-this-secret\nPORT=1234\nexport PORT="8080" # current\nOTHER=value\n')
        code, output = self.run_piped_tty([""])
        self.assertEqual(code, 0, output)
        self.assertIn("Web UI port [8080]", output)
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
        result = self.run_installer("--port", "8081")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlinked .env", result.stderr)
        self.assertEqual(external.read_text(), "PORT=3000\nSUSHI_AUTH_SECRET=keep\n")

    def test_missing_systemd_uses_docker_restart_policy(self):
        self.fake("systemctl", "exit 1")
        result = self.run_installer("--port", "4321")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("systemd is unavailable", result.stdout)
        self.assertIn("Sushi is up!", result.stdout)

    def test_does_not_report_healthy_when_health_check_times_out(self):
        result = self.run_installer("--port", "3210", "--timeout", "0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not become healthy", result.stderr)
        self.assertNotIn("Sushi is up!", result.stdout)


if __name__ == "__main__":
    unittest.main()
