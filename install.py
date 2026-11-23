#!/usr/bin/env python3
"""
Sushi — one-click installer (Python 3.9+, no third-party packages).

    python3 install.py                  # install + build + start in the background
    python3 install.py --foreground     # install + build + run in this terminal
    python3 install.py --prebuilt       # pull the published image (fastest; Docker)
    python3 install.py --docker         # use Docker Compose and build from source
    python3 install.py --node           # force the Node.js install
    python3 install.py --port 8080      # pick a port without prompting
    python3 install.py --dir ~/sushi    # pick an install directory
    python3 install.py --no-start       # install + build only

Without --port or a PORT environment variable, the installer asks for the web UI
port before doing anything else. Likewise, without --docker / --prebuilt / --node
it asks how to install — the recommendation is the fastest fit for this VPS (the
pull-and-run prebuilt image when Docker works, Node.js otherwise). Both prompts
read stdin when it is a terminal and fall back to the controlling terminal
(/dev/tty) when the installer is piped or run over SSH — so `curl ... | bash` and
remote sessions both work. In a fully unattended run (no terminal), the installer
uses the default port and recommended method and prints a note explaining that
the flags override both.

What it does, in order:
  1. Asks you for the web UI port (unless --port / PORT is given) and for the
     install method (unless --docker / --prebuilt / --node is given), then checks
     that Node.js >= 20 (or Docker) exists — and tells you the one command to
     install it if not.
  2. Downloads the latest Sushi source (git clone, falling back to a GitHub
     tarball when git is unavailable).
  3. `npm ci` + `npm run build` with output-streaming, then starts the server.
  4. Waits until /api/system/capabilities answers, then prints the URL — the
     server's public IPv4 link when it can detect it (or SUSHI_PUBLIC_IP is
     set), with localhost shown as the local check.

Nothing here needs root: it installs into a directory you own (`./sushi` by
default) and never touches `data/` once it exists, so re-running the installer
upgrades the code without deleting your account or encrypted vault.

Sushi is AI-assisted software provided "AS IS", without warranty — see
DISCLAIMER.md and PRIVACY.md in the repository before exposing it to the internet.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

REPO = "sarakplaystore/sushi"
MIN_NODE_MAJOR = 20
HEALTH_PATH = "/api/system/capabilities"
DEFAULT_PORT = 3000


# --------------------------------------------------------------------------- #
# tiny terminal helpers (no dependencies, colour only when attached to a TTY)
# --------------------------------------------------------------------------- #
class Style:
    _on = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

    @classmethod
    def _wrap(cls, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if cls._on else text

    @classmethod
    def bold(cls, text: str) -> str:
        return cls._wrap("1", text)

    @classmethod
    def green(cls, text: str) -> str:
        return cls._wrap("32", text)

    @classmethod
    def yellow(cls, text: str) -> str:
        return cls._wrap("33", text)

    @classmethod
    def red(cls, text: str) -> str:
        return cls._wrap("31", text)

    @classmethod
    def dim(cls, text: str) -> str:
        return cls._wrap("2", text)


def step(message: str) -> None:
    print(f"{Style.bold('==>')} {message}", flush=True)


def ok(message: str) -> None:
    print(f"  {Style.green('✔')} {message}", flush=True)


def warn(message: str) -> None:
    print(f"  {Style.yellow('!')} {message}", flush=True)


def fail(message: str, hint: str | None = None) -> "NoReturn":  # type: ignore[name-defined]
    print(f"\n{Style.red('✘')} {message}", file=sys.stderr)
    if hint:
        print(f"  {hint}", file=sys.stderr)
    raise SystemExit(1)


# --------------------------------------------------------------------------- #
# environment checks
# --------------------------------------------------------------------------- #
def run(cmd: list[str], cwd: str | None = None, env: dict[str, str] | None = None) -> int:
    """Run a command, streaming output, and return its exit code."""
    completed = subprocess.run(cmd, cwd=cwd, env=env)
    return completed.returncode


def which(name: str) -> str | None:
    return shutil.which(name)


def node_version(binary: str = "node") -> tuple[int, int, int] | None:
    if not which(binary):
        return None
    try:
        out = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=20
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    out = out.lstrip("v")
    parts = out.split(".")
    if not parts or not parts[0].isdigit():
        return None
    nums = [int(p) for p in parts[:3] if p.isdigit()]
    while len(nums) < 3:
        nums.append(0)
    return nums[0], nums[1], nums[2]


NODE_HINT = {
    "linux": "Install Node.js 22 with:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs",
    "darwin": "Install Node.js 22 with:  brew install node@22   (or download from https://nodejs.org)",
}


def require_node() -> None:
    version = node_version()
    if version is None:
        fail(
            "Node.js is not installed (Sushi needs Node.js 22).",
            NODE_HINT.get(platform.system().lower(), "Download it from https://nodejs.org"),
        )
    if version[0] < MIN_NODE_MAJOR:
        fail(
            f"Node.js {version[0]}.{version[1]}.{version[2]} is too old — Sushi needs Node.js {MIN_NODE_MAJOR}+ (22 recommended).",
            NODE_HINT.get(platform.system().lower(), "Download a newer version from https://nodejs.org"),
        )
    ok(f"Node.js {version[0]}.{version[1]}.{version[2]}")


def _quiet_run(cmd: list[str]) -> int:
    """Run a command quietly and return its exit code."""
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        return result.returncode
    except (OSError, subprocess.SubprocessError):
        return 1


def docker_available() -> bool:
    """True when Docker can actually be used in this shell (no sudo needed)."""
    if which("docker") is None:
        return False
    if _quiet_run(["docker", "compose", "version"]) != 0:
        return False
    if _quiet_run(["docker", "info"]) != 0:
        return False
    return True


def recommended_method() -> str:
    """Fastest fit for this VPS: the pulled prebuilt image when Docker works."""
    return "prebuilt" if docker_available() else "node"


def require_docker() -> None:
    if which("docker") is None:
        fail(
            "Docker is not installed.",
            "Install it from https://docs.docker.com/engine/install/ (or run this script without --docker to use Node.js).",
        )
    if run(["docker", "compose", "version"]) != 0:
        fail("Docker Compose v2 is missing.", "Update Docker Desktop / the docker-compose-plugin.")
    if run(["docker", "info"]) != 0:
        fail(
            "The Docker daemon is not running (or you lack permission to use it).",
            "Start Docker Desktop / run `sudo systemctl start docker`, or use the Node.js install instead.",
        )
    ok("Docker + Compose")


# --------------------------------------------------------------------------- #
# source download
# --------------------------------------------------------------------------- #
def download_source(target: str, branch: str, ref: str | None) -> None:
    """Clone (preferred) or download a tarball of the repository into `target`."""
    if os.path.isdir(os.path.join(target, ".git")) or os.path.isfile(
        os.path.join(target, "install.py")
    ):
        ok(f"Reusing the existing checkout at {target}")
        return

    os.makedirs(target, exist_ok=True)
    git = which("git")
    if git:
        step(f"Downloading Sushi ({branch}) with git…")
        url = f"https://github.com/{REPO}.git"
        shallow = ["clone", "--depth", "1", "--branch", ref or branch, url, target]
        if run([git, *shallow]) == 0:
            ok("Source downloaded")
            return
        warn("git clone failed — falling back to a GitHub tarball")

    archive_ref = ref or branch
    step(f"Downloading Sushi ({archive_ref}) as a tarball…")
    tarball_url = f"https://codeload.github.com/{REPO}/tar.gz/refs/heads/{archive_ref}"
    with tempfile.TemporaryDirectory() as tmp:
        archive = os.path.join(tmp, "sushi.tar.gz")
        try:
            with urllib.request.urlopen(tarball_url, timeout=120) as response:
                with open(archive, "wb") as handle:
                    shutil.copyfileobj(response, handle)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as error:
            fail(
                f"Could not download {tarball_url}",
                f"{error} — check your internet connection, or clone manually: git clone https://github.com/{REPO}.git",
            )
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter="data") if hasattr(tarfile, "data_filter") else tar.extractall(tmp)
        roots = [p for p in os.listdir(tmp) if os.path.isdir(os.path.join(tmp, p)) and p != "__MACOSX"]
        if not roots:
            fail("The downloaded archive was empty.")
        source = os.path.join(tmp, roots[0])
        for entry in os.listdir(source):
            shutil.move(os.path.join(source, entry), os.path.join(target, entry))
    ok("Source downloaded")


# --------------------------------------------------------------------------- #
# server address (so the summary shows a link you can actually open)
# --------------------------------------------------------------------------- #
PUBLIC_IP_ENDPOINTS = (
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://icanhazip.com",
)


def valid_ipv4(raw: str) -> bool:
    """True for a strict dotted-quad IPv4 address."""
    try:
        ipaddress.IPv4Address(raw.strip())
    except (ipaddress.AddressValueError, ValueError):
        return False
    return True


# Ranges reachable only inside the host/provider network, matching
# install-vps.sh. Kept explicit rather than using IPv4Address.is_private, which
# also flags reserved documentation ranges such as 203.0.113.0/24.
LOCAL_IPV4_NETWORKS = (
    ipaddress.IPv4Network("0.0.0.0/8"),
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("100.64.0.0/10"),   # carrier-grade NAT
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv4Network("169.254.0.0/16"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)


def is_private_ipv4(raw: str) -> bool:
    """True when the address is not reachable from the public internet."""
    try:
        address = ipaddress.IPv4Address(raw.strip())
    except (ipaddress.AddressValueError, ValueError):
        return False
    return any(address in network for network in LOCAL_IPV4_NETWORKS)


def detect_public_ip() -> str | None:
    """Best-effort public IPv4 of this machine, or None.

    `SUSHI_PUBLIC_IP` wins when it is a valid IPv4 address. Otherwise a few
    public "what is my IP" services are asked (short timeouts, first answer
    wins), and as a last resort the address of the interface that would reach
    the internet is used — public on many VPSes, private behind cloud NAT.
    """
    override = (os.environ.get("SUSHI_PUBLIC_IP") or "").strip()
    if override:
        if valid_ipv4(override):
            return override
        warn(f"Ignoring SUSHI_PUBLIC_IP={override} (not an IPv4 address); detecting it instead.")

    for endpoint in PUBLIC_IP_ENDPOINTS:
        try:
            with urllib.request.urlopen(endpoint, timeout=3) as response:
                candidate = response.read(64).decode("ascii", "replace").strip()
        except (urllib.error.URLError, OSError, ValueError):
            continue
        if valid_ipv4(candidate):
            return candidate

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("1.1.1.1", 80))
            local = probe.getsockname()[0]
    except OSError:
        return None
    return local if valid_ipv4(local) and local != "0.0.0.0" else None


# --------------------------------------------------------------------------- #
# health check
# --------------------------------------------------------------------------- #
def wait_for_health(port: int, timeout_seconds: int = 180, proc: subprocess.Popen | None = None) -> bool:
    url = f"http://127.0.0.1:{port}{HEALTH_PATH}"
    deadline = time.time() + timeout_seconds
    step(f"Waiting for Sushi to answer on port {port}…")
    while time.time() < deadline:
        if proc is not None and proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status < 500:
                    payload = json.loads(response.read().decode("utf-8", "replace") or "{}")
                    ok(f"Healthy — runtime mode: {payload.get('mode', 'unknown')}")
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
            pass
        time.sleep(2)
    return False


# --------------------------------------------------------------------------- #
# web UI port selection (prompt when --port / PORT are not given)
# --------------------------------------------------------------------------- #
def is_valid_port_value(raw: str) -> bool:
    return raw.isdigit() and 1 <= int(raw) <= 65535


def read_saved_port(target: str) -> str | None:
    """Read the PORT saved in an existing .env (the shell installer's behaviour).

    Last assignment wins. Returns the raw value (string), or None when there is
    no .env or no PORT line; an unparseable value is returned as-is and left for
    the caller to reject.
    """
    env_file = os.path.join(target, ".env")
    if os.path.islink(env_file) or not os.path.isfile(env_file):
        return None
    try:
        with open(env_file, "r", encoding="utf-8", errors="replace") as handle:
            content = handle.read()
    except OSError:
        return None
    port = None
    for line in content.splitlines():
        match = re.match(r"^\s*(?:export\s+)?PORT\s*=(.*)$", line)
        if not match:
            continue
        value = match.group(1)
        value = re.sub(r"\s*#.*$", "", value).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if value:
            port = value
    return port


def _open_controlling_tty():
    """Return an fd for the controlling terminal, or None when there is none."""
    try:
        flags = os.O_RDWR | (getattr(os, "O_NOCTTY", 0) if hasattr(os, "O_NOCTTY") else 0)
        return os.open("/dev/tty", flags)
    except OSError:
        return None


class ConsoleInput:
    """Line source for the port prompt.

    Prefers stdin when it is a terminal (plain `python3 install.py`), otherwise
    falls back to the controlling terminal — the way the shell installer behaves
    when it runs piped (`curl ... | bash`) or over an SSH session. Returns no
    availability for fully unattended runs (no terminal at all).
    """

    def __init__(self, source=None):
        # `source` lets tests inject a line-based fake.
        self._input = None
        self._fd = None
        if source is not None:
            self._input = source
            return
        if sys.stdin.isatty():
            self._input = sys.stdin
            return
        fd = _open_controlling_tty()
        if fd is None:
            return
        self._fd = fd
        try:
            self._input = open(fd, "r")
        except OSError:
            self._fd = None

    def available(self) -> bool:
        return self._input is not None

    def readline(self) -> str | None:
        if self._input is None:
            return None
        return self._input.readline()

    def close(self) -> None:
        if self._input is not None and self._fd is not None:
            try:
                self._input.close()
            except Exception:
                pass
            try:
                os.close(self._fd)
            except OSError:
                pass


def choose_port(args: argparse.Namespace, target: str, source=None) -> int:
    """Pick the web UI port.

    --port or the PORT environment variable wins; otherwise ask interactively
    (default: saved .env port, else 3000). No terminal → use the default with a
    printed note, so unattended/CI installs never block.
    """
    explicit_flag = args.port is not None
    env_port = (os.environ.get("PORT") or "").strip()
    if explicit_flag or env_port:
        raw = str(args.port).strip() if explicit_flag else env_port
        if not is_valid_port_value(raw):
            fail(f"Invalid web UI port '{raw}' (choose 1–65535).")
        return int(raw)

    saved = read_saved_port(target)
    if saved is not None and not is_valid_port_value(saved):
        fail(
            f"Invalid PORT in {os.path.join(target, '.env')}.",
            "Fix it or supply --port.",
        )
    default = int(saved) if saved else DEFAULT_PORT

    tty = ConsoleInput(source)
    if not tty.available():
        print(f"No interactive terminal; using web UI port {default} (override with --port).")
        return default
    try:
        while True:
            print(f"Web UI port [{default}]: ", file=sys.stderr, flush=True)
            try:
                answer = tty.readline()
            except OSError:
                answer = None
            if not answer:
                fail("Port selection cancelled.")
            answer = answer.strip()
            if not answer:
                return default
            if is_valid_port_value(answer):
                return int(answer)
            warn("Enter a port from 1 to 65535.")
    finally:
        tty.close()


# --------------------------------------------------------------------------- #
# install method selection (Docker prebuilt / Docker build / Node.js)
# --------------------------------------------------------------------------- #
METHOD_ALIASES = {
    "prebuilt": ("prebuilt", "p", "images", "fastest"),
    "build": ("build", "b", "docker"),
    "node": ("node", "n", "nodejs"),
}

EXPLICIT_METHOD_FLAGS = {
    "--docker": "build",
    "--prebuilt": "prebuilt",
    "--node": "node",
}


def explicit_method(argv: list[str]) -> str | None:
    """Explicit --docker/--prebuilt/--node (last flag wins), or None."""
    chosen = None
    for token in argv:
        if token in EXPLICIT_METHOD_FLAGS:
            chosen = EXPLICIT_METHOD_FLAGS[token]
    return chosen


def choose_method(args: argparse.Namespace, argv: list[str], source=None) -> str:
    """Pick the install method.

    --docker / --prebuilt / --node win outright; otherwise ask interactively
    (the recommendation is the fastest fit for this VPS). No terminal → use the
    recommendation with a printed note, so unattended installs never block.
    """
    explicit = explicit_method(argv)
    if explicit:
        return explicit

    recommended = recommended_method()

    tty = ConsoleInput(source)
    if not tty.available():
        print(f"No interactive terminal; using install method {recommended} (override with --prebuilt / --docker / --node).")
        return recommended
    try:
        while True:
            print(f"Install method [{recommended}] (build | prebuilt | node): ", file=sys.stderr, flush=True)
            try:
                answer = tty.readline()
            except OSError:
                answer = None
            if not answer:
                fail("Method selection cancelled.")
            answer = answer.strip().lower()
            if not answer:
                return recommended
            for method, aliases in METHOD_ALIASES.items():
                if answer in aliases:
                    return method
            warn("Choose build, prebuilt, or node.")
    finally:
        tty.close()


def write_env_port(target: str, port: int) -> None:
    """Create or update the .env PORT in the Docker install path.

    Keeps every other line (credentials, data volume keys) untouched, like the
    shell installer. The PORT line is normalized to a single `PORT=<n>`, the
    file is chmod 600, and a symlinked .env is never rewritten.
    """
    env_file = os.path.join(target, ".env")
    if os.path.lexists(env_file) and os.path.islink(env_file):
        fail("Refusing to replace a symlinked .env; use a regular file instead.")
    created = False
    if not os.path.isfile(env_file):
        example = os.path.join(target, ".env.example")
        if os.path.isfile(example):
            shutil.copyfile(example, env_file)
        secret = os.urandom(24).hex()
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"\n# generated by install.py\nSUSHI_AUTH_SECRET={secret}\n")
        created = True

    with open(env_file, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    kept = [line for line in lines if not re.match(r"^\s*(?:export\s+)?PORT\s*=", line)]
    kept.append(f"PORT={port}")

    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix=".env.port.", dir=target)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for line in kept:
                handle.write(line + "\n")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, env_file)
    except Exception:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise
    if created:
        ok(f"Created .env with a random SUSHI_AUTH_SECRET (port {port})")
    else:
        ok("Updated the port in .env")


# --------------------------------------------------------------------------- #
# node install path
# --------------------------------------------------------------------------- #
def install_with_node(args: argparse.Namespace, target: str) -> int:
    require_node()
    download_source(target, args.branch, None)

    env = dict(os.environ)
    env.setdefault("NEXT_TELEMETRY_DISABLED", "1")

    if not os.path.isdir(os.path.join(target, "node_modules")):
        step("Installing dependencies (npm ci) — this takes a minute…")
        if run(["npm", "ci", "--no-audit", "--no-fund"], cwd=target, env=env) != 0:
            warn("npm ci failed — retrying with npm install")
            if run(["npm", "install", "--no-audit", "--no-fund"], cwd=target, env=env) != 0:
                fail("Could not install dependencies.", "Check that npm can reach registry.npmjs.org.")
        ok("Dependencies installed")
    else:
        ok("Dependencies already installed")

    step("Building the production bundle (this is the slow part, ~1–3 min)…")
    if run(["npm", "run", "build"], cwd=target, env=env) != 0:
        fail("The build failed.", "Re-run with `npm run build` inside the directory to see the full error.")
    ok("Build complete")

    if args.no_start:
        return 0

    data_dir = args.data_dir or os.path.join(target, "data")
    os.makedirs(data_dir, exist_ok=True)

    serve_env = dict(env)
    serve_env.update(
        {
            "NODE_ENV": "production",
            "HOST": args.host,
            "PORT": str(args.port),
            "DATA_DIR": data_dir,
        }
    )
    server = ["npm", "start"]

    if args.foreground:
        step(f"Starting Sushi in the foreground on http://{args.host}:{args.port} (Ctrl+C to stop)")
        return run(server, cwd=target, env=serve_env)

    log_dir = os.path.join(target, ".sushi")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "sushi.log")
    step(f"Starting Sushi in the background (log: {log_path})")
    with open(log_path, "ab") as log:
        proc = subprocess.Popen(
            server,
            cwd=target,
            env=serve_env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pid_path = os.path.join(log_dir, "sushi.pid")
    with open(pid_path, "w", encoding="utf-8") as handle:
        handle.write(str(proc.pid))

    if not wait_for_health(args.port, args.timeout, proc):
        tail = subprocess.run(["tail", "-n", "30", log_path], capture_output=True, text=True).stdout
        print(tail.rstrip(), file=sys.stderr)
        fail(
            "Sushi did not become healthy in time.",
            f"Check {log_path}, then retry with --foreground to see the output live.",
        )

    print_summary(args, target, pid=str(proc.pid))
    return 0


# --------------------------------------------------------------------------- #
# docker install path
# --------------------------------------------------------------------------- #
def install_with_docker(args: argparse.Namespace, target: str) -> int:
    require_docker()
    download_source(target, args.branch, None)

    write_env_port(target, args.port)

    prebuilt = args.method == "prebuilt"
    if prebuilt:
        step("Pulling the published image and starting Sushi + guacd…")
        cmd = ["docker", "compose", "-f", "docker-compose.prebuilt.yml", "up", "-d"]
        fail_hint = "Run `docker compose -f docker-compose.prebuilt.yml up -d` in the directory to see the error."
    else:
        step("Building and starting Sushi + guacd with Docker Compose…")
        cmd = ["docker", "compose", "up", "-d", "--build"]
        fail_hint = "Run `docker compose up --build` in the directory to see the error."
    if run(cmd, cwd=target) != 0:
        fail("Docker Compose failed.", fail_hint)

    if not wait_for_health(args.port, args.timeout):
        warn("The container is running but has not answered yet — check `docker compose logs -f sushi`.")
    print_summary(args, target, docker=True)
    return 0


def summary_links(args: argparse.Namespace) -> tuple[str, str | None, str | None]:
    """Return (local URL, public URL, private-but-detected address).

    The public URL is only offered when Sushi listens on every interface; a
    localhost address is useless to a browser on another machine, so the
    detected public IPv4 is preferred whenever it is reachable from outside.
    """
    shown_host = "localhost" if args.host in {"0.0.0.0", "::"} else args.host
    local_url = f"http://{shown_host}:{args.port}"
    if args.host not in {"0.0.0.0", "::"}:
        return local_url, None, None
    detected = detect_public_ip()
    if not detected:
        return local_url, None, None
    if is_private_ipv4(detected):
        return local_url, None, detected
    return local_url, f"http://{detected}:{args.port}", None


def print_summary(args: argparse.Namespace, target: str, pid: str | None = None, docker: bool = False) -> None:
    local_url, public_url, private_ip = summary_links(args)
    print()
    print(Style.green(Style.bold("  Sushi is up.")))
    if public_url:
        print(f"  Open:      {Style.bold(public_url)}")
        print(f"  Local:     {local_url}")
    else:
        print(f"  Open:      {Style.bold(local_url)}")
        if private_ip:
            print(f"  Note:      this host's own address is http://{private_ip}:{args.port} "
                  + Style.dim("(private - open your provider's public IP instead)"))
    print(f"  Directory: {target}")
    print(f"  Data:      {args.data_dir or os.path.join(target, 'data')}  {Style.dim('(back this up — account + encrypted vault)')}")
    print()
    if docker:
        compose_file = "-f docker-compose.prebuilt.yml " if getattr(args, "method", None) == "prebuilt" else ""
        print(f"  Stop:      cd {target} && docker compose {compose_file}down")
        print(f"  Logs:      cd {target} && docker compose {compose_file}logs -f sushi")
    elif args.foreground:
        print("  Stop:      Ctrl+C")
    else:
        print(f"  Stop:      kill {pid or '<pid in .sushi/sushi.pid>'}")
        print(f"  Logs:      tail -f {os.path.join(target, '.sushi', 'sushi.log')}")
    print()
    print(Style.yellow("  First visit asks you to create the admin account — do that immediately,"))
    print(Style.yellow("  and put HTTPS in front of it before exposing it to the internet."))
    print()
    print(Style.dim("  Sushi is AI-assisted software provided \"AS IS\", without warranty."))
    print(Style.dim("  See DISCLAIMER.md and PRIVACY.md."))
    print()


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="install.py",
        description="Install, build and start Sushi (self-hosted web SSH/SFTP/RDP workspace) in one step.",
        epilog="Docs: https://github.com/sarakplaystore/sushi#quick-start",
    )
    parser.add_argument("--dir", default="sushi", help="install directory (default: ./sushi)")
    parser.add_argument("--port", type=str, default=None, help=f"HTTP port (default: {DEFAULT_PORT}; prompted interactively when omitted)")
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default: 0.0.0.0)")
    parser.add_argument("--data-dir", default=None, help="where auth.json / vault.enc.json live (default: <dir>/data)")
    parser.add_argument("--branch", default="main", help="git branch or tag to install (default: main)")
    parser.add_argument("--docker", action="store_true", help="force Docker Compose with a build from source (Sushi + guacd)")
    parser.add_argument("--prebuilt", action="store_true", help="pull the published Sushi image instead of building (fastest; Docker must work)")
    parser.add_argument("--node", action="store_true", help="force the Node.js install (no Docker)")
    parser.add_argument("--foreground", action="store_true", help="keep the server attached to this terminal")
    parser.add_argument("--no-start", action="store_true", help="install and build, but do not start the server")
    parser.add_argument("--timeout", type=int, default=180, help="seconds to wait for the health check (default: 180)")
    parser.add_argument("--version", action="version", version="Sushi installer 1.0.0")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    target = os.path.abspath(os.path.expanduser(args.dir))

    print()
    print(Style.bold("  Sushi installer"))
    print(Style.dim("  self-hosted web SSH · SFTP · RDP workspace"))
    print()

    step(f"Install directory: {target}")

    args.port = choose_port(args, target)
    args.method = choose_method(args, argv)
    print(Style.dim(f"  Port {args.port} · Method: {args.method}"))

    os.makedirs(target, exist_ok=True)

    if args.method == "node":
        return install_with_node(args, target)
    return install_with_docker(args, target)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        raise SystemExit(130)
