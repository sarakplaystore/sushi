# Privacy Policy / Data-Processing Notice

**Project:** Sushi — self-hosted & Vercel-ready web SSH / SFTP / RDP workspace
**Repository:** <https://github.com/sarakplaystore/sushi>
**Last updated:** 20 November 2026

> **Read this first.** Sushi is **self-hosted software, not a service run by the project.**
> The maintainer does not run a Sushi server for you and has no access to your deployment. That
> means **you — the person who deploys Sushi — are the data controller** for everything in it,
> and this document exists to tell you *exactly* what the software stores and sends so you can
> write your own privacy notice and meet your own obligations.
>
> **This is not legal advice.** GDPR, UK GDPR, CCPA/CPRA, Cambodia's PDPA, and other laws have
> different thresholds and wording. Have a qualified professional review anything you publish.

Everything below describes behaviour verifiable in the source tree. Where a statement depends
on how *you* deploy, it says so.

---

## 1. Who is responsible for what

| Role | Who | Responsibility |
|---|---|---|
| **Data controller** | Whoever deploys and operates a Sushi instance | Users, hosts, credentials, retention, access requests, breach notification, their own privacy notice |
| **Software author / maintainer** | The Sushi project maintainer | Publishes the code. **Receives no data from your deployment** |
| **Infrastructure processors** | Your VPS provider, Vercel, your RDP/SSH targets | Process whatever you configure them to; governed by their terms |
| **Third-party recipients** | Google Translate (`gtx`) *only if* you leave translation on its default provider; block explorers only when a user clicks a link | See §6 |

The project maintainer has **no backend, no telemetry endpoint, no analytics account and no
way to see your data**. There is no "phone home".

---

## 2. What Sushi stores, where, and why

### 2.1 On the server (your data store)

| Data | Where | Encrypted? | Why it exists |
|---|---|---|---|
| Admin username | `auth.json` on a VPS, or `SUSHI_AUTH_USERNAME` in the server environment | Not encrypted (needed to sign in) | Authenticate you |
| Password verifier | VPS `auth.json`: `passwordSalt` + `passwordHash` (`scrypt`, N=16384, r=8, p=1) | One-way hash | Verify an interactively created password |
| Environment-managed password | `SUSHI_AUTH_PASSWORD` in your hosting environment when configured | Stored as provided by your host | Authenticate without a server account file, including on Vercel |
| `authSecret` | VPS account file or server environment | Not encrypted by Sushi | Sign sessions and passkey certificates; derive session-mode vault keys |
| WebAuthn passkeys | VPS account file or `SUSHI_PASSKEYS_JSON` | Public credential data only | Passwordless sign-in |
| **Vault contents** — host names, IPs, ports, usernames, passwords, SSH private keys, snippets, whitelist settings | `vault.enc.json` on a VPS; none on Vercel | AES-256-GCM ciphertext, encrypted in the browser | Sync saved connections via a persistent VPS disk |
| Vault revision id | alongside the disk envelope (`_syncRevision`) | n/a | Conflict detection during sync |
| Failed-login counters | **Memory only**, per IP, 5-minute window, 12 attempts | n/a | Brute-force throttling |

Vercel stores no server-side vault; each browser holds its own encrypted vault.
Sushi does not persist decrypted host credentials, SSH private keys in the clear,
terminal output, session history, or IP access logs on its own server (your reverse
proxy or host may log IPs). During normal operation, credentials and commands are
sent to Sushi for the selected connection. If you set `SUSHI_AUTH_PASSWORD`, your
host also holds that plaintext environment value; interactively created VPS
accounts instead persist a password verifier.

Session-mode vault encryption uses a key derived from the server's `authSecret`;
the server can derive and provide it to an authenticated same-origin session.
This is **not zero-knowledge encryption**. Older password/passphrase vaults derive
a key in the browser with PBKDF2-SHA256 (210,000 iterations); device-key vaults
store their key in that browser. Losing the relevant key or passphrase can make
the vault unrecoverable; keep verified portable backups.

### 2.2 In your browser (this device only)

