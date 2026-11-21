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
- **Deployed on Vercel (Serverless Node.js)**: Uses Google Cloud Firestore or a Redis-compatible REST database for a persistent account and cross-device vault (see setup below). Graphical **SFTP** file browsing/uploads/downloads/editing, **Serverless Streaming SSH** execution, and **MS-RDPBCGR X.224 / TLS / NLA** server probes work natively on Vercel Serverless Functions — and you can optionally link any Gateway URL (`wss://...`) inside the UI to unlock persistent WebSocket PTY shells and live browser RDP streaming — hosted on a **VPS**, on **Railway** ([`.railway/railway.ts`](.railway/railway.ts) deploys the gateway *and* `guacd`), or on **Render** ([`render.yaml`](render.yaml)), all three built from the slim [`Dockerfile.gateway`](Dockerfile.gateway).

---

## Features

- **Username, Password & WebAuthn Passkey Protection**
  - One interactive admin account shared across devices: persistent disk on a VPS, or configured Turso/Firestore/Redis storage on a VPS or Vercel. Optional `SUSHI_AUTH_USERNAME` / `SUSHI_AUTH_PASSWORD` environment overrides remain available.
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
  - Browser-side `AES-256-GCM` encryption with the account password (`PBKDF2-SHA256`, 210,000 iterations), a separate master passphrase, or a device key
  - Encrypted cross-device host, credential, key and snippet sync with revision checks; optional passphrase-encrypted portable JSON backups

---

## One account and saved connections on multiple devices

1. Configure persistent storage as described in **Quick Start**. Open Sushi on a
   trusted network and create the admin account once. Anyone who reaches a new,
   uninitialized deployment first can claim that account, so protect setup.
2. Save a connection. On another device, open the **same Sushi URL** and sign in
   with the same account. Saved SSH/SFTP/RDP profiles, passwords, private keys,
   whitelist settings and snippets are stored in the encrypted shared vault.
   Open terminal/RDP sessions and gateway settings are not transferred.
3. Other tabs in the same browser pick up saved changes promptly. Sushi also
   checks for shared changes when the page regains focus and periodically while
   it is visible and no editor is open. **Settings → Refresh saved connections**
   checks manually. A conflicting save is rejected rather than overwriting another
   tab or device; keep your unsaved edits, reload the latest vault and reapply them.

If shared storage is disabled or not configured, only tabs using the same browser
profile and exact origin share the local vault. Other devices, private browsing,
and different Sushi hostnames cannot see it. On Vercel, configure Turso, Firestore,
or Redis REST storage before expecting cross-device sync; keep the original
browser's data until migration is complete.

New shared vaults use the **account password** in the browser for PBKDF2 and
AES-256-GCM. It is kept in memory while unlocked, not stored as plaintext in
browser storage. A reload or Passkey sign-in may still ask for the
account password to decrypt the vault. Use a long, unique password: anyone with
an encrypted vault copy can attempt to guess it offline. Sushi sends the account
password to its server for normal sign-in and password verification, so this is
**not zero-knowledge encryption**. The server serves the browser code, and a
compromised server could capture the password. Use HTTPS and trust both your
server and storage provider. The shared store contains the account password
hash/session signing secret, public passkeys, and encrypted vault—not
plaintext saved SSH passwords or private keys.

**Existing vaults:** After enabling shared storage, open the **original browser
first** so its existing account and vault can migrate. Unlock an old master
passphrase vault if necessary, then enter the current account password when
prompted to upload its encrypted contents. If a vault already exists in shared
storage, use **Vault Encryption → Account password sync** when appropriate.
Verify it on a second device before removing the original browser's data.
Device-key vaults and older device-key backups cannot be opened on another
browser: keep the original device key and make a portable backup first.
If the browser has a different local vault from the shared vault, Sushi asks you
to download its encrypted copy before opening the shared one; it does not merge
conflicting vaults automatically. Restoring a backup replaces the current vault.

**Changing the account password:** Use **Account & Passkeys → Password** while
the vault is unlocked. Sushi first keeps the vault decryptable with the old
password, changes the account, then re-encrypts the vault with the new password.
Keep the old password until the final step succeeds. If the update is interrupted,
the interface explains how to unlock with the previous password and enable sync
with the current one. Changing credentials signs out other device sessions; sign
in again there with the new account credentials. Existing sessions also need to
sign in once after upgrading to credential-bound sessions. For environment-managed
passwords changed outside Sushi, sign in with the new password and, if prompted,
unlock the vault with its previous password. A separate-master-passphrase vault
keeps its separate passphrase.

