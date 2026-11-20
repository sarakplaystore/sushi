# Disclaimer, Terms of Use & Limitation of Liability

**Project:** Sushi — self-hosted & Vercel-ready web SSH / SFTP / RDP workspace
**Repository:** <https://github.com/sarakplaystore/sushi>
**Last updated:** 17 November 2026

> **This is not legal advice.** This document is a clear, plain-language statement of how the
> project is provided and what it does *not* promise. It was drafted with AI assistance (see
> §1) precisely so that limitation should be treated with the same caution: if you operate
> Sushi as a service, have a qualified lawyer in your jurisdiction review it before you rely
> on it.

---

## 1. AI-assisted development disclosure

Sushi's source code, documentation and tests have been written **with substantial assistance
from large language models (AI coding assistants)**, reviewed and integrated by the
maintainer. Concretely, that means:

- Parts of the code were machine-generated or machine-edited, then reviewed by a human.
- AI assistance does **not** come with a guarantee of correctness, completeness, security or
  fitness for purpose. Generated code can contain subtle bugs, unsafe defaults, or security
  flaws that no test suite catches.
- The crypto, authentication, vault-encryption, SSH/SFTP/RDP and access-control code paths are
  the highest-risk parts of this project. **Anyone exposing Sushi to the public internet
  should perform an independent security review** appropriate to their risk tolerance before
  doing so.
- No vendor, model provider or AI company involved in producing this code is a party to your
  use of Sushi, and none of them accepts any liability for it.

The presence of AI assistance is disclosed here so that no user can claim they were misled
about the provenance or the review level of the software.

---

## 2. The software is provided "AS IS", without warranty

Sushi is provided **"AS IS" and "AS AVAILABLE", without warranty of any kind**, express or
implied, including but not limited to the implied warranties of **merchantability, fitness for
a particular purpose, title and non-infringement**, and any warranty that the software is
**free of defects, secure, uninterrupted, accurate, or suitable for production use**.

No advice or information — whether given in this repository, in the README, in issues, in
pull requests, in chat, or by any AI assistant — creates a warranty not expressly stated
here. Where a jurisdiction does not allow the exclusion of implied warranties, the exclusions
apply to the maximum extent permitted by that jurisdiction.

**Nothing in this repository is professional advice.** It is not legal, security, network
operations, privacy, financial or compliance advice.

---

## 3. Assumption of risk — this is remote-access software

Sushi connects to **your** servers using **your** credentials. That is inherently dangerous,
and you accept the following risks in full:

1. **You are the operator.** You choose which hosts are reachable, which account can reach
   them, whether the deployment is on the public internet, and how it is hardened. The
   maintainer has no access to, control over, or responsibility for your deployment.
2. **Sushi has a single-admin account model.** There are no per-user roles, per-host
   permissions, or least-privilege accounts in the application itself (at the time of
   writing). Limiting what a person can do must be enforced on the target host (scoped OS
   users, `rbash`, scoped `sudoers`, RDP "Remote Desktop Users") — **not** by handing out the
   admin password.
3. **Compromise means host compromise.** If someone obtains your Sushi credentials, session
   token, browser profile or gateway token, they may be able to run commands as the remote
   accounts you saved. Treat the Sushi URL, `SUSHI_GATEWAY_TOKEN`, vault passphrase and every
   saved private key as production secrets.
4. **Destructive actions are possible by design.** Sushi can run shell commands, delete and
   overwrite files over SFTP, and control desktops over RDP. There is **no undo** for a
   command you run against a production host. Keep backups and test on non-production
   machines.
5. **Third-party infrastructure.** On Vercel, on a VPS provider, Docker, or any RDP/SSH
   target, the availability, security posture and
   billing of those services are governed by *their* terms, not this project's.
6. **No guarantee of interoperability.** Host operating systems, `xrdp`, `guacd`, `sshd`
   versions, corporate proxies, browser passkey support and similar external variables change
   over time and may break features without notice.

---

## 4. Limitation of liability

To the **maximum extent permitted by applicable law**, in no event shall the author,
maintainer, contributors, copyright holders, or anyone who has distributed this software
(collectively, "the Project Parties") be liable for any of the following, whether arising in
contract, tort (including negligence), strict liability, warranty or otherwise, and whether or
not the Project Parties were advised of the possibility:

- **indirect, incidental, special, consequential, exemplary or punitive damages**;
- **loss of profits, revenue, business, goodwill, opportunity or anticipated savings**;
- **loss, corruption, disclosure or unauthorized access of data** — including credentials,
  SSH keys, source code, customer data or personal data;
- **downtime, service interruption, or inability to access a host**;
- **damage to, or unauthorized control of, any server, virtual machine, desktop or network
  reachable through Sushi**;
- **costs of procurement of substitute goods, services or recovery**;
- **regulatory fines, penalties, or third-party claims** arising from your own deployment or
  your own failure to comply with applicable law.

Where liability cannot lawfully be excluded, the Project Parties' **total aggregate liability**
for any and all claims relating to the software is limited to the **greater of (a) the total
amount you have paid the maintainer for Sushi in the twelve (12) months preceding the claim,
or (b) twenty (20) USD**. Sushi is free software provided without charge, so in most cases
that amount is zero.

Some jurisdictions do not allow the exclusion or limitation of certain damages; in those
places the above applies only to the extent permitted, and nothing here limits liability that
cannot be limited by law (for example, liability for intentional misconduct or gross
negligence, where such limitation is prohibited).

