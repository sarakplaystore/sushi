import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { resolve } from "node:path";
import {
  DONATION_ADDRESS,
  DONATION_NETWORKS,
  DONATION_QR_PAYLOADS,
  donationExplorerUrl,
  donationWalletUri,
  isDonationAddressShapeValid,
} from "../src/lib/client/donation";

console.log("==> Testing the crypto donation address (Settings → Donate crypto)...");

// ---- the address itself ---------------------------------------------------------
assert.match(
  DONATION_ADDRESS,
  /^0x[0-9a-fA-F]{40}$/,
  "the published donation address is a 20-byte hex address"
);
assert.ok(isDonationAddressShapeValid(), "shape guard accepts the published address");
assert.equal(isDonationAddressShapeValid("0x1234"), false, "short addresses are rejected");
assert.equal(
  isDonationAddressShapeValid("0xf3430a560b57189a888Ac02763c4d8f383B00F8z"),
  false,
  "non-hex characters are rejected"
);

// EIP-55 checksum: the mixed-case address must match keccak256 of its lowercase
// form, so a single mistyped character on this page is a failing test.
const body = DONATION_ADDRESS.slice(2);
const hash = Buffer.from(keccak_256(Buffer.from(body.toLowerCase(), "utf8"))).toString("hex");
const checksummed =
  "0x" +
  body
    .toLowerCase()
    .split("")
    .map((char, index) => (parseInt(hash[index], 16) >= 8 ? char.toUpperCase() : char))
    .join("");
assert.equal(checksummed, DONATION_ADDRESS, "the address carries a valid EIP-55 checksum");

// ---- wallet / QR payloads -------------------------------------------------------
const addressPayload = DONATION_QR_PAYLOADS.find((p) => p.id === "address");
const uriPayload = DONATION_QR_PAYLOADS.find((p) => p.id === "ethereum");
assert.ok(addressPayload && uriPayload, "the dialog offers both a bare address and an EIP-681 URI");
assert.equal(addressPayload.value, DONATION_ADDRESS, "QR 'Address' encodes exactly the address");
assert.equal(
  uriPayload.value,
  `ethereum:${DONATION_ADDRESS}`,
  "QR 'ethereum:' payload encodes the EIP-681 URI"
);
assert.equal(donationWalletUri(), `ethereum:${DONATION_ADDRESS}`);
assert.equal(
  donationWalletUri(56),
  `ethereum:${DONATION_ADDRESS}@56`,
  "a chain id can be pinned for wallets that ask"
);
// Version 3 (29×29) at level "M" holds enough for the bare address; the
// `ethereum:` URI lands in version 4 (33×33) — both stay easy to scan from a
// phone screen, and the dialog keeps its 168 px QR from getting dense.
import qrcode from "qrcode-generator";
for (const payload of DONATION_QR_PAYLOADS) {
  const qr = qrcode(0, "M");
  qr.addData(payload.value, "Byte");
  qr.make();
  assert.ok(
    qr.getModuleCount() <= 33,
    `${payload.label} QR stays at ≤ 33 modules (got ${qr.getModuleCount()})`
  );
}

// ---- chains and explorer links --------------------------------------------------
assert.ok(DONATION_NETWORKS.length >= 2, "the dialog lists the chains the address works on");
assert.ok(
  DONATION_NETWORKS.some((n) => /Ethereum/.test(n)) &&
    DONATION_NETWORKS.some((n) => /BNB Smart Chain/.test(n)),
  "Ethereum and BNB Smart Chain are documented"
);
assert.equal(donationExplorerUrl(), `https://etherscan.io/address/${DONATION_ADDRESS}`);
assert.equal(donationExplorerUrl("bsc"), `https://bscscan.com/address/${DONATION_ADDRESS}`);
assert.equal(donationExplorerUrl("polygon"), `https://polygonscan.com/address/${DONATION_ADDRESS}`);
assert.equal(donationExplorerUrl("base"), `https://basescan.org/address/${DONATION_ADDRESS}`);
assert.equal(donationExplorerUrl("arbitrum"), `https://arbiscan.io/address/${DONATION_ADDRESS}`);

