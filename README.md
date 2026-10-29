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
- **Termix Import & Export (`Termix-SSH/Termix`)**
  - **Termix SQLite database import**: drop in Termix's `db.sqlite` or its default encrypted-at-rest `db.sqlite.encrypted` (plus the legacy `.meta` two-file layout) to import hosts, SSH/RDP logins, credential-library keys, and command snippets
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

## Importing a Termix SQLite Database

1. Copy the database and its key file from your Termix server (Docker data dir `/app/data`):
   ```bash
   docker cp termix:/app/data/db.sqlite.encrypted .
   docker cp termix:/app/data/.env termix.env
   ```
2. In Sushi, open **Vault → Termix Import / Export**, drop `db.sqlite.encrypted`, and paste (or load) `termix.env`:
   - `DATABASE_KEY` decrypts the `db.sqlite.encrypted` file itself.
   - `ENCRYPTION_KEY` unwraps each Termix user's data key, decrypting saved passwords, private keys, key passphrases, and RDP logins.
   - Older **Termix 2.x** accounts whose data key is still wrapped by the account password can be unlocked by entering that Termix password.
3. Pick which Termix user to import (or all users), review the preview, then **Merge** or **Replace**. Re-importing skips hosts that already exist.

The database is parsed with SQLite compiled to WebAssembly (`sql.js`) and decrypted with WebCrypto **entirely in your browser** — the file, your Termix keys, and the decrypted secrets are never uploaded to the Sushi server, so there's no Vercel request-size limit either. Termix SSH and SFTP hosts become Sushi SSH/SFTP profiles, RDP logins (`host_protocol_auth` and legacy 2.8 `rdp_*` columns) become RDP profiles, credential-library private keys are added to the Vault SSH Key Whitelist (with `SHA256:` fingerprints), and jump-host/SOCKS5 settings are kept in host notes. VNC/Telnet-only hosts are skipped.

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

> **Plain `http://<vps-ip>:3000` works**, including SSH, SFTP, RDP, the encrypted vault and Termix import.
> Browsers disable WebCrypto (`crypto.subtle`, `crypto.randomUUID`) on non-HTTPS pages, so Sushi
> falls back to audited pure-JS AES-GCM / PBKDF2 / HKDF (`@noble/ciphers`, `@noble/hashes`) with
> byte-identical output. Vaults move freely between HTTP and HTTPS. For anything beyond a quick
> test, put Sushi behind HTTPS (Caddy / Nginx + a domain): over plain HTTP your Sushi login and the
> server passwords/keys you send travel unencrypted, and **passkeys only work on HTTPS** (or
> `http://localhost`). Sushi shows a dismissible notice when it is opened over plain HTTP.

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
   The token you enter must equal the gateway's `SUSHI_GATEWAY_TOKEN`. If it is missing or wrong, the
   terminal says so and falls back to serverless SSH. A full Sushi install (`docker compose`) can act
   as the gateway too, as long as `SUSHI_GATEWAY_TOKEN` is set in its `.env`.

---

## SSH Troubleshooting

| What you see | What it means / fix |
|---|---|
| `Could not reach host:22 (connection timed out)` | Wrong IP/port or a firewall. **Vercel cannot reach private / LAN / Tailscale addresses** (`192.168.x.x`, `10.x`, `100.64.x.x`): self-host Sushi on that network or attach a VPS gateway. |
| `Connection refused by host:port` | Nothing listens for SSH on that port. Check the port and that `sshd` is running. |
| `The connection … was reset before SSH finished connecting` | Firewall / network blocking outbound SSH, a fail2ban IP ban, or a non-SSH service on that port. |
| `Authentication failed … wrong username or password` | Or the server has `PasswordAuthentication no`. Use SSH key authentication. |
| `Authentication failed … the server rejected this private key` | Add the key's public half to `~/.ssh/authorized_keys` for that user. |
| `This private key is passphrase-protected` / `Incorrect passphrase` | Enter (or fix) the key passphrase in the host settings. |
| `vim`/`top`/`less`/`sudo` password prompts don't work on Vercel | Serverless SSH runs each command on its own and can't forward keystrokes. Use a live PTY: self-hosted Sushi or **Attach VPS Gateway**. Pagers (`systemctl`, `journalctl`, `git log`, `man`) are disabled automatically. |

Supported private keys: OpenSSH (`BEGIN OPENSSH PRIVATE KEY`, incl. passphrase-protected), PEM
(`BEGIN RSA/EC PRIVATE KEY`, incl. encrypted), **PKCS#8** (`BEGIN PRIVATE KEY` /
`BEGIN ENCRYPTED PRIVATE KEY`, converted automatically for RSA, ECDSA and Ed25519) and PuTTY `.ppk` v2 RSA keys
(for other `.ppk` keys use PuTTYgen → *Conversions → Export OpenSSH key*).
Keys mangled by copy & paste (CRLF, indentation, one-line keys, literal `\n`) are repaired automatically.

---

## Verification & Protocol Tests

```bash
npm run typecheck
npm test
npm run build
```
