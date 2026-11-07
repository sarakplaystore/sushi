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
- **SSH Client Import & Export**
  - Import OpenSSH config, Termius-compatible CSV, PuTTY registry exports, MobaXterm, WinSCP, Tabby, Xshell, SecureCRT sessions, mRemoteNG connections, SSHBorg and 7 Term backups, and simple SSH-host JSON, plus Termix (`Termix-SSH/Termix`) JSON and SQLite databases
  - Select files or supported ZIPs from the device or iCloud Drive, review warnings, then merge or replace hosts. Export to Termix JSON with or without secrets.
- **SSH Terminal (`@xterm/xterm` + `ssh2`)**
  - Live bidirectional **WebSocket PTY** (`/ws/ssh`) on VPS/Gateway (`vim`, `htop`, `tmux`, resize, 256-color ANSI)
  - Automatic **Serverless HTTP Streaming Shell** (`/api/ssh/exec`) fallback on Vercel with persistent working directory (`cd`), command history, and Ctrl+C cancellation
  - **Keystroke channel for the serverless shell**: every command gets a private keystroke FIFO on the host, so `[Y/n]` prompts, passwords and full-screen `whiptail`/`debconf`/`ncurses` menus (`Configuring lightdm`, `tasksel`, `nmtui`) are answerable in any browser — with a menu bar that shows the box's real choices and buttons
  - Password, keyboard-interactive (PAM), and PEM/OpenSSH Private Key (`Ed25519`, `RSA`, `ECDSA` + passphrase) authentication
  - **Distro & cloud badge on connect**: the header names the machine you are on — `Ubuntu 24.04.1 LTS · Oracle Cloud`, `Debian 12 · KVM VPS`, `Rocky Linux 9.4 · AWS EC2` — read in one non-root exec (`/etc/os-release`, cloud-init's `cloud-id`, DMI strings) and cached for five minutes; the **Test SSH Auth** card in *New Connection* shows the same OS, hosting platform and vCPU/RAM before you connect
  - SHA-256 host key fingerprint verification, quick command snippets, scrollback search, and terminal themes
  - **Translate selected text**: highlight any text in the terminal and hit the **Translate** button — the translation appears in a panel above the terminal (Chinese by default, 14 target languages, remembered per browser). Translates through Sushi's own `/api/translate` (see *Translating text* below)
- **SFTP File Manager (`/api/sftp/*`)**
  - Works identically on **Vercel Serverless** and **VPS**
  - Interactive breadcrumb navigation, drag-and-drop multi-file uploads, binary downloads, `mkdir`, rename, recursive delete, and an interactive Unix `chmod` permissions matrix
  - **Folder download as `.zip`**: pick any directory (or click **Download ZIP** for the folder you are in) and Sushi streams the whole tree — nested folders, dotfiles, binary files, empty folders and permissions — straight to your browser. No remote `zip`/`tar` binary and no shell needed, so it works on Vercel exactly like on a VPS.
  - **Multi-select download**: check any mix of files and folders (checkbox, ⌘/Ctrl-click, Shift-click, or the select-all box) and **Download** puts exactly those items into one archive, each kept under its own name.
  - **Built-in Remote Code Editor** (`⌘S` / `Ctrl+S` direct save over SFTP)
- **RDP Remote Desktop (`guacamole-common-js` + `guacd` + X.224 Inspector)**
  - Live in-browser Windows & Linux `xrdp` desktop streaming via `/ws/rdp` -> `guacd` (`NLA / CredSSP`, `TLS`, `Standard RDP`)
  - **Fit-to-window resolution** (the desktop follows the pane instead of being scaled), keyboard capture with a `Ctrl+Alt+Shift` release, and **three picture presets** — Best / Balanced / Fast — that trade wallpaper, themes, font smoothing and colour depth for bandwidth
  - **Two-way clipboard that just works**: `Ctrl+V` inside the desktop pastes your local clipboard (no dialog), and text copied in the desktop is copied back to your machine — the clipboard panel also has a **Translate** button for the remote clipboard text
  - **Drag & drop uploads** into a redirected drive, plus a fullscreen mode, special key combos (`Ctrl+Alt+Del`, `Win`, `Ctrl+Shift+Esc`) and PNG screenshot capture
  - **Automatic reconnect** when the desktop drops (network blip, `guacd` restart, RDP server reboot) with backoff and a visible countdown; a wrong password is not retried in a loop
  - **View only** mode for watching someone else's screen without stealing their keyboard, and human error messages for every Guacamole status code
  - Native serverless **MS-RDPBCGR X.224 + TLS certificate inspector** (`/api/rdp/probe`) and one-click `.rdp` profile generator
  - **Open via RDP from anywhere**: a desktop button on every SSH/SFTP host row and host card, plus **Open RDP** in the terminal header and **RDP** in the file manager toolbar — the same host, reached as a desktop on port 3389, no duplicate host needed (see *Open a host's desktop over RDP*).
- **AES-256-GCM Encrypted Credential Vault**
  - Client-side WebCrypto `AES-256-GCM` encryption (automatic device key or `PBKDF2-SHA256` Master Passphrase lock)
  - Passphrase-encrypted portable JSON backups (including files stored in iCloud Drive) + automatic `/data/vault.enc.json` sync when self-hosted on a VPS

---

## Add Sushi to an iPhone or iPad Home Screen

1. Open your Sushi URL over **HTTPS** in Safari, tap **Share**, and choose
   **Add to Home Screen**. Confirm the name and tap **Add**. Sushi has a dedicated
   Home Screen icon and opens as a standalone web app.
2. Use the navigation button at the top left to access saved hosts and settings
   on a phone. Sessions still require a network connection; installing the icon
   does not make SSH, SFTP, or RDP work offline.

The Home Screen app may have separate login and browser storage from Safari,
including the local device key used to encrypt a device-key vault. You may need
to sign in again, unlock a synced master-passphrase vault, or restore a portable
backup. **Before switching, create and verify a passphrase-protected portable
backup in the original browser** (see below); do not reset an unreadable vault
until you have a working backup. The icon does not automatically sync vaults or
keys between Safari and the installed app.

---

## Importing SSH clients and iCloud Drive files

Open **Import / Export** on the dashboard or in the sidebar. Choose files, or on
an iPhone/iPad use the Files picker and select **Browse → iCloud Drive**. Files
are parsed locally in the browser; no Apple account or SSH client account is
connected and the original files are not uploaded. Review the preview and its
warnings before **Merge into Sushi** or **Replace Existing Hosts**. Merge skips
matching profiles; Replace asks for confirmation and replaces hosts only, while
keeping existing keys and snippets.

| Source | Supported file / data |
| --- | --- |
| OpenSSH | `~/.ssh/config`: literal host aliases, HostName, User, Port, and matching `Host` defaults. |
| Termius-compatible or generic CSV | Header such as `Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password`; headerless `Name,Address,Username` CSV also works. Quoted fields and newlines are supported. |
| PuTTY | Export `HKCU\Software\SimonTatham\PuTTY\Sessions` with `reg export` to a `.reg` file (UTF-16 or UTF-8). |
| MobaXterm | `.mxtsessions`, `.moba`, or `MobaXterm.ini` bookmark sections. |
| WinSCP | `WinSCP.ini` SFTP or SCP session sections. SCP-only entries become SSH profiles; Sushi's file browser needs SFTP. |
| Tabby | Unencrypted `config.yaml` SSH profiles and `profileDefaults.ssh`. |
| Xshell | `.xsh` SSH/SFTP session files (select multiple files together). |
| SecureCRT | Per-session typed `.ini` files, or **Tools → Export Settings → Sessions** XML (SSH2 sessions only). Folder names, usernames, ports, and key-file references are imported; stored passwords and global settings are not. |
| mRemoteNG | Plaintext connection-settings XML, such as `confCons.xml` (SSH2 and RDP only), including supported folder inheritance. Full-file encrypted XML must first be opened and exported without full-file encryption in mRemoteNG. Encrypted passwords and PuTTY session settings are not imported. |
| SSHBorg for iOS / Android | Host-backup JSON (`hosts`, `groups`, `exported_at`). Backups omit credentials and host keys; key labels, jumps and forwards need manual attention. |
| 7 Term for macOS | Version 1 `7term-backup.json`; SSH hosts only. Keychain passwords and private key contents are omitted; serial profiles are skipped. |
| Termix | Host/Share JSON, v2 user data JSON, and the Termix SQLite database described below. This is **Termix-SSH/Termix**, not an unrelated iOS app with the same name. |
| Simple JSON | An array, or an object with a `hosts`, `connections`, or `servers` array. Supported fields include name/label, host/hostname/address/ip, port, user/username, protocol, password, privateKey, passphrase, group, tags and notes. |
| ZIP | Unencrypted ZIP containing supported exports; choose it directly from iCloud Drive or locally. Import limits are 50 MB combined input and expanded output, 200 archive entries, and 100 supported files; text files are limited to 10 MB. Nested/encrypted archives are not opened. |

For example, a CSV can be:

```csv
Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password
Production,Web 1,"web,prod",192.0.2.10,ssh,2222,deploy,"example password"
```

Embedded plaintext private keys are added to the keychain. **File paths are not
private keys**: browsers cannot read `IdentityFile`, `.ppk` paths, SSH agents or
other apps' keychains. You can select actual private key files alongside an
export (or include them in the selected ZIP); uniquely matching filenames are
linked to the host. Ambiguous or missing matches must be selected manually in
the host editor. If an imported key is passphrase-protected, enter its passphrase
in the host editor. PuTTY, MobaXterm, WinSCP, Xshell, Tabby, SecureCRT, and
mRemoteNG do not provide portable plaintext passwords in the supported exports;
re-enter the missing secrets. mRemoteNG's PuTTY sessions can contain keys or
proxy settings, so review SSH routes and authentication even for its default
session. Imported mRemoteNG RDP profiles do not ignore TLS certificate errors
and start with Sushi's file-transfer drive disabled; change these in the host
editor if needed.
XML imports reject DTDs and entity definitions and have bounded nesting
and complexity. Secrets marked encrypted, or using an `enc:`, `encrypted:`,
`vault://`, or `keychain://` prefix, are not imported as plaintext; re-enter them
if a legitimate password uses one of those prefixes. Proxy/jump hosts, tunnels, agent forwarding,
commands, host-key trust and unsupported protocols are not migrated; the preview
reports affected entries. Recheck each
host and verify its server fingerprint before connecting. OpenSSH `Include`
files and `Match` rules are not evaluated.

**iCloud Drive is not the same as an iCloud device backup.** Sushi can import a
supported file that you explicitly choose from Files/iCloud Drive, but it cannot
sign in to iCloud, access iCloud Keychain, or decrypt an iPhone/iPad device backup
or a third-party app's proprietary encrypted backup. Restore the original app on
an Apple device first and export a supported format from it; ask that app's
developer for its export options. Not every SSH client has a portable export.

### Save or restore a portable Sushi backup

1. Open **Vault Encryption**. Under **Portable Encrypted Sushi Backup**, enter
   and confirm a backup passphrase, then choose **Download Portable Backup**.
   This creates a separate AES-256-GCM / PBKDF2-encrypted `.enc.json` and does
   **not** change the current vault password. Keep the passphrase separately.
2. Save or move that file to iCloud Drive using your browser/Files app (or any
   other storage you choose). This is a manual backup, not automatic iCloud sync.
3. On the new device, select the file using **Import / Export** or **Choose
   Backup to Restore**, enter its passphrase, and confirm replacement of the
   current vault. The restored contents are re-encrypted using that device's
   current vault protection.

Old backups exported in **device-key mode** can only be decrypted in the
original browser with the same device key: the device key was never included in those files. Create a new
passphrase-protected portable backup there before changing devices.

---

## Importing a Termix SQLite Database

1. Copy the database and its key file from your Termix server (Docker data dir `/app/data`):
   ```bash
   docker cp termix:/app/data/db.sqlite.encrypted .
   docker cp termix:/app/data/.env termix.env
   ```
2. In Sushi, open **Vault → Import / Export**, drop `db.sqlite.encrypted`, and paste (or load) `termix.env`:
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

### Open a host's desktop over RDP

Any host saved for SSH or SFTP can be opened as an RDP desktop with one click — the Vault keeps a
single profile per machine:

- **host row** in the sidebar → the coral monitor icon (always visible);
- **host card** on the dashboard → the **RDP** button next to *SFTP* / *SSH*;
- **inside a session** → **Open RDP** in the SSH terminal header, **RDP** in the file manager toolbar.

What gets connected:

- the same address, username and password, on **port 3389** (`rdp://user@host:3389`) — an SSH host on
  a custom port is not asked to speak RDP on that port;
- RDP options the profile already has (domain, security mode, resolution, ignore-certificate) are
  kept, and SSH key material is **never** sent to the RDP bridge;
- clicking the button again focuses the desktop tab that is already open for that host.

Desktop logins are often a different account than the SSH login (`Administrator`, a domain user, or
the Linux user signed in to `xrdp`). **Credentials** in the RDP session header opens the connection
dialog prefilled for this server: fix the username / domain / port / password there and connect
ephemeral, or save it — saving creates a separate RDP host and leaves the SSH entry untouched.

Live pixels need `guacd` (self-hosted `docker compose`) or an attached VPS gateway; without one the
tab still gives you the X.224/TLS/NLA probe and a native `.rdp` launcher.

### Getting the most out of the RDP desktop

Once the pixels are flowing, the toolbar and the **settings** (sliders icon) control how the session
behaves. Everything below except fit/fullscreen/screenshot is sent to `guacd` at connect time, so
changing it reconnects the stream (a note appears while it does):

| Control | What it does |
|---|---|
| **Fit window** (arrows icon) | Asks the RDP server for exactly the pane's size (`resize-method: display-update`), so text is pixel-crisp instead of scaled. Toggling it off keeps the host's fixed resolution and scales it. Resizes smaller than ~12 px are ignored so the desktop cannot oscillate. |
| **Best / Balanced / Fast** | Picture presets: *Best* = wallpaper + themes + font smoothing + 32-bit + lossless; *Balanced* (default) = themes and smoothing, no wallpaper, 24-bit; *Fast* = 16-bit, no themes, no smoothing — the choice for a slow VPS link or a phone hotspot. |
| **Desktop audio** | Plays the remote's sounds in the browser (Web Audio is unlocked by your first click). Turn it off on a metered link; no audio stream is then requested at all. |
| **View only** | Stops sending keyboard and mouse — useful for watching a colleague's screen or for a machine you only need to look at. A `View only` chip appears in the toolbar while it is on. |
| **File uploads** | Redirects a drive named `Sushi` into the session. Drop files anywhere on the desktop (or use **Upload**) and they are copied to it; the remote sees them on that drive. |
| **Keyboard capture** | Keys reach the desktop only after you click into it, so typing in the sidebar, the search box or the clipboard panel never leaks into the remote. Press **Ctrl+Alt+Shift** (or click the chip) to hand the keyboard back to the browser — the modifiers are released properly, so the remote never gets stuck with Ctrl held. |
| **Clipboard** | `Ctrl+V` inside the desktop pastes your local clipboard; text copied in the desktop is copied back to your machine automatically (Chrome/Edge; elsewhere use the Clipboard panel). |
| **Auto-reconnect** | A dropped session (network blip, `guacd` restart, RDP reboot) is rebuilt with 1 s → 2 s → 4 s … backoff (max 5 attempts) and a countdown; **Retry now** skips the wait. Authentication failures (`the remote refused the login`) are shown once instead of being retried forever. |

Each failure is translated instead of dumped as a number: `guacd could not reach the host on port
3389`, `the remote refused the login — check the account, domain and NLA`, `this account is already
using the desktop with different settings`, `your Sushi session is no longer valid — sign in again`.

### Which Ubuntu (or Debian, Rocky, …) version is this host?

As soon as an SSH session connects, the header shows a badge next to `user@host:port` with the remote
distro and version and, where Sushi can tell, the cloud the machine runs on:

| Badge | Means |
|---|---|
| `Ubuntu 24.04.1 LTS · Oracle Cloud` | Oracle Cloud instance (cloud-init `oraclecloud`, or `OracleCloud.com` in the DMI data) |
| `Ubuntu 22.04.5 LTS · AWS EC2` | Amazon EC2 |
| `Debian 12 · KVM VPS` | A plain KVM/QEMU VPS without a cloud identity |
| `Rocky Linux 9.4 (Blue Onyx) · Hetzner Cloud` | Hetzner, any distro |
| `Ubuntu 24.04.1 LTS · VMware` / `· Docker container` | Virtualised, but not on a named cloud |

Hover the badge for kernel/arch, codename, vCPU + RAM and uptime. It is read by
`/api/ssh/sysinfo`, which runs a single `KEY=value` exec as your **login user** — no root, no extra
packages, no outbound network from the host:

- `/etc/os-release` → `PRETTY_NAME`, `VERSION_ID`, `VERSION_CODENAME` (so Ubuntu reports `LTS` and the
  release number exactly as `lsb_release -a` would);
- `/run/cloud-init/cloud-id` → the provider that booted the image;
- `/sys/class/dmi/id/*` → `sys_vendor` / `product_name` / `board_vendor` for images without cloud-init;
- `systemd-detect-virt`, `uname -sr`, `nproc`, `/proc/meminfo`, `/proc/loadavg`.

Recognised clouds: Oracle Cloud, AWS EC2, Google Cloud, Microsoft Azure, DigitalOcean, Hetzner,
Akamai/Linode, Vultr, Scaleway, OVHcloud, UpCloud, Contabo, netcup, Alibaba, Tencent, Huawei, IBM
Cloud, Rackspace, Equinix Metal and OpenStack; anything else still shows its hypervisor (`KVM VPS`,
`VMware`, `Hyper-V`, `Xen`, `LXC`…) or its cloud-init datasource id.

The same probe powers **Test SSH Auth** in *New Connection* (`Remote OS`, `Hosted on`, `Machine`), so
you can confirm you opened the Ubuntu 22.04 box and not the 24.04 one *before* saving the host. If a
host's shell is restricted (no `/etc/os-release`, a jailed `rbash`), the badge simply stays hidden and
connecting still works.

### Downloading files and folders (SFTP → ZIP)

**Select what you want, then download it.** Every row has a checkbox and the header checkbox selects
everything in the current folder. Clicking a row selects it too: plain click replaces the selection,
⌘/Ctrl-click toggles one row, Shift-click extends the range. The bar above the list shows the
selection (how many files and folders, total size) with a **Download** button and **Clear**.

- **Download** on a selection: one file is fetched as the file itself, while a folder — or any mix of
  files and folders — becomes a single archive named `<item>.zip` (one folder) or
  `<current-folder>-selection.zip` (several items). Each selected item keeps its own name inside the
  archive, so `app/` and `single.txt` sit side by side when you unzip it.
- The selection is kept when the directory is refreshed and pruned when an item disappears; opening
  another folder clears it.
- **Right-click** a row that is part of a multi-selection → *Download N selected items (.zip)*.

**One folder at a time** — three ways to get a folder off the server:

- **ZIP** button on the folder's row (Actions column) — downloads that folder as `<folder>.zip`.
- **Right-click a row** → *Download folder (.zip)* (or *Download file* for files; the menu also has
  open/edit, copy path, rename, permissions and delete).
- **Download ZIP** in the toolbar — archives the folder you are currently browsing.

In Chromium browsers Sushi asks where to save the archive first and then writes it straight to disk as
it streams in, so even a multi-GB folder is never held in the tab's memory. Everywhere else (Safari,
Firefox, or if you dismiss the dialog with Esc → nothing is downloaded) it uses a normal browser
download.

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
- Archiving a single file on its own is rejected with a hint to download it directly — the file
  download button stays the right tool there. (It is fine inside a multi-item selection.)
- A selection is capped at 500 items per request so one click cannot queue an unbounded walk.

---

## Command speed (`SUSHI_SSH_POOL`)

On Vercel every keystroke runs as its own request, and a request used to open a brand-new SSH
connection: TCP, key exchange, authentication — five or six round trips to the host *before*
the command started. Measured against a host 60 ms away, one command took **~505 ms**; the
command itself was a few milliseconds.

Sushi now keeps the connection open for the next command:

- the terminal's first probe opens the connection, and every command after it opens only a new
  channel on that connection (no handshake, no new TCP connection);
- key presses reach the running command over the same connection, so typing into a
  whiptail/debconf menu is no longer one SSH handshake per key;
- the distro badge (`Ubuntu 24.04.1 LTS · Oracle Cloud`) rides on it too, so the header no longer
  opens a second connection while the shell is starting;
- connections are per host + user + credentials (never shared between different logins), closed
  after 90 s idle, recycled after 10 minutes, capped at 8 per instance, and kept alive with SSH
  keepalives. A connection that died is dropped, and the command is retried once on a fresh one
  (the command never started, so nothing runs twice);
- the SSH socket is put in `TCP_NODELAY` mode: with Nagle enabled, each small write waited for the
  previous one to be acknowledged, adding a delayed-ACK stall to every round trip.

Same test after the change: **~195 ms** per command (2.6× faster; on a host 150 ms away the saving
is proportionally larger, since a handshake is RTT-bound).

| Setting | Default | Meaning |
|---|---|---|
| `SUSHI_SSH_POOL` | on | `off` disables reuse — every request opens and closes its own connection. |
| `SUSHI_SSH_POOL_IDLE_MS` | `90000` | How long an idle connection is kept for the next command. |
| `SUSHI_SSH_POOL_MAX` | `8` | Idle connections kept per server instance. |
| `SUSHI_SSH_POOL_MAX_AGE_MS` | `600000` | Hard limit on a connection's lifetime. |

Running on Vercel: each warm function instance keeps its own pool, so the first command of an
instance still pays for the handshake and the rest reuse it. A self-hosted instance (or a VPS
gateway) keeps the connection warm for the whole session.

## SSH Troubleshooting

| What you see | What it means / fix |
|---|---|
| `Could not reach host:22 (connection timed out)` | Wrong IP/port or a firewall. **Vercel cannot reach private / LAN / Tailscale addresses** (`192.168.x.x`, `10.x`, `100.64.x.x`): self-host Sushi on that network or attach a VPS gateway. |
| The terminal shows only `Could not reach …` with a **Reconnect** button — no shell prompt | Expected. The SSH handshake never completed, so nothing ran and there is no shell to type into: Sushi shows the one sentence, offers **Reconnect**, and retries on its own every **10 s** (a countdown runs under the message; **Stop retrying** keeps it manual). Fix the port / firewall / credentials, then reconnect — no reload needed. |
| `Connection refused by host:port` | Nothing listens for SSH on that port. Check the port and that `sshd` is running. |
| `The connection … was reset before SSH finished connecting` | Firewall / network blocking outbound SSH, a fail2ban IP ban, or a non-SSH service on that port. |
| `Authentication failed … wrong username or password` | Or the server has `PasswordAuthentication no`. Use SSH key authentication. |
| `Authentication failed … the server rejected this private key` | Add the key's public half to `~/.ssh/authorized_keys` for that user. |
| `This private key is passphrase-protected` / `Incorrect passphrase` | Enter (or fix) the key passphrase in the host settings. |
| An old installer shows a `┌─┤ Configuring … ├─┐` box and arrow keys type `[B` | Fixed: the box is detected and its keys are delivered through the host-side keystroke channel — see *Answering prompts*. |
| The distro badge (`Ubuntu 24.04.1 LTS · Oracle Cloud`) is missing | The host answered SSH but not the probe: a restricted shell (`rbash`, no `/etc/os-release`, no `uname`), or the deployment cannot open a second connection to it. The session itself is unaffected. |
| The badge says `KVM VPS` on a cloud server | That image has no cloud-init `cloud-id` and no vendor string in its DMI data, so only the hypervisor is identifiable. Everything else (distro, version, kernel, CPU, RAM) is still exact. |
| `vim`/`top`/`less`/`tmux` don't run on Vercel | Serverless SSH runs each command on its own. When live input is available (see *Answering prompts* below) simple interactive programs work but nothing can resize or re-enter full-screen mode, so a live PTY is still better: self-hosted Sushi or **Attach VPS Gateway**. These always work in the Vercel terminal: `cat`, `tail -n 100`, `sed -i`, `top -bn1`, `systemctl status`, `journalctl -n 50`, `git log`. Pipe installers also work — `curl -fsSL https://get.docker.com | sh` and `bash <(curl …)` run the piped script, and any `[y/n]` they ask is still answerable (key channel / answer bar / **No timeout**). |
| `su` says it needs the root password (Vercel) | `su` wants the *root account's* password. Use `sudo su` instead: Sushi asks for **your** sudo password (on NOPASSWD hosts it switches instantly). |
| `Download ZIP` / the row **ZIP** button does nothing | If your browser shows a save dialog first, it was dismissed (Esc) — click again and confirm. Right-click the folder row → *Download folder (.zip)* is the same action. |
| `Download ZIP` fails with "is not a folder" | The path is a file or a symlink to a file — use the single-file download button (or open its folder and archive that). |
| RDP: `guacd could not reach the host on port 3389` | The desktop service is not listening. On Windows enable *Remote Desktop*; on Linux install and start `xrdp` (`systemctl enable --now xrdp`), then check the port number in the host. |
| RDP: `the remote refused the login` | The desktop account is not the SSH account. Open **Credentials** in the RDP tab and set the Windows / domain account (or the Linux user `xrdp` logs in as), plus the domain and the security mode the server requires (**NLA** for most Windows hosts). |
| RDP: picture looks soft / stretched | **Fit window** is off, so the desktop is scaled. Click the arrows icon in the toolbar to have the server match the pane. |
| RDP: laggy over a slow link | Switch the quality preset to **Fast** (16-bit, no themes) and turn **Desktop audio** off. |
| RDP: typing goes to the browser instead of the desktop | Click the desktop once (**Click the desktop to type**), or look for the `Keyboard captured` chip. **Ctrl+Alt+Shift** releases the keyboard again. |
| RDP: the session reconnects by itself | Expected after a network blip or a `guacd` restart — it rebuilds with backoff. If it keeps happening, check the X.224 probe in the diagnostics panel and the `guacd` container logs. |
| The selection download produces `<folder>-selection.zip` | Expected: several selected items are packed into one archive named after the folder you are in. Each item keeps its own name inside. |
| `Download` does nothing with several items selected | Same rules as the folder ZIP: a dismissed save dialog downloads nothing, and a selection that is too large / nested too deeply / has too many files is refused before streaming. |
| A command sits on `Do you want to continue? [Y/n]` / `Password:` (Vercel) | Type the answer in the terminal and press Enter (or click **Yes (y)** / **No (n)**): Sushi re-runs the command with your answer piped in. To avoid the question entirely use `apt install -y docker`, `ssh-keygen -f ~/.ssh/id_ed25519 -N ''`, `DEBIAN_FRONTEND=noninteractive`. |
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

### Answering prompts in the Vercel terminal (`[Y/n]`, passwords, whiptail menus, …)

Serverless SSH runs one command per request, so there is no PTY to type into. Sushi gives you four
ways past a question — including the old curses installers (`Configuring lightdm`, `tasksel`,
`debconf`) that only listen to key presses:

1. **Key channel (default on every connection where live typing is impossible).** Each command runs
   inside `script(1)` on the host, with a private keystroke FIFO (`/tmp/.sushi-keys-…`, mode 600,
   owned by your login user, removed when the command ends). Every keystroke — `y`, arrows, `Tab`,
   `Space`, `Enter`, `Esc`, Ctrl+C — is delivered as a tiny extra request (`/api/ssh/exec/keys`), so
   it works in **Firefox, Safari, HTTP/1.1 and through buffering proxies**, and it does not depend on
   the deployment keeping the same server instance. A `whiptail`/`debconf` screen is picked up
   automatically: a **menu bar** appears above the terminal with the box's title, its choices
   (`(*) gdm3`, `( ) lightdm`), its buttons (`<Ok>`, `<Cancel>`) and a keypad, so you can answer an old
   Ubuntu installer with one click. Typed keys simply work; nothing is re-run and no install is
   interrupted.
2. **Type it, even without any channel.** If the host has no `script`/`mkfifo`, Sushi falls back to the
   old behaviour: typing an answer and pressing **Enter** stops the stuck command and re-runs it with
   that line piped into stdin — `y` really answers `[Y/n]`, `n` aborts, an empty line takes the
   default. Typing something that isn't an answer runs it as a new command instead, so a busy terminal
   never locks you out.
3. **Live typing**, where the platform allows it: if the browser can stream a request body *and* the
   connection is HTTP/2 (Chrome/Edge on HTTPS), the running command's stdin is connected and
   keystrokes reach it directly — the header then shows **Live input** and no key channel is created.
   Browsers that report *"ReadableStream uploading is not supported"* (Firefox, Safari) are detected
   before any request is sent, and a deployment that buffers request bodies is detected within a few
   seconds; both switch to (1) without an error in the terminal.
4. **Non-interactive flags** — the safest habit: `apt install -y`, `apt-get -y`, `ssh-keygen -N ''`,
   `DEBIAN_FRONTEND=noninteractive`, `debconf-set-selections`.
5. **No timeout** (terminal header toggle, serverless shell): the command ignores SIGHUP, so if the
   internet drops mid-install the command **keeps running on the host** instead of being killed with
   the request; prompts like `确认是否继续?[y/n]:` wait forever (no automatic Ctrl-D), the whole
   session is also written to a log file (`/tmp/.sushi-run-….log`, announced in the terminal when the
   command starts), and the keystroke FIFO stays open for a day. After reconnecting, a
   *still running on host* chip appears in the header with **y⏎ / ⏎ / ^C** buttons that deliver keys
   to that command through `/api/ssh/exec/keys`, and the output log can be read via SFTP or
   `cat /tmp/.sushi-run-….log`. Stop always sends a real Ctrl+C through the FIFO.

Ctrl+C sends a real SIGINT when stdin is live and cancels the request otherwise, and always leaves the
session healthy. After a deployment, an open tab shows a **Reload** banner instead of silently keeping
the old build.

Supported private keys: OpenSSH (`BEGIN OPENSSH PRIVATE KEY`, incl. passphrase-protected), PEM
(`BEGIN RSA/EC PRIVATE KEY`, incl. encrypted), **PKCS#8** (`BEGIN PRIVATE KEY` /
`BEGIN ENCRYPTED PRIVATE KEY`, converted automatically for RSA, ECDSA and Ed25519) and PuTTY `.ppk` v2 RSA keys
(for other `.ppk` keys use PuTTYgen → *Conversions → Export OpenSSH key*).
Keys mangled by copy & paste (CRLF, indentation, one-line keys, literal `\n`) are repaired automatically.

