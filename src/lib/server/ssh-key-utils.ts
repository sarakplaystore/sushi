import crypto from "node:crypto";
import ssh2, { type ParsedKey } from "ssh2";
import type { AuthorizedKeyRecord } from "@/types/auth";

function unwrapParsedKey(
  result: ParsedKey | ParsedKey[] | Error
): ParsedKey {
  if (result instanceof Error) {
    throw result;
  }
  const key = Array.isArray(result) ? result[0] : result;
  if (!key) {
    throw new Error("Unable to parse SSH/PEM key.");
  }
  return key;
}

/* ------------------------------------------------------------------ */
/* Private key repair & format conversion for the ssh2 client          */
/* ------------------------------------------------------------------ */

const PEM_BLOCK_RE = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

/**
 * Repairs common copy/paste damage in a private key so it parses:
 * literal `\n` escapes (from JSON / .env files), CRLF line endings, indented
 * lines, keys flattened onto one line, and text surrounding the PEM block.
 */
export function repairPrivateKeyText(raw: string): string {
  let text = (raw || "").replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n?/g, "\n");

  if (/PuTTY-User-Key-File-/.test(text)) {
    return `${text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")}\n`;
  }

  const match = text.match(PEM_BLOCK_RE);
  if (!match) return text.trim();

  const label = match[1].trim();
  const lines = match[2]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const headers: string[] = [];
  let base64 = "";
  if (lines.length <= 1) {
    // Single-line key: the body may use spaces instead of newlines
    const flat = (lines[0] || "").trim();
    const legacy = flat.match(/^(Proc-Type:\s*\S+)\s+(DEK-Info:\s*\S+)\s+([\s\S]*)$/);
    if (legacy) {
      headers.push(legacy[1], legacy[2]);
      base64 = legacy[3].replace(/\s+/g, "");
    } else {
      base64 = flat.replace(/\s+/g, "");
    }
  } else {
    for (const line of lines) {
      if (/^[A-Za-z-]+:\s/.test(line)) headers.push(line);
      else base64 += line.replace(/\s+/g, "");
    }
  }

  const width = label === "OPENSSH PRIVATE KEY" ? 70 : 64;
  const wrapped = base64.match(new RegExp(`.{1,${width}}`, "g"))?.join("\n") ?? "";
  text = `-----BEGIN ${label}-----\n`;
  if (headers.length > 0) text += `${headers.join("\n")}\n\n`;
  text += `${wrapped}\n-----END ${label}-----\n`;
  return text;
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** Encodes a raw Ed25519 seed + public key as an unencrypted `openssh-key-v1` private key. */
export function encodeOpenSshEd25519PrivateKey(
  seed: Buffer,
  publicKey: Buffer,
  comment = ""
): string {
  const keyType = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.concat([sshString(keyType), sshString(publicKey)]);
  const check = crypto.randomBytes(4);
  const privateSection = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(Buffer.from(comment, "utf8")),
  ]);
  const padLength = (8 - (privateSection.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1));
  const keyCount = Buffer.alloc(4);
  keyCount.writeUInt32BE(1, 0);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString(Buffer.from("none")),
    sshString(Buffer.from("none")),
    sshString(Buffer.alloc(0)),
    keyCount,
    sshString(publicBlob),
    sshString(Buffer.concat([privateSection, padding])),
  ]);
  const b64 = body.toString("base64").match(/.{1,70}/g)?.join("\n") ?? "";
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function describePrivateKeyProblem(
  parseError: Error,
  keyText: string,
  passphrase: string | undefined
): string {
  const msg = parseError.message || "";
  if (/no passphrase given/i.test(msg)) {
    return "This private key is passphrase-protected — enter its passphrase.";
  }
  if (/bad passphrase|bad decrypt|failed to decrypt|integrity check failed/i.test(msg)) {
    return passphrase
      ? "Incorrect passphrase for this private key."
      : "This private key is passphrase-protected — enter its passphrase.";
  }
  if (/PuTTY-User-Key-File-/.test(keyText)) {
    return "This PuTTY .ppk key isn't supported (only .ppk v2 RSA keys are). In PuTTYgen choose Conversions → Export OpenSSH key, and paste that key instead.";
  }
  if (/BEGIN SSH2 (ENCRYPTED )?PRIVATE KEY/.test(keyText)) {
    return "SSH.com / Tectia (SSH2) private keys aren't supported. Convert it with `ssh-keygen -i -f <key>` or export it in OpenSSH format.";
  }
  if (
    /^\s*(ssh-(rsa|dss|ed25519)|ecdsa-sha2-|sk-)/.test(keyText) ||
    /BEGIN (SSH2 |RSA )?PUBLIC KEY/.test(keyText)
  ) {
    return "That's a public key. Paste the PRIVATE key (e.g. ~/.ssh/id_ed25519, not the .pub file).";
  }
  return `Unsupported private key format (${msg || "unreadable key"}). Paste an OpenSSH (BEGIN OPENSSH PRIVATE KEY), PEM (BEGIN RSA / EC PRIVATE KEY) or PKCS#8 (BEGIN PRIVATE KEY) key.`;
}