| Key | Contents | Cleared by |
|---|---|---|
| `sushi.auth.sessionToken.v1` | signed session token (also set as an httpOnly `sushi_session` cookie, 7-day TTL) | signing out / cookie expiry |
| `sushi.auth.adminProfileCert.v1`, `sushi.auth.passkeyCerts.v1` | signed profile/password-verifier and **public** passkey certificates (no plaintext passwords or private keys); old admin profiles no longer authorize an account | clearing site data / removing the passkey |
| `sushi_encrypted_vault_v1` | local cache of the **encrypted** vault envelope | clearing site data |
| `sushi_device_aes_key_v1` | a random device key for device-key vaults (the default for new browser-local vaults) | clearing site data |
| `sushi_gateway_settings_v1` | optional gateway URL + gateway token | clearing site data |
| `sushi_recent_hosts_v1`, `sushi_resumable_runs_v1`, `sushi_open_tabs_v1`, `sushi_workspace_tombstones_v1` | session history: host/user/port, command lines, run ids — **never passwords or keys** (runs older than a week are pruned) | the UI's "forget" actions, or clearing site data |
| `sushi_rdp_prefs_v1`, `sushi.translateTarget`, `sushi_mobile_home_v1`, `sushi_http_notice_dismissed`, `sushi_mobile_home_notice_dismissed` | preferences and dismissible notices | clearing site data |

Any browser extension, shared computer profile, or XSS in another app on the same origin can
read the non-httpOnly entries. Use a dedicated browser profile or a private window on shared
machines.

### 2.3 On the hosts you connect to

Sushi's serverless shell writes short-lived artefacts on the **remote** machine so that a
command can survive a closed tab or answer a prompt:

- `/tmp/.sushi-run-<id>.log` — output of a command you ran (tail-read, capped)
- `/tmp/.sushi-keys-<id>` — a FIFO for keystrokes you type into prompts
- `/tmp/.sushi-notimeout-<id>` — holds `sudo` timestamps for the "no timeout" mode

These contain whatever your command printed and may contain secrets. They live under `/tmp`,
are readable by the SSH user you configured, and are your responsibility to clean up if your
host's `/tmp` is not wiped on reboot.

### 2.4 On a gateway VPS, if you use one

A gateway relays WebSocket SSH/RDP traffic and accepts requests authenticated by
`SUSHI_GATEWAY_TOKEN`. It may keep pooled SSH connections open in memory (`SUSHI_SSH_POOL`) and
appears in your VPS provider's logs like any other process. It does not store vault plaintext.

---

## 3. Why the processing is lawful (for controllers who need a basis)

Typical bases under GDPR-style law, to be confirmed by you:

- **Contract / legitimate interest** — authenticating you, storing the connections you asked to
  save, keeping sessions alive.
- **Consent** — only if you choose to enable optional features (e.g. passkeys bind to a device,
  not to marketing).
- **Legal obligation** — retaining access logs where your own law requires it (Sushi does not
  create those logs; your proxy/host may).

Do **not** use Sushi to process special-category data (health, biometric identifiers beyond
passkey public keys, etc.) without the analysis your jurisdiction requires.

---

## 4. Retention

| Data | Retention |
|---|---|
| VPS account + vault files | until **you** delete `data/auth.json` and `data/vault.enc.json` |
| Vercel credentials | until **you** remove them from the hosting environment |
| Session cookie / token | 7 days (server-issued), or until sign-out |
| Local browser entries | until you clear them; recent hosts and runs are pruned after ~7 days |
| Remote `/tmp/.sushi-*` artefacts | until the host reboots or you delete them (`rm -f /tmp/.sushi-*`) |
| Failed-login counters | 5 minutes, in memory, lost on restart |

Deleting the server files or clearing browser storage can destroy the only accessible
vault copy. Keep a verified portable encrypted backup (`Vault & iCloud Drive backup`
in Settings) and its passphrase. The backup includes hosts, snippets, SSH keys and
whitelist settings, but not passkeys or workspace history such as open tabs and
resumable runs.

---

## 5. Security measures (summary — details in `SECURITY.md`)

