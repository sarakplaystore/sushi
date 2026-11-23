#!/usr/bin/env bash
# Sushi — one-command installer for Linux (Ubuntu/Debian, Rocky/Alma, Fedora, Arch, Alpine)
#
#   curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh | bash
#
#   # The installer asks for the install method (prebuilt Docker is recommended),
#   # the web UI port (default: 3000) and, optionally, a domain for HTTPS.
#   # It prints the server's public IP link (http://<ip>:<port>) when it can
#   # detect it, so you can open Sushi right away.
#   # For unattended installs, pass explicit flags:
#   curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh | bash -s -- --prebuilt --port 8080
#
#   # or from a checkout, with options:
#   bash scripts/install-vps.sh --port 8080
#   bash scripts/install-vps.sh --yes                           # non-interactive restart
#   bash scripts/install-vps.sh --https sushi.example.com      # + Caddy & automatic HTTPS
#   bash scripts/install-vps.sh --domain sushi.example.com     # same as --https
#   bash scripts/install-vps.sh --no-domain                     # skip the domain prompt
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
SKIP_DOMAIN_PROMPT=0 # --no-domain: never ask for a domain
PUBLIC_ADDR=""        # this server's public IPv4, when it can be detected
PUBLIC_ADDR_PRIVATE=0 # 1 when the address we found is only local/private
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
  --https DOMAIN    Configure Caddy for HTTPS on DOMAIN (alias: --domain)
  --domain DOMAIN   Same as --https
  --no-domain       Skip the optional "domain for HTTPS" prompt
  --timeout SECONDS Time to wait for health (default 180)
  -h, --help        Show this help
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die "--port requires a value"; PORT="$2"; PORT_EXPLICIT=1; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir requires a value"; INSTALL_DIR="$2"; shift 2 ;;
    --https|--domain) [ $# -ge 2 ] || die "$1 requires a value"; HTTPS_DOMAIN="$2"; shift 2 ;;
    --no-domain) SKIP_DOMAIN_PROMPT=1; shift ;;
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
    echo "No interactive terminal; using install method $MODE. Options: 1) prebuilt, 2) build, 3) node (override with --build / --prebuilt / --node)."
    return 0
  fi
  while :; do
    printf 'Install method [%s] — enter a number or name:\n  1) Docker prebuilt image (recommended)\n  2) Docker build from source\n  3) Node.js install\nSelection: ' "$recommended" >&2
    IFS= read -r answer <"$tty_input" || die "Method selection cancelled."
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$answer" ]; then MODE="$recommended"; return 0; fi
    case "$answer" in
      1|p|prebuilt|images|fastest) MODE="prebuilt"; return 0 ;;
      2|b|build) MODE="build"; return 0 ;;
      3|n|node|nodejs) MODE="node"; return 0 ;;
    esac
    warn "Choose 1 (prebuilt), 2 (build), or 3 (node)."
  done
}

choose_method

# --------------------------------------------------------------- addressing ---
# Sushi is usually opened by IP before a domain exists, so the summary shows a
# real link instead of a placeholder whenever the address can be detected.
is_ipv4() {
  local ip="$1" octet IFS=.
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  for octet in $ip; do
    [ "$((10#$octet))" -le 255 ] || return 1
  done
  return 0
}

is_private_ipv4() {
  case "$1" in
    10.*|127.*|0.*|169.254.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.[6-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;; # CGNAT
  esac
  return 1
}

# Prints the public IPv4 of this host, or nothing when it cannot be determined.
# Order: explicit SUSHI_PUBLIC_IP, public lookup, then the host's own address
# (which is public on many VPSes and private behind cloud NAT).
detect_public_ip() {
  local ip="" endpoint
  if [ -n "${SUSHI_PUBLIC_IP:-}" ]; then
    if is_ipv4 "$SUSHI_PUBLIC_IP"; then
      printf '%s' "$SUSHI_PUBLIC_IP"
      return 0
    fi
    printf 'Ignoring SUSHI_PUBLIC_IP=%s (not an IPv4 address); detecting it instead.\n' \
      "$SUSHI_PUBLIC_IP" >&2
  fi
  if have curl; then
    for endpoint in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
      ip="$(curl -fsS -m 4 "$endpoint" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_ipv4 "$ip"; then printf '%s' "$ip"; return 0; fi
    done
  fi
  if have ip; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
  fi
  if ! is_ipv4 "$ip" && have hostname; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if is_ipv4 "$ip"; then printf '%s' "$ip"; fi
  return 0
}

resolve_public_addr() {
  PUBLIC_ADDR="$(detect_public_ip)"
  PUBLIC_ADDR_PRIVATE=0
  if [ -n "$PUBLIC_ADDR" ] && is_private_ipv4 "$PUBLIC_ADDR"; then
    PUBLIC_ADDR_PRIVATE=1
  fi
}

# Accept "example.com", "https://example.com/", "example.com:8443" and the like.
normalize_domain() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  value="${value%%:*}"
  printf '%s' "$value"
}

