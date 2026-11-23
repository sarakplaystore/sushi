#!/usr/bin/env python3
"""Exercise install.py's interactive web UI port prompt.

Hermetic: no network, no real Docker, no npm. The prompt is the first thing
that happens in the --docker path, then the install fails fast on the missing
Docker Compose — that failure proves the prompt worked and flowed past it.
"""
import fcntl
import io
import os
import pty
import select
import shlex
import subprocess
import sys
import tempfile
import termios
import time
import unittest
import unittest.mock
import urllib.error
from importlib import util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSTALLER = ROOT / "install.py"


def load_installer():
    spec = util.spec_from_file_location("install_py_prompt_test", str(INSTALLER))
    module = util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = False
    return module


class FakeInput:
    """Line-based source for choose_port's test injection."""

    def __init__(self, lines):
        self.lines = iter(lines)

    def readline(self):
        try:
            line = next(self.lines)
        except StopIteration:
            return ""
        return line + "\n"


class TtyHarness:
    """Run a command under a pty, as if the installer were piped or run over SSH."""

    def __init__(self, root, bin):
        self.root = root
        self.bin = bin
        self.env = {
            "PATH": f"{bin}:{os.environ['PATH']}",
            "HOME": str(root),
            # Keep a real interactive session from picking up anything else.
            "PORT": "",
            "NO_COLOR": "1",
        }

    def run_piped(self, cmd, answers, timeout=20):
        """stdin is a pipe (curl | bash style); stdout/stderr are the pty."""
        return self._run(cmd, answers, timeout, command_style="bash")

    def run_stdin_tty(self, cmd_args, answers, timeout=20):
        """stdin is a tty (plain interactive run)."""
        return self._run(cmd_args, answers, timeout, stdin="tty")

    def run_plain(self, cmd_args, timeout=20):
        """No terminal at all: stdin is /dev/null, no controlling tty."""
        try:
            result = subprocess.run(
                cmd_args, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=self.env, start_new_session=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            self.fail("installer blocked without a terminal")
        return result.returncode, result.stdout + result.stderr

    def _run(self, cmd_or_args, answers, timeout, command_style=None, stdin=None):
        master, slave = pty.openpty()

        def setup():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        if command_style == "bash":
            proc = subprocess.Popen(
                ["bash", "-c", cmd_or_args],
                stdin=slave, stdout=slave, stderr=slave,
                env=self.env, preexec_fn=setup, close_fds=True,
            )
        else:
            proc = subprocess.Popen(
                cmd_or_args,
                stdin=slave, stdout=slave, stderr=slave,
                env=self.env, preexec_fn=setup, close_fds=True,
            )
        os.close(slave)
        output = b""
        answers = iter(answers)
        sent = 0

        def answer_new_prompts():
            nonlocal sent
            count = output.count(b"Web UI port [") + output.count(b"Install method [")
            while count > sent:
                try:
                    answer = next(answers)
                except StopIteration:
                    return
                os.write(master, (answer + "\n").encode())
                sent += 1

        try:
            deadline = time.monotonic() + timeout
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
                    answer_new_prompts()
                if proc.poll() is not None and not readable:
                    break
            proc.wait(timeout=3)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            os.close(master)
        return proc.returncode, output.decode(errors="replace")


class PortPromptIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.target = self.root / "sushi"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # A failing docker stub: require_docker fails fast, after the prompt.
        (self.bin / "docker").write_text("#!/bin/sh\nexit 1\n")
        (self.bin / "docker").chmod(0o755)
        self.harness = TtyHarness(self.root, self.bin)

    def tearDown(self):
        self.tmp.cleanup()

    def piped_cmd(self, *extra):
        return (
            f"cat {shlex.quote(str(INSTALLER))} | {shlex.quote(sys.executable)} - "
            f"--dir {shlex.quote(str(self.target))} "
            + " ".join(map(shlex.quote, map(str, extra)))
        )

    def test_piped_install_prompts_and_method_selection_on_controlling_tty(self):
        code, output = self.harness.run_piped(self.piped_cmd(), ["0", "8088", "build"])
        self.assertEqual(code, 1, output)
        self.assertIn("Web UI port [3000]", output)
        self.assertIn("Enter a port from 1 to 65535", output)
        self.assertIn("Install method [node]", output)
        self.assertIn("Docker Compose v2 is missing", output)
        self.assertFalse((self.target / ".env").exists())

    def test_stdin_tty_prompts_and_validates(self):
        args = [sys.executable, str(INSTALLER), "--dir", str(self.target)]
        code, output = self.harness.run_stdin_tty(args, ["0", "not-a-port", "8088", "build"])
        self.assertEqual(code, 1, output)
        self.assertIn("Web UI port [3000]", output)
        self.assertIn("Enter a port from 1 to 65535", output)
        self.assertIn("Install method [node]", output)
        self.assertIn("Docker Compose v2 is missing", output)

    def test_saved_port_becomes_the_default_and_method_default_is_shown(self):
        self.target.mkdir(parents=True, exist_ok=True)
        (self.target / ".env").write_text("SUSHI_AUTH_SECRET=keep-this-secret\nPORT=4321\n")
        code, output = self.harness.run_piped(self.piped_cmd(), ["", "build"])
        self.assertEqual(code, 1, output)
        self.assertIn("Web UI port [4321]", output)
        self.assertIn("Install method [node]", output)

    def test_no_terminal_explicit_docker_skips_method_note(self):
        # No tty + an explicit --docker: no port/method prompts, no notes.
        args = [sys.executable, str(INSTALLER), "--docker", "--dir", str(self.target)]
        code, output = self.harness.run_plain(args)
        self.assertEqual(code, 1, output)
        self.assertIn("No interactive terminal; using web UI port 3000", output)
        self.assertNotIn("using install method", output)
        self.assertIn("Docker Compose v2 is missing", output)

    def test_no_terminal_uses_recommended_method_and_reports(self):
        # No tty + no method flag: the method note prints, then the flow stops
        # in the Node.js path at the (stubbed) npm step — nothing is downloaded.
        npm = self.bin / "npm"
        npm.write_text("#!/bin/sh\nexit 1\n")
        npm.chmod(0o755)
        self.target.mkdir(parents=True, exist_ok=True)
        (self.target / "install.py").write_text("")
        args = [sys.executable, str(INSTALLER), "--dir", str(self.target)]
        code, output = self.harness.run_plain(args)
        self.assertEqual(code, 1, output)
        self.assertIn("No interactive terminal; using install method node", output)
        self.assertIn("Could not install dependencies", output)

    def test_no_terminal_uses_default_and_reports(self):
        args = [sys.executable, str(INSTALLER), "--docker", "--dir", str(self.target)]
        code, output = self.harness.run_plain(args)
        self.assertEqual(code, 1, output)
        self.assertIn("No interactive terminal; using web UI port 3000", output)
        self.assertFalse((self.target / ".env").exists())

    def test_explicit_invalid_port_fails_without_prompt(self):
        args = [sys.executable, str(INSTALLER), "--docker", "--dir", str(self.target), "--port", "0"]
        code, output = self.harness.run_plain(args)
        self.assertEqual(code, 1, output)
        self.assertIn("Invalid web UI port '0'", output)
        self.assertNotIn("Web UI port [", output)

    def test_explicit_port_and_env_port_skip_prompt(self):
        args = [sys.executable, str(INSTALLER), "--docker", "--dir", str(self.target), "--port", "8088"]
        code, output = self.harness.run_plain(args)
        self.assertEqual(code, 1, output)
        self.assertNotIn("Web UI port [", output)
        self.assertIn("Docker Compose v2 is missing", output)
        args = [sys.executable, str(INSTALLER), "--docker", "--dir", str(self.target)]
        env = dict(self.harness.env, PORT="01234")
        result = subprocess.run(
            args, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            env=env, start_new_session=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertNotIn("No interactive terminal", result.stdout)
        self.assertNotIn("Web UI port [", result.stdout)
        self.assertIn("Docker Compose v2 is missing", result.stdout)


class ChooseMethodUnitTest(unittest.TestCase):
    """Module-level tests for the install-method selection helpers."""

    def setUp(self):
        self.install = load_installer()

    def choose(self, argv, answers=None):
        import argparse
        args = argparse.Namespace()
        source = FakeInput(answers) if answers is not None else None
        return self.install.choose_method(args, argv, source=source)

    def test_explicit_flag_precedence_last_flag_wins(self):
        self.assertEqual(self.install.explicit_method(["--docker"]), "build")
        self.assertEqual(self.install.explicit_method(["--prebuilt"]), "prebuilt")
        self.assertEqual(self.install.explicit_method(["--node"]), "node")
        self.assertEqual(self.install.explicit_method(["--docker", "--prebuilt"]), "prebuilt")
        self.assertEqual(self.install.explicit_method(["--prebuilt", "--node"]), "node")
        self.assertIsNone(self.install.explicit_method(["--dir", "sushi", "--port", "8080"]))

    def test_explicit_method_skips_prompt(self):
        source = FakeInput(["node"])
        self.assertEqual(self.choose(["--prebuilt"], ["x"]), "prebuilt")
        self.assertEqual(self.choose(["--node"], ["x"]), "node")
        self.assertEqual(self.choose(["--docker"], ["x"]), "build")

    def test_choose_method_accepts_aliases(self):
        self.assertEqual(self.choose([], ["fastest"]), "prebuilt")
        self.assertEqual(self.choose([], ["p"]), "prebuilt")
        self.assertEqual(self.choose([], ["images"]), "prebuilt")
        self.assertEqual(self.choose([], ["docker"]), "build")
        self.assertEqual(self.choose([], ["b"]), "build")
        self.assertEqual(self.choose([], ["nodejs"]), "node")
        self.assertEqual(self.choose([], ["n"]), "node")

    def test_choose_method_reprompts_on_invalid_input(self):
        self.assertEqual(self.choose([], ["nope", "build"]), "build")

    def test_choose_method_empty_line_uses_recommended(self):
        with unittest.mock.patch.object(self.install, "recommended_method", lambda: "prebuilt"):
            self.assertEqual(self.choose([], [""]), "prebuilt")

    def test_recommended_method_falls_back_to_node_without_docker(self):
        with unittest.mock.patch.object(self.install, "docker_available", lambda: False):
            self.assertEqual(self.install.recommended_method(), "node")
        with unittest.mock.patch.object(self.install, "docker_available", lambda: True):
            self.assertEqual(self.install.recommended_method(), "prebuilt")

    def test_docker_available_stub(self):
        tmp = Path(tempfile.mkdtemp())
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        try:
            docker = bin_dir / "docker"
            docker.write_text("#!/bin/sh\nexit 0\n")
            docker.chmod(0o755)
            with unittest.mock.patch.dict(os.environ, {"PATH": str(bin_dir)}, clear=True):
                self.assertTrue(self.install.docker_available())
            docker.write_text("#!/bin/sh\nif [ \"$1\" = compose ]; then exit 1; fi\nexit 0\n")
            docker.chmod(0o755)
            with unittest.mock.patch.dict(os.environ, {"PATH": str(bin_dir)}, clear=True):
                self.assertFalse(self.install.docker_available())
            with unittest.mock.patch.dict(os.environ, {"PATH": str(tmp / "empty")}, clear=True):
                self.assertFalse(self.install.docker_available())
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_no_terminal_prints_note_and_uses_recommended(self):
        import argparse
        stdout = io.StringIO()
        with unittest.mock.patch.object(self.install.sys, "stdin", io.StringIO()), \
             unittest.mock.patch.object(self.install.sys, "stdout", stdout), \
             unittest.mock.patch.object(self.install, "_open_controlling_tty", lambda: None):
            args = argparse.Namespace()
            self.assertEqual(self.install.choose_method(args, [], source=None), "node")
        self.assertIn("using install method node", stdout.getvalue())


class ChoosePortUnitTest(unittest.TestCase):
    """Module-level tests for the port-selection helpers."""

    def setUp(self):
        self.install = load_installer()
        self.tmp = tempfile.TemporaryDirectory()
        self.target = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def choose(self, port_flag, answers=None):
        import argparse
        args = argparse.Namespace(port=port_flag)
        source = FakeInput(answers) if answers is not None else None
        return self.install.choose_port(args, str(self.target), source=source)

    def test_explicit_flag_wins(self):
        self.assertEqual(self.choose("8088"), 8088)

    def test_prompt_defaults_to_3000_and_accepts_empty_line(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.choose(None, [""]), 3000)

    def test_explicit_invalid_flag_fails(self):
        for bad in ("0", "65536", "x", "12x4", "-1"):
            with self.assertRaises(SystemExit) as ctx:
                self.choose(bad)
            self.assertEqual(ctx.exception.code, 1)

    def test_explicit_invalid_env_fails(self):
        with unittest.mock.patch.dict(os.environ, {"PORT": "70000"}, clear=True):
            with self.assertRaises(SystemExit):
                self.choose(None)

    def test_valid_env_port_wins(self):
        with unittest.mock.patch.dict(os.environ, {"PORT": "8088"}, clear=True):
            self.assertEqual(self.choose(None, ["9999"]), 8088)

    def test_saved_port_becomes_prompt_default(self):
        (self.target / ".env").write_text('SUSHI_AUTH_SECRET=keep\nexport PORT="8088" # current\n')
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.choose(None, [""]), 8088)

    def test_invalid_saved_port_fails_without_prompting(self):
        (self.target / ".env").write_text("PORT=${SOMETHING_ELSE}\n")
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as ctx:
                self.choose(None, [""])
            self.assertEqual(ctx.exception.code, 1)

    def test_prompt_reprompts_on_invalid_input(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.choose(None, ["0", "12x4", "9999"]), 9999)

    def test_non_interactive_prints_note_and_uses_default(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            stdout = io.StringIO()
            with unittest.mock.patch.object(self.install.sys, "stdin", io.StringIO()), \
                 unittest.mock.patch.object(self.install.sys, "stdout", stdout), \
                 unittest.mock.patch.object(self.install, "_open_controlling_tty", lambda: None):
                self.assertEqual(self.choose(None), 3000)
        self.assertIn("No interactive terminal; using web UI port 3000", stdout.getvalue())

    def test_saved_port_parsing_variants(self):
        cases = {
            "PORT=8088": "8088",
            'PORT="8088"': "8088",
            "PORT='8088'": "8088",
            "PORT=8088 # comment": "8088",
            'export PORT="8088" # comment': "8088",
            "export PORT=8088": "8088",
            "PORT = 8088": "8088",
            "PORT=8088\nPORT=9999\n": "9999",
            "OTHER=1\n": None,
        }
        for content, expected in cases.items():
            (self.target / ".env").write_text(content)
            self.assertEqual(self.install.read_saved_port(str(self.target)), expected, content)

    def test_write_env_port_creates_new_env_with_secret_and_port(self):
        (self.target / ".env.example").write_text("SUSHI_SERVER_VAULT=true\nPORT=3000\n")
        self.install.write_env_port(str(self.target), 8088)
        content = (self.target / ".env").read_text()
        lines = [l for l in content.splitlines() if l.startswith("PORT=")]
        self.assertEqual(lines, ["PORT=8088"])
        self.assertIn("SUSHI_AUTH_SECRET=", content)
        self.assertIn("SUSHI_SERVER_VAULT=true", content)
        self.assertEqual((self.target / ".env").stat().st_mode & 0o777, 0o600)

    def test_write_env_port_updates_existing_env_preserving_lines(self):
        (self.target / ".env").write_text('SUSHI_AUTH_SECRET=keep-this-secret\nPORT=1234\nexport PORT="8080" # current\nOTHER=value\n')
        self.install.write_env_port(str(self.target), 9090)
        content = (self.target / ".env").read_text()
        self.assertEqual([l for l in content.splitlines() if l.startswith("PORT=")], ["PORT=9090"])
        self.assertIn("SUSHI_AUTH_SECRET=keep-this-secret", content)
        self.assertIn("OTHER=value", content)
        self.assertEqual((self.target / ".env").stat().st_mode & 0o777, 0o600)

    def test_write_env_port_refuses_symlinks(self):
        external = self.target / "external.env"
        external.write_text("PORT=3000\n")
        (self.target / ".env").symlink_to(external)
        with self.assertRaises(SystemExit):
            self.install.write_env_port(str(self.target), 8088)
        self.assertEqual(external.read_text(), "PORT=3000\n")


class PublicAddressUnitTest(unittest.TestCase):
    """Module-level tests for the public-IP detection used by the summary."""

    def setUp(self):
        self.install = load_installer()

    def test_valid_ipv4(self):
        for good in ("198.51.100.9", " 203.0.113.7 ", "8.8.8.8"):
            self.assertTrue(self.install.valid_ipv4(good), good)
        for bad in ("", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::1", "not-an-ip"):
            self.assertFalse(self.install.valid_ipv4(bad), bad)

    def test_is_private_ipv4(self):
        for private in ("10.0.0.5", "192.168.1.10", "172.16.0.1", "127.0.0.1", "169.254.10.1"):
            self.assertTrue(self.install.is_private_ipv4(private), private)
        for public in ("203.0.113.7", "198.51.100.9", "8.8.8.8", "172.32.0.1"):
            self.assertFalse(self.install.is_private_ipv4(public), public)
        self.assertFalse(self.install.is_private_ipv4("nope"))

    def test_env_override_wins_without_lookup(self):
        with unittest.mock.patch.dict(os.environ, {"SUSHI_PUBLIC_IP": "198.51.100.9"}, clear=True), \
             unittest.mock.patch.object(self.install.urllib.request, "urlopen",
                                        side_effect=AssertionError("lookup must not run")):
            self.assertEqual(self.install.detect_public_ip(), "198.51.100.9")

    def test_invalid_override_warns_and_falls_back_to_lookup(self):
        stdout = io.StringIO()
        with unittest.mock.patch.dict(os.environ, {"SUSHI_PUBLIC_IP": "nope"}, clear=True), \
             unittest.mock.patch.object(self.install.urllib.request, "urlopen",
                                        lambda *a, **k: io.BytesIO(b"203.0.113.7\n")), \
             unittest.mock.patch.object(self.install.sys, "stdout", stdout):
            self.assertEqual(self.install.detect_public_ip(), "203.0.113.7")
        self.assertIn("Ignoring SUSHI_PUBLIC_IP=nope", stdout.getvalue())

    def test_lookup_skips_unusable_answers(self):
        answers = iter([io.BytesIO(b"<html>not an ip</html>"), io.BytesIO(b"203.0.113.7")])
        with unittest.mock.patch.dict(os.environ, {}, clear=True), \
             unittest.mock.patch.object(self.install.urllib.request, "urlopen",
                                        lambda *a, **k: next(answers)):
            self.assertEqual(self.install.detect_public_ip(), "203.0.113.7")

    def test_falls_back_to_the_interface_address(self):
        class FakeSocket:
            def __init__(self, *args, **kwargs):
                self.address = None

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def connect(self, address):
                self.address = address

            def getsockname(self):
                return ("10.1.2.3", 5555)

        with unittest.mock.patch.dict(os.environ, {}, clear=True), \
             unittest.mock.patch.object(self.install.urllib.request, "urlopen",
                                        side_effect=urllib.error.URLError("offline")), \
             unittest.mock.patch.object(self.install.socket, "socket", FakeSocket):
            self.assertEqual(self.install.detect_public_ip(), "10.1.2.3")

    def test_returns_none_when_everything_fails(self):
        class BrokenSocket:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def connect(self, address):
                raise OSError("network is unreachable")

        with unittest.mock.patch.dict(os.environ, {}, clear=True), \
             unittest.mock.patch.object(self.install.urllib.request, "urlopen",
                                        side_effect=OSError("offline")), \
             unittest.mock.patch.object(self.install.socket, "socket", BrokenSocket):
            self.assertIsNone(self.install.detect_public_ip())


class SummaryLinkTest(unittest.TestCase):
    """The summary must offer a link a browser on another machine can open."""

    def setUp(self):
        self.install = load_installer()
        self.tmp = tempfile.TemporaryDirectory()
        self.target = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def summary(self, host="0.0.0.0", detected="203.0.113.7", docker=False):
        import argparse
        args = argparse.Namespace(host=host, port=3000, data_dir=None,
                                  foreground=False, method="node")
        stdout = io.StringIO()
        with unittest.mock.patch.object(self.install, "detect_public_ip", lambda: detected), \
             unittest.mock.patch.object(self.install.sys, "stdout", stdout):
            self.install.print_summary(args, str(self.target), pid="4242", docker=docker)
        return stdout.getvalue()

    def test_public_ip_becomes_the_open_link(self):
        out = self.summary()
        self.assertIn("http://203.0.113.7:3000", out)
        self.assertIn("Local:     http://localhost:3000", out)

    def test_private_address_is_not_offered_as_the_open_link(self):
        out = self.summary(detected="10.0.0.5")
        self.assertIn("Open:      http://localhost:3000", out)
        self.assertNotIn("Open:      http://10.0.0.5", out)
        self.assertIn("http://10.0.0.5:3000", out)
        self.assertIn("private", out)

    def test_no_detection_keeps_the_localhost_link(self):
        out = self.summary(detected=None)
        self.assertIn("Open:      http://localhost:3000", out)
        self.assertNotIn("private", out)

    def test_explicit_bind_host_is_used_without_detection(self):
        out = self.summary(host="127.0.0.1", detected="203.0.113.7")
        self.assertIn("Open:      http://127.0.0.1:3000", out)
        self.assertNotIn("203.0.113.7", out)
        self.assertNotIn("Local:", out)


if __name__ == "__main__":
    unittest.main()
