# Sushi

**Sushi** is a self-hosted and Vercel-ready web workspace for **SSH**, **SFTP**, and **RDP** remote infrastructure management.

It is designed around a **Hybrid VPS + Serverless Architecture**:
- **Self-Hosted on a VPS (Docker Compose or Node.js)**: Runs a unified HTTP + WebSocket server (`server.ts`) paired with Apache Guacamole's `guacd` daemon for full interactive `xterm.js` PTY SSH terminals, graphical SFTP file management + remote code editing, and live 60fps HTML5 Remote Desktop (RDP) sessions.
- **Deployed on Vercel (Serverless Node.js)**: Deploys directly to Vercel with zero database setup. Graphical **SFTP** file browsing/uploads/downloads/editing, **Serverless Streaming SSH** execution, and **MS-RDPBCGR X.224 / TLS / NLA** server probes work natively on Vercel Serverless Functions — and you can optionally link any VPS Gateway URL (`wss://...`) inside the UI to unlock persistent WebSocket PTY shells and live browser RDP streaming.

---

## Features

- **Username, Password, WebAuthn Passkey & Whitelisted Private Key Protection**
  - Interactive first-run Admin Setup directly in the browser on **both VPS and Vercel** (no manual env copy-paste required!), plus optional `SUSHI_AUTH_USERNAME` / `SUSHI_AUTH_PASSWORD` / `SUSHI_AUTHORIZED_KEYS` environment overrides
  - **Whitelisted Private Key Login & SSH Keychain**: Sign in to Sushi using an `ed25519` / `rsa` / `ecdsa` private key verified via cryptographic challenge signature against whitelisted public keys, and optionally enforce a strict **Vault SSH Key Whitelist** across all SSH/SFTP server connections
  - **FIDO2 / WebAuthn Passkeys** (`@simplewebauthn/server` & `@simplewebauthn/browser`) for Touch ID, Face ID, Windows Hello, and YubiKey
- **Termix File Import & Export (`Termix-SSH/Termix`)**
  - Seamless import from Termix Host Export (`.json`), Termix Share Export, Termix v2.0 User Data Export, and OpenSSH `~/.ssh/config` — plus 1-click export to Termix JSON (with or without secrets)
- **SSH Terminal (`@xterm/xterm` + `ssh2`)**
  - Live bidirectional **WebSocket PTY** (`/ws/ssh`) on VPS/Gateway (`vim`, `htop`, `tmux`, resize, 256-color ANSI)
  - Automatic **Serverless HTTP Streaming Shell** (`/api/ssh/exec`) fallback on Vercel with persistent working directory (`cd`), command history, and Ctrl+C cancellation
  - Password, keyboard-interactive (PAM), and PEM/OpenSSH Private Key (`Ed25519`, `RSA`, `ECDSA` + passphrase) authentication
  - SHA-256 host key fingerprint verification, quick command snippets, scrollback search, and terminal themes
- **SFTP File Manager (`/api/sftp/*`)**
  - Works identically on **Vercel Serverless** and **VPS**
  - Interactive breadcrumb navigation, drag-and-drop multi-file uploads, binary downloads, `mkdir`, rename, recursive delete, and an interactive Unix `chmod` permissions matrix
  - **Built-in Remote Code Editor** (`⌘S` / `Ctrl+S` direct save over SFTP)
- **RDP Remote Desktop (`guacamole-common-js` + `guacd` + X.224 Inspector)**
  - Live in-browser Windows & Linux `xrdp` desktop streaming via `/ws/rdp` -> `guacd` (`NLA / CredSSP`, `TLS`, `Standard RDP`)
  - Dynamic display scaling, fullscreen mode, clipboard sync, special key combos (`Ctrl+Alt+Del`, `Win`, `Ctrl+Shift+Esc`), and PNG screenshot capture
  - Native serverless **MS-RDPBCGR X.224 + TLS certificate inspector** (`/api/rdp/probe`) and one-click `.rdp` profile generator
- **AES-256-GCM Encrypted Credential Vault**
  - Client-side WebCrypto `AES-256-GCM` encryption (automatic device key or `PBKDF2-SHA256` Master Passphrase lock)
  - Portable encrypted JSON backup import/export + automatic `/data/vault.enc.json` sync when self-hosted on a VPS

---

## Quick Start

### 1. Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### 2. Self-Host on a VPS (Recommended for Full SSH + SFTP + Live RDP)

```bash
git clone https://github.com/sarakplaystore/sushi.git
cd sushi
cp .env.example .env
docker compose up -d --build
```

Or run the one-step VPS installer on Ubuntu/Debian:

```bash
bash scripts/install-vps.sh
```

`docker-compose.yml` launches both:
- `sushi` on port `3000` (Web UI + API + `/ws/ssh` + `/ws/rdp`)
- `guacd` (`guacamole/guacd:1.5.5`) on an internal bridge network for live RDP rendering

### 3. Deploy to Vercel (+ Optional Companion VPS Gateway)

1. Import `sarakplaystore/sushi` into **Vercel** (Framework Preset: **Next.js**, Node.js `22.x`) and deploy.
2. Out of the box on Vercel:
   - **SFTP File Manager & Remote File Editor** work natively.
   - **SSH Terminal** runs in Serverless Streaming PTY mode.
   - **RDP** runs live X.224/TLS/NLA diagnostics and exports `.rdp` launch files.
3. *(Optional)* To enable persistent WebSocket PTY shells and live browser RDP on your Vercel deployment, run a lightweight gateway on any VPS:
   ```bash
   docker compose up -d guacd
   SUSHI_GATEWAY_TOKEN="your-secret" ALLOWED_ORIGIN="https://your-app.vercel.app" npm run gateway
   ```
   Put Caddy/Nginx HTTPS in front of the VPS and enter `https://gw.yourdomain.com` + your token in **Gateway** inside the Sushi UI.

---

## Verification & Protocol Tests

```bash
npm run typecheck
npm test
npm run build
```