---

## 5. No support, maintenance or availability commitment

There is **no SLA, support contract, uptime commitment, security-fix deadline or roadmap
obligation** of any kind. Issues and pull requests may be answered, ignored or closed at the
maintainer's sole discretion. Features may change or be removed in any release. Nothing in
this repository obliges the maintainer to fix a defect, ship a feature, or keep any
integration working.

---

## 6. Your responsibilities as an operator

If you deploy Sushi for yourself or for other people, **you** are responsible for — among
other things — the following. The Project Parties assume you have done them:

- **Lawful use**: you have the right to access every host you connect to. Using Sushi against
  systems you do not own or are not authorized to access is prohibited (see §7).
- **Data protection**: if other people's personal data passes through your deployment or is
  stored in it, you are the **data controller**, and *you* must have a lawful basis, provide a
  privacy notice, handle access/deletion requests, and comply with GDPR / UK GDPR / CCPA /
  PDPA / local equivalents. See [`PRIVACY.md`](PRIVACY.md) for exactly what Sushi does and
  does not store, so you can build your own notice on top of it.
- **Security**: HTTPS in front of the app, a strong unique admin password, passkeys where
  available, network restrictions (VPN / IP allowlist / firewall), keeping the deployment and
  its dependencies patched, backups of the `data/` directory or verified portable vault
  backups, and an incident-response plan.
- **Secrets hygiene**: never commit `.env`, `data/*.json`, vault backups or SSH private keys.
  Rotate `SUSHI_GATEWAY_TOKEN`, `SUSHI_AUTH_SECRET`, host keys and passwords if a deployment is
  ever exposed.
- **Compliance & export control**: you must comply with the laws applicable to you, including
  export-control and sanctions rules that restrict who may receive or use strong encryption or
  remote-administration software.
- **Third-party terms**: comply with your hosting provider, your cloud storage provider, and
  the terms of the systems you connect to. Sushi is not an authorized substitute for a
  provider's own access controls.

---

## 7. Acceptable use

By using this software you agree **not** to use it:

- to access any system without the owner's explicit authorization;
- to evade access controls, monitoring, or billing of any service;
- to exfiltrate data, deploy malware, run botnets, mine crypto, or attack third parties;
- to break the law, including computer-misuse, privacy, surveillance or export-control law;
- to provide a paid remote-access service to third parties while misrepresenting its security
  or warranty status.

The maintainer may refuse support, close issues, or decline contributions from anyone
violating this section. **You are solely liable for your own use.**

---

## 8. Security disclosure and no security guarantee

Sushi implements meaningful protections (client-side AES-256-GCM vault encryption, `scrypt`
password hashing, signed httpOnly sessions, WebAuthn passkeys, rate-limited logins — see
[`SECURITY.md`](SECURITY.md)). **This is not a promise that the software is secure.** Security
is a process, and *your* configuration determines most of it. If you believe you have found a
vulnerability, report it privately as described in `SECURITY.md` rather than opening a public
issue.

---

## 9. Third-party components and links

Sushi depends on open-source packages (Next.js, React, `ssh2`, `ws`, `@noble/*`,
`@simplewebauthn/*`, Guacamole, IronRDP, and others). Each is governed by its **own license and
its own terms**, and several carry their own disclaimers and liability caps that attach to
your use of those components. The repository also links to third-party sites (block
explorers, provider docs, translation services); the Project Parties do not control and are
not responsible for their content, availability or privacy practices.

---

## 10. Licensing, accuracy and changes

- **License.** The repository currently ships **without a `LICENSE` file**, which under
  default copyright law means the code is **all rights reserved** and you have no licence to
  copy, modify or redistribute it beyond what GitHub's Terms of Service and applicable law
  allow. If you intend others to use or contribute to Sushi, add an explicit license (for
  example MIT, Apache-2.0, or AGPL-3.0) — each carries its own warranty and liability terms
  that interact with this document. *This section is not a grant of rights; only an explicit
  `LICENSE` file is.*
- **Accuracy.** Documentation can drift from code. Where this document and the actual
  behaviour of the software disagree, the software's behaviour governs, and you assume the
  risk of relying on either.
- **Changes.** This document may be updated at any time by committing to the repository. The
  version that applies to you is the one present in the commit you deployed.
- **Severability.** If any provision is held unenforceable, the remainder stays in force and
  the unenforceable provision is limited to the minimum extent necessary.
- **No waiver.** Failure to enforce any provision is not a waiver of it.
- **Entire agreement.** These terms, together with `PRIVACY.md`, `SECURITY.md` and any
  `LICENSE` file, are the whole statement about the software, and supersede any informal
  assurance given elsewhere — including anything an AI assistant, chatbot or support reply has
  said about the project.

---

## 11. Governing law and disputes

The Project Parties make **no representation** that Sushi or these documents are appropriate or
available for use in every jurisdiction. If you operate Sushi commercially you should have a
lawyer insert a governing-law and jurisdiction clause tailored to the maintainer's location
and your users. Until such a clause exists, nothing here consents to any particular forum, and
the Project Parties reserve all defences available to them where a claim is brought.

---

## 12. Contact

- Security reports: see [`SECURITY.md`](SECURITY.md) (private reporting first).
- Everything else: open an issue at <https://github.com/sarakplaystore/sushi/issues>.

---

*Sushi is a self-hosted remote-access tool. It is not a managed service, not a security
product, and not a compliance tool. Read §2 and §4 again before you point it at a production
server.*