/**
 * Prepares a pasted private key for the ssh2 client:
 * - repairs copy/paste damage (see `repairPrivateKeyText`);
 * - converts PKCS#8 keys (`BEGIN PRIVATE KEY` / `BEGIN ENCRYPTED PRIVATE KEY`), which
 *   ssh2 cannot parse, into PKCS#1 (RSA), SEC1 (ECDSA) or OpenSSH (Ed25519) format;
 * - throws a clear, actionable error for wrong/missing passphrases, public keys,
 *   PuTTY v3 and other unsupported formats.
 * Returns the key text plus the passphrase to use with it (`undefined` once the key
 * has been decrypted during conversion).
 */
export function normalizePrivateKeyForSsh(
  rawKey: string,
  passphrase?: string
): { privateKey: string; passphrase?: string } {
  const repaired = repairPrivateKeyText(rawKey);
  const pass = passphrase || undefined;
  if (!repaired) {
    throw new Error("Private key is empty.");
  }

  const direct = ssh2.utils.parseKey(repaired, pass);
  if (!(direct instanceof Error)) {
    const parsed = Array.isArray(direct) ? direct[0] : direct;
    if (parsed && !parsed.isPrivateKey()) {
      throw new Error(
        "That's a public key. Paste the PRIVATE key (e.g. ~/.ssh/id_ed25519, not the .pub file)."
      );
    }
    return { privateKey: repaired, passphrase: pass };
  }

  if (/-----BEGIN (ENCRYPTED )?PRIVATE KEY-----/.test(repaired)) {
    const encrypted = /BEGIN ENCRYPTED PRIVATE KEY/.test(repaired);
    if (encrypted && !pass) {
      throw new Error("This private key is passphrase-protected — enter its passphrase.");
    }
    let keyObject: crypto.KeyObject;
    try {
      keyObject = crypto.createPrivateKey({
        key: repaired,
        format: "pem",
        passphrase: pass,
      });
    } catch (err) {
      if (encrypted) {
        throw new Error("Incorrect passphrase for this private key.");
      }
      throw new Error(
        `Could not read this PKCS#8 private key: ${
          err instanceof Error ? err.message : "invalid key"
        }`
      );
    }

    const type = keyObject.asymmetricKeyType;
    if (type === "rsa") {
      return { privateKey: keyObject.export({ type: "pkcs1", format: "pem" }).toString() };
    }
    if (type === "ec") {
      return { privateKey: keyObject.export({ type: "sec1", format: "pem" }).toString() };
    }
    if (type === "ed25519") {
      const jwk = keyObject.export({ format: "jwk" }) as { d?: string; x?: string };
      if (jwk.d && jwk.x) {
        return {
          privateKey: encodeOpenSshEd25519PrivateKey(
            Buffer.from(jwk.d, "base64url"),
            Buffer.from(jwk.x, "base64url")
          ),
        };
      }
    }
    throw new Error(
      `Unsupported PKCS#8 key type "${type ?? "unknown"}" — use an RSA, ECDSA or Ed25519 key.`
    );
  }

  throw new Error(describePrivateKeyProblem(direct, repaired, pass));
}