---

### Translating text (terminal selection & clipboard)

Select any text in the SSH terminal and click the **Translate** button in the terminal header (or
**Translate** in the RDP clipboard panel). The translation opens in a small panel with a target
language picker — **Chinese (Simplified) is the default**, with Chinese (Traditional), English,
Khmer, Japanese, Korean, Vietnamese, Thai, French, German, Spanish, Portuguese, Russian and Arabic
available; your choice is remembered in `localStorage`.

Translation runs server-side through `POST /api/translate` (authenticated like every other Sushi
API, max 4000 characters per call), so no translation API keys live in the browser:

- Set **`SUSHI_TRANSLATE_URL`** (and optionally **`SUSHI_TRANSLATE_API_KEY`**) to a self-hosted
  [LibreTranslate](https://libretranslate.com/) endpoint to keep text on your own infrastructure —
  recommended for self-hosted Sushi.
- Without it, Sushi uses the keyless Google Translate `gtx` endpoint, which works from any VPS with
  outbound HTTPS and needs no key.

The provider, request timeout (12 s) and response parsing live in `src/lib/server/translate.ts` and
are covered by `npm test` (both response shapes are exercised with an injected `fetch`, and the
route is tested against a mock translator server).

---

## Verification & Protocol Tests

```bash
npm run typecheck
npm test
npm run build
```
