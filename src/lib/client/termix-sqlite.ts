import type {
  CommandSnippet,
  HostProfile,
  ProtocolType,
  RdpSecurityMode,
  WhitelistedSshKey,
} from "@/types/connection";
import type { Database, InitSqlJsStatic, SqlJsStatic, SqlValue } from "sql.js";

/**
 * Termix SQLite database importer (`Termix-SSH/Termix`).
 *
 * Runs entirely in the browser (and in Node 22 for tests) using sql.js + WebCrypto,
 * so the Termix database, its `.env` master keys, and every decrypted secret stay
 * on the user's device: nothing is uploaded to the Sushi server, and Vercel's
 * 4.5 MB serverless request limit does not apply.
 *
 * Supported inputs:
 *  - `db.sqlite`: plaintext SQLite (Termix with `DB_FILE_ENCRYPTION=false`)
 *  - `db.sqlite.encrypted`: Termix's default encrypted-at-rest file
 *    (`[UInt32BE metadataLength][metadata JSON][AES-256-GCM ciphertext]`,
 *    keyed by `DATABASE_KEY`), plus the legacy two-file layout with a separate
 *    `db.sqlite.encrypted.meta`, and legacy `v1` files (PBKDF2 `DB_FILE_KEY` seed)
 *
 * Secret columns (`ssh_data.password/key/key_password`,
 * `ssh_credentials.password/private_key/key/key_password`,
 * `host_protocol_auth.password/secret_fields`) use Termix FieldCrypto:
 * AES-256-GCM with HKDF-SHA256(userDEK, salt, `${recordId}:${fieldName}`).
 * User data keys (DEKs) are unwrapped from the `settings` table:
 *  - `user_dek_v3_<userId>`: HKDF(ENCRYPTION_KEY, "", `termix:dek-wrap:v3:<userId>`), AAD = userId
 *  - `user_encrypted_dek_<userId>` + `user_kek_salt_<userId>`: PBKDF2(Termix password) (2.x)
 *  - `user_encrypted_dek_oidc_<userId>` / `user_encrypted_dek_webauthn_<userId>`: system wraps
 */

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type TermixSqliteFileKind =
  | "sqlite"
  | "termix-encrypted-v2"
  | "termix-encrypted-v1";

export type TermixDekUnlockMethod =
  | "encryption_key"
  | "password"
  | "oidc_system_key"
  | "passkey_system_key";

export interface TermixSqliteUserInfo {
  id: string;
  username: string;
  isAdmin: boolean;
  hostCount: number;
  credentialCount: number;
  snippetCount: number;
  /** True when this user's data key (DEK) was unlocked and their secrets can be decrypted. */
  unlocked: boolean;
  unlockMethod?: TermixDekUnlockMethod;
  /** Which kind of wrapped data key the database holds for this user. */
  wrapKinds: Array<"v3" | "password" | "oidc" | "passkey">;
  /** Encrypted secret fields (in the imported scope) that could not be decrypted. */
  lockedSecrets: number;
}

export interface TermixSqliteSecretStats {
  plaintext: number;
  decrypted: number;
  locked: number;
}

export interface TermixSqliteImportOptions {
  /** Contents of Termix's `.env` file (`DATABASE_KEY`, `ENCRYPTION_KEY`, ...) or a bare 64-hex key. */
  termixEnv?: string;
  /** Termix account password: unlocks legacy (2.x) password-wrapped data keys. */
  termixPassword?: string;
  /** Contents of `db.sqlite.encrypted.meta` for the legacy two-file encrypted layout. */
  metaJson?: string;
  /** Only import data owned by this Termix user id. */
  onlyUserId?: string;
  /** Existing Sushi keychain entries, used to de-duplicate imported SSH keys. */
  existingSshKeys?: WhitelistedSshKey[];
  /** Override the sql.js loader (tests). */
  loadSqlJs?: () => Promise<SqlJsStatic>;
}

