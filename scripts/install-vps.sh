#!/usr/bin/env bash
# Sushi — one-command installer for Linux (Ubuntu/Debian, Rocky/Alma, Fedora, Arch, Alpine)
#
#   curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh | bash
#
#   # The installer asks for the install method (prebuilt Docker is recommended)
#   # and the web UI port (default: 3000).
#   # For unattended installs, pass explicit flags:
#   curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh | bash -s -- --prebuilt --port 8080
#
#   # or from a checkout, with options:
#   bash scripts/install-vps.sh --port 8080
#   bash scripts/install-vps.sh --yes                           # non-interactive restart
#   bash scripts/install-vps.sh --https sushi.example.com      # + Caddy & automatic HTTPS
#   bash scripts/install-vps.sh --prebuilt                      # pull ghcr.io image, no build
#   bash scripts/install-vps.sh --node                          # no Docker: Node.js
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
PORT="${PORT:-}"
PORT_EXPLICIT=0
[ -n "$PORT" ] && PORT_EXPLICIT=1
HTTPS_DOMAIN=""
FORCED_METHOD=""      # explicit --build / --prebuilt / --node, last flag wins
MODE="build"          # the effective install method (build | prebuilt | node)
INSTALL_DIR="${SUSHI_DIR:-$PWD/sushi}"
WAIT_SECONDS=180
ASSUME_YES=0
COMPOSE_KIND=""

have() { command -v "$1" >/dev/null 2>&1; }

bold() { printf '\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'HELP'
Sushi Docker installer (Linux)
Usage: bash install-vps.sh [options]
  --port PORT       Web UI port (1–65535; default 3000)
  --dir PATH        Install directory (default ./sushi)
  --yes             Allow restarting an existing running Sushi container
  --build           Build the image from source with Docker Compose
  --prebuilt        Pull the published image instead of building (fastest)
  --node            Install with Node.js instead of Docker
  --https DOMAIN    Configure Caddy for HTTPS
  --timeout SECONDS Time to wait for health (default 180)
  -h, --help        Show this help
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die "--port requires a value"; PORT="$2"; PORT_EXPLICIT=1; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir requires a value"; INSTALL_DIR="$2"; shift 2 ;;
    --https) [ $# -ge 2 ] || die "--https requires a value"; HTTPS_DOMAIN="$2"; shift 2 ;;
    --build) FORCED_METHOD="build"; shift ;;
    --prebuilt) FORCED_METHOD="prebuilt"; shift ;;
    --node) FORCED_METHOD="node"; shift ;;
    --timeout) [ $# -ge 2 ] || die "--timeout requires a value"; WAIT_SECONDS="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ "$WAIT_SECONDS" =~ ^[0-9]{1,6}$ ]] || die "--timeout must be a non-negative number of seconds."
WAIT_SECONDS="$((10#$WAIT_SECONDS))"

# Keep later cd/Compose/systemd paths stable for relative --dir values.
case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac

# Read the existing simple PORT assignment without executing the .env file.
# Refuse unusual expressions instead of silently choosing a different port.
saved_port() {
  [ -f "$INSTALL_DIR/.env" ] || return 0
  awk '
    /^[[:space:]]*(export[[:space:]]+)?PORT[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/[[:space:]]*#.*/, "", value)
      gsub(/^[[:space:]\r]+|[[:space:]\r]+$/, "", value)
      gsub(/^[\047\042]|[\047\042]$/, "", value)
      port = value
    }
    END { if (port != "") print port }
  ' "$INSTALL_DIR/.env"
}

bold "Sushi installer — self-hosted web SSH · SFTP · RDP workspace"
echo "  install dir: $INSTALL_DIR"
echo

valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$1))" -ge 1 ] && [ "$((10#$1))" -le 65535 ]
}

choose_port() {
  local default="3000" existing="" answer="" tty_input=""
  if [ "$PORT_EXPLICIT" -eq 0 ]; then
    existing="$(saved_port)"
    if [ -n "$existing" ]; then
      valid_port "$existing" || die "Invalid PORT in $INSTALL_DIR/.env. Fix it or supply --port."
      default="$existing"
    fi
    # A piped installer receives the script on stdin. Read its controlling TTY
    # instead, but do not block CI or unattended installs with no terminal.
    if [ -t 0 ]; then tty_input=/dev/stdin
    elif ( : </dev/tty ) 2>/dev/null; then tty_input=/dev/tty
    fi
    if [ -n "$tty_input" ]; then
      while :; do
        printf 'Web UI port [%s]: ' "$default" >&2
        IFS= read -r answer <"$tty_input" || die "Port selection cancelled."
        PORT="${answer:-$default}"
        valid_port "$PORT" && break
        warn "Enter a port from 1 to 65535."
      done
    else
      PORT="$default"
      echo "No interactive terminal; using web UI port $PORT (override with --port)."
    fi
  fi
  valid_port "$PORT" || die "Invalid web UI port '$PORT' (choose 1–65535)."
  PORT="$((10#$PORT))"
}

choose_port

# ---------------------------------------------------------------- privileges ---
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else die "Run as root or install sudo."; fi
fi

# -------------------------------------------------------------- install method ---
choose_method() {
  if [ -n "$FORCED_METHOD" ]; then MODE="$FORCED_METHOD"; return 0; fi
  # Detection uses the current user's Docker access, falling back to
  # non-interactive sudo (no password prompt). When Docker works, the
  # fastest fit is the prebuilt image; otherwise Node.js.
  local recommended="node"
  if have docker && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    recommended="prebuilt"
  elif have docker && command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
    recommended="prebuilt"
  fi
  local tty_input="" answer=""
  if [ -t 0 ]; then tty_input=/dev/stdin
  elif ( : </dev/tty ) 2>/dev/null; then tty_input=/dev/tty
  fi
  if [ -z "$tty_input" ]; then
    MODE="$recommended"
    echo "No interactive terminal; using install method $MODE (override with --build / --prebuilt / --node)."
    return 0
  fi
  while :; do
    printf 'Install method [%s] (build | prebuilt | node): ' "$recommended" >&2
    IFS= read -r answer <"$tty_input" || die "Method selection cancelled."
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$answer" ]; then MODE="$recommended"; return 0; fi
    case "$answer" in
      p|prebuilt|images|fastest) MODE="prebuilt"; return 0 ;;
      b|build) MODE="build"; return 0 ;;
      n|node|nodejs) MODE="node"; return 0 ;;
    esac
    warn "Choose build, prebuilt, or node."
  done
}