export function computeOpenSshFingerprint(pubSshBytes: Buffer): string {
  const b64 = crypto
    .createHash("sha256")
    .update(pubSshBytes)
    .digest("base64")
    .replace(/=+$/, "");
  return `SHA256:${b64}`;
}

export function formatOpenSshPublicLine(
  key: ParsedKey,
  comment?: string
): string {
  const pubBuf = key.getPublicSSH();
  const base = `${key.type} ${pubBuf.toString("base64")}`;
  const cleanComment = (comment || key.comment || "").trim();
  return cleanComment ? `${base} ${cleanComment}` : base;
}

/**
 * Parses an OpenSSH authorized_keys line (`ssh-ed25519 AAAA...`), PEM public key,
 * or SSH/PEM private key, extracting ONLY the public key material and SHA256 fingerprint
 * for safe whitelisting.
 */
export function parseAuthorizedPublicKey(
  rawInput: string,
  labelHint?: string,
  passphrase?: string
): AuthorizedKeyRecord {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error("Key input is empty.");
  }

  let parsed: ParsedKey;
  try {
    if (/PRIVATE KEY-----|PuTTY-User-Key-File-/.test(trimmed)) {
      // Private keys (incl. PKCS#8 / pasted-flat keys): only the public half is kept
      const normalized = normalizePrivateKeyForSsh(trimmed, passphrase);
      parsed = unwrapParsedKey(
        ssh2.utils.parseKey(normalized.privateKey, normalized.passphrase)
      );
    } else {
      parsed = unwrapParsedKey(ssh2.utils.parseKey(trimmed, passphrase));
    }
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Invalid SSH/PEM key format: ${err.message}`
        : "Invalid SSH/PEM key format."
    );
  }

  const pubBytes = parsed.getPublicSSH();
  const fingerprint = computeOpenSshFingerprint(pubBytes);
  const label =
    (labelHint || parsed.comment || `${parsed.type} key`).trim().slice(0, 80);
  const publicKeyOpenSSH = formatOpenSshPublicLine(parsed, label);

  return {
    id: fingerprint,
    fingerprint,
    keyType: parsed.type,
    publicKeyOpenSSH,
    label,
    createdAt: Date.now(),
  };
}

/**
 * Parses multi-line `authorized_keys` content (ignoring `#` comments and blank lines)
 * or a JSON array of AuthorizedKeyRecords.
 */
export function parseAuthorizedKeysBlock(raw: string): AuthorizedKeyRecord[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        const out: AuthorizedKeyRecord[] = [];
        for (const item of arr) {
          if (typeof item === "string") {
            try {
              out.push(parseAuthorizedPublicKey(item));
            } catch {
              // skip invalid
            }
          } else if (item && typeof item.publicKeyOpenSSH === "string") {
            try {
              const rec = parseAuthorizedPublicKey(
                item.publicKeyOpenSSH,
                item.label
              );
              out.push({
                ...rec,
                createdAt: Number(item.createdAt || rec.createdAt),
                lastUsedAt: item.lastUsedAt ? Number(item.lastUsedAt) : undefined,
              });
            } catch {
              // skip
            }
          }
        }
        return out;
      }
    } catch {
      // fall through to line-by-line parsing
    }
  }

  const records: AuthorizedKeyRecord[] = [];
  const seen = new Set<string>();

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Strip optional authorized_keys leading options before key-type (e.g. `no-port-forwarding ssh-ed25519 ...`)
    const keyTypeMatch =
      /\b(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.exec(
        line
      );
    const candidate = keyTypeMatch ? keyTypeMatch[0] : line;

    try {
      const rec = parseAuthorizedPublicKey(candidate);
      if (!seen.has(rec.fingerprint)) {
        seen.add(rec.fingerprint);
        records.push(rec);
      }
    } catch {
      // ignore unparseable line
    }
  }

  return records;
}

/**
 * Generates a fresh Ed25519 OpenSSH keypair for whitelisted private-key login or SSH hosts.
 */