If shared storage is unavailable or an existing vault cannot be read, Sushi does
not silently create an empty account/vault or claim that a save succeeded. On a
VPS, if a crashed process left a `data/*.lock` file, stop all Sushi processes and
confirm no writer is active before removing the **lock file only**; never remove
the `.json` files to clear a lock. Firestore and Vercel vault snapshots are
limited to 4 MiB; self-hosted disk/Redis snapshots are limited to 32 MiB. Firestore
splits larger records into sub-1 MiB documents and updates them transactionally.

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
  `/hosts`, which the server answers with a redirect into the workspace view
  (`/?view=hosts`) because the vault key is only in your browser — the page is never a
  fabricated empty list. **`/hosts?format=json`** answers scripts.
- **`GET /api/hosts`** — the machine-readable half: one entry per machine with `id`,
  `accessUrl`, `protocols`, `counts`, and `links[]` holding `ssh://…`, `sftp://…` and
  `rdp://…` (each labelled `saved` or `derived`). Protected by the normal Sushi session
  (`x-sushi-session`), like every other API — there is no second, weaker secret.
- **One link per machine**: `/hosts?host=<id>` (or `/hosts?host=<id>&protocol=rdp`)
  opens that machine in the workspace, which unlocks the vault and starts the session.
  `?host=` also accepts `user@host` for hand-written links. Links never carry
  credentials.

**Why the single URL is an index, not a dump of your servers.** Sushi's vault is
end-to-end encrypted: the server stores `{iv, ciphertext}` and has no key, so it cannot
read host names or passwords, and returning them in clear would mean storing them in
clear. `/api/hosts` therefore reports the structure honestly — one entry per machine,
its protocols, ports and access URLs, with `encrypted: true` and names redacted
(`host #1`) — and `/hosts` hands the browser to the workspace, where **All hosts**
unlocks the vault and lists the real names, addresses and links. (Earlier the server
printed an empty host list in that case, which read as “you have no hosts”.) A
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
including the local device key used to encrypt a device-key vault. Sign in to
the same configured Sushi deployment in the Home Screen app to open an
account-password-synced vault; the icon itself does not sync data through iCloud.
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

**Pick the one-liner for your platform. Each installs, configures, builds and starts Sushi
(Web UI + SSH + SFTP + guacd for RDP) — no manual config, no cloning by hand.**

| You have | Run this | Notes |
| --- | --- | --- |
| **Docker** (recommended) | `curl -fsSL https://raw.githubusercontent.com/sarakplaystore/sushi/main/scripts/install-vps.sh \| bash` | Installs Docker if missing, starts Sushi + guacd, waits for health, prints the URL. Debian/Ubuntu, Rocky/Alma, Fedora, Arch, Alpine |
| **Docker, prebuilt image** (fastest, no compile) | `docker run -d --name sushi -p 3000:3000 -v sushi-data:/app/data --restart unless-stopped ghcr.io/sarakplaystore/sushi:latest` | Pulls a multi-arch image (~1 min). Needs a separate `guacd` only if you want *live* RDP |
| **Docker Compose, no clone** | `curl -fsSLO https://raw.githubusercontent.com/sarakplaystore/sushi/main/docker-compose.prebuilt.yml && docker compose -f docker-compose.prebuilt.yml up -d` | Sushi **+ guacd** from the published image |
| **Python 3.9+** (no Docker needed) | `python3 install.py` | Cross-platform (Linux, macOS, Windows via WSL). Downloads the source, `npm ci`, builds, starts in the background and health-checks it |
| **Node.js 22 only** | `git clone https://github.com/sarakplaystore/sushi.git && cd sushi && npm ci && npm run build && npm start` | The manual equivalent |
| **Vercel** | Import the repo, add Turso/Firestore/Redis | See [Deploy to Vercel](#3-deploy-to-vercel--optional-companion-gateway-vps-railway-or-render) |
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
*(Vercel needs a Turso / Firestore / Redis database before the admin account can be created — see §3.)*

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi)
*(Deploys the **gateway** from [`render.yaml`](render.yaml) — the native WebSocket PTY companion for a Vercel UI, not the whole app. See §3.)*