choose_method

echo "  port:        $PORT"
echo "  mode:        $MODE"
echo

# ------------------------------------------------------------- prerequisites ---
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
  if ! have docker; then
    warn "Docker not found — installing it (official convenience script)…"
    local installer
    installer="$(mktemp)"
    if ! curl -fsSL https://get.docker.com -o "$installer"; then
      rm -f "$installer"
      die "Could not download the Docker installer; no installation was attempted."
    fi
    if ! $SUDO sh "$installer" </dev/null; then
      rm -f "$installer"
      die "Docker installation failed. See https://docs.docker.com/engine/install/"
    fi
    rm -f "$installer"
    $SUDO systemctl enable --now docker 2>/dev/null || true
    have docker || die "Docker install failed. See https://docs.docker.com/engine/install/"
  fi
  if ! $SUDO docker info >/dev/null 2>&1; then
    die "Cannot access the Docker daemon. Start Docker and check permissions, then rerun (try: sudo docker info)."
  fi
  if $SUDO docker compose version >/dev/null 2>&1; then COMPOSE_KIND=v2
  elif have docker-compose && $SUDO docker-compose version >/dev/null 2>&1; then COMPOSE_KIND=v1
  else die "Docker Compose is missing. Install the Docker Compose plugin, then rerun."
  fi
  if [ "$MODE" = prebuilt ] && [ "$COMPOSE_KIND" = v1 ]; then
    die "--prebuilt requires Docker Compose v2; install the Compose plugin or omit --prebuilt to build locally."
  fi
  ok "Docker daemon and Compose are available"
}

