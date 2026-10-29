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
    parsed = unwrapParsedKey(ssh2.utils.parseKey(trimmed, passphrase));
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
    privKey = unwrapParsedKey(
      ssh2.utils.parseKey(trimmed, passphrase || undefined)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/passphrase|decrypt|encrypted/i.test(msg)) {
      return {
        ok: false,
        error: "Private key is encrypted — please enter the correct key passphrase.",
      };
    }
    return {
      ok: false,
      error: "Invalid SSH/PEM private key format.",
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
  const trimmed = privateKeyInput.trim();
  const parsed = unwrapParsedKey(
    ssh2.utils.parseKey(trimmed, passphrase || undefined)
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