export function generateEd25519KeyPair(label = "sushi-admin-key"): {
  privateKey: string;
  publicKey: string;
  record: AuthorizedKeyRecord;
} {
  const cleanLabel = label.trim() || "sushi-admin-key";
  const kp = ssh2.utils.generateKeyPairSync("ed25519", {
    comment: cleanLabel,
  });
  const record = parseAuthorizedPublicKey(kp.public, cleanLabel);
  return {
    privateKey: kp.private,
    publicKey: kp.public.trim(),
    record,
  };
}

/**
 * Cryptographically verifies that `privateKeyInput` is a genuine private key
 * (not merely a public key!) AND matches one of `authorizedKeys` by signing
 * a fresh 32-byte random nonce and verifying the signature against the whitelisted public key.
 */
export function verifyPrivateKeyAgainstWhitelist(
  privateKeyInput: string,
  passphrase: string | undefined,
  authorizedKeys: AuthorizedKeyRecord[]
): { ok: true; matchedKey: AuthorizedKeyRecord } | { ok: false; error: string } {
  const trimmed = privateKeyInput.trim();
  if (!trimmed) {
    return { ok: false, error: "Private key is required." };
  }
  if (!authorizedKeys.length) {
    return {
      ok: false,
      error: "No whitelisted public keys are configured on this Sushi instance yet.",
    };
  }

  let privKey: ParsedKey;
  try {
    const normalized = normalizePrivateKeyForSsh(trimmed, passphrase || undefined);
    privKey = unwrapParsedKey(
      ssh2.utils.parseKey(normalized.privateKey, normalized.passphrase)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/passphrase|decrypt|encrypted/i.test(msg)) {
      return {
        ok: false,
        error: "Private key is encrypted — please enter the correct key passphrase.",
      };
    }
    if (/public key/i.test(msg)) {
      return {
        ok: false,
        error: "Provided key is a public key — a private key is required to sign in.",
      };
    }
    return {
      ok: false,
      error: msg ? `Invalid SSH/PEM private key: ${msg}` : "Invalid SSH/PEM private key format.",
    };
  }

  if (!privKey.isPrivateKey() || typeof privKey.sign !== "function") {
    return {
      ok: false,
      error: "Provided key is a public key — a private key is required to sign in.",
    };
  }

  const candidateFp = computeOpenSshFingerprint(privKey.getPublicSSH());
  const matched = authorizedKeys.find((k) => k.fingerprint === candidateFp);
  if (!matched) {
    return {
      ok: false,
      error: `Key (${candidateFp}) is not in the authorized key whitelist.`,
    };
  }

  // Cryptographic challenge-response proof of private key possession
  try {
    const pubKey = unwrapParsedKey(
      ssh2.utils.parseKey(matched.publicKeyOpenSSH)
    );
    const nonce = crypto.randomBytes(32);
    const signature = privKey.sign(nonce);
    if (signature instanceof Error) {
      return { ok: false, error: "Private key signing check failed." };
    }
    const verified = pubKey.verify(nonce, signature);
    if (verified !== true) {
      return {
        ok: false,
        error: "Cryptographic signature verification failed against whitelisted public key.",
      };
    }
  } catch {
    return {
      ok: false,
      error: "Failed to verify key signature against whitelisted public key.",
    };
  }

  return { ok: true, matchedKey: matched };
}

/**
 * Inspects a private key for Vault Keychain storage, returning its fingerprint,
 * keyType, and derived OpenSSH public key line.
 */
export function inspectPrivateKey(
  privateKeyInput: string,
  passphrase?: string,
  labelHint?: string
): {
  fingerprint: string;
  keyType: string;
  publicKeyOpenSSH: string;
} {
  const normalized = normalizePrivateKeyForSsh(
    privateKeyInput.trim(),
    passphrase || undefined
  );
  const parsed = unwrapParsedKey(
    ssh2.utils.parseKey(normalized.privateKey, normalized.passphrase)
  );
  if (!parsed.isPrivateKey()) {
    throw new Error(
      "This appears to be a public key. Please provide an OpenSSH or PEM private key."
    );
  }
  const pubBytes = parsed.getPublicSSH();
  const fingerprint = computeOpenSshFingerprint(pubBytes);
  const publicKeyOpenSSH = formatOpenSshPublicLine(parsed, labelHint);
  return {
    fingerprint,
    keyType: parsed.type,
    publicKeyOpenSSH,
  };
}