confirm_existing_container() {
  local running answer tty_input=""
  running="$($SUDO docker inspect --format '{{.State.Running}}' sushi 2>/dev/null || true)"
  [ "$running" = "true" ] || return 0
  warn "A Sushi container is already running. Rebuilding or restarting it can terminate its active SSH terminals."
  [ "$ASSUME_YES" -eq 1 ] && return 0
  if [ -t 0 ]; then tty_input=/dev/stdin
  elif ( : </dev/tty ) 2>/dev/null; then tty_input=/dev/tty
  fi
  [ -n "$tty_input" ] || die "No terminal for confirmation. Finish important commands, then rerun with --yes to allow restart."
  printf 'Continue and potentially restart it? [y/N]: ' >&2
  IFS= read -r answer <"$tty_input" || die "Installation cancelled; the running container was not changed."
  case "$answer" in y|Y|yes|YES|Yes) ;; *) die "Installation cancelled; the running container was not changed." ;; esac
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
      local branch changes
      branch="$(git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || true)"
      changes="$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)"
      if [ "$branch" != main ] || [ -n "$changes" ]; then
        warn "Checkout is not a clean main branch; using it without pulling. Review it before upgrading."
      else
        ( cd "$INSTALL_DIR" && GIT_TERMINAL_PROMPT=0 git pull --ff-only </dev/null >/dev/null 2>&1 ) && ok "Updated the existing checkout" || warn "Could not git pull — continuing with the local copy"
      fi
    fi
    return 0
  fi
  bold "Downloading Sushi into $INSTALL_DIR…"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR" </dev/null; then ok "Source downloaded"; else die "git clone failed"; fi
}

write_env() {
  cd "$INSTALL_DIR"
  [ ! -L .env ] || die "Refusing to replace a symlinked .env; use a regular file instead."
  umask 077
  if [ ! -f .env ]; then
    [ -f .env.example ] && cp .env.example .env
    {
      echo ""
      echo "# generated by install-vps.sh"
      echo "SUSHI_AUTH_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      echo "PORT=$PORT"
    } >> .env
    chmod 600 .env
    ok "Wrote .env with a random SUSHI_AUTH_SECRET"
  else
    ok "Keeping your existing .env and credentials"
  fi
  # Update only PORT, leaving credentials and the data volume untouched. Remove
  # duplicate assignments so Compose uses the same port on later restarts.
  local tmp
  tmp="$(mktemp .env.port.XXXXXX)"
  if ! awk '
    !/^[[:space:]]*(export[[:space:]]+)?PORT[[:space:]]*=/ { print }
    END { print "PORT=" port }
  ' port="$PORT" .env > "$tmp"; then
    rm -f "$tmp"
    die "Could not update the port in .env."
  fi
  chmod 600 "$tmp"
  mv "$tmp" .env
}

wait_for_http() {
  local url="http://127.0.0.1:${PORT}/api/system/capabilities" waited=0 response=""
  bold "Waiting for Sushi to answer on port ${PORT} (up to ${WAIT_SECONDS}s)…"
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    # Check identifying capability fields, not just any 200 response on the port.
    if response="$(curl -fsS -m 5 "$url" 2>/dev/null)" &&
       printf '%s' "$response" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"vps"' &&
       printf '%s' "$response" | grep -Eq '"websocketSsh"[[:space:]]*:[[:space:]]*true'; then
      ok "Sushi is answering with WebSocket SSH available"
      return 0
    fi
    sleep 3; waited=$((waited + 3))
  done
  warn "Sushi did not answer with the expected capabilities. Check the Compose logs and port ${PORT}."
  return 1
}

setup_https() {
  [ -n "$HTTPS_DOMAIN" ] || return 0
  bold "Configuring Caddy for automatic HTTPS on $HTTPS_DOMAIN…"
  if ! have caddy && ! have apt-get; then die "Cannot configure Caddy automatically on this host. Install Caddy and configure HTTPS manually."; fi
  if ! have caddy; then
    $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq caddy
  fi
  local conf=/etc/caddy/Caddyfile
  if $SUDO grep -q "$HTTPS_DOMAIN" "$conf" 2>/dev/null; then warn "Caddy already has a block for $HTTPS_DOMAIN. Verify it proxies to 127.0.0.1:$PORT."; else
    printf '\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$HTTPS_DOMAIN" "$PORT" | $SUDO tee -a "$conf" >/dev/null
    ok "Added reverse_proxy for $HTTPS_DOMAIN → 127.0.0.1:$PORT"
  fi
  $SUDO systemctl reload caddy 2>/dev/null || $SUDO systemctl restart caddy
  ok "Caddy reloaded. Point DNS to this server and verify the HTTPS certificate and proxy."
}