- Vault: browser-side AES-256-GCM; PBKDF2-SHA256 at 210k iterations and a random salt for passphrase-mode vaults.
- Interactively created VPS passwords: `scrypt` (N=16384, r=8, p=1) with per-account salt; environment passwords are stored as provided by the host.
- Sessions: HMAC-signed, `httpOnly`, `SameSite=Lax`, `Secure` on HTTPS/production, 7-day TTL.
- Passkeys: WebAuthn public-key only; no biometric data ever reaches the server.
- Transport: HTTPS/WSS expected in production (Sushi warns in the UI when you use plain HTTP).
- Login throttling: 12 failures per IP per 5 minutes.
- Multi-revision vault writes prevent one device silently overwriting another.

No system is impenetrable. You remain responsible for HTTPS, strong credentials, patching,
network restrictions and backups.

---

## 6. Third parties and data transfer

| Recipient | When | What is sent |
|---|---|---|
| **Your hosting provider** (VPS, Vercel, Docker host) | always | whatever the process handles; see their terms |
| **Google Translate `gtx`** (`translate.googleapis.com`) | only when a user clicks **Translate** and `SUSHI_TRANSLATE_URL` is **not** set | the **selected/clipboard text** (up to 4,000 chars) plus the target language, over HTTPS. **The author does not control Google's handling — if the text is sensitive, set `SUSHI_TRANSLATE_URL` to a self-hosted LibreTranslate** |
| **Block explorers** (etherscan.io, bscscan.com, polygonscan.com, basescan.org, arbiscan.io) | only when a user clicks a link in the donation dialog | your IP and the public donation address in the request |
| **Your SSH/RDP targets** | always | the credentials and commands you send them |
| **Passkey authenticator** (iCloud Keychain, Google Password Manager, Windows Hello, YubiKey) | only when enrolling/signing in with a passkey | WebAuthn public key + credential id; the biometric stays on your device |
| **npm/CDN at install time** | when you run `npm install` | package downloads (no runtime telemetry) |

There are **no** analytics SDKs, ad networks, session recorders, error-reporting services, or
external font/CDN requests in the runtime code. The app is designed to run fully offline once
installed.

International transfers arise only through the providers you choose (e.g. Vercel or your
VPS provider). Assess and document those yourself.

---

## 7. Your rights, and how to exercise them

Because **the maintainer holds none of your data**, access/deletion/portability requests go to
**the operator of the instance you use**, not to this repository. As an operator, you should
provide a contact and answer within the statutory window (30 days under GDPR, 45 under CCPA,
etc.).

Practical mechanics the software gives you:

- **Access / portability** — Settings → *Import / Export* exports your hosts (with or without
  secrets) and Settings → *Vault & iCloud Drive backup* produces an encrypted portable file.
- **Erasure** — sign out, clear the browser entries in §2.2, delete `data/auth.json` and
  `data/vault.enc.json` or remove hosting environment credentials, remove `/tmp/.sushi-*` on
  connected hosts, and rotate any credential you ever stored.
- **Rectification / restriction** — edit or delete individual hosts in the vault through the
  authenticated workspace.
- **Objection / withdrawal** — stop using the instance; delete the deployment.

---

## 8. Children

Sushi is an infrastructure administration tool, not directed at children, and should not be
offered to anyone under the age at which they can lawfully consent to processing in your
jurisdiction (13–18 depending on country).

---

## 9. Breach notification

If your deployment is compromised, **you** must assess and notify under your local law
(72 hours under GDPR to a supervisory authority where the threshold is met). Rotate the admin
password, `SUSHI_AUTH_SECRET`, `SUSHI_GATEWAY_TOKEN`, all saved host credentials and affected
SSH keys; revoke passkeys; and assume any credential in the vault was exposed.

---

## 10. Changes

This notice may change with any commit; the version in the commit you deployed is the one that
applies to that deployment. Material changes should be noted in the repository's commit
history — review it before upgrading, and re-read this file after you do.

---

## 11. Contact

- Privacy questions about **this repository's code**: open an issue at
  <https://github.com/sarakplaystore/sushi/issues>.
- Privacy questions about **a deployment you use**: contact that deployment's operator — the
  maintainer cannot see, retrieve, or delete your data.

---

*Nothing in this document is legal advice, and it creates no obligation on the maintainer to
process, retain or protect data on your behalf — the software runs on your infrastructure, under
your control.*
