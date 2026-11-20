# Sushi

> **⚠️ Read before you deploy.** Sushi is **AI-assisted software provided "AS IS", with no
> warranty and no support commitment.** It is remote-access software: whoever signs in can run
> commands as the accounts you save, and the app has **one admin account with full access to
> every saved host** — there are no per-user or per-host permissions. Limit other people on the
> target machine (scoped OS users, `rbash`, `sudoers`, RDP "Remote Desktop Users"), never by
> handing out your admin password.
> **Operate it only on hosts you are authorized to access, over HTTPS, with backups.**
> Full terms: [`DISCLAIMER.md`](DISCLAIMER.md) · Data handling: [`PRIVACY.md`](PRIVACY.md) ·
> Reporting a vulnerability: [`SECURITY.md`](SECURITY.md).

**Sushi** is a self-hosted and Vercel-ready web workspace for **SSH**, **SFTP**, and **RDP** remote infrastructure management.

It is designed around a **Hybrid VPS + Serverless Architecture**:
- **Self-Hosted on a VPS (Docker Compose or Node.js)**: Runs a unified HTTP + WebSocket server (`server.ts`) paired with Apache Guacamole's `guacd` daemon for full interactive `xterm.js` PTY SSH terminals, graphical SFTP file management + remote code editing, and live 60fps HTML5 Remote Desktop (RDP) sessions.
- **Deployed on Vercel (Serverless Node.js)**: Uses environment-based admin sign-in and an encrypted **browser-local vault**, without a database. **SFTP**, **Serverless Streaming SSH**, and **MS-RDPBCGR X.224 / TLS / NLA** probes work natively. Attach a persistent Gateway URL (`wss://...`) for reliable live RDP, team sharing, and WebSocket PTY shells — hosted on a **VPS**, **Railway** ([`.railway/railway.ts`](.railway/railway.ts)), or **Render** ([`render.yaml`](render.yaml)), using [`Dockerfile.gateway`](Dockerfile.gateway).

---

## Features

- **Username, Password & WebAuthn Passkey Protection**
  - One admin account: interactive setup persists to disk on a VPS, while Vercel uses `SUSHI_AUTH_USERNAME` and `SUSHI_AUTH_PASSWORD` environment variables. A VPS can also use those variables.
  - **SSH Keychain & Vault Key Whitelist**: Store encrypted `ed25519` / `rsa` / `ecdsa` SSH keys in the Vault Keychain, and optionally enforce a strict **Vault SSH Key Whitelist** across all SSH/SFTP server connections
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
- **Team Sharing — one SSH session, several people** (`/ws/ssh` + `/share/<id>`)
  - **Share** in the terminal header publishes the shell you are already in: everyone who opens the link lands in *that* PTY — same screen, same working directory, same half-finished `vim` — and can keep running commands there
  - **The shell outlives every browser**: close your laptop, and the SSH channel stays open on the server, so a teammate re-attaches hours later and carries on instead of starting over
  - **Two ways in**: a 6-digit share code for anyone with the link, or *signed-in Sushi accounts only* — no code to leak, no guest list to manage
  - **Who is in here**: a live roster with names and join times, and a `… is typing` hint so two people do not drive at once; **New code** invalidates the old one instantly
  - **Let teammates type** is the default; switch it off for a read-only share when someone should only watch
  - **Scrollback replay** for late joiners (256 KB ring buffer), terminal size follows the smallest attached screen, and **Stop sharing** disconnects guests while your own terminal keeps running
- Commands survive a closed tab (No timeout + resume prompt) and recently connected hosts are remembered
- One merged entry per machine in the sidebar and launchpad, plus **All hosts** (`/hosts`) — one table of every machine with its SSH/SFTP/RDP ports and one link each — and `GET /api/hosts` for scripts
  - **Translate selected text**: highlight any text in the terminal and hit the **Translate** button — the translation appears in a panel above the terminal (Chinese by default, 14 target languages, remembered per browser). Translates through Sushi's own `/api/translate` (see *Translating text* below)
