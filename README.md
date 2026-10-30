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
  - **Folder download as `.zip`**: pick any directory (or click **Download ZIP** for the folder you are in) and Sushi streams the whole tree — nested folders, dotfiles, binary files, empty folders and permissions — straight to your browser. No remote `zip`/`tar` binary and no shell needed, so it works on Vercel exactly like on a VPS.
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

### Folder download (SFTP → ZIP)

Clicking the folder icon in the **Actions** column downloads that folder as `<folder>.zip`; the
**Download ZIP** button in the toolbar archives the folder you are currently browsing.

- Works without a remote shell or `zip` binary: Sushi walks the tree over the SFTP subsystem and
  streams a standard ZIP (deflate, UNIX modes, UTF-8 names) as it reads, so nothing is written to
  disk on the server and no archive is held in memory server-side.
- Empty folders, dotfiles and file permissions (`0644`, `0755`, …) are preserved, so the extracted
  tree matches the server.
- Symlinks to files are included as regular files; symlinks to folders are skipped (counted in the
  confirmation message) so cyclic links cannot loop forever.
- Progress (bytes streamed + file count) is shown above the file list with a **Cancel** button.
- Limits on the serverless/browser path prevent runaway downloads: 20 000 files, 24 levels of
  nesting, and **300 MB on Vercel / 2 GB on a VPS**. On Vercel the function's 60 s response limit
  applies, so a folder that would stream for longer is rejected up front (a shorter, safe cut-off)
  instead of arriving as a truncated `.zip`. Anything larger should be pulled with `tar`/`rsync`
  over SSH, or from a self-hosted Sushi. Sushi reports exactly which limit was hit.
- Archiving a single file is rejected with a hint to download it directly — the file download
  button stays the right tool there.

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
| `vim`/`top`/`less`/`tmux` don't run on Vercel | Serverless SSH runs each command on its own, so full-screen programs are reported instead of hanging. Use a live PTY for them: self-hosted Sushi or **Attach VPS Gateway**. These work fine in the Vercel terminal: `cat`, `tail -n 100`, `sed -i`, `top -bn1`, `systemctl status`, `journalctl -n 50`, `git log`. |
| `su` says it needs the root password (Vercel) | `su` wants the *root account's* password. Use `sudo su` instead: Sushi asks for **your** sudo password (on NOPASSWD hosts it switches instantly). |
| `Download ZIP` fails with "is not a folder" | The path is a file or a symlink to a file — use the single-file download button (or open its folder and archive that). |
| `Download ZIP` fails with "contains more than 20 000 files" / "larger than 2.0 GB" / "nested deeper than 24 levels" | Sushi stopped a runaway archive before streaming it. Download a sub-folder, or `tar -czf` / `rsync` the tree over SSH. |

### Root access (`sudo su`) in the Vercel terminal

On Vercel each command is a separate SSH exec, so an interactive `su` prompt is impossible — Sushi
emulates it:

- `sudo su`, `sudo -i`, `sudo -s`, `sudo bash` → switch the session to **root mode**. The prompt turns
  into `root@host:/path#`, every following command runs through `sudo`, and `exit` goes back to your
  login user. On hosts with passwordless sudo (e.g. the default `ubuntu` user on Oracle/AWS/GCP
  images) this is instant; otherwise Sushi asks for your sudo password once and masks it (`****`).
- `sudo <command>` runs that one command elevated without entering root mode.
- The sudo password is kept in memory only for that terminal tab, is never written to the Vault,
  is never echoed into the terminal, and is dropped when you type `exit` or reconnect.
- On a self-hosted instance or through a VPS gateway (live PTY) `sudo su` is the real thing — Sushi
  does not intercept it.

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
