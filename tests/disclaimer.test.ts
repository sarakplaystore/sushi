import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

console.log("==> Testing AI disclosure, disclaimer, privacy policy & in-app notice...");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const disclaimer = read("DISCLAIMER.md");
const privacy = read("PRIVACY.md");
const security = read("SECURITY.md");
const readme = read("README.md");

// ---- DISCLAIMER.md: the clauses that actually protect an AI-built project ---------
assert.match(disclaimer, /^# Disclaimer, Terms of Use & Limitation of Liability/m, "titled");
assert.match(disclaimer, /## 1\. AI-assisted development disclosure/, "discloses AI assistance up front");
assert.match(
  disclaimer,
  /machine-generated or machine-edited/,
  "says code may be machine-generated and human-reviewed"
);
assert.match(
  disclaimer,
  /No vendor, model provider or AI company involved in producing this code is a party to your\s+use of Sushi/,
  "AI vendors are not parties to the user's use"
);
assert.match(disclaimer, /\*\*"AS IS" and "AS AVAILABLE", without warranty of any kind\*\*/, "AS IS warranty disclaimer");
for (const warranty of ["merchantability", "fitness for\\s+a particular purpose", "non-infringement", "free of defects"]) {
  assert.match(disclaimer, new RegExp(warranty), `disclaims ${warranty.replace("\\s+", " ")}`);
}
assert.match(disclaimer, /## 3\. Assumption of risk — this is remote-access software/, "assumption of risk section");
assert.match(disclaimer, /single-admin account model/, "states the single-admin model honestly");
assert.match(disclaimer, /There is \*\*no undo\*\*/, "warns that destructive actions are unundoable");
assert.match(disclaimer, /## 4\. Limitation of liability/, "liability cap section");
for (const damage of [
  "indirect, incidental, special, consequential, exemplary or punitive damages",
  "loss of profits",
  "loss, corruption, disclosure or unauthorized access of data",
  "downtime",
  "regulatory fines, penalties, or third-party claims",
]) {
  assert.ok(disclaimer.includes(damage), `liability excludes: ${damage}`);
}
assert.match(
  disclaimer,
  /greater of \(a\) the total\s+amount you have paid the maintainer for Sushi in the twelve \(12\) months preceding the claim,\s+or \(b\) twenty \(20\) USD/,
  "aggregate liability is capped (zero/twenty USD)"
);
assert.match(disclaimer, /no SLA, support contract, uptime commitment, security-fix deadline/, "no support/SLA promise");
assert.match(disclaimer, /## 7\. Acceptable use/, "acceptable use rules");
assert.match(disclaimer, /## 8\. Security disclosure and no security guarantee/, "no security guarantee");
assert.match(disclaimer, /without a `LICENSE` file/, "flags the missing LICENSE and that copyright defaults apply");
assert.match(disclaimer, /## 11\. Governing law/, "governing-law placeholder, not a fake jurisdiction");
assert.match(disclaimer, /This is not legal advice/, "not legal advice");
assert.match(disclaimer, /Last updated:\*\*/, "dated");
// It must not invent an entity, address, or jurisdiction it cannot know.
assert.ok(!/Ltd\.|LLC|registered office|VAT number|company number/i.test(disclaimer), "no invented legal entity details");

// ---- PRIVACY.md: claims must match what the code actually does -------------------
assert.match(privacy, /^# Privacy Policy \/ Data-Processing Notice/m, "titled");
assert.match(privacy, /you — the person who deploys Sushi — are the data controller/, "names the controller as the deployer");
assert.match(privacy, /no telemetry endpoint/, "states there is no telemetry");
assert.match(privacy, /`vault\.enc\.json`/, "names the vault file");
assert.match(privacy, /AES-256-GCM ciphertext, encrypted in the browser/, "vault is browser-side encrypted");
assert.match(privacy, /server can derive and provide it/, "documents that the server can derive session-mode keys");
assert.match(privacy, /not zero-knowledge encryption/, "does not misrepresent the server's access");
assert.match(privacy, /Vercel stores no server-side vault; each browser holds its own encrypted vault/, "documents browser-local vaults on Vercel");
assert.match(privacy, /PBKDF2-SHA256\s*\(210,000 iterations\)/, "documents the PBKDF2 cost");
assert.match(privacy, /`scrypt`, N=16384, r=8, p=1/, "documents the scrypt parameters");
assert.match(privacy, /translate\.googleapis\.com|Google Translate `gtx`/, "names the translate third party");
assert.match(privacy, /SUSHI_TRANSLATE_URL/, "explains how to avoid the third-party translator");
assert.match(privacy, /\/tmp\/\.sushi-run-/, "documents remote /tmp artefacts");
assert.match(privacy, /7-day TTL|7 days/, "documents session retention");
assert.match(privacy, /## 7\. Your rights/, "data-subject rights section");
assert.match(privacy, /## 9\. Breach notification/, "breach duties");
assert.match(privacy, /maintainer holds none of your data/i, "explains why the maintainer cannot answer DSRs");

// Cross-check the privacy doc against the implementation it describes.
const authSrc = read("src/lib/server/auth.ts");
assert.match(authSrc, /N: 16384, r: 8, p: 1/, "scrypt settings in auth.ts match the privacy policy");
assert.match(authSrc, /const SESSION_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/, "7-day session TTL matches");
assert.match(authSrc, /bucket\.count >= 12/, "12-attempt login throttle matches");
assert.match(read("src/lib/server/vault-store.ts"), /SCrypt|envelope/, "vault store keeps the envelope");
const cryptoVault = read("src/lib/client/crypto-vault.ts");
assert.match(cryptoVault, /210_000|210000/, "PBKDF2 iterations in code match the doc");
assert.match(cryptoVault, /sushi_encrypted_vault_v1/, "local vault key matches the doc");
assert.match(read("src/lib/client/auth-storage.ts"), /sushi\.auth\.sessionToken\.v1/, "session storage key matches");
assert.match(read("src/lib/client/session-resume.ts"), /sushi_recent_hosts_v1/, "recent-hosts key matches");
assert.match(read("src/lib/server/exec-script.ts"), /RUN_LOG_PREFIX = "\/tmp\/\.sushi-run-"/, "/tmp run log prefix matches");
assert.match(read("src/lib/server/translate.ts"), /translate\.googleapis\.com/, "google translate host matches");
// No analytics/tracking exists — the privacy policy says so, keep it true.
for (const tracker of ["google-analytics", "googletagmanager", "posthog", "mixpanel", "sentry", "segment.com"]) {
  assert.ok(!read("src/app/layout.tsx").includes(tracker), `layout must not load ${tracker}`);
}

// ---- SECURITY.md -----------------------------------------------------------------
assert.match(security, /## Reporting a vulnerability/, "security reporting section");
assert.match(security, /security\/advisories\/new/, "points at GitHub private advisories");
assert.match(security, /Never send real credentials/, "protects reporters");
assert.match(security, /no SLA and no guaranteed fix deadline/, "no fix SLA");

// ---- README + in-app notice ------------------------------------------------------
assert.match(readme, /AI-assisted software provided "AS IS"/, "README leads with the disclaimer");
assert.ok(readme.includes("DISCLAIMER.md") && readme.includes("PRIVACY.md") && readme.includes("SECURITY.md"), "README links all three");
assert.match(readme, /## Legal, privacy & liability \(read this\)/, "README has a legal section");

const notice = read("src/components/AiDisclaimer.tsx");
assert.match(notice, /AI-assisted, experimental software/, "in-app notice says it plainly");
assert.match(notice, /one admin account with full access to every saved host/, "in-app notice states the access model");
assert.match(notice, /blob\/main\/DISCLAIMER\.md/, "in-app notice links the disclaimer");
assert.match(notice, /blob\/main\/PRIVACY\.md/, "in-app notice links the privacy policy");
assert.match(notice, /sushi_ai_disclaimer_dismissed_v1/, "dismissal is remembered per browser");

assert.match(
  read("src/components/AuthGateScreen.tsx"),
  /import \{ AiDisclaimer \} from "\.\/AiDisclaimer"/,
  "sign-in screen imports the notice"
);
const gate = read("src/components/AuthGateScreen.tsx");
assert.ok(
  (gate.match(/<AiDisclaimer variant="card" \/>/g) ?? []).length >= 2,
  "notice appears on both the create-admin and sign-in cards"
);
assert.match(
  read("src/components/SushiWorkspace.tsx"),
  /<AiDisclaimer className="mx-auto mb-4 w-full max-w-5xl" \/>/,
  "launchpad shows the dismissible notice"
);

console.log("AI disclosure, disclaimer, privacy policy & in-app notice tests passed.");