**Railway** has no repo-based one-click button: the provisioning helper applies
[`.railway/railway.ts`](.railway/railway.ts) to create `sushi-gateway` **and** `guacd`,
then adds missing gateway variables (see §3 for the CLI and dashboard routes).

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
disables shared vault sync. Firestore or Redis REST can optionally replace disk
for the account and vault; switching stores does not automatically copy data.

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

If a new deployment shows **Connect shared storage**, the guide links to the
[Turso Cloud](https://vercel.com/marketplace/tursocloud/database) and
[Upstash Redis](https://vercel.com/marketplace/upstash/upstash-kv) Marketplace
integrations. Choose **one**, review the provider's plan, and create a database or
connect an existing Vercel-managed resource. On the resource's **Projects** tab,
connect the Sushi project to the environment you use (normally **Production**)
and leave the custom environment-variable prefix blank. Existing external
Turso/Upstash databases can instead be connected with the server-side settings
below. Sushi does not provision a database or enable billing on your behalf.

After connecting a resource or changing variables, open the project's
**Deployments**, redeploy the latest deployment for that environment, and wait
for **Ready**. Return to the production domain or the new deployment URL and
click **Check connection**. An old, unique deployment URL retains its old
settings. If you used `vercel deploy --prebuilt`, create a fresh build and
deployment with the latest settings rather than reusing the old prebuilt output.
The check reads the account status; merely seeing variable names in Vercel does
not prove that the database is reachable or that a vault is healthy. Never paste database
credentials into Sushi, chat, `NEXT_PUBLIC_` variables, or the repository.

**Already using Sushi?** Back up the original store and verify a portable vault
backup before changing anything. Reconnect the original database and namespace;
a new database does not contain or automatically migrate your account and vault.
Keep the original browser's data, existing effective signing secret, and
existing environment-managed credentials. If prompted unexpectedly to create
an account, stop and check the database and namespace instead of creating a new
one. See [existing vaults](#one-account-and-saved-connections-on-multiple-devices)
and the [Firestore migration instructions](#migrate-an-existing-disk-or-redis-store-to-firestore).

1. Provision **Turso (libSQL)**, **[Google Cloud Firestore](#google-cloud-firestore)**,
   or a **Redis database with an Upstash-compatible REST API**. Sushi does not
   create a database or enable billing for you. Back up and migrate existing data
   before changing an existing deployment's backend (see below).
2. Import `sarakplaystore/sushi` into Vercel (Next.js, Node.js `22.x`):
   - **Turso (libSQL):** Connect a Turso database from the Vercel Marketplace
     (with no custom variable prefix, it injects `TURSO_DATABASE_URL` and
     `TURSO_AUTH_TOKEN`), or set `SUSHI_TURSO_DATABASE_URL` +
     `SUSHI_TURSO_AUTH_TOKEN` as server-side secrets. Sushi does not recognize
     arbitrary Marketplace variable prefixes. Sushi automatically provisions
     the `sushi_state_v1` table over Turso's HTTPS
     pipeline (`/v2/pipeline`) on first use.
   - **Firestore:** Use the server-side settings in the next section.
   - **Redis:** Set one complete pair of **server-side** environment variables:
     - `SUSHI_REDIS_REST_URL` and `SUSHI_REDIS_REST_TOKEN`, or
     - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or
     - `KV_REST_API_URL` and `KV_REST_API_TOKEN` (older Vercel KV integrations).

   A partial credential pair (or configuring both Redis and Turso without setting
   `SUSHI_STORAGE_BACKEND=redis` or `SUSHI_STORAGE_BACKEND=turso`) fails closed.
   Never prefix a credential with `NEXT_PUBLIC_` or commit it. Redeploy
   after changing environment variables. Production and preview normally have
   different default namespaces. Use an explicit `SUSHI_STORAGE_PREFIX` only
   for instances that should share the same account; back up the database.
3. Open the deployed URL and create the account once. Other devices visiting
   that deployment see sign-in and can open the same encrypted vault. Without
   persistent storage, first-time interactive setup is blocked instead of
   silently creating a different browser-local account. Existing env-configured
   accounts can still sign in, but have no shared vault until storage is set up.
   For legacy browser-local behavior only, `SUSHI_ALLOW_STATELESS_SETUP=true`
   explicitly opts back in; it does **not** provide cross-device sync.
4. On Vercel, SFTP and serverless SSH work natively, and RDP can probe/export a
   `.rdp` file. A Vercel function can never accept a WebSocket upgrade, so
   *(optional)* attach a **gateway** — one small always-on process — for
   persistent WebSocket PTY shells (full-screen `vim`/`htop`/`tmux`, terminal
   resize), team-shared terminals, and live guacd RDP. All three routes below end
   the same way: one `wss://` URL plus its token, pasted into Sushi's
   **Settings → Gateway** (the panel offers the same snippets behind its
   *VPS / Railway / Render* tabs).

   | Gateway host | What you run | Native PTY | Live RDP | Files |
   | --- | --- | --- | --- | --- |
   | **VPS** (Docker/Node) | Provision a local file, then `docker compose -f docker-compose.gateway.yml up -d --build` | ✅ | ✅ via `guacd` | [`docker-compose.gateway.yml`](docker-compose.gateway.yml), [`Dockerfile.gateway`](Dockerfile.gateway) |
   | **[Railway](https://railway.com/new)** | Create a template once for new projects, or use the setup helper → `sushi-gateway` + `guacd` on one private network | ✅ | ✅ via `guacd` | [Template setup](.railway/TEMPLATE.md), [`.railway/railway.ts`](.railway/railway.ts), [`Dockerfile.gateway`](Dockerfile.gateway) |
   | **[Render](https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi)** | New + → Blueprint → this repo | ✅ | In-browser IronRDP WASM by default; the blueprint does not deploy `guacd` | [`render.yaml`](render.yaml), [`Dockerfile.gateway`](Dockerfile.gateway) |

   **Default origin and overrides:** An up-to-date `GATEWAY_ONLY=true` process uses
   `https://sushi-lyart-three.vercel.app` for `ALLOWED_ORIGIN` **only if the variable is absent**.
   Redeploy the latest gateway code to use this default; older gateways may need it set explicitly.
   Set it to your own frontend's exact origin (scheme, host and optional port, no path or trailing
   slash) when different. Existing settings—including empty strings and `*`—are preserved; both
   empty and `*` allow all origins. The default does not change the full self-hosted app's CORS
   behavior. The gateway checks the configured origin for browser WebSocket upgrades as well as
   HTTP CORS. On an existing gateway, an origin mismatch that previously worked for WebSockets
   will now be rejected; update the override if needed. Requests without an `Origin` remain
   possible for non-browser clients, and origins can be forged outside a browser: origin checks
   are **not authentication**. Continue to protect the token, require HTTPS/WSS and restrict
   network access where possible.

   **Railway template for future new deployments:** Follow the [one-time template setup](.railway/TEMPLATE.md)
   in your Railway workspace. The template composer uses the copyable
   [gateway variables JSON](.railway/gateway-template-variables.json), including Railway's
   `${{secret(48, "abcdef0123456789")}}` template function. When deployed from the saved
   template, it is intended to generate a distinct 48-character hex token without manually
   generating or setting it. Verify this with fresh test deployments before relying on it.
   A repository file does **not** create the template or a deploy link; this route does not
   modify an existing gateway. The separate Sushi browser still needs the generated token and
   URL entered privately. Do not paste the template JSON into a live service.

   **Railway CLI** (`railway.json` is deprecated and stops being read on 2026‑12‑01, so Sushi
   ships Railway's Infrastructure-as-Code file instead). For a **new, dedicated project**,
   from a Sushi checkout with Node 22 and Railway CLI **5.47.2 or newer**:

   **Before applying:** This IaC manages the **entire selected environment**, not just the
   gateway. It can remove services or variables absent from the file. Use a dedicated project,
   review the plan carefully, and cancel if it contains unintended changes. The two gateway
   keys use `preserve()`, but that does not protect unrelated resources or variables.

   ```bash
   npm i -g @railway/cli
   railway login && railway init          # create a dedicated project
   railway status                         # verify the linked project and environment
   npm i --no-save railway@3.17.0         # SDK, only to evaluate .railway/railway.ts
   env -u _ railway config plan           # preview (avoids SDK _ handling)
   # For a new gateway with another frontend, append --origin https://your-app.vercel.app
   node scripts/provision-gateway.mjs railway --apply
   ```

   The helper runs `railway config apply` with Railway's normal confirmation, then adds a
   24-byte random hex token and the default origin **only where each key is absent**. It reads
   variable names without printing values, and passes new values to `railway variable set --stdin`.
   Railway's list response contains unsealed values, which the helper captures in local memory;
   run it only on a trusted machine. A sealed (`null`) key counts as existing. IaC `preserve()`
   alone does not generate secrets.

   For an **existing gateway**, use `railway link`, verify `railway status`, then run
   `node scripts/provision-gateway.mjs railway` **without `--apply`** to avoid changing other
   resources. Add `--environment NAME` / `--service NAME` to select the existing target. Combining
   `--apply` with `--environment` requires Railway CLI 5.64.0 or newer; alternatively link the
   environment first. `--apply` manages the IaC's `sushi-gateway` service; it cannot target a
   different service name. The helper does not overwrite an existing value even when `--origin`
   is supplied—change an existing origin deliberately in the dashboard. If an existing token
   is blank, the helper stops rather than replacing it; set a strong token explicitly or remove
   the blank key and retry. Do not run simultaneous edits/provisioners: Railway's variable upsert
   is not atomic "create if absent". A failed update may have an uncertain outcome; inspect the
   dashboard before retrying.

   After deployment, open the gateway service in the [Railway dashboard](https://railway.com/dashboard)
   and find its public domain under **Settings → Networking → Public Networking**. If necessary,
   select **Generate Domain**, using the service's `PORT` as the target port (the Docker image
   defaults to 3000). Copy the token privately from the service's **Variables**
   ([how Railway variables work](https://docs.railway.com/variables)); apply staged changes if
   prompted and wait for the deployment to become active. Sealed values cannot be read back:
   keep a secure copy before sealing, or deliberately rotate the token and update every client.

   Without the CLI: [*New Project → GitHub Repo → this repository*](https://railway.com/new), set
   **Settings → Build Configuration → Dockerfile Path** to `Dockerfile.gateway`, add a second
   service from the Docker image `guacamole/guacd:1.5.5`, and point `GUACD_HOST` at that service's
   `RAILWAY_PRIVATE_DOMAIN`. For a new gateway, generate a token locally with
   `openssl rand -hex 24` and paste the **output**, not the command, into the gateway's
   `SUSHI_GATEWAY_TOKEN` variable. This dashboard-only route is manual. Add `ALLOWED_ORIGIN`
   if you need to override the default, then **Generate Domain** and deploy the changes.

   **Render**: *New + → Blueprint → this repository* (or the [Deploy to Render button](https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi)
   above). `render.yaml` builds `Dockerfile.gateway`; Render creates and retains a **256-bit base64**
   `SUSHI_GATEWAY_TOKEN` (not 24-byte hex, but stronger) unless one already exists. If an existing
   token is blank, set a strong value explicitly; Render does not replace it. Copy the token privately
   from **sushi-gateway → Environment** in the [Render dashboard](https://dashboard.render.com),
   along with the public `https://…onrender.com` URL. The default origin is supplied at gateway
   startup and may not appear in the Environment tab. Add `ALLOWED_ORIGIN` there if you need a
   different origin; existing overrides are kept because the Blueprint does not manage that key.
   Save and deploy any changes ([Environment Variables and Secrets](https://render.com/docs/configure-environment-variables)).

   **VPS / Docker companion** (from the checkout, with Node 22 and Docker Compose):

   ```bash
   # For a new file and another frontend, append --origin https://your-app.vercel.app
   node scripts/provision-gateway.mjs local
   docker compose -f docker-compose.gateway.yml up -d --build
   ```

   The helper creates `.env.gateway.local` with owner-only permissions and a 24-byte random hex
   token. Rerunning it fills only missing keys and never replaces existing ones; edit an existing
   origin deliberately, or set a strong token yourself if its entry is blank. To avoid Node and
   Docker Compose interpreting an existing file differently, the helper refuses ambiguous dotenv
   syntax without changing the file (for example, single-quote a literal `$` instead of using
   interpolation). This file is gitignored and excluded from Docker builds. Keep and back it up
   securely: it must survive rebuilds, redeployments and all replicas. Read the token privately
   from the file and enter it in Sushi. The Compose gateway binds to `127.0.0.1:3000`; set
   `SUSHI_GATEWAY_PORT` for another host port, and put an HTTPS/WSS reverse proxy in front of it.
   `guacd` stays on the private Compose network.

   For Node without Docker, install dependencies and start the gateway directly; configure a
   reachable private guacd separately if needed:

   ```bash
   npm ci
   HOST=127.0.0.1 NODE_ENV=production GATEWAY_ONLY=true \
     node --env-file=.env.gateway.local --import tsx server.ts
   ```

   Shell environment values take precedence over Node's env file. Do not combine `--env-file`
   with `node --run gateway`: some Node versions do not pass the file's values to the subprocess.

   **Other providers:** Use their persistent secret manager or the local helper to generate a
   token once, then import `SUSHI_GATEWAY_TOKEN` and, if needed, `ALLOWED_ORIGIN` into the gateway
   service. A dashboard/import step may be manual on platforms without a supported secret
   generator. Never generate a token on each container start or store its only copy on ephemeral
   disk. A gateway token authorizes protocol access; it is not an admin sign-in and cannot read or
   change the shared vault.

   **Connect an already-deployed gateway:** In Sushi, open **Settings → Gateway** and choose
   Railway, Render, or VPS under **Find your PTY gateway**. The guide shows where to find the
   public service URL and matching token, and lets you copy this Sushi page's exact origin for
   the gateway's `ALLOWED_ORIGIN`. Paste the base `https://` URL and token into the gateway fields;
   do not append `/ws/ssh` or use a private/`guacd` address. Click **Test Gateway Endpoint**,
   save, and open an SSH session. The test checks public HTTP capabilities only, without sending
   credentials—it does not validate the token or prove that a WebSocket session works. Only use a
   trusted gateway; Sushi saves the token in this browser's local storage. The show button reveals
   only the token entered here; it cannot retrieve a token from the gateway host. If a token is sealed
   or hidden, use a previously saved copy; if you no longer have it, generate and deploy a new strong
   token and update every gateway client. Never share it in chat or commit it. Some RDP WebSocket
   URLs contain tokens in query parameters: configure proxies and monitoring not to log query
   strings or credentials.

   > **Idle sleep.** A managed host that suspends idle services (Render's free instance plan,
   > an unscaled Railway service) cannot answer a WebSocket handshake while asleep, and the
   > first shell then waits for a cold start or fails. To wake it, open its public URL in another
   > tab, wait for a response, and retry the test in Sushi. Use an always-on plan or a VPS for
   > sessions that must remain up. The optional **Keep this gateway awake** toggle attempts a
   > `/health` ping every 4 minutes only while the gateway settings panel is open; browsers or
   > hosts can still suspend it, and a dropped session cannot be restored.

   The gateway image is deliberately slim: it contains no Next.js build and no web assets,
   only `server.ts` with `GATEWAY_ONLY=true`, so it starts in about a second and answers
   `GET /health` and `GET /api/system/capabilities` for platform health checks. Every other
   API route 404s on purpose, which is what makes the Vercel frontend keep using its own
   serverless endpoints (for example *Test SSH Auth* → the Vercel `/api/ssh/test`).

**Upgrading an existing browser-local Vercel account:** Back up the old vault
first. Preserve the existing effective signing secret and deployment identity,
add Turso, Firestore, or Redis configuration, and open the upgraded deployment
first in the original browser, before another visitor creates an account. If
`SUSHI_AUTH_SECRET` was set, keep its existing value; otherwise changing
`SUSHI_AUTH_USERNAME` / `SUSHI_AUTH_PASSWORD` or other inputs used to derive
the secret can make existing sessions or session-key vaults inaccessible. Its
valid signed account profile initializes the empty shared account atomically.
Unlock the original vault and enable account-password sync as above. Passkeys
that existed only as local browser certificates may need to be registered again.

### Google Cloud Firestore

Firestore is an optional **live server database**, not an iCloud connection. It
works with both Vercel and self-hosted Sushi:

1. Create a Google Cloud project and a **Firestore in Native mode** database;
   enable the Firestore API and any required billing. Choose its location
   carefully. Give a server identity permission to read and write Firestore
   documents, for example the **Cloud Datastore User** (`roles/datastore.user`)
   IAM role. The server SDK uses IAM and bypasses Firestore security rules.
2. Set these **server-only** variables in Vercel, your VPS environment, or the
   Compose `.env`, then redeploy/restart. Never put credentials in browser code,
   `NEXT_PUBLIC_` variables, the repository, or chat.
   - `SUSHI_STORAGE_BACKEND=firestore` (required to select Firestore).
   - `SUSHI_FIRESTORE_PROJECT_ID`: the Google Cloud project ID.
   - `SUSHI_FIRESTORE_DATABASE_ID`: optional named database ID; blank uses
     `(default)`.
   - `SUSHI_FIRESTORE_CREDENTIALS_JSON`: service-account JSON as one secret.
     Alternatively leave it blank and use Google **Application Default
     Credentials** (ADC), such as an attached workload identity or an ADC file
     referenced by `GOOGLE_APPLICATION_CREDENTIALS`. In Docker, a credential
     file must be mounted at the path **inside** the container.
3. Use the same project, database and `SUSHI_STORAGE_PREFIX` for every instance
   that should share one Sushi account. By default the prefix is
   `sushi:<VERCEL_PROJECT_ID>:<VERCEL_ENV>` (missing parts default to `default`).
   Set an explicit prefix on all instances when sharing between Vercel and a
   VPS; keep preview and production separate unless sharing is intentional.
   Sidebar **Settings** reports the selected backend, not a live health check.
4. Create the account on a new deployment, or migrate an existing persistent
   store as described below. The account and ciphertext are stored in Firestore;
   Firestore transactions reject conflicting changes. The vault remains encrypted
   with the account password as described above. Firestore outages or invalid
   credentials do not cause Sushi to initialize an empty replacement account.
   Normal account checks and vault sync incur Firestore operations; Google Cloud
   may charge for usage, so review its billing and backup policies.

When `SUSHI_STORAGE_BACKEND` is blank/`auto`, existing Redis-or-disk selection
is unchanged. Firestore variables require explicitly selecting `firestore`;
`disk` is not supported on Vercel. `SUSHI_SERVER_VAULT=false` disables vault sync
but does not move or disable the configured account store.

### Migrate an existing disk or Redis store to Firestore

Switching the backend **does not automatically copy existing data**. Before
switching, create and verify a portable encrypted backup in the original browser
and retain a separate backup of the original database/disk and its configuration.
The optional migration command copies the exact account record (including stored
passkeys and signing secret) and encrypted vault **together** into an empty
Firestore namespace; it never deletes the source or overwrites a target. The
source vault must fit Firestore's 4 MiB limit; both records together must fit
within 6 MiB for the atomic copy. Browser-only data is not in that server store.

1. Make **all** old and new Sushi deployments inaccessible to writers and wait
   for in-flight requests to finish. Keep them stopped until migration and the
   new deployment are verified. The command cannot enforce this for you: writes
   made to the old store after the copy will not be included.
2. On a trusted machine with Node.js 22, the source disk volume or Redis REST
   credentials, and access to Firestore, configure the source settings and the
   Firestore settings above. Preserve `SUSHI_AUTH_SECRET`, environment-managed
   authentication, and the original `SUSHI_STORAGE_PREFIX`/Vercel namespace.
   Use `SUSHI_STORAGE_BACKEND=firestore` for the **destination**. The command
   reads `.env` and accepts normal environment overrides. For a Docker disk
   volume, stop Sushi, then use a one-off container on the same volume, e.g.
   `docker compose run --rm --no-deps sushi npm run migrate:firestore -- ...`.
3. Dry-run, then copy using the appropriate source (`disk` or `redis`):
   ```bash
   npm run migrate:firestore -- --source=redis
   npm run migrate:firestore -- --source=redis --apply --writers-stopped
   ```
   The command checks that the target is empty, writes both records in one
   transaction, and verifies the copy. If the result cannot be confirmed, keep
   the source and inspect the destination before retrying; do not reset either.
4. Start the Firestore deployment and verify sign-in and saved connections on a
   second device before allowing normal use. Keep the old store and backup until
   you have verified recovery. If a namespace already contains account/vault
   data, the migration refuses to overwrite it; resolve it manually first.

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
| [`PRIVACY.md`](PRIVACY.md) | Exactly what is stored and where — `auth.json` (username, `scrypt` verifier, public passkeys), `vault.enc.json` (**AES-256-GCM ciphertext the server cannot decrypt**), browser `localStorage` keys, `/tmp/.sushi-*` files on remote hosts — plus retention, third parties (Google Translate only if `SUSHI_TRANSLATE_URL` is unset), data-subject rights and breach duties. **There is no telemetry and no maintainer backend** |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability privately, what is in/out of scope, and the protections you are expected to enable |

**The short version:** no warranty; you are the operator and the data controller; the maintainer
receives none of your data and owes you no SLA; use it only on systems you are authorized to
access; keep backups. None of these documents is legal advice — if you run Sushi as a service
for other people, have a lawyer review them for your jurisdiction.

Inside the app the same warning appears once, on the sign-in screen and on the launchpad
(AI-assisted · experimental · no warranty), with a link to these files.