- **SFTP File Manager (`/api/sftp/*`)**
  - Works identically on **Vercel Serverless** and **VPS**
  - Interactive breadcrumb navigation, drag-and-drop multi-file uploads, binary downloads, `mkdir`, rename, recursive delete, and an interactive Unix `chmod` permissions matrix
  - **Folder download as `.zip`**: pick any directory (or click **Download ZIP** for the folder you are in) and Sushi streams the whole tree — nested folders, dotfiles, binary files, empty folders and permissions — straight to your browser. No remote `zip`/`tar` binary and no shell needed, so it works on Vercel exactly like on a VPS.
  - **Multi-select download**: check any mix of files and folders (checkbox, ⌘/Ctrl-click, Shift-click, or the select-all box) and **Download** puts exactly those items into one archive, each kept under its own name. The header checkbox always matches the rows on screen — select-all covers the current filter, deselect-all clears those same rows and leaves filtered-out rows selected (the bar says so), and the count only ever includes rows that really exist. Navigating to another folder starts with an empty selection, so paths from the folder you left can never inflate the count.
  - **Built-in Remote Code Editor** (`⌘S` / `Ctrl+S` direct save over SFTP)
  - **Auto root — "sudo su" for files**: flip the **Sudo** button in the file manager (or tick *Auto root (sudo su) for files* on an SFTP host) and the whole browser runs as root through `sudo`, so `/etc`, `/var`, `/root` and every root-owned file is editable — not just your home directory. Sushi starts OpenSSH's own `sftp-server` through sudo on a separate channel, so nothing about the SFTP protocol changes. When the server needs a sudo password, Sushi asks for it once (kept in that tab only, never saved on the host); when sudo is missing, needs a password it was not given, or the host has no `sftp-server` binary, the browser keeps working as your login user and says exactly why in a banner. See [`src/lib/server/sftp-elevation.ts`](src/lib/server/sftp-elevation.ts).
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
  - Browser-side `AES-256-GCM` encryption with a server-derived session key, account password, separate passphrase, or browser device key
  - Cross-device sync with revision checks on a persistent self-hosted disk; browser-local storage on Vercel; passphrase-encrypted portable JSON backups

---

## Accounts, vaults, and backups

Sushi does not require or connect to a database. **Self-hosted** deployments keep
`auth.json` and the encrypted `vault.enc.json` on a persistent disk (`DATA_DIR`,
or the `sushi-data` Docker volume). After creating the admin account, sign in at
the same URL on another device to see its saved connections. Changes use revision
checks so concurrent writes do not silently overwrite one another. Protect the
first-run setup page from untrusted visitors and back up the volume.