valid_domain() {
  local d="$1"
  [ -n "$d" ] && [ "${#d}" -le 253 ] || return 1
  [[ "$d" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

# Hints (never blocks) whether DNS already points the domain at this server.
check_domain_dns() {
  local domain="$1" expected="$2" resolved=""
  [ -n "$expected" ] && [ "$PUBLIC_ADDR_PRIVATE" -eq 0 ] || return 0
  have getent || return 0
  if have timeout; then
    resolved="$(timeout 4 getent ahostsv4 "$domain" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
  else
    resolved="$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
  fi
  if [ -z "$resolved" ]; then
    warn "DNS: $domain does not resolve yet — add an A record pointing to $expected for the HTTPS certificate."
  elif [ "$resolved" != "$expected" ]; then
    warn "DNS: $domain resolves to $resolved, not $expected. Fix the A record if Caddy cannot get a certificate."
  else
    ok "DNS: $domain points at $expected"
  fi
}

# Optional domain prompt. Pressing Enter (or having no terminal) skips HTTPS and
# leaves Sushi on its plain http://<ip>:<port> URL.
ask_domain() {
  [ -z "$HTTPS_DOMAIN" ] || return 0
  [ "$SKIP_DOMAIN_PROMPT" -eq 0 ] || return 0
  local tty_input="" answer="" domain=""
  if [ -t 0 ]; then tty_input=/dev/stdin
  elif ( : </dev/tty ) 2>/dev/null; then tty_input=/dev/tty
  fi
  [ -n "$tty_input" ] || return 0
  while :; do
    printf 'Domain for HTTPS (optional, Enter to skip): ' >&2
    IFS= read -r answer <"$tty_input" || return 0
    domain="$(normalize_domain "$answer")"
    [ -n "$domain" ] || return 0
    if valid_domain "$domain"; then
      HTTPS_DOMAIN="$domain"
      break
    fi
    warn "Enter a domain like sushi.example.com, or press Enter to skip HTTPS."
  done
  if [ -n "$PUBLIC_ADDR" ] && [ "$PUBLIC_ADDR_PRIVATE" -eq 0 ]; then
    echo "  IP link:     http://$PUBLIC_ADDR:$PORT" >&2
  fi
}

resolve_public_addr
if [ -n "$HTTPS_DOMAIN" ]; then
  SUPPLIED_DOMAIN="$HTTPS_DOMAIN"
  HTTPS_DOMAIN="$(normalize_domain "$SUPPLIED_DOMAIN")"
  valid_domain "$HTTPS_DOMAIN" ||
    die "Invalid domain '$SUPPLIED_DOMAIN' (use something like sushi.example.com)."
fi
ask_domain

echo "  port:        $PORT"
echo "  mode:        $MODE"
if [ -n "$PUBLIC_ADDR" ]; then
  if [ "$PUBLIC_ADDR_PRIVATE" -eq 0 ]; then
    echo "  address:     http://$PUBLIC_ADDR:$PORT"
  else
    echo "  address:     http://$PUBLIC_ADDR:$PORT (local/private — use your provider's public IP)"
  fi
else
  echo "  address:     http://<your-vps-ip>:$PORT (public IP could not be detected)"
fi
[ -n "$HTTPS_DOMAIN" ] && echo "  HTTPS:       https://$HTTPS_DOMAIN"
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
    [ "$major" -ge 22 ] && { ok "Node.js $(node -v)"; return 0; }
    warn "Node.js $(node -v) is too old for Sushi (needs Node.js 22+)."
    local tty_input="" answer=""
    if [ -t 0 ]; then tty_input=/dev/stdin
    elif ( : </dev/tty ) 2>/dev/null; then tty_input=/dev/tty
    fi
    [ -n "$tty_input" ] || die "Node.js upgrade requires confirmation. Rerun in a terminal or install Node.js 22 manually."
    printf 'Upgrade Node.js to version 22 now? [y/N]: ' >&2
    IFS= read -r answer <"$tty_input" || die "Node.js upgrade cancelled."
    case "$answer" in
      y|Y|yes|YES|Yes) ;;
      *) die "Node.js upgrade declined; Sushi was not installed." ;;
    esac
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
  [ -n "$PUBLIC_ADDR" ] || resolve_public_addr
  check_domain_dns "$HTTPS_DOMAIN" "$PUBLIC_ADDR"
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
  ok "Caddy reloaded. Point DNS to this server, allow inbound TCP 80 and 443, then verify the certificate."
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
# curl may only have been installed during the build; try the public lookup again.
[ -n "$PUBLIC_ADDR" ] || resolve_public_addr
SHOWN_HOST="localhost"
# The IP link is always the direct way in; HTTPS (when configured) is on top.
# A private address is not reachable from outside, so it is not offered as a URL.
if [ -n "$PUBLIC_ADDR" ] && [ "$PUBLIC_ADDR_PRIVATE" -eq 0 ]; then
  IP_URL="http://${PUBLIC_ADDR}:${PORT}"
else
  IP_URL="http://<your-vps-ip>:${PORT}"
fi

echo
if [ -n "$HTTPS_DOMAIN" ]; then
  printf '\033[1;32m  Sushi is up!  https://%s\033[0m\n' "$HTTPS_DOMAIN"
  echo "  VPS IP link:  ${IP_URL}  (direct, plain HTTP)"
else
  printf '\033[1;32m  Sushi is up!  %s\033[0m\n' "$IP_URL"
fi
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
  if [ "$PUBLIC_ADDR_PRIVATE" -eq 1 ]; then
    echo "  Note: this host's own address is http://${PUBLIC_ADDR}:${PORT} (private, it is behind NAT);"
    echo "        open your provider's public IP instead."
  fi
  printf '\033[33m  Next: open the link above and create the admin account immediately, then put HTTPS\n'
  printf '  in front of it (re-run with --https your.domain) before exposing it publicly.\033[0m\n'
fi
printf '\033[2m  Sushi is AI-assisted software provided "AS IS", without warranty. See DISCLAIMER.md.\033[0m\n'
