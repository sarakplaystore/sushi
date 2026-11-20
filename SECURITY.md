# Security Policy

**Project:** Sushi — self-hosted & Vercel-ready web SSH / SFTP / RDP workspace
**Last updated:** 17 November 2026

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use **GitHub's private vulnerability reporting** on this repository
(*Security* tab → *Report a vulnerability*, i.e.
<https://github.com/sarakplaystore/sushi/security/advisories/new>). If that is unavailable,
open a minimal public issue that says only "security report — please contact me" and wait for a
private channel; do not include exploit details, credentials, hostnames or data in it.

Useful in a report:

- Affected version / commit, and how you deployed it (VPS, Vercel, gateway).
- Which component: auth, passkey, vault sync, SSH exec, SFTP, RDP/guacd, WebSocket gateway.
- Reproduction steps, and the impact you believe it has.
- Whether the issue is already public anywhere.

**Never send real credentials, private keys, passphrases, customer data or `.env` contents.**
Redact them.

## What to expect

Sushi is a volunteer, **AI-assisted** project provided without warranty (see
[`DISCLAIMER.md`](DISCLAIMER.md)). There is **no SLA and no guaranteed fix deadline**. Reports
are triaged on a best-effort basis; confirmed issues are fixed on `main` and noted in the commit
history. Please allow reasonable time for a fix before publishing details.

## Scope

In scope — code in this repository: authentication and session handling, WebAuthn/passkey
verification, vault encryption and sync, SFTP/ZIP streaming and path handling, serverless SSH
execution and its `/tmp/.sushi-*` channels, RDP parameter handling, gateway CORS/token checks,
SSRF-ish behaviour in probes, and XSS in rendered terminal/SFTP/RDP output.

Out of scope — findings that depend on: you running Sushi over plain HTTP, weak/reused
passwords, a compromised browser profile or extension, host-level root compromise, missing
patches in Next.js/Node/Docker/`sshd`/`xrdp`/`guacd` themselves, third-party providers, and
"the admin account can access every host" (that is the documented single-admin design, not a
vulnerability — see `DISCLAIMER.md` §3.2).

## Shared SSH sessions (team sharing)

A shared terminal is a live handover of the host account: everyone attached to
`/share/<id>` runs commands as that connection's SSH user, and the shell stays up on the
server (default 12 h) after the last person leaves. Share only with people you would
give the host password to, prefer the read-only mode when someone only needs to watch,
and stop the share when the work is done. Rotate the 6-digit code if a link leaks, or
switch the share to *signed-in Sushi accounts* so no code exists at all.

## Baseline protections you should enable

HTTPS in front of the app, a strong unique password, passkeys where available, network
restriction (VPN / IP allowlist), `SUSHI_GATEWAY_TOKEN` when bridging to a Vercel frontend,
backups of the self-hosted `data/` directory or verified portable vault backups, and prompt patching.
