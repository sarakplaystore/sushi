#!/usr/bin/env bash
# Sushi — one-command installer for Linux (Ubuntu/Debian, Rocky/Alma, Fedora, Arch, Alpine)
#
#   curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh | bash
#
#   # or from a checkout, with options:
#   bash scripts/install-vps.sh --port 8080
#   bash scripts/install-vps.sh --https sushi.example.com      # + Caddy & automatic HTTPS
#   bash scripts/install-vps.sh --prebuilt                      # pull ghcr.io image, no build
#   bash scripts/install-vps.sh --node                          # no Docker: Node.js + systemd
#
# It installs Docker if missing, writes a .env with a random SUSHI_AUTH_SECRET,
# starts Sushi + guacd, waits until /api/system/capabilities answers, and prints
# the URL. Safe to re-run: an existing .env and the data volume are never deleted.
#
# Sushi is AI-assisted software provided "AS IS", without warranty — see
# DISCLAIMER.md / PRIVACY.md. Never expose it to the internet without HTTPS.

set -euo pipefail

REPO_URL="https://github.com/sarakplaystore/sushi.git"
RAW_URL="https://raw.githubusercontent.com/sarakplaystore/sushi/main"
PORT="${PORT:-3000}"
HTTPS_DOMAIN=""
MODE="build"          # build | prebuilt | node
INSTALL_DIR="${SUSHI_DIR:-$PWD/sushi}"
WAIT_SECONDS=180

bold() { printf '\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --https) HTTPS_DOMAIN="$2"; shift 2 ;;
    --prebuilt) MODE="prebuilt"; shift ;;
    --node) MODE="node"; shift ;;
    --timeout) WAIT_SECONDS="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

bold "Sushi installer — self-hosted web SSH · SFTP · RDP workspace"
echo "  install dir: $INSTALL_DIR"
echo "  port:        $PORT"
echo "  mode:        $MODE"
echo

# ---------------------------------------------------------------- privileges ---
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else die "Run as root or install sudo."; fi
fi

# ------------------------------------------------------------- prerequisites ---
have() { command -v "$1" >/dev/null 2>&1; }

ensure_git_and_curl() {
  have git && have curl && return 0
  warn "Installing git and curl…"
  if have apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git curl ca-certificates
  elif have dnf; then $SUDO dnf install -y -q git curl ca-certificates
  elif have yum; then $SUDO yum install -y -q git curl ca-certificates
  elif have pacman; then $SUDO pacman -Sy --noconfirm git curl ca-certificates
  elif have apk; then $SUDO apk add --no-cache git curl ca-certificates
  else die "Please install git and curl, then re-run."
  fi
}

install_docker() {
  have docker && return 0
  warn "Docker not found — installing it (official convenience script)…"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker 2>/dev/null || true
  if [ "$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then
    $SUDO usermod -aG docker "$USER" 2>/dev/null || true
    warn "Added $USER to the docker group — log out and back in if docker asks for permission."
  fi
  have docker || die "Docker install failed. See https://docs.docker.com/engine/install/"
  ok "Docker installed"
}

# Compose v1 fallback keeps older VPS images working.
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif have docker-compose; then docker-compose "$@"
  else die "Docker Compose is missing (install docker-compose-plugin)."
  fi
}

ensure_node() {
  if have node; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$major" -ge 20 ] && { ok "Node.js $(node -v)"; return 0; }
    warn "Node.js $(node -v) is too old for Sushi (needs 20+, 22 recommended)."
  fi
  warn "Installing Node.js 22…"
  if have apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - && $SUDO apt-get install -y -qq nodejs
  elif have dnf; then
    $SUDO dnf module install -y nodejs:22/common 2>/dev/null || $SUDO dnf install -y nodejs npm
  elif have apk; then
    $SUDO apk add --no-cache nodejs npm
  else
    die "Install Node.js 22 from https://nodejs.org and re-run."
  fi
  have node || die "Node.js install failed."
  ok "Node.js $(node -v) installed"
}

# ------------------------------------------------------------------- source ---
ensure_source() {
  ensure_git_and_curl
  if [ -f "$INSTALL_DIR/package.json" ]; then
    ok "Using existing checkout at $INSTALL_DIR"
    if [ -d "$INSTALL_DIR/.git" ]; then
      ( cd "$INSTALL_DIR" && git pull --ff-only >/dev/null 2>&1 ) && ok "Updated to the latest main" || warn "Could not git pull — continuing with the local copy"
    fi
    return 0
  fi
  bold "Downloading Sushi into $INSTALL_DIR…"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"; then ok "Source downloaded"; else die "git clone failed"; fi
}

write_env() {
  cd "$INSTALL_DIR"
  if [ ! -f .env ]; then
    [ -f .env.example ] && cp .env.example .env
    {
      echo ""
      echo "# generated by install-vps.sh"
      echo "SUSHI_AUTH_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      echo "PORT=$PORT"
    } >> .env
    ok "Wrote .env with a random SUSHI_AUTH_SECRET"
  else
    ok "Keeping your existing .env"
  fi
}

