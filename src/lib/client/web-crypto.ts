/**
 * Secure-context-independent crypto primitives (browser + Node).
 *
 * Browsers only expose WebCrypto's `crypto.subtle` and `crypto.randomUUID()` in
 * "secure contexts" — HTTPS pages or http://localhost. A self-hosted Sushi opened
 * at `http://<vps-ip>:3000` is NOT a secure context, so every SubtleCrypto call
 * throws and `crypto.randomUUID is not a function` breaks host creation, the
 * encrypted vault, and opening SSH/SFTP/RDP sessions.
 *
 * These helpers use native WebCrypto whenever it is available and otherwise fall
 * back to the audited pure-JS `@noble/ciphers` / `@noble/hashes` implementations.
 * Both paths produce byte-identical output (AES-GCM `ciphertext || tag`, PBKDF2 /
 * HKDF bits, SHA-256 digests), so a vault written over plain HTTP still opens over
 * HTTPS and vice versa. `crypto.getRandomValues()` is available in every context
 * and is used for all randomness.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { pbkdf2Async as noblePbkdf2Async } from "@noble/hashes/pbkdf2.js";

const encoder = new TextEncoder();

let forcePureJs = false;

/** Test hook: force the pure-JS fallback even when native WebCrypto exists. */
export function __setForcePureJsCrypto(value: boolean): void {
  forcePureJs = value;
}

function globalCrypto(): Crypto | undefined {
  return (globalThis as { crypto?: Crypto }).crypto;
}

function nativeSubtle(): SubtleCrypto | null {
  if (forcePureJs) return null;
  const subtle = globalCrypto()?.subtle;
  return subtle && typeof subtle.importKey === "function" ? subtle : null;
}

/** True when native WebCrypto (`crypto.subtle`) can be used in this context. */
export function isNativeWebCryptoAvailable(): boolean {
  return nativeSubtle() !== null;
}

/**
 * True when running in a browser page that is not a secure context
 * (e.g. `http://203.0.113.10:3000`). Passkeys and the async Clipboard API are
 * unavailable there, and traffic to Sushi itself is unencrypted.
 */
export function isInsecureBrowserContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === false;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === "string" ? encoder.encode(input) : input;
}

/** Exact-length ArrayBuffer copy (WebCrypto rejects views over larger buffers in some engines). */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function randomBytes(length: number): Uint8Array {
  const c = globalCrypto();
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("A secure random number generator is unavailable in this browser.");
  }
  const out = new Uint8Array(length);
  // getRandomValues() fills at most 65,536 bytes per call
  for (let offset = 0; offset < length; offset += 65536) {
    c.getRandomValues(out.subarray(offset, Math.min(length, offset + 65536)));
  }
  return out;
}

/** RFC 4122 v4 UUID that also works outside secure contexts. */
export function randomUUID(): string {
  const c = globalCrypto();
  if (!forcePureJs && c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // fall through to the getRandomValues() implementation
    }
  }
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = toBytes(data);
  const subtle = nativeSubtle();
  if (subtle) {
    return new Uint8Array(await subtle.digest("SHA-256", exactBuffer(bytes)));
  }
  return nobleSha256(bytes);
}

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array | string,
  length = 32
): Promise<Uint8Array> {
  const infoBytes = toBytes(info);
  const subtle = nativeSubtle();
  if (subtle) {
    const key = await subtle.importKey("raw", exactBuffer(ikm), "HKDF", false, [
      "deriveBits",
    ]);
    const bits = await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: exactBuffer(salt),
        info: exactBuffer(infoBytes),
      },
      key,
      length * 8
    );
    return new Uint8Array(bits);
  }
  return nobleHkdf(nobleSha256, ikm, salt, infoBytes, length);
}

export async function pbkdf2Sha256(
  password: Uint8Array | string,
  salt: Uint8Array,
  iterations: number,
  length = 32
): Promise<Uint8Array> {
  const pw = toBytes(password);
  const subtle = nativeSubtle();
  if (subtle) {
    const key = await subtle.importKey("raw", exactBuffer(pw), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: exactBuffer(salt), iterations },
      key,
      length * 8
    );
    return new Uint8Array(bits);
  }
  // Async variant yields to the event loop so the UI stays responsive
  return noblePbkdf2Async(nobleSha256, pw, salt, {
    c: iterations,
    dkLen: length,
    asyncTick: 20,
  });
}

/** AES-GCM encrypt; returns `ciphertext || 16-byte tag` exactly like WebCrypto. */
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const subtle = nativeSubtle();
  if (subtle) {
    const cryptoKey = await subtle.importKey("raw", exactBuffer(key), "AES-GCM", false, [
      "encrypt",
    ]);
    const params: AesGcmParams = { name: "AES-GCM", iv: exactBuffer(iv) };
    if (aad) params.additionalData = exactBuffer(aad);
    return new Uint8Array(await subtle.encrypt(params, cryptoKey, exactBuffer(plaintext)));
  }
  return gcm(key, iv, aad).encrypt(plaintext);
}

/** AES-GCM decrypt of `ciphertext || tag` (throws on authentication failure). */
export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad?: Uint8Array,
  tagLengthBytes = 16
): Promise<Uint8Array> {
  const subtle = nativeSubtle();
  if (subtle) {
    const cryptoKey = await subtle.importKey("raw", exactBuffer(key), "AES-GCM", false, [
      "decrypt",
    ]);
    const params: AesGcmParams = {
      name: "AES-GCM",
      iv: exactBuffer(iv),
      tagLength: tagLengthBytes * 8,
    };
    if (aad) params.additionalData = exactBuffer(aad);
    return new Uint8Array(
      await subtle.decrypt(params, cryptoKey, exactBuffer(ciphertextWithTag))
    );
  }
  if (tagLengthBytes !== 16) {
    throw new Error("Only 128-bit AES-GCM tags can be decrypted without WebCrypto.");
  }
  return gcm(key, iv, aad).decrypt(ciphertextWithTag);
}