**Vercel** has no persistent server disk: set the admin credentials as server-only
environment variables (see [deployment](#3-deploy-to-vercel--optional-companion-gateway-vps-railway-or-render)).
Each browser profile and origin keeps its own encrypted vault. Tabs in that profile
can share changes, but **different devices and private windows do not sync**. Use
**Settings → Vault & iCloud Drive backup → Download Portable Backup** and restore
it on each device; restoring replaces that device's vault. Keep the backup and
its passphrase safe and verify recovery before clearing browser data. A browser
device-key vault or an old device-key backup requires its original browser key.

Vault data is encrypted in the browser with AES-256-GCM. New disk-synced vaults
normally use a session key derived from the server's `authSecret` and delivered
only to authenticated same-origin sessions; the server can derive that key, so
this is **not zero-knowledge encryption**. Older vaults may use an account password
or another passphrase (PBKDF2-SHA256, 210,000 iterations). New browser-only vaults
use a device key stored in that browser. Use HTTPS, trust the server, protect
its files and environment secrets, and keep portable backups. Changing or losing
`SUSHI_AUTH_SECRET` can make a session-key vault unreadable; preserve the old
secret until a verified portable backup is available.

On a VPS, change an interactively created password under **Account & Passkeys →
Password**. Environment-managed credentials must be changed in the hosting
settings and redeployed. On Vercel, passkey certificates are browser-local unless
you explicitly configure `SUSHI_PASSKEYS_JSON`; enroll or configure them for
other browsers separately. A browser-local passkey cannot be globally revoked
from another browser without changing the server signing secret.

If disk storage is unavailable or an existing vault cannot be read, Sushi does
not silently create an empty account or claim a save succeeded. If a crashed VPS
process left a `data/*.lock` file, stop all Sushi processes and confirm no writer
is active before removing the **lock file only**; do not delete the `.json` files
to clear a lock. Self-hosted vault snapshots are limited to 32 MiB.

## One URL for every host (SSH + SFTP + RDP merged)

A server is usually saved more than once — an SSH entry, maybe an SFTP one, maybe an
RDP one — because each protocol has its own settings. Sushi now **merges those
profiles into one entry per machine + account**, everywhere hosts are listed, and gives
each entry a single URL:

- **Sidebar and launchpad**: one row per machine, with `SSH`/`SFTP`/`RDP` badges for
  every way in and one click for each (a host saved only for SSH still offers the SFTP
  action, and a desktop through the derived RDP companion on 3389). Search and the
  protocol filter work on the merged entries, so “SSH” lists an SFTP-saved host too.
- **All hosts** — the **All hosts** tab in the workspace header (or the `/hosts` URL)
  lists every saved machine in one table: folder, name, tags, `ssh://user@host:port`
  addresses, one button per way in, and a **link** button that copies that machine's
  URL. Search covers name, address, account, folder, tag *and* pasted addresses; the
  `ALL / SSH / SFTP / RDP` tabs filter by how a machine can be opened. It opens from
  `/hosts`, which redirects into the workspace view (`/?view=hosts`) when the server
  route has no readable inventory. **`/hosts?format=json`** answers scripts.
- **`GET /api/hosts`** — when an explicit clear-text inventory is configured, the
  machine-readable endpoint returns one entry per machine with `id`, `accessUrl`,
  `protocols`, `counts`, and protocol `links[]`. Otherwise it reports vault metadata,
  not the contents of the encrypted vault. It requires the normal Sushi session.
- **One link per machine**: `/hosts?host=<id>` (or `/hosts?host=<id>&protocol=rdp`)
  opens that machine in the workspace, which unlocks the vault and starts the session.
  `?host=` also accepts `user@host` for hand-written links. Links never carry
  credentials.

**Why the server endpoint is not a dump of your vault.** Sushi stores vault data as
`{iv, ciphertext}` and these endpoints do not decrypt it. The server can derive
session-mode keys, however, so this is not zero-knowledge encryption. Without a
clear-text inventory, `/api/hosts` returns an empty placeholder list and counts: it
cannot determine the actual host count from the encrypted envelope. `/hosts` hands
the browser to the workspace, where **All hosts** lists the unlocked entries. A
deployment that deliberately keeps a clear-text inventory can set
`SUSHI_HOSTS_INVENTORY` (inline JSON or a file path, shape
`{ "hosts": [ { …HostProfile } ] }`); those entries are merged the same way, returned
with `encrypted: false`, and rendered as the real table on `/hosts` itself — no
JavaScript required.

**Editing and deleting stay consistent** (`lib/client/host-consistency`): change the
address or account of one profile and its SSH/SFTP/RDP siblings move with it, so a
machine never splits into two half-entries (and a clash with an existing machine is
reported before two machines merge). Deleting a merged row deletes the machine, with a
confirmation naming the protocols that go with it, instead of leaving orphaned
profiles behind. Saves still go through the normal encrypted-vault path — no new
storage, no new sync path.

## Team sharing — one SSH session, several people

A normal Sushi terminal is private: one tab, one shell, and the shell dies with the tab.
**Share** (in the terminal header) turns that shell into a shared one:

1. Open a host's terminal and hit **Share**.
2. Pick **Anyone with the link** (Sushi mints a 6-digit code) or **Signed-in Sushi
   accounts** (the link only works for people logged in to this instance), and decide
   whether teammates may type.
3. Send the link (`<your-sushi>/share/<id>`). Whoever opens it types their name, the
   code if there is one, and **Join session**.

From then on there is exactly **one** SSH connection to the host, no matter how many
browsers are attached. Output goes to everyone; keystrokes from anyone with write
access go into that one PTY. It is the difference between "here is the box, good luck"
and "here is *my* shell, carry on where I stopped".

**The shell keeps running when nobody is watching.** Detaching is the normal case, not
an error: the SSH channel stays open on the server until it has been idle for
`SUSHI_SHARE_IDLE_TTL_MS` (default 12 h), so a teammate can close their laptop and
somebody else re-attaches to the same session later — replaying the scrollback they
missed instead of a blank screen.

Where it works, and where it does not:

| | Shared shell |
| --- | --- |
| VPS / Docker install (`server.ts`) | ✅ |
| `GATEWAY_ONLY=true` gateway | ✅ |
| Vercel serverless | ❌ serverless has no process to hold a PTY open — the Share panel says so and offers *Attach a gateway* (VPS, Railway or Render) |

Managing shares: **Share → Other shared sessions here** lists everything currently
published on this server, with **Rejoin** and **Stop**. The same list is available to
scripts and dashboards at `GET /api/ssh/share` (account required); `DELETE
/api/ssh/share?id=…` stops one, and `PATCH` with `{"id": …, "passcode": "auto"}` rotates
its code (`"passcode": null` switches it to account-only).

**Treat a share link as a handover of the host account.** Everyone in the shell runs
commands as the SSH user of that connection, with that user's `sudo`, on the machine
you pointed Sushi at. Share with people you would hand the password to, prefer
read-only when someone only needs to watch, rotate or stop the share when the work is
done, and remember the shell keeps running until you stop it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUSHI_SHARE_MAX_SESSIONS` | `50` | Most shells shared at once on this server |
| `SUSHI_SHARE_IDLE_TTL_MS` | `43200000` (12 h) | How long a detached shell with nobody attached is kept |
| `SUSHI_SHARE_SCROLLBACK_BYTES` | `262144` (256 KB) | Scrollback replayed to whoever joins late |

---

## Add Sushi to an iPhone or iPad Home Screen

1. Open your Sushi URL over **HTTPS** in Safari, tap **Share**, and choose
   **Add to Home Screen**. Confirm the name and tap **Add**. Sushi has a dedicated
   Home Screen icon and opens as a standalone web app.
2. On a phone the app opens straight onto **your host list**: Recently Connected
   at the top, then search, the **All / SSH / SFTP / RDP** filter and one row per
   machine with its protocol actions. Tap **Show quick connect** for the dashboard
   (quick connect, capability pills and the new-connection cards); the choice is
   remembered per device. On a tablet or desktop the dashboard is the home screen
   and the same list lives in the sidebar. Sessions still require a network
   connection; installing the icon does not make SSH, SFTP, or RDP work offline.

The Home Screen app may have separate login and browser storage from Safari,
including the local device key used to encrypt a device-key vault. On a self-hosted deployment, sign in to the same Sushi URL to open the
disk-synced vault. On Vercel, restore a portable backup into the Home Screen app;
the icon itself does not sync data through iCloud.
**Before switching, create and verify a passphrase-protected portable backup in
the original browser** (see below); do not reset an unreadable vault until you
have a working backup.

---

## Importing SSH clients and iCloud Drive files

Open **Import / Export** on the dashboard or under sidebar **Settings**. Choose files, or on
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

1. Open sidebar **Settings → Vault & iCloud Drive backup**. Under **Portable
   Encrypted Sushi Backup**, enter and confirm a backup passphrase, then choose
   **Download Portable Backup**.
   This creates a separate AES-256-GCM / PBKDF2-encrypted `.enc.json` and does
   **not** change the current vault password. It includes saved hosts, snippets,
   SSH keys and the key-whitelist setting, but **not** passkeys or workspace
   history (open tabs, recent hosts and resumable runs). Keep the passphrase separately.
2. Save or move that file to iCloud Drive using your browser/Files app (or any
   other storage you choose). This is a manual backup, not automatic iCloud sync.
3. On the new device, select the file using **Import / Export** or **Choose
   Backup to Restore**, enter its passphrase, and confirm replacement of the
   current vault. The restored contents are re-encrypted using the current vault
   protection. On Vercel this replaces only that browser's vault; on a self-hosted
   deployment with disk sync enabled it replaces the shared vault for all synced devices.

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

**Pick the one-liner for your platform. Each installs, configures, builds and starts Sushi
(Web UI + SSH + SFTP + guacd for RDP) — no manual config, no cloning by hand.**

| You have | Run this | Notes |
| --- | --- | --- |
| **Docker** (recommended) | `curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh \| bash` | Installs Docker if missing, starts Sushi + guacd, waits for health, prints the URL. Debian/Ubuntu, Rocky/Alma, Fedora, Arch, Alpine |
| **Docker, prebuilt image** (fastest, no compile) | `docker run -d --name sushi -p 3000:3000 -v sushi-data:/app/data --restart unless-stopped ghcr.io/sarakplaystore/sushi:latest` | Pulls a multi-arch image (~1 min). Needs a separate `guacd` only if you want *live* RDP |
| **Docker Compose, no clone** | `curl -fsSLO https://raw.githubusercontent.com/sarakplaystore/sushi/main/docker-compose.prebuilt.yml && docker compose -f docker-compose.prebuilt.yml up -d` | Sushi **+ guacd** from the published image |
| **Python 3.9+** (no Docker needed) | `python3 install.py` | Cross-platform (Linux, macOS, Windows via WSL). Downloads the source, `npm ci`, builds, starts in the background and health-checks it |
| **Node.js 22 only** | `git clone https://github.com/sarakplaystore/sushi.git && cd sushi && npm ci && npm run build && npm start` | The manual equivalent |
| **Vercel** | Import the repo, configure admin environment variables | See [Deploy to Vercel](#3-deploy-to-vercel--optional-companion-gateway-vps-railway-or-render) |
| **Vercel + native PTY** | Vercel for the UI, Railway or Render for [`Dockerfile.gateway`](Dockerfile.gateway) | See [Deploy to Vercel](#3-deploy-to-vercel--optional-companion-gateway-vps-railway-or-render) — no server to maintain |

Useful installer flags: `--port 8080`, `--dir ~/sushi`, `--https your.domain` (adds Caddy with
automatic HTTPS), `--prebuilt` (skip the build), `--node` (no Docker: Node.js + systemd), and
`--foreground` (Python: keep it in this terminal). Every path is safe to re-run: your `.env`,
`data/` and the `sushi-data` volume are never deleted, so re-running **upgrades** the code.

> **Docker image:** published to GitHub Container Registry by
> [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) on every push to
> `main` and on `v*` tags (linux/amd64 + linux/arm64). If the image is not published yet, use the
> `--build` / build-from-source paths above — nothing else changes.

### 0. One-click deploys

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsarakplaystore%2Fsushi&repository-name=sushi)
*(Set server-side admin credentials in Vercel before signing in — see §3.)*

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi)
*(Deploys the **gateway** from [`render.yaml`](render.yaml) — the native WebSocket PTY companion for a Vercel UI, not the whole app. See §3.)*

**Railway** has no repo-based one-click button: run `railway config apply` against
[`.railway/railway.ts`](.railway/railway.ts), which creates the `sushi-gateway` **and** `guacd`
services in one step (see §3 for both the CLI and dashboard routes).

```bash
# Docker, one line, everything included (Sushi + guacd)
docker run -d --name sushi --restart unless-stopped -p 3000:3000 \
  -v sushi-data:/app/data ghcr.io/sarakplaystore/sushi:latest
```

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

Or run the one-step installer (any Linux distro, adds `--https your.domain` for Caddy):

```bash
bash scripts/install-vps.sh                 # build locally
bash scripts/install-vps.sh --prebuilt      # pull ghcr.io image instead
bash scripts/install-vps.sh --node          # no Docker: Node.js + systemd unit
```

Keep the `sushi-data` volume (or `DATA_DIR` when running Node directly) persistent
and backed up: it holds `auth.json` and `vault.enc.json`. Recreating or deleting
that storage can lose the account and saved connections. `SUSHI_SERVER_VAULT=false`
disables disk vault sync and keeps the vault only in each browser. No database is required.

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

### 3. Deploy to Vercel (+ Optional Companion Gateway: VPS, Railway or Render)

1. Import `sarakplaystore/sushi` into Vercel (Next.js, Node.js `22.x`). No
   database integration is needed.
2. In **Project Settings → Environment Variables**, set these as **server-only**
   secrets for the environments you deploy. Never use a `NEXT_PUBLIC_` prefix or
   commit their values:
   - `SUSHI_AUTH_USERNAME`: your admin username.
   - `SUSHI_AUTH_PASSWORD`: a long, unique admin password.
   - `SUSHI_AUTH_SECRET`: a stable, random signing secret (strongly recommended;
     generate one with `openssl rand -hex 32`). Preserve it when redeploying.
3. Redeploy and sign in. The same credentials work on each device, but the
   **encrypted vault is browser-local** and will not sync between devices. Make a
   portable encrypted backup and restore it on each browser. Vercel cannot safely
   offer public interactive account creation without a persistent account store;
   the old `SUSHI_ALLOW_STATELESS_SETUP` flag no longer enables it.
4. On Vercel, SFTP, serverless SSH, and RDP probes work natively. Direct live RDP
   over split HTTP requests depends on those requests reaching the same process;
   it may disconnect on serverless platforms. Attach a **gateway** — one small
   always-on process — for reliable live RDP, persistent WebSocket PTY shells
   (full-screen `vim`/`htop`/`tmux`, terminal resize), and team-shared terminals. All three routes below end
   the same way: one `wss://` URL plus its token, pasted into Sushi's
   **Settings → Gateway** (the panel offers the same snippets behind its
   *VPS / Railway / Render* tabs).

   | Gateway host | What you run | Native PTY | Live RDP | Files |
   | --- | --- | --- | --- | --- |
   | **VPS** (Docker/Node) | `docker compose up -d` or `npm run gateway` | ✅ | ✅ via `guacd` | [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) |
   | **[Railway](https://railway.com/new)** | `railway config apply` → `sushi-gateway` + `guacd` on one private network | ✅ | ✅ via `guacd` | [`.railway/railway.ts`](.railway/railway.ts), [`Dockerfile.gateway`](Dockerfile.gateway) |
   | **[Render](https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi)** | New + → Blueprint → this repo | ✅ | In-browser IronRDP WASM (Render services get no private hostname for a `guacd` sidecar) | [`render.yaml`](render.yaml), [`Dockerfile.gateway`](Dockerfile.gateway) |

   **Railway** (`railway.json` is deprecated and stops being read on 2026‑12‑01, so Sushi
   ships Railway's Infrastructure-as-Code file instead):

   ```bash
   npm i -g @railway/cli
   railway login && railway init          # or: railway link
   npm i --no-save railway                # SDK, only to evaluate .railway/railway.ts
   railway config plan && railway config apply
   railway variable set SUSHI_GATEWAY_TOKEN="$(openssl rand -hex 24)" --service sushi-gateway
   railway variable set ALLOWED_ORIGIN="https://your-app.vercel.app" --service sushi-gateway
   ```

   Then give `sushi-gateway` a public domain (**Settings → Networking → Generate Domain**) and
   paste that `https://…up.railway.app` URL plus the token into Sushi's gateway panel. Both values
   live under **sushi-gateway → Variables** in the [Railway dashboard](https://railway.com/new)
   ([how Railway variables work](https://docs.railway.com/variables)); the same panel in Sushi links
   there next to its `SUSHI_GATEWAY_TOKEN` field.

   Without the CLI: [*New Project → GitHub Repo → this repository*](https://railway.com/new), set
   **Settings → Build Configuration → Dockerfile Path** to `Dockerfile.gateway`, add a second
   service from the Docker image `guacamole/guacd:1.5.5`, point `GUACD_HOST` at that service's
   `RAILWAY_PRIVATE_DOMAIN`, set the two variables above, then **Generate Domain**.

   **Render**: *New + → Blueprint → this repository* (or the [Deploy to Render button](https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi)
   above). `render.yaml` builds `Dockerfile.gateway` and **generates `SUSHI_GATEWAY_TOKEN` for
   you** — read the generated value under **sushi-gateway → Environment** in the
   [Render dashboard](https://dashboard.render.com), where you also set `ALLOWED_ORIGIN` to your
   Vercel origin ([Environment Variables and Secrets](https://render.com/docs/configure-environment-variables)).
   Copy the service URL and that token into Sushi.

   **VPS**:

   ```bash
   docker compose up -d guacd
   SUSHI_GATEWAY_TOKEN="your-secret" ALLOWED_ORIGIN="https://your-app.vercel.app" npm run gateway
   ```

   Put Caddy/Nginx HTTPS in front of the VPS and enter its URL and matching token
   in Sushi's **Settings → Gateway**. A gateway token authorizes protocol access;
   it is not an admin sign-in and cannot read or change the shared vault.

   > **Idle sleep.** A managed host that suspends idle services (Render's free instance plan,
   > an unscaled Railway service) cannot answer a WebSocket handshake while asleep, and the
   > first shell then waits for a cold start or fails. Use an always-on plan, keep Sushi's
   > **Keep this gateway awake** toggle on in the gateway panel (pings `/health` every
   > 4 minutes while that tab is open), or run the gateway on a VPS. A sleep also drops every
   > session the gateway was holding — no keepalive can bring those back.

   The gateway image is deliberately slim: it contains no Next.js build and no web assets,
   only `server.ts` with `GATEWAY_ONLY=true`, so it starts in about a second and answers
   `GET /health` and `GET /api/system/capabilities` for platform health checks. Every other
   API route 404s on purpose, which is what makes the Vercel frontend keep using its own
   serverless endpoints (for example *Test SSH Auth* → the Vercel `/api/ssh/test`).

## Migrating from database storage

**Back up before upgrading.** Earlier Sushi releases could store the account,
passkeys and encrypted vault in Turso, Firestore or Redis. This release no longer
connects to those services or migrates their data automatically. A deployment
with old database configuration fails closed rather than creating a new empty
account. The services and their contents are **not deleted** by this upgrade.

1. While the **previous version** and its database are still available, open the
   original browser, sign in, and use **Settings → Vault & iCloud Drive backup →
   Download Portable Backup**. Choose a separate passphrase and verify that you
   can restore the file. Portable backups omit passkeys and workspace history
   (including open tabs and resumable runs), so record anything needed separately.
   Keep a secure backup of the old database and its settings until the new
   deployment has been checked. Export or re-enroll passkeys as needed. Do not
   clear the original browser data.
2. For Vercel, set `SUSHI_AUTH_USERNAME` and `SUSHI_AUTH_PASSWORD` in the hosting
   dashboard. Keep a stable `SUSHI_AUTH_SECRET`. To open a cached vault whose
   `keySource` is `session` without restoring the backup, this must be the **same
   effective secret** used by the old deployment (from its old server-side
   setting or protected account record). Handle it as a secret; never paste it in
   chat or commit it. If the old secret is unavailable, use a new random secret
   and restore the portable backup instead. On a VPS, protect the setup page and
   create a new disk-backed admin account after the configuration change.
3. Remove legacy database environment variables and any provider integration
   that injects them: `SUSHI_TURSO_*` / `TURSO_*`, `SUSHI_FIRESTORE_*`,
   `SUSHI_REDIS_*`, `UPSTASH_REDIS_*` and `KV_REST_API_*`. Remove the old
   `SUSHI_STORAGE_BACKEND` value or set it to `auto` (`disk` is VPS-only).
   `SUSHI_STORAGE_PREFIX` and `SUSHI_ALLOW_STATELESS_SETUP` are no longer used.
   Docker Compose detects old settings via presence-only markers; remove them
   from the Compose `.env` as well. Restart/redeploy after changing settings.
4. Sign in and verify the vault. If the old local vault cannot be unlocked, or a
   previously synced vault is missing from the new server, the **Vault unavailable**
   screen lets you download the browser's existing copy and restore a portable
   backup without first opening the vault. On a VPS this also seeds the empty server
   vault with an encrypted copy; a concurrent server change is never overwritten.
   Otherwise restore through **Settings → Vault & iCloud Drive backup**. Restoring
   replaces the browser-local vault on Vercel, or the shared vault when disk sync
   is enabled on a VPS. Repeat on each Vercel browser, since they no longer sync.
   Re-enroll or configure passkeys as needed. Keep the old service
   and backups until you have independently verified the new account and saved
   connections; disconnecting a service does not necessarily stop its billing.

The old cross-instance database relay for live RDP has also been removed. Use a
persistent gateway when serverless requests land on separate instances.
Termix SQLite **import** still reads files locally in your browser; it is not a
Sushi storage backend.

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

For reliable live pixels, use `guacd` (self-hosted `docker compose`) or an attached persistent
gateway. Serverless HTTP streaming can fail across separate instances; the X.224/TLS/NLA probe
and native `.rdp` launcher remain available without a gateway.

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

### One-tap OS commands (Snippets → `OS · …`)

The header badge is the automatic answer. The same answers are also one click away in the
**Snippets** popover, which now has a group per OS family — handy when you want to re-check a host by
hand, script the same probe yourself, or look at a box whose restricted shell hides `/etc/os-release`
from the automatic badge. Every command is read-only, runs as your login user (no `sudo`, no installs,
no network access from the host) and has a fallback for a missing tool:

| Group | Examples |
|---|---|
| `OS · Any Linux` | `cat /etc/os-release` (with a `/usr/lib/os-release` and `uname` fallback), kernel + libc, `hostnamectl`, cloud-init/DMI platform, `nproc` + `free -h` |
| `OS · Ubuntu` | `lsb_release -a`, codename (`noble`, `jammy`, …), running kernel and every installed `linux-image-*`, `do-release-upgrade -c` (check only) |
| `OS · Debian` | `/etc/debian_version` + codename, `lsb_release` fallback, configured apt repositories |
| `OS · RHEL / Rocky / Alma` | `/etc/redhat-release`, `rpm -E '%{rhel} %{dist}'` (tells Rocky from Alma from genuine RHEL), `dnf check-update` |
| `OS · Fedora` | `/etc/fedora-release`, `dnf check-update`, kernels |
| `OS · Arch` | `/etc/arch-release` (rolling release, so no version number), kernel packages, package count + last upgrade from `pacman.log` |
| `OS · Alpine` | `/etc/alpine-release`, apk repositories, `musl` version (the usual reason glibc binaries fail there) |
| `OS · SUSE / openSUSE` | `os-release`, `/etc/SUSE-brand` + SLES registration status, `zypper list-updates` |
| `OS · Amazon Linux` | `/etc/system-release`, `ID`/`VERSION_ID` and whether the host is dnf-based (2023) or yum-based (AL2) |

Snippets are grouped by category in the popover, and the group that matches the connected host is
flagged **this host** (the probe reads `PRETTY_NAME`, `NAME` and `VERSION_CODENAME`), so on an Ubuntu
box you do not have to remember whether the right answer is `lsb_release` or
`/etc/redhat-release`. Vaults saved before these commands existed get them merged into the popover —
your own snippets and imported Termix snippet folders are untouched, and nothing is written back to
the vault until you make a change yourself.

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
| Arrow keys / Home / End / Delete do nothing in the terminal (or ↑ types `A`, `[B: not found`) | Fixed. The serverless shell (Vercel, no live PTY) now runs a real line editor in the browser: **← →** move the caret, **Home / End** jump to either end, **Delete** removes the character under the caret, **↑ ↓** walk history (both the CSI and application-mode `ESC O A` forms), plus **Ctrl+A/E/U/K/W** and **Alt+B/F** word motion. Anything typed in the middle of a line is inserted at the caret, pasting is literal (bracketed paste), and every unknown escape sequence is swallowed instead of being typed as text. Same keys work in the mobile shortcut bar. See [`src/lib/client/line-editor.ts`](src/lib/client/line-editor.ts). |
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

**Closing the tab no longer loses the command.** With **No timeout** on, Sushi remembers the run
(host, command line, working directory, keystroke FIFO and log path) in this browser, so:

- **Reopen Sushi (or reload the tab)** and a card asks *"A command is still running on the host —
  go back to that session?"* with **Go back to the session**, **Just open the host** and **Dismiss**.
  *Go back* reopens the host, replays the command line in the terminal, redraws the output you missed
  from `/tmp/.sushi-run-….log` and re-attaches the keystroke channel to the FIFO that is still there —
  typing reaches the running command instead of starting a second copy. A **Resumed run** bar above
  the terminal shows whether it is *still running*, with **Stop it** (real Ctrl+C through the FIFO) and
  **Dismiss** (stop following; the command keeps running). The log is polled every 4 s, so the
  terminal keeps filling in until the command ends.
- **Recently Connected** sits at the top of the home screen (the dashboard on desktop, the host list
  on a phone) and lists hosts from this browser only — an ad-hoc connection is marked *ad-hoc*,
  saved hosts open from the vault with fresh credentials — plus every run that outlived its tab,
  with *running · 4m 12s* or *finished · exit 2*, so you can go back to it later.
- Only non-secret session data is kept in `localStorage` (no passwords, keys or passphrases); runs
  older than a week are pruned, and removing a run from the list never stops anything on the host.
- `POST /api/ssh/exec/run` answers *is it still running?* in one round trip (`test -p` on the FIFO,
  `tail -c` of the log, max 256 KiB, both paths validated against the exact `/tmp/.sushi-…` shapes).
  A WebSocket PTY tab cannot outlive its socket, so only serverless runs are offered.

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

## Support Sushi — donate crypto

Sushi is free and self-hosted. If it saves you time, you can send crypto to the project's address:

```
0xf3430a560b57189a888Ac02763c4d8f383B00F8d
```

<img src="public/donate-qr.svg" alt="QR code for the Sushi donation address" width="180" height="180">

*(EVM address — Ethereum, BNB Smart Chain, Polygon, Base, Arbitrum, Optimism.)*

- **One EVM address, many chains** — Ethereum (ETH / ERC-20), BNB Smart Chain (BNB / BEP-20),
  Polygon (POL / ERC-20) and Base / Arbitrum / Optimism (ETH / ERC-20).
- In the app the same address lives under **Settings → Donate crypto** (and the
  **Donate crypto** button on the launchpad hero): a locally generated QR code — scan it with
  MetaMask, Trust Wallet, Rainbow, Coinbase Wallet or any other wallet — a one-tap **Copy**
  button, the list of accepted chains and an Etherscan link.
- Send only assets on those EVM chains: a transfer on another network (Bitcoin, Solana, Tron, …)
  cannot be recovered. Sushi never asks for a seed phrase or private key, and nobody from the
  project will ever request one.

The address, chain list, EIP-681 `ethereum:` URI and explorer links live in
`src/lib/client/donation.ts`; `tests/donate.test.ts` (included in `npm test`) verifies the
address shape **and its EIP-55 checksum**, so a mistyped character fails CI instead of sending
funds into the void.

---

## Verification & Protocol Tests

```bash
npm run typecheck
npm test
npm run build
```

---

## Legal, privacy & liability (read this)

Sushi is a **self-hosted tool that can run commands and control desktops on your servers**. That
is powerful and dangerous. The project publishes three documents so expectations are explicit:

| Document | What it covers |
|---|---|
| [`DISCLAIMER.md`](DISCLAIMER.md) | **AI-assisted development disclosure**, "AS IS" warranty disclaimer, assumption of risk (remote access, destructive actions, credential compromise), **limitation of liability** (indirect/consequential damages, data loss, downtime, regulatory fines), no-support policy, acceptable-use rules, and the fact that there is **no `LICENSE` file yet** (so default copyright applies — add one before redistributing) |
| [`PRIVACY.md`](PRIVACY.md) | Exactly what is stored and where — VPS account files, encrypted disk or browser vaults, `localStorage` keys, `/tmp/.sushi-*` files on remote hosts, and the server's ability to derive session-mode keys — plus retention, third parties, data-subject rights and breach duties. **There is no telemetry and no maintainer backend** |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability privately, what is in/out of scope, and the protections you are expected to enable |

**The short version:** no warranty; you are the operator and the data controller; the maintainer
receives none of your data and owes you no SLA; use it only on systems you are authorized to
access; keep backups. None of these documents is legal advice — if you run Sushi as a service
for other people, have a lawyer review them for your jurisdiction.

Inside the app the same warning appears once, on the sign-in screen and on the launchpad
(AI-assisted · experimental · no warranty), with a link to these files.