install_systemd_service() {
  if ! have systemctl || ! systemctl show --property=Version >/dev/null 2>&1; then
    warn "systemd is unavailable; Docker's restart policy will start the containers when Docker starts."
    return 0
  fi
  bold "Installing a systemd service (start on boot, restart on crash)…"
  local compose_command compose_file=""
  if [ "$COMPOSE_KIND" = v2 ]; then compose_command="$(command -v docker) compose"
  else compose_command="$(command -v docker-compose)"
  fi
  [ "$MODE" = "prebuilt" ] && [ -f docker-compose.prebuilt.yml ] && compose_file="-f docker-compose.prebuilt.yml"
  $SUDO tee /etc/systemd/system/sushi.service >/dev/null <<UNIT
[Unit]
Description=Sushi (SSH/SFTP/RDP web workspace)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=$compose_command $compose_file up -d
ExecStop=$compose_command $compose_file down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  if $SUDO systemctl enable sushi.service >/dev/null 2>&1; then
    ok "systemd service installed (systemctl status sushi)"
  else
    warn "Could not enable sushi.service; check systemd. Docker restart policies remain configured."
  fi
}

run_compose() {
  if [ "$COMPOSE_KIND" = v2 ]; then
    if [ -n "$SUDO" ]; then $SUDO -E env PORT="$PORT" docker compose "$@" </dev/null
    else env PORT="$PORT" docker compose "$@" </dev/null
    fi
  else
    if [ -n "$SUDO" ]; then $SUDO -E env PORT="$PORT" docker-compose "$@" </dev/null
    else env PORT="$PORT" docker-compose "$@" </dev/null
    fi
  fi
}

# ------------------------------------------------------------------- install ---
case "$MODE" in
  build|prebuilt)
    ensure_git_and_curl
    install_docker
    confirm_existing_container
    ensure_source
    write_env
    if [ "$MODE" = "prebuilt" ]; then
      bold "Pulling the prebuilt image and starting Sushi + guacd…"
      if [ -f docker-compose.prebuilt.yml ]; then
        run_compose -f docker-compose.prebuilt.yml up -d || die "docker compose failed"
      else
        warn "docker-compose.prebuilt.yml missing — falling back to a local build"
        run_compose up -d --build || die "docker compose failed"
      fi
    else
      bold "Building and starting Sushi + Apache Guacamole (first build takes a few minutes)…"
      run_compose up -d --build || die "docker compose failed"
    fi
    wait_for_http || die "Sushi did not become healthy. Check the Docker Compose logs before retrying."
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
    wait_for_http || die "Sushi did not become healthy. Check $INSTALL_DIR/sushi.log."
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
echo "  Data:         Docker Compose volume 'sushi-data' (project-prefixed; or $INSTALL_DIR/data in Node mode) — back it up: auth.json + vault.enc.json"
echo
if [ "$MODE" = "node" ]; then
  echo "  Stop:   kill \$(cat $INSTALL_DIR/sushi.pid)"
  echo "  Logs:   tail -f $INSTALL_DIR/sushi.log"
else
  COMPOSE_FILE=""
  [ "$MODE" = "prebuilt" ] && [ -f "$INSTALL_DIR/docker-compose.prebuilt.yml" ] && COMPOSE_FILE="-f docker-compose.prebuilt.yml "
  COMPOSE_DISPLAY="docker compose"
  [ "$COMPOSE_KIND" = v1 ] && COMPOSE_DISPLAY="docker-compose"
  echo "  Stop:   cd $INSTALL_DIR && ${COMPOSE_DISPLAY} ${COMPOSE_FILE}down"
  echo "  Logs:   cd $INSTALL_DIR && ${COMPOSE_DISPLAY} ${COMPOSE_FILE}logs -f sushi"
fi
echo
if [ -z "$HTTPS_DOMAIN" ]; then
  printf '\033[33m  Next: open the URL and create the admin account immediately, then put HTTPS\n'
  printf '  in front of it (re-run with --https your.domain) before exposing it publicly.\033[0m\n'
fi
printf '\033[2m  Sushi is AI-assisted software provided "AS IS", without warranty. See DISCLAIMER.md.\033[0m\n'