wait_for_http() {
  local url="http://127.0.0.1:${PORT}/api/system/capabilities" waited=0
  bold "Waiting for Sushi to answer on port ${PORT} (up to ${WAIT_SECONDS}s)…"
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    if curl -fsS -m 5 "$url" >/dev/null 2>&1; then ok "Sushi is answering"; return 0; fi
    sleep 3; waited=$((waited + 3))
  done
  warn "No answer yet — the container may still be starting. Check: docker compose logs -f sushi"
  return 1
}

setup_https() {
  [ -n "$HTTPS_DOMAIN" ] || return 0
  bold "Configuring Caddy for automatic HTTPS on $HTTPS_DOMAIN…"
  if ! have caddy && ! have apt-get; then warn "Skipping Caddy setup (no apt on this host)"; return 0; fi
  if ! have caddy; then
    $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq caddy
  fi
  local conf=/etc/caddy/Caddyfile
  if $SUDO grep -q "$HTTPS_DOMAIN" "$conf" 2>/dev/null; then ok "Caddy already has a block for $HTTPS_DOMAIN"; else
    printf '\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$HTTPS_DOMAIN" "$PORT" | $SUDO tee -a "$conf" >/dev/null
    ok "Added reverse_proxy for $HTTPS_DOMAIN → 127.0.0.1:$PORT"
  fi
  $SUDO systemctl reload caddy 2>/dev/null || $SUDO systemctl restart caddy
  ok "HTTPS enabled (point $HTTPS_DOMAIN's DNS A record at this server)"
}

install_systemd_service() {
  bold "Installing a systemd service (start on boot, restart on crash)…"
  local user="${SUDO_USER:-$(id -un)}"
  $SUDO tee /etc/systemd/system/sushi.service >/dev/null <<UNIT
[Unit]
Description=Sushi (SSH/SFTP/RDP web workspace)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v docker) compose up -d
ExecStop=$(command -v docker) compose down
User=$user
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable sushi.service >/dev/null 2>&1 || true
  ok "systemd service installed (systemctl status sushi)"
}

# ------------------------------------------------------------------- install ---
case "$MODE" in
  build|prebuilt)
    install_docker
    ensure_source
    write_env
    if [ "$MODE" = "prebuilt" ]; then
      bold "Pulling the prebuilt image and starting Sushi + guacd…"
      if [ -f docker-compose.prebuilt.yml ]; then
        $SUDO -E PORT="$PORT" docker compose -f docker-compose.prebuilt.yml up -d || die "docker compose failed"
      else
        warn "docker-compose.prebuilt.yml missing — falling back to a local build"
        $SUDO -E PORT="$PORT" docker compose up -d --build || die "docker compose failed"
      fi
    else
      bold "Building and starting Sushi + Apache Guacamole (first build takes a few minutes)…"
      $SUDO -E PORT="$PORT" docker compose up -d --build || die "docker compose failed"
    fi
    wait_for_http || true
    install_systemd_service
    setup_https
    ;;

  node)
    ensure_node
    ensure_source
    cd "$INSTALL_DIR"
    [ -d node_modules ] || { bold "Installing dependencies…"; npm ci --no-audit --no-fund || npm install --no-audit --no-fund; }
    bold "Building…"
    NEXT_TELEMETRY_DISABLED=1 npm run build || die "Build failed"
    write_env
    bold "Starting Sushi on port $PORT…"
    PORT="$PORT" HOST=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 nohup npm start > sushi.log 2>&1 &
    echo $! > sushi.pid
    wait_for_http || warn "Check $INSTALL_DIR/sushi.log"
    setup_https
    ;;
esac

# ------------------------------------------------------------------- summary ---
SHOWN_HOST="localhost"
URL="http://<your-vps-ip>:${PORT}"
[ -n "$HTTPS_DOMAIN" ] && URL="https://${HTTPS_DOMAIN}"

echo
printf '\033[1;32m  Sushi is up!  %s\033[0m\n' "$URL"
echo "  Local check:  http://${SHOWN_HOST}:${PORT}"
echo "  Directory:    $INSTALL_DIR"
echo "  Data:         docker volume 'sushi-data' (or $INSTALL_DIR/data) — back it up: auth.json + vault.enc.json"
echo
if [ "$MODE" = "node" ]; then
  echo "  Stop:   kill \$(cat $INSTALL_DIR/sushi.pid)"
  echo "  Logs:   tail -f $INSTALL_DIR/sushi.log"
else
  echo "  Stop:   cd $INSTALL_DIR && docker compose down"
  echo "  Logs:   cd $INSTALL_DIR && docker compose logs -f sushi"
fi
echo
if [ -z "$HTTPS_DOMAIN" ]; then
  printf '\033[33m  Next: open the URL and create the admin account immediately, then put HTTPS\n'
  printf '  in front of it (re-run with --https your.domain) before exposing it publicly.\033[0m\n'
fi
printf '\033[2m  Sushi is AI-assisted software provided "AS IS", without warranty. See DISCLAIMER.md.\033[0m\n'