export interface TermixSqliteImportResult {
  status: "ok" | "needs_database_key";
  fileKind: TermixSqliteFileKind;
  /** Set when `status === "needs_database_key"`. */
  message?: string;
  hosts: HostProfile[];
  sshKeys: WhitelistedSshKey[];
  snippets: CommandSnippet[];
  users: TermixSqliteUserInfo[];
  secrets: TermixSqliteSecretStats;
  /** Hosts that could not be imported (VNC/Telnet-only, missing address, ...). */
  skippedHosts: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Byte, encoding & WebCrypto helpers (browser + Node 22)              */
/* ------------------------------------------------------------------ */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto is unavailable in this browser context. Open Sushi over HTTPS (or http://localhost) to decrypt Termix databases."
    );
  }
  return subtle;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(clean)) {
    throw new Error("Invalid hex value");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length = 32
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    "raw",
    toArrayBuffer(ikm),
    "HKDF",
    false,
    ["deriveBits"]
  );
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(textEncoder.encode(info)),
    },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function pbkdf2Sha256(
  secret: string,
  salt: Uint8Array,
  iterations: number,
  length = 32
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    "raw",
    toArrayBuffer(textEncoder.encode(secret)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations,
    },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const cryptoKey = await subtle.importKey(
    "raw",
    toArrayBuffer(key),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const params: AesGcmParams = {
    name: "AES-GCM",
    iv: toArrayBuffer(iv),
    tagLength: tag.length * 8,
  };
  if (aad) params.additionalData = toArrayBuffer(aad);
  const plain = await subtle.decrypt(
    params,
    cryptoKey,
    toArrayBuffer(concatBytes(ciphertext, tag))
  );
  return new Uint8Array(plain);
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/* ------------------------------------------------------------------ */
/* Termix `.env` secrets                                               */
/* ------------------------------------------------------------------ */

export interface TermixEnvSecrets {
  databaseKey?: Uint8Array;
  encryptionKey?: Uint8Array;
  dbFileKey?: string;
  oidcSystemSecret?: string;
  webauthnSystemSecret?: string;
  /** True when the input was a single bare 64-hex key rather than a `.env` file. */
  bareKey?: boolean;
}

const HEX_KEY_RE = /^[0-9a-f]{64,}$/i;

function stripQuotes(value: string): string {
  const t = value.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function parseHexKey(value: string | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  const clean = stripQuotes(value);
  if (!HEX_KEY_RE.test(clean)) return undefined;
  // Mirror Node's Buffer.from(hex, "hex"), which ignores a trailing odd nibble.
  return hexToBytes(clean.length % 2 === 0 ? clean : clean.slice(0, -1));
}

/**
 * Extracts Termix master secrets from a pasted `.env` file (`KEY=value`),
 * docker-compose `environment:` entries (`KEY: value` / `- KEY=value`),
 * or a bare 64-character hex key (tried as both DATABASE_KEY and ENCRYPTION_KEY).
 */
export function parseTermixEnvSecrets(raw?: string): TermixEnvSecrets {
  const trimmed = raw?.trim();
  if (!trimmed) return {};

  if (!/[=:\n]/.test(trimmed)) {
    const bare = parseHexKey(trimmed);
    if (bare) {
      return { databaseKey: bare, encryptionKey: bare, bareKey: true };
    }
  }

  const out: TermixEnvSecrets = {};
  for (const rawLine of trimmed.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/i, "").replace(/^-\s+/, "");
    const match = line.match(/^([A-Za-z0-9_]+)\s*[=:]\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toUpperCase();
    const value = stripQuotes(match[2].replace(/\s+#.*$/, ""));
    switch (key) {
      case "DATABASE_KEY":
        out.databaseKey = parseHexKey(value) ?? out.databaseKey;
        break;
      case "ENCRYPTION_KEY":
        out.encryptionKey = parseHexKey(value) ?? out.encryptionKey;
        break;
      case "DB_FILE_KEY":
        if (value) out.dbFileKey = value;
        break;
      case "OIDC_SYSTEM_SECRET":
        if (value) out.oidcSystemSecret = value;
        break;
      case "WEBAUTHN_SYSTEM_SECRET":
        if (value) out.webauthnSystemSecret = value;
        break;
      default:
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Database file detection & decryption                                */
/* ------------------------------------------------------------------ */

const SQLITE_MAGIC = textEncoder.encode("SQLite format 3\u0000");

interface TermixFileMetadata {
  iv: string;
  tag: string;
  version?: string;
  algorithm?: string;
  salt?: string;
  dataSize?: number;
  fingerprint?: string;
}

function hasSqliteHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= SQLITE_MAGIC.length &&
    bytesEqual(bytes.subarray(0, SQLITE_MAGIC.length), SQLITE_MAGIC)
  );
}

function isFileMetadata(value: unknown): value is TermixFileMetadata {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return typeof m.iv === "string" && typeof m.tag === "string";
}

function readEmbeddedMetadata(
  bytes: Uint8Array
): { meta: TermixFileMetadata; payload: Uint8Array } | null {
  if (bytes.length < 8) return null;
  const metaLen =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (metaLen < 2 || metaLen > 65536 || 4 + metaLen > bytes.length) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      textDecoder.decode(bytes.subarray(4, 4 + metaLen))
    );
    if (isFileMetadata(parsed)) {
      return { meta: parsed, payload: bytes.subarray(4 + metaLen) };
    }
  } catch {
    // not an embedded Termix metadata header
  }
  return null;
}

function parseMetaJson(raw?: string): TermixFileMetadata | null {
  if (!raw?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isFileMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when `text` is a Termix `db.sqlite.encrypted.meta` sidecar file. */
export function isTermixMetadataJson(text: string): boolean {
  const parsed = parseMetaJson(text);
  return Boolean(
    parsed &&
      !("ciphertext" in parsed) &&
      !("hosts" in parsed) &&
      (parsed.version || parsed.algorithm || parsed.fingerprint)
  );
}

/**
 * Whether a picked file should go through the Termix SQLite importer
 * (rather than the JSON / OpenSSH config importer).
 */
export function looksLikeTermixDatabaseFile(
  bytes: Uint8Array,
  fileName = ""
): boolean {
  if (hasSqliteHeader(bytes) || readEmbeddedMetadata(bytes)) return true;
  if (/\.(sqlite3?|db|encrypted)$/i.test(fileName)) return true;
  // Binary (non-text) content can't be a JSON export or OpenSSH config.
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  for (const b of sample) {
    const isTextControl = b === 9 || b === 10 || b === 12 || b === 13 || b === 27;
    if (b < 32 && !isTextControl) return true;
  }
  return false;
}

type UnwrapResult =
  | { ok: true; sqlite: Uint8Array; kind: TermixSqliteFileKind }
  | { ok: false; kind: TermixSqliteFileKind; message: string };

async function unwrapDatabaseFile(
  bytes: Uint8Array,
  env: TermixEnvSecrets,
  metaJson?: string
): Promise<UnwrapResult> {
  if (hasSqliteHeader(bytes)) {
    return { ok: true, sqlite: bytes, kind: "sqlite" };
  }

  let meta: TermixFileMetadata;
  let payload: Uint8Array;
  const embedded = readEmbeddedMetadata(bytes);
  if (embedded) {
    meta = embedded.meta;
    payload = embedded.payload;
  } else {
    const external = parseMetaJson(metaJson);
    if (!external) {
      throw new Error(
        "Unrecognized database file. Expected a Termix SQLite database (db.sqlite) or encrypted database (db.sqlite.encrypted). If your db.sqlite.encrypted came with a separate db.sqlite.encrypted.meta file, select both files together."
      );
    }
    meta = external;
    payload = bytes;
  }

  if (typeof meta.dataSize === "number" && meta.dataSize !== payload.length) {
    throw new Error(
      `The encrypted Termix database looks truncated (expected ${meta.dataSize} bytes, got ${payload.length}). Copy db.sqlite.encrypted again while Termix is idle.`
    );
  }
  const algorithm = (meta.algorithm || "aes-256-gcm").toLowerCase();
  if (algorithm !== "aes-256-gcm") {
    throw new Error(`Unsupported Termix database cipher "${meta.algorithm}".`);
  }

  let iv: Uint8Array;
  let tag: Uint8Array;
  try {
    iv = hexToBytes(meta.iv);
    tag = hexToBytes(meta.tag);
  } catch {
    throw new Error("The Termix database metadata (iv/tag) is corrupted.");
  }

  if (meta.version === "v1") {
    if (!meta.salt) {
      throw new Error("This legacy (v1) Termix database is missing its salt.");
    }
    const salt = hexToBytes(meta.salt);
    const seeds = [env.dbFileKey, "termix-database-file-encryption-seed-v1"]
      .filter((s): s is string => Boolean(s));
    for (const seed of seeds) {
      try {
        const key = await pbkdf2Sha256(seed, salt, 100000);
        const plain = await aesGcmDecrypt(key, iv, payload, tag);
        if (hasSqliteHeader(plain)) {
          return { ok: true, sqlite: plain, kind: "termix-encrypted-v1" };
        }
      } catch {
        // try next seed
      }
    }
    return {
      ok: false,
      kind: "termix-encrypted-v1",
      message:
        "This legacy (v1) Termix database was sealed with a custom DB_FILE_KEY. Paste your Termix .env (including DB_FILE_KEY) to decrypt it.",
    };
  }

  const candidates = [env.databaseKey, env.encryptionKey].filter(
    (k): k is Uint8Array => Boolean(k && k.length === 32)
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      kind: "termix-encrypted-v2",
      message:
        "This is an encrypted Termix database (db.sqlite.encrypted). Paste your Termix .env file (or its DATABASE_KEY) to decrypt it in your browser.",
    };
  }
  for (const key of candidates) {
    try {
      const plain = await aesGcmDecrypt(key, iv, payload, tag);
      if (hasSqliteHeader(plain)) {
        return { ok: true, sqlite: plain, kind: "termix-encrypted-v2" };
      }
    } catch {
      // wrong key, try next
    }
  }
  return {
    ok: false,
    kind: "termix-encrypted-v2",
    message:
      "That DATABASE_KEY could not decrypt this db.sqlite.encrypted (authentication failed). Copy DATABASE_KEY from the .env of the same Termix instance — it changes whenever Termix's data volume is recreated.",
  };
}

/* ------------------------------------------------------------------ */
/* sql.js loader                                                       */
/* ------------------------------------------------------------------ */

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/** Lazily loads sql.js (single-file WASM build, ~1 MB) only when a SQLite file is imported. */
export function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = import("sql.js/dist/sql-wasm-inline.js")
      .then((mod) => {
        let init: unknown = mod;
        for (let i = 0; i < 3 && typeof init !== "function"; i++) {
          init = (init as { default?: unknown } | null)?.default;
        }
        if (typeof init !== "function") {
          throw new Error("Failed to load the SQLite engine (sql.js).");
        }
        return (init as InitSqlJsStatic)();
      })
      .catch((err) => {
        sqlJsPromise = null;
        throw err;
      });
  }
  return sqlJsPromise;
}

type Row = Record<string, SqlValue>;

function selectAll(db: Database, sql: string): Row[] {
  const results = db.exec(sql);
  if (results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map((vals) => {
    const row: Row = {};
    columns.forEach((col, idx) => {
      row[col] = vals[idx];
    });
    return row;
  });
}

/* ------------------------------------------------------------------ */
/* Termix DEK unwrapping & field decryption                            */
/* ------------------------------------------------------------------ */

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function unwrapV3Dek(
  userId: string,
  raw: string,
  encryptionKey: Uint8Array
): Promise<Uint8Array | null> {
  const w = parseJsonObject(raw);
  if (
    !w ||
    w.v !== 3 ||
    w.alg !== "aes-256-gcm" ||
    typeof w.iv !== "string" ||
    typeof w.ct !== "string" ||
    typeof w.tag !== "string"
  ) {
    return null;
  }
  try {
    const wrapKey = await hkdfSha256(
      encryptionKey,
      new Uint8Array(0),
      `termix:dek-wrap:v3:${userId}`
    );
    return await aesGcmDecrypt(
      wrapKey,
      base64ToBytes(w.iv),
      base64ToBytes(w.ct),
      base64ToBytes(w.tag),
      textEncoder.encode(userId)
    );
  } catch {
    return null;
  }
}

async function unwrapLegacyDek(
  raw: string,
  kek: Uint8Array
): Promise<Uint8Array | null> {
  const w = parseJsonObject(raw);
  if (
    !w ||
    typeof w.data !== "string" ||
    typeof w.iv !== "string" ||
    typeof w.tag !== "string"
  ) {
    return null;
  }
  try {
    return await aesGcmDecrypt(
      kek,
      hexToBytes(w.iv),
      hexToBytes(w.data),
      hexToBytes(w.tag)
    );
  } catch {
    return null;
  }
}

interface UnlockedDek {
  dek: Uint8Array;
  method: TermixDekUnlockMethod;
}

async function unlockUserDek(
  userId: string,
  settings: Map<string, string>,
  env: TermixEnvSecrets,
  password: string | undefined
): Promise<{ unlocked: UnlockedDek | null; wrapKinds: TermixSqliteUserInfo["wrapKinds"] }> {
  const wrapKinds: TermixSqliteUserInfo["wrapKinds"] = [];

  // 1. Termix v3: DEK wrapped by the system ENCRYPTION_KEY (no password needed)
  const v3 = settings.get(`user_dek_v3_${userId}`);
  if (v3) {
    wrapKinds.push("v3");
    if (env.encryptionKey) {
      const dek = await unwrapV3Dek(userId, v3, env.encryptionKey);
      if (dek) return { unlocked: { dek, method: "encryption_key" }, wrapKinds };
    }
  }

  // 2. Termix 2.x password wrap: PBKDF2(password, user_kek_salt_*)
  const pwWrap = settings.get(`user_encrypted_dek_${userId}`);
  const saltRaw = settings.get(`user_kek_salt_${userId}`);
  if (pwWrap && saltRaw) {
    wrapKinds.push("password");
    const saltInfo = parseJsonObject(saltRaw);
    if (
      password &&
      saltInfo &&
      typeof saltInfo.salt === "string" &&
      typeof saltInfo.iterations === "number"
    ) {
      try {
        const kek = await pbkdf2Sha256(
          password,
          hexToBytes(saltInfo.salt),
          saltInfo.iterations
        );
        const dek = await unwrapLegacyDek(pwWrap, kek);
        if (dek) return { unlocked: { dek, method: "password" }, wrapKinds };
      } catch {
        // wrong password
      }
    }
  }

  // 3. Termix 2.x OIDC system wrap
  const oidcWrap = settings.get(`user_encrypted_dek_oidc_${userId}`);
  if (oidcWrap) {
    wrapKinds.push("oidc");
    const keks: Array<() => Promise<Uint8Array>> = [];
    if (env.oidcSystemSecret) {
      const secret = env.oidcSystemSecret;
      keks.push(() => pbkdf2Sha256(secret, textEncoder.encode(userId), 100000));
    }
    if (env.encryptionKey) {
      const ek = env.encryptionKey;
      keks.push(() =>
        hkdfSha256(ek, textEncoder.encode(userId), "termix:oidc-user-kek")
      );
    }
    keks.push(() =>
      pbkdf2Sha256(
        "termix-oidc-system-secret-default",
        textEncoder.encode(userId),
        100000
      )
    );
    for (const makeKek of keks) {
      try {
        const dek = await unwrapLegacyDek(oidcWrap, await makeKek());
        if (dek) return { unlocked: { dek, method: "oidc_system_key" }, wrapKinds };
      } catch {
        // next candidate
      }
    }
  }

  // 4. Termix 2.x passkey (WebAuthn) system wrap
  const webauthnWrap = settings.get(`user_encrypted_dek_webauthn_${userId}`);
  if (webauthnWrap) {
    wrapKinds.push("passkey");
    const keks: Array<() => Promise<Uint8Array>> = [];
    const configured = env.webauthnSystemSecret || env.oidcSystemSecret;
    if (configured) {
      keks.push(() =>
        pbkdf2Sha256(configured, textEncoder.encode(`webauthn:${userId}`), 100000)
      );
    }
    if (env.encryptionKey) {
      const ek = env.encryptionKey;
      keks.push(() =>
        hkdfSha256(ek, textEncoder.encode(userId), "termix:webauthn-user-kek")
      );
    }
    keks.push(() =>
      pbkdf2Sha256(
        "termix-webauthn-system-secret-default",
        textEncoder.encode(`webauthn:${userId}`),
        100000
      )
    );
    for (const makeKek of keks) {
      try {
        const dek = await unwrapLegacyDek(webauthnWrap, await makeKek());
        if (dek) {
          return { unlocked: { dek, method: "passkey_system_key" }, wrapKinds };
        }
      } catch {
        // next candidate
      }
    }
  }

  return { unlocked: null, wrapKinds };
}

interface FieldEnvelope {
  data: string;
  iv: string;
  tag: string;
  salt: string;
  recordId?: string;
}

function parseFieldEnvelope(value: string): FieldEnvelope | null {
  if (!value.startsWith("{")) return null;
  try {
    const p = JSON.parse(value) as Partial<FieldEnvelope>;
    if (
      typeof p.data === "string" &&
      typeof p.iv === "string" &&
      typeof p.tag === "string" &&
      typeof p.salt === "string"
    ) {
      return p as FieldEnvelope;
    }
  } catch {
    // plaintext that happens to start with "{"
  }
  return null;
}

async function openSecret(
  value: SqlValue | undefined,
  dek: Uint8Array | undefined,
  fallbackRecordId: string,
  fieldNames: string[],
  tally: TermixSqliteSecretStats
): Promise<string | undefined> {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const envelope = parseFieldEnvelope(value);
  if (!envelope) {
    tally.plaintext++;
    return value;
  }
  if (!dek) {
    tally.locked++;
    return undefined;
  }
  let salt: Uint8Array;
  let iv: Uint8Array;
  let tag: Uint8Array;
  let data: Uint8Array;
  try {
    salt = hexToBytes(envelope.salt);
    iv = hexToBytes(envelope.iv);
    tag = hexToBytes(envelope.tag);
    data = hexToBytes(envelope.data);
  } catch {
    tally.locked++;
    return undefined;
  }
  const recordId = envelope.recordId || fallbackRecordId;
  for (const fieldName of fieldNames) {
    try {
      const fieldKey = await hkdfSha256(dek, salt, `${recordId}:${fieldName}`);
      const plain = await aesGcmDecrypt(fieldKey, iv, data, tag);
      tally.decrypted++;
      return textDecoder.decode(plain);
    } catch {
      // try the next field-name context
    }
  }
  tally.locked++;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* SSH key helpers                                                     */
/* ------------------------------------------------------------------ */

function isPrivateKeyText(value: string | undefined): value is string {
  return Boolean(
    value &&
      (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value) ||
        value.startsWith("PuTTY-User-Key-File-"))
  );
}

function normalizeKeyTypeHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const h = hint.trim().toLowerCase();
  if (!h || h === "auto" || h === "unknown") return undefined;
  return hint.trim();
}

/**
 * Reads the public half of an OpenSSH-format private key (stored unencrypted in the
 * `openssh-key-v1` container even for passphrase-protected keys) and returns its
 * OpenSSH public line and `SHA256:` fingerprint, matching `ssh-keygen -lf`.
 */
export async function deriveOpenSshPublicInfo(
  privateKey: string,
  comment?: string
): Promise<{ keyType: string; publicKey: string; fingerprint: string } | null> {
  const match = privateKey.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/
  );
  if (!match) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(match[1]);
  } catch {
    return null;
  }
  const magic = textEncoder.encode("openssh-key-v1\u0000");
  if (bytes.length < magic.length || !bytesEqual(bytes.subarray(0, magic.length), magic)) {
    return null;
  }
  let offset = magic.length;
  const readU32 = (): number => {
    if (offset + 4 > bytes.length) throw new Error("truncated");
    const v =
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0;
    offset += 4;
    return v;
  };
  const readString = (): Uint8Array => {
    const len = readU32();
    if (offset + len > bytes.length) throw new Error("truncated");
    const out = bytes.subarray(offset, offset + len);
    offset += len;
    return out;
  };
  try {
    readString(); // ciphername
    readString(); // kdfname
    readString(); // kdfoptions
    const keyCount = readU32();
    if (keyCount < 1) return null;
    const publicBlob = readString();
    if (publicBlob.length < 4) return null;
    const typeLen =
      ((publicBlob[0] << 24) |
        (publicBlob[1] << 16) |
        (publicBlob[2] << 8) |
        publicBlob[3]) >>>
      0;
    if (4 + typeLen > publicBlob.length) return null;
    const keyType = textDecoder.decode(publicBlob.subarray(4, 4 + typeLen));
    const digest = new Uint8Array(
      await getSubtle().digest("SHA-256", toArrayBuffer(publicBlob))
    );
    const fingerprint = `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`;
    const cleanComment = (comment || "").trim().replace(/\s+/g, "-");
    const base = `${keyType} ${bytesToBase64(publicBlob)}`;
    return {
      keyType,
      publicKey: cleanComment ? `${base} ${cleanComment}` : base,
      fingerprint,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Value coercion                                                      */
/* ------------------------------------------------------------------ */

function str(value: SqlValue | undefined): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function idOf(value: SqlValue | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "string") {
    const s = String(value).trim();
    return s.length > 0 && s !== "0" ? s : undefined;
  }
  return undefined;
}

function portOf(value: SqlValue | undefined): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

function boolOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

function splitTags(value: SqlValue | undefined): string[] {
  const raw = str(value);
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .map((t) => (typeof t === "string" ? t.trim() : ""))
          .filter(Boolean);
      }
    } catch {
      // fall back to comma separated
    }
  }
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function stringMap(raw: string | undefined): Record<string, string> {
  const obj = parseJsonObject(raw);
  if (!obj) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

function colorFor(protocol: ProtocolType): string {
  if (protocol === "rdp") return "#ff6b57";
  if (protocol === "sftp") return "#38bdf8";
  return "#34d399";
}

const RDP_SECURITY_MODES: RdpSecurityMode[] = ["any", "nla", "tls", "rdp"];

function rdpSecurityOf(...values: Array<string | undefined>): RdpSecurityMode {
  for (const v of values) {
    const s = v?.trim().toLowerCase();
    if (!s) continue;
    if ((RDP_SECURITY_MODES as string[]).includes(s)) return s as RdpSecurityMode;
    if (s === "nla-ext") return "nla";
    if (s === "vmconnect") return "any";
  }
  return "any";
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

interface ImportedCredential {
  name: string;
  authType: "password" | "key";
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sshKeyId?: string;
}

interface ProtocolLogin {
  authType: string;
  credentialId?: string;
  username?: string;
  password?: string;
  fields: Record<string, string>;
  secretFields: Record<string, string>;
}

/**
 * Parses a Termix SQLite database (plain or `db.sqlite.encrypted`) into Sushi
 * hosts, whitelisted SSH keys, and command snippets.
 */
export async function importTermixSqliteDatabase(
  fileBytes: Uint8Array,
  options: TermixSqliteImportOptions = {}
): Promise<TermixSqliteImportResult> {
  const env = parseTermixEnvSecrets(options.termixEnv);
  const password = options.termixPassword || undefined;
  const unwrapped = await unwrapDatabaseFile(fileBytes, env, options.metaJson);

  const emptyResult = (
    kind: TermixSqliteFileKind,
    message: string
  ): TermixSqliteImportResult => ({
    status: "needs_database_key",
    fileKind: kind,
    message,
    hosts: [],
    sshKeys: [],
    snippets: [],
    users: [],
    secrets: { plaintext: 0, decrypted: 0, locked: 0 },
    skippedHosts: 0,
    warnings: [],
  });

  if (!unwrapped.ok) {
    return emptyResult(unwrapped.kind, unwrapped.message);
  }

  const SQL = await (options.loadSqlJs ?? loadSqlJs)();
  let db: Database;
  try {
    db = new SQL.Database(unwrapped.sqlite);
  } catch {
    throw new Error("The SQLite database could not be opened (corrupted file?).");
  }

  try {
    let tableNames: Set<string>;
    try {
      tableNames = new Set(
        selectAll(
          db,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
          .map((r) => str(r.name))
          .filter((n): n is string => Boolean(n))
      );
    } catch {
      throw new Error(
        "The SQLite database could not be read (corrupted file or not a SQLite database)."
      );
    }

    if (!tableNames.has("ssh_data") && !tableNames.has("ssh_credentials")) {
      throw new Error(
        "This is a valid SQLite database, but it has no Termix tables (ssh_data / ssh_credentials)."
      );
    }

    const has = (t: string) => tableNames.has(t);
    const userRows = has("users") ? selectAll(db, "SELECT * FROM users") : [];
    const settingRows = has("settings")
      ? selectAll(db, "SELECT key, value FROM settings")
      : [];
    const hostRows = has("ssh_data")
      ? selectAll(db, "SELECT * FROM ssh_data ORDER BY id")
      : [];
    const credRows = has("ssh_credentials")
      ? selectAll(db, "SELECT * FROM ssh_credentials ORDER BY id")
      : [];
    const protoRows = has("host_protocol_auth")
      ? selectAll(db, "SELECT * FROM host_protocol_auth")
      : [];
    const snippetRows = has("snippets")
      ? selectAll(db, "SELECT * FROM snippets ORDER BY id")
      : [];

    const settings = new Map<string, string>();
    for (const s of settingRows) {
      if (typeof s.key === "string" && typeof s.value === "string") {
        settings.set(s.key, s.value);
      }
    }

    // ---- Users & data keys -------------------------------------------------
    const userMeta = new Map<string, { username: string; isAdmin: boolean }>();
    for (const u of userRows) {
      const id = idOf(u.id);
      if (!id) continue;
      userMeta.set(id, {
        username: str(u.username) || id,
        isAdmin: boolOf(u.is_admin, false),
      });
    }
    for (const r of [...hostRows, ...credRows, ...snippetRows]) {
      const owner = idOf(r.user_id);
      if (owner && !userMeta.has(owner)) {
        userMeta.set(owner, { username: owner, isAdmin: false });
      }
    }

    const deks = new Map<string, UnlockedDek>();
    const wrapKindsByUser = new Map<string, TermixSqliteUserInfo["wrapKinds"]>();
    for (const userId of userMeta.keys()) {
      const { unlocked, wrapKinds } = await unlockUserDek(
        userId,
        settings,
        env,
        password
      );
      wrapKindsByUser.set(userId, wrapKinds);
      if (unlocked) deks.set(userId, unlocked);
    }

    const onlyUser = options.onlyUserId;
    const included = (ownerId: string | undefined) =>
      !onlyUser || ownerId === onlyUser;

    const tally: TermixSqliteSecretStats = { plaintext: 0, decrypted: 0, locked: 0 };
    const lockedByUser = new Map<string, number>();
    const warnings: string[] = [];

    /** Opens a Termix secret column with its owner's data key, tracking locked fields per user. */
    const open = async (
      ownerId: string | undefined,
      value: SqlValue | undefined,
      recordId: string,
      fieldNames: string[]
    ): Promise<string | undefined> => {
      const lockedBefore = tally.locked;
      const out = await openSecret(
        value,
        ownerId ? deks.get(ownerId)?.dek : undefined,
        recordId,
        fieldNames,
        tally
      );
      const newlyLocked = tally.locked - lockedBefore;
      if (newlyLocked > 0 && ownerId) {
        lockedByUser.set(ownerId, (lockedByUser.get(ownerId) ?? 0) + newlyLocked);
      }
      return out;
    };

    // ---- SSH keychain registration ----------------------------------------
    const existingKeys = options.existingSshKeys ?? [];
    const newKeys: WhitelistedSshKey[] = [];
    const registerKey = async (
      privateKey: string,
      name: string,
      passphrase: string | undefined,
      keyTypeHint: string | undefined
    ): Promise<string> => {
      const clean = privateKey.trim();
      const pool = [...existingKeys, ...newKeys];
      const sameText = pool.find((k) => k.privateKey.trim() === clean);
      if (sameText) return sameText.id;
      const info = await deriveOpenSshPublicInfo(clean, name);
      if (info) {
        const sameFp = pool.find((k) => k.fingerprint === info.fingerprint);
        if (sameFp) return sameFp.id;
      }
      const id = randomId();
      newKeys.push({
        id,
        name,
        privateKey: clean,
        passphrase: passphrase || undefined,
        publicKey: info?.publicKey,
        keyType: info?.keyType || normalizeKeyTypeHint(keyTypeHint),
        fingerprint: info?.fingerprint,
        createdAt: Date.now(),
      });
      return id;
    };

    // Hosts in scope, and every credential they reference (a host can use a
    // credential shared from another Termix user).
    const includedHostIds = new Set<string>();
    const referencedCredIds = new Set<string>();
    for (const row of hostRows) {
      const id = idOf(row.id);
      if (!id || !included(idOf(row.user_id))) continue;
      includedHostIds.add(id);
      for (const ref of [row.credential_id, row.rdp_credential_id]) {
        const credRef = idOf(ref);
        if (credRef) referencedCredIds.add(credRef);
      }
    }
    for (const row of protoRows) {
      const hostId = idOf(row.host_id);
      const credRef = idOf(row.credential_id);
      if (hostId && credRef && includedHostIds.has(hostId)) {
        referencedCredIds.add(credRef);
      }
    }

    // ---- ssh_credentials ----------------------------------------------------
    const credentials = new Map<string, ImportedCredential>();
    let lockedKeyCredentials = 0;
    for (const row of credRows) {
      const credId = idOf(row.id);
      const ownerId = idOf(row.user_id);
      if (!credId) continue;
      if (!included(ownerId) && !referencedCredIds.has(credId)) continue;
      const name = str(row.name) || `Termix Credential ${credId}`;
      const authTypeRaw = (str(row.auth_type) || "").toLowerCase();

      const credPassword = await open(ownerId, row.password, credId, ["password"]);
      const privateKeyCol = await open(ownerId, row.private_key, credId, [
        "privateKey",
        "private_key",
      ]);
      const keyCol = await open(ownerId, row.key, credId, ["key", "privateKey"]);
      const keyPassword = await open(ownerId, row.key_password, credId, [
        "keyPassword",
        "key_password",
      ]);

      const privateKey = [privateKeyCol, keyCol].find(isPrivateKeyText);
      const isKey = authTypeRaw === "key" || Boolean(privateKey);
      if (isKey && !privateKey && (row.private_key || row.key)) {
        lockedKeyCredentials += included(ownerId) ? 1 : 0;
      }

      let sshKeyId: string | undefined;
      if (privateKey && included(ownerId)) {
        sshKeyId = await registerKey(
          privateKey,
          name,
          keyPassword,
          str(row.key_type) || str(row.detected_key_type)
        );
      }

      credentials.set(credId, {
        name,
        authType: isKey ? "key" : "password",
        username: str(row.username),
        password: credPassword,
        privateKey,
        passphrase: keyPassword,
        sshKeyId,
      });
    }

    // ---- host_protocol_auth (Termix 3.x RDP/VNC/Telnet logins) ------------
    const protocolLogins = new Map<string, Map<string, ProtocolLogin>>();
    for (const row of protoRows) {
      const hostId = idOf(row.host_id);
      const protocol = str(row.protocol)?.toLowerCase();
      if (!hostId || !protocol || !includedHostIds.has(hostId)) continue;
      const ownerId = idOf(row.user_id);
      const recordId = `host-protocol-auth-${hostId}-${protocol}`;
      const loginPassword = await open(ownerId, row.password, recordId, ["password"]);
      const secretFieldsRaw = await open(ownerId, row.secret_fields, recordId, [
        "secretFields",
        "secret_fields",
      ]);
      const byProtocol = protocolLogins.get(hostId) ?? new Map<string, ProtocolLogin>();
      byProtocol.set(protocol, {
        authType: (str(row.auth_type) || "direct").toLowerCase(),
        credentialId: idOf(row.credential_id),
        username: str(row.username),
        password: loginPassword,
        fields: stringMap(typeof row.fields === "string" ? row.fields : undefined),
        secretFields: stringMap(secretFieldsRaw),
      });
      protocolLogins.set(hostId, byProtocol);
    }

    // ---- ssh_data -> Sushi hosts -------------------------------------------
    const hostNameById = new Map<string, string>();
    for (const row of hostRows) {
      const id = idOf(row.id);
      if (id) hostNameById.set(id, str(row.name) || str(row.ip) || `Host ${id}`);
    }

    type SortableHost = { profile: HostProfile; folder: string; sort: number };
    const imported: SortableHost[] = [];
    let skippedHosts = 0;
    let unsupportedProtocolHosts = 0;
    let proxiedHosts = 0;
    let templatedUsernames = 0;
    let unsupportedAuthHosts = 0;
    const now = Date.now();

    for (const row of hostRows) {
      const hostId = idOf(row.id);
      const ownerId = idOf(row.user_id);
      if (!hostId || !included(ownerId)) continue;

      const address = str(row.ip);
      if (!address) {
        skippedHosts++;
        continue;
      }

      const connectionType = (str(row.connection_type) || "ssh").toLowerCase();
      const logins = protocolLogins.get(hostId);
      const rdpLogin = logins?.get("rdp");
      const displayName = str(row.name) || address;
      const parentName = idOf(row.parent_host_id)
        ? hostNameById.get(idOf(row.parent_host_id)!)
        : undefined;
      const folder = str(row.folder) || parentName || "Termix Imported";
      const tags = splitTags(row.tags);
      const sortOrder = typeof row.sort_order === "number" ? row.sort_order : Number.MAX_SAFE_INTEGER;
      const pinned = boolOf(row.pin, false);

      const wantsRdp =
        connectionType === "rdp" ||
        boolOf(row.enable_rdp, false) ||
        Boolean(rdpLogin);
      const wantsSsh =
        (connectionType === "ssh" || connectionType === "sftp") &&
        boolOf(row.enable_ssh, true);

      if (!wantsSsh && !wantsRdp) {
        unsupportedProtocolHosts++;
        skippedHosts++;
        continue;
      }

      // Notes: carry over unsupported Termix features so nothing is silently lost
      const noteLines: string[] = [];
      const ownNotes = str(row.notes);
      if (ownNotes) noteLines.push(ownNotes);
      const jumpRaw = str(row.jump_hosts);
      if (jumpRaw && jumpRaw !== "[]" && jumpRaw !== "null") {
        let jumpNames: string[] = [];
        try {
          const parsed: unknown = JSON.parse(jumpRaw);
          if (Array.isArray(parsed)) {
            jumpNames = parsed
              .map((j) => {
                const ref =
                  j && typeof j === "object"
                    ? (j as Record<string, unknown>).hostId ??
                      (j as Record<string, unknown>).id
                    : j;
                const refId =
                  typeof ref === "number" || typeof ref === "string"
                    ? String(ref)
                    : undefined;
                return refId ? hostNameById.get(refId) || `host #${refId}` : "";
              })
              .filter(Boolean);
          }
        } catch {
          // ignore malformed jump host JSON
        }
        if (jumpNames.length > 0) {
          noteLines.push(`Termix jump hosts: ${jumpNames.join(" → ")}`);
          proxiedHosts++;
        }
      }
      if (boolOf(row.use_socks5, false) && str(row.socks5_host)) {
        noteLines.push(
          `Termix SOCKS5 proxy: ${str(row.socks5_host)}:${portOf(row.socks5_port) || 1080}`
        );
        proxiedHosts++;
      }
      const notes = noteLines.length > 0 ? noteLines.join("\n") : undefined;

      const hostPassword = await open(ownerId, row.password, hostId, ["password"]);

      // ----- SSH / SFTP profile -----
      if (wantsSsh) {
        const protocol: ProtocolType = connectionType === "sftp" ? "sftp" : "ssh";
        const authType = (str(row.auth_type) || "password").toLowerCase();
        const credential = idOf(row.credential_id)
          ? credentials.get(idOf(row.credential_id)!)
          : undefined;
        const hostKey = await open(ownerId, row.key, hostId, ["key"]);
        const hostKeyPassword = await open(ownerId, row.key_password, hostId, [
          "keyPassword",
          "key_password",
        ]);

        let username = str(row.username) || "";
        let usesKey = false;
        let sshPassword: string | undefined;
        let privateKey: string | undefined;
        let passphrase: string | undefined;
        let sshKeyId: string | undefined;

        if (authType === "credential" && credential) {
          const override = boolOf(row.override_credential_username, false);
          username = override
            ? username || credential.username || ""
            : credential.username || username;
          if (credential.authType === "key") {
            usesKey = true;
            privateKey = credential.privateKey;
            passphrase = credential.passphrase;
            sshKeyId = credential.sshKeyId;
          } else {
            sshPassword = credential.password;
          }
        } else if (authType === "key" || (authType !== "password" && isPrivateKeyText(hostKey))) {
          usesKey = true;
          privateKey = isPrivateKeyText(hostKey) ? hostKey : undefined;
          passphrase = hostKeyPassword;
        } else {
          if (!["password", "none", "credential"].includes(authType)) {
            unsupportedAuthHosts++;
          }
          sshPassword = hostPassword;
        }

        if (usesKey && privateKey && !sshKeyId) {
          sshKeyId = await registerKey(
            privateKey,
            `${displayName} Key`,
            passphrase,
            str(row.key_type)
          );
        }

        if (/\$(external|oidc)\./.test(username)) templatedUsernames++;

        const port =
          (connectionType === "ssh" || connectionType === "sftp"
            ? portOf(row.port)
            : undefined) ||
          portOf(row.ssh_port) ||
          22;

        imported.push({
          folder,
          sort: pinned ? -1 : sortOrder,
          profile: {
            id: randomId(),
            name: displayName,
            protocol,
            host: address,
            port,
            username: username || "root",
            authMethod: usesKey ? "privateKey" : "password",
            password: usesKey ? undefined : sshPassword,
            privateKey: usesKey ? privateKey : undefined,
            passphrase: usesKey ? passphrase : undefined,
            sshKeyId: usesKey ? sshKeyId : undefined,
            initialPath: protocol === "sftp" ? str(row.default_path) : undefined,
            group: folder,
            tags: pinned && !tags.includes("pinned") ? [...tags, "pinned"] : tags,
            accentColor: colorFor(protocol),
            notes,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // ----- RDP profile -----
      if (wantsRdp) {
        let rdpUser: string | undefined;
        let rdpPassword: string | undefined;
        let domain: string | undefined;
        let securityHint: string | undefined;
        let ignoreCertRaw: unknown;

        if (rdpLogin) {
          if (rdpLogin.authType === "credential" && rdpLogin.credentialId) {
            const c = credentials.get(rdpLogin.credentialId);
            rdpUser = c?.username;
            rdpPassword = c?.password;
          } else if (rdpLogin.authType !== "none") {
            rdpUser = rdpLogin.username;
            rdpPassword = rdpLogin.password;
          }
          domain = rdpLogin.fields.domain || rdpLogin.secretFields.domain;
          securityHint = rdpLogin.fields.security;
          ignoreCertRaw = rdpLogin.fields.ignoreCert ?? rdpLogin.fields["ignore-cert"];
        } else {
          const storedType = (str(row.rdp_auth_type) || "").toLowerCase();
          const rdpCredId = idOf(row.rdp_credential_id);
          if (storedType === "credential" || (!storedType && rdpCredId)) {
            const c = rdpCredId ? credentials.get(rdpCredId) : undefined;
            rdpUser = c?.username;
            rdpPassword = c?.password;
          } else if (storedType !== "none") {
            rdpUser = str(row.rdp_user);
            rdpPassword = await open(ownerId, row.rdp_password, hostId, [
              "rdpPassword",
              "rdp_password",
              "password",
            ]);
          }
          domain = str(row.rdp_domain);
          securityHint = str(row.rdp_security) || str(row.security);
          ignoreCertRaw = row.rdp_ignore_cert ?? row.ignore_cert;
        }

        // Very old installs kept a remote desktop login in username/password/domain
        if (!rdpUser && !rdpPassword && connectionType === "rdp") {
          rdpUser = str(row.username);
          rdpPassword = hostPassword;
          domain = domain || str(row.domain);
        }

        const port =
          (connectionType === "rdp" ? portOf(row.port) : undefined) ||
          portOf(row.rdp_port) ||
          3389;

        imported.push({
          folder,
          sort: pinned ? -1 : sortOrder,
          profile: {
            id: randomId(),
            name: wantsSsh ? `${displayName} (RDP)` : displayName,
            protocol: "rdp",
            host: address,
            port,
            username: rdpUser || "Administrator",
            authMethod: "password",
            password: rdpPassword,
            domain: domain || undefined,
            rdpSecurity: rdpSecurityOf(securityHint),
            ignoreCert: boolOf(ignoreCertRaw, true),
            rdpWidth: 1280,
            rdpHeight: 720,
            group: folder,
            tags: pinned && !tags.includes("pinned") ? [...tags, "pinned"] : tags,
            accentColor: colorFor("rdp"),
            notes,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
    }

    imported.sort(
      (a, b) =>
        a.folder.localeCompare(b.folder) ||
        a.sort - b.sort ||
        a.profile.name.localeCompare(b.profile.name)
    );

    // ---- snippets -------------------------------------------------------------
    const snippets: CommandSnippet[] = [];
    for (const row of snippetRows) {
      if (!included(idOf(row.user_id))) continue;
      if (boolOf(row.is_note, false)) continue;
      const title = str(row.name);
      const command = typeof row.content === "string" ? row.content.trim() : "";
      if (!title || !command) continue;
      snippets.push({
        id: `snip-termix-${randomId()}`,
        title,
        command,
        category: str(row.folder) || "Termix Snippets",
        description: str(row.description),
      });
    }

    // ---- users summary -------------------------------------------------------
    const users: TermixSqliteUserInfo[] = [...userMeta.entries()].map(
      ([id, meta]) => ({
        id,
        username: meta.username,
        isAdmin: meta.isAdmin,
        hostCount: hostRows.filter((r) => idOf(r.user_id) === id).length,
        credentialCount: credRows.filter((r) => idOf(r.user_id) === id).length,
        snippetCount: snippetRows.filter(
          (r) => idOf(r.user_id) === id && !boolOf(r.is_note, false)
        ).length,
        unlocked: deks.has(id),
        unlockMethod: deks.get(id)?.method,
        wrapKinds: wrapKindsByUser.get(id) ?? [],
        lockedSecrets: lockedByUser.get(id) ?? 0,
      })
    );

    // ---- warnings ---------------------------------------------------------------
    const lockedUsers = users.filter((u) => u.lockedSecrets > 0);
    const lockedCount = (list: TermixSqliteUserInfo[]) =>
      list.reduce((n, u) => n + u.lockedSecrets, 0);
    const userNames = (list: TermixSqliteUserInfo[]) =>
      list.map((u) => u.username).join(", ");
    const needEncryptionKey = lockedUsers.filter((u) => u.wrapKinds.includes("v3"));
    const needPassword = lockedUsers.filter(
      (u) => !u.wrapKinds.includes("v3") && u.wrapKinds.includes("password")
    );
    const needSystemSecret = lockedUsers.filter(
      (u) =>
        !u.wrapKinds.includes("v3") &&
        !u.wrapKinds.includes("password") &&
        (u.wrapKinds.includes("oidc") || u.wrapKinds.includes("passkey"))
    );
    const missingDek = lockedUsers.filter((u) => u.wrapKinds.length === 0);
    if (needEncryptionKey.length > 0) {
      warnings.push(
        `${lockedCount(needEncryptionKey)} saved password/key field(s) for ${userNames(needEncryptionKey)} are still encrypted — paste Termix's .env (it contains ENCRYPTION_KEY) to decrypt them.`
      );
    }
    if (needPassword.length > 0) {
      warnings.push(
        `${lockedCount(needPassword)} saved password/key field(s) for ${userNames(needPassword)} are locked with that Termix account's password (Termix 2.x) — enter it to decrypt them.`
      );
    }
    if (needSystemSecret.length > 0) {
      warnings.push(
        `${lockedCount(needSystemSecret)} saved password/key field(s) for ${userNames(needSystemSecret)} use Termix SSO/passkey data keys — add OIDC_SYSTEM_SECRET / WEBAUTHN_SYSTEM_SECRET from Termix's environment to decrypt them.`
      );
    }
    if (missingDek.length > 0) {
      warnings.push(
        `${lockedCount(missingDek)} saved password/key field(s) for ${userNames(missingDek)} can't be decrypted because this database holds no data key for them.`
      );
    }
    if (lockedKeyCredentials > 0 && tally.locked === 0) {
      warnings.push(
        `${lockedKeyCredentials} Termix key credential(s) did not contain a readable private key.`
      );
    }
    if (unsupportedProtocolHosts > 0) {
      warnings.push(
        `Skipped ${unsupportedProtocolHosts} VNC/Telnet-only host(s) — Sushi supports SSH, SFTP, and RDP.`
      );
    }
    if (proxiedHosts > 0) {
      warnings.push(
        `${proxiedHosts} host(s) use Termix jump hosts or SOCKS5 proxies, which Sushi doesn't chain yet — the details were saved in each host's notes.`
      );
    }
    if (templatedUsernames > 0) {
      warnings.push(
        `${templatedUsernames} host(s) use Termix SSO username templates ($external.username) — edit their usernames after importing.`
      );
    }
    if (unsupportedAuthHosts > 0) {
      warnings.push(
        `${unsupportedAuthHosts} host(s) use Termix-only auth (Vault SSH CA / OPKSSH) and were imported as password hosts.`
      );
    }

    return {
      status: "ok",
      fileKind: unwrapped.kind,
      hosts: imported.map((h) => h.profile),
      sshKeys: newKeys,
      snippets,
      users,
      secrets: tally,
      skippedHosts,
      warnings,
    };
  } finally {
    db.close();
  }
}
