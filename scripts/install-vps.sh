#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing Sushi (SSH, SFTP & RDP Self-Hosted Workspace)"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker not found. Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "==> Generated .env from .env.example (optional token ready if needed: $TOKEN)"
fi

echo "==> Building and starting Sushi + Apache Guacamole (guacd)..."
docker compose up -d --build

PORT_VAL="$(grep -E '^PORT=' .env | cut -d= -f2 || echo 3000)"
PORT_VAL="${PORT_VAL:-3000}"

echo ""
echo "Sushi is live on port ${PORT_VAL}!"
echo "  - Web UI & SFTP:  http://<your-vps-ip>:${PORT_VAL}"
echo "  - WebSocket SSH:  ws://<your-vps-ip>:${PORT_VAL}/ws/ssh"
echo "  - WebSocket RDP:  ws://<your-vps-ip>:${PORT_VAL}/ws/rdp (backed by guacd)"
echo ""
echo "Tip: Put Caddy or Nginx in front of port ${PORT_VAL} for automatic HTTPS & WSS."