// ---- decode round-trip: what the dialog draws really scans -----------------------
// Build the exact SVG path the dialog builds, rasterize it, and decode it back
// with an independent QR reader. A wrong address (or a broken renderer) fails.
import jsQR from "jsqr";
import { qrSvgPath } from "../src/lib/client/qr-svg";

function decodeQrPath(path: string, moduleCount: number): string | null {
  const scale = 10;
  const borderModules = 4;
  const total = moduleCount + borderModules * 2;
  const width = total * scale;
  const dark = new Uint8Array(total * total);
  for (const run of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const x = Number(run[1]) + borderModules;
    const y = Number(run[2]) + borderModules;
    const length = Number(run[3]);
    for (let i = 0; i < length; i += 1) dark[y * total + x + i] = 1;
  }
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let py = 0; py < width; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const value = dark[Math.floor(py / scale) * total + Math.floor(px / scale)] ? 0 : 255;
      const offset = (py * width + px) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return jsQR(pixels, width, width)?.data ?? null;
}

for (const payload of DONATION_QR_PAYLOADS) {
  const qr = qrcode(0, "M");
  qr.addData(payload.value, "Byte");
  qr.make();
  const built = qrSvgPath(qr);
  assert.equal(decodeQrPath(built.path, built.moduleCount), payload.value, `${payload.label} QR scans back to its payload`);
}

// The QR committed for the README must scan to the address too (border = 4 modules).
const committedSvg = readFileSync(resolve(process.cwd(), "public", "donate-qr.svg"), "utf8");
const committedPath = committedSvg.match(/<path d="([^"]+)"/)?.[1] ?? "";
const committedModules = Number(committedSvg.match(/viewBox="0 0 (\d+) \d+"/)?.[1] ?? 0) - 8;
assert.ok(committedModules > 0, "donate-qr.svg declares a square viewBox");
assert.equal(
  decodeQrPath(committedPath, committedModules),
  DONATION_ADDRESS,
  "public/donate-qr.svg scans to the donation address"
);

// ---- the UI is wired up ---------------------------------------------------------
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const workspace = read("src/components/SushiWorkspace.tsx");
assert.match(workspace, /import \{ DonateModal \} from "\.\/DonateModal"/, "workspace imports the dialog");
assert.match(workspace, /const \[donateModalOpen, setDonateModalOpen\] = useState\(false\)/, "dialog state");
assert.match(
  workspace,
  /setSettingsOpen\(false\); setDonateModalOpen\(true\);/,
  "Settings menu opens the donation dialog"
);
assert.match(workspace, /<DonateModal[\s\S]{0,120}isOpen=\{donateModalOpen\}/, "dialog is rendered");
assert.match(workspace, />\s*Donate crypto/, "donation action is visible in the UI");

const modal = read("src/components/DonateModal.tsx");
assert.match(modal, /DONATION_ADDRESS/, "the dialog shows the address");
assert.match(modal, /copyTextToClipboard/, "the address can be copied");
assert.match(modal, /import\("qrcode-generator"\)/, "the QR generator is loaded lazily");
assert.match(modal, /Scan with any wallet/, "the QR code explains itself");
assert.match(modal, /Seed phrase|seed phrase/, "warns that no seed phrase is ever requested");
assert.match(modal, /qrSvgPath\(qr\)/, "QR modules are drawn from the generator via qrSvgPath");

const deps = JSON.parse(read("package.json")).dependencies as Record<string, string>;
assert.ok(deps["qrcode-generator"], "qrcode-generator is a runtime dependency");

// ---- README + committed QR stay identical to the code ---------------------------
const readme = read("README.md");
assert.ok(
  readme.includes("## Support Sushi — donate crypto"),
  "README documents the donation address"
);
assert.ok(readme.includes(DONATION_ADDRESS), "README publishes the same address");
assert.ok(readme.includes("public/donate-qr.svg"), "README embeds the committed QR code");
const qrSvg = read("public/donate-qr.svg");
assert.match(qrSvg, /<svg[\s\S]*<path d="M/, "donate-qr.svg is a real, scannable QR code");
assert.ok(qrSvg.includes(DONATION_ADDRESS), "donate-qr.svg names the address it encodes");
assert.match(
  qrSvg,
  /Ethereum, BNB Smart Chain, Polygon, Base, Arbitrum and Optimism/,
  "donate-qr.svg documents the chains in its description"
);

console.log("Crypto donation address tests passed.");
