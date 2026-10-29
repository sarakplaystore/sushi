import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { NextRequest, NextResponse } from "next/server";
import type {
  AuthorizedKeyRecord,
  PublicPasskeySummary,
  StoredPasskeyRecord,
} from "@/types/auth";
import { parseAuthorizedKeysBlock } from "./ssh-key-utils";

export const SESSION_COOKIE_NAME = "sushi_session";
export const ADMIN_CERT_COOKIE_NAME = "sushi_admin_cert";
export const CHALLENGE_COOKIE_NAME = "sushi_webauthn_challenge";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_CERT_TTL_SEC = 365 * 24 * 60 * 60; // 1 year
const CHALLENGE_TTL_MS = 3 * 60 * 1000; // 3 minutes

export interface DiskAuthFile {
  version: 1;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  authSecret: string;
  passkeys: StoredPasskeyRecord[];
  authorizedKeys?: AuthorizedKeyRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface SignedAdminProfilePayload {
  v: 1;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  authorizedKeys: AuthorizedKeyRecord[];
  updatedAt: number;
}

export interface EffectiveAuthConfig {
  initialized: boolean;
  canBootstrapOnDisk: boolean;
  canBootstrapInteractive: boolean;
  envConfigured: boolean;
  username: string;
  verifyPassword: (candidate: string) => Promise<boolean>;
  authSecret: string;
  serverPasskeys: StoredPasskeyRecord[];
  authorizedKeys: AuthorizedKeyRecord[];
  adminProfilePayload?: SignedAdminProfilePayload;
}

// Simple per-IP login brute-force tracker
const failedLoginBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkLoginRateLimit(ip: string): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  const now = Date.now();
  const bucket = failedLoginBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    return { allowed: true };
  }
  if (bucket.count >= 12) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const bucket = failedLoginBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    failedLoginBuckets.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
  } else {
    bucket.count += 1;
  }
}

export function clearLoginFailures(ip: string): void {
  failedLoginBuckets.delete(ip);
}

export function getAuthFilePath(): string {
  const dir = process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");
  return path.join(dir, "auth.json");
}

export function isPersistentDiskAvailable(): boolean {
  return process.env.VERCEL !== "1";
}

function scryptHash(password: string, saltHex: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      Buffer.from(saltHex, "hex"),
      64,
      { N: 16384, r: 8, p: 1 },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      }
    );
  });
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = crypto.createHash("sha256").update(a, "utf8").digest();
  const bufB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

function deriveInstanceSecret(seedMaterial?: string): string {
  const envSecret = process.env.SUSHI_AUTH_SECRET?.trim();
  if (envSecret) return envSecret;

  const fallbackSeed =
    seedMaterial ||
    process.env.SUSHI_GATEWAY_TOKEN?.trim() ||
    process.env.VERCEL_PROJECT_ID?.trim() ||
    process.env.VERCEL_GIT_REPO_ID?.trim() ||
    "sushi-serverless-instance-key-v1";

  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      fallbackSeed,
      "sushi-auth-hkdf-salt-v1",
      "sushi-session-hmac-secret",
      32
    )
  ).toString("hex");
}

async function readDiskAuthFile(): Promise<DiskAuthFile | null> {
  if (!isPersistentDiskAvailable()) return null;
  try {
    const raw = await fs.readFile(getAuthFilePath(), "utf8");
    const parsed = JSON.parse(raw) as DiskAuthFile;
    if (!parsed?.username || (!parsed?.passwordHash && !parsed?.authorizedKeys?.length)) {
      return null;
    }
    return {
      ...parsed,
      passkeys: Array.isArray(parsed.passkeys) ? parsed.passkeys : [],
      authorizedKeys: Array.isArray(parsed.authorizedKeys)
        ? parsed.authorizedKeys
        : [],
    };
  } catch {
    return null;
  }
}

async function writeDiskAuthFile(data: DiskAuthFile): Promise<void> {
  const filePath = getAuthFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function parseEnvPasskeys(): StoredPasskeyRecord[] {
  const raw = process.env.SUSHI_PASSKEYS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (p) => p && typeof p.id === "string" && typeof p.publicKey === "string"
      );
    }
    return [];
  } catch {
    return [];
  }
}

function parseEnvAuthorizedKeys(): AuthorizedKeyRecord[] {
  const raw = process.env.SUSHI_AUTHORIZED_KEYS?.trim();
  if (!raw) return [];
  return parseAuthorizedKeysBlock(raw).map((k) => ({
    ...k,
    source: "env" as const,
  }));
}

function mergeAuthorizedKeyLists(
  ...lists: Array<AuthorizedKeyRecord[] | undefined>
): AuthorizedKeyRecord[] {
  const map = new Map<string, AuthorizedKeyRecord>();
  for (const list of lists) {
    if (!list) continue;
    for (const key of list) {
      if (!key?.fingerprint || !key?.publicKeyOpenSSH) continue;
      map.set(key.fingerprint, key);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// HMAC-Signed Tokens & Certificates
// ---------------------------------------------------------------------------

function signPayload(payloadObj: Record<string, unknown>, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), "utf8").toString(
    "base64url"
  );
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifySignedPayload<T>(
  token: string | undefined | null,
  secret: string
): T | null {
  if (!token || !secret) return null;
  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const providedSig = token.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");

  const a = Buffer.from(providedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function issueAdminProfileCertificate(
  payload: SignedAdminProfilePayload,
  secret: string
): string {
  return signPayload(payload as unknown as Record<string, unknown>, secret);
}

export function verifyAdminProfileCertificate(
  cert: string | undefined | null,
  secret: string
): SignedAdminProfilePayload | null {
  const parsed = verifySignedPayload<SignedAdminProfilePayload>(cert, secret);
  if (!parsed || parsed.v !== 1 || typeof parsed.username !== "string") {
    return null;
  }
  return {
    ...parsed,
    authorizedKeys: Array.isArray(parsed.authorizedKeys)
      ? parsed.authorizedKeys
      : [],
  };
}

function parseCookieValue(
  cookieHeader: string | undefined | null,
  name: string
): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function extractAdminCertFromHeaders(
  headers?: Headers | IncomingMessage["headers"] | null,
  explicitAdminCert?: string | null
): string | null {
  if (explicitAdminCert?.trim()) return explicitAdminCert.trim();
  const envCert = process.env.SUSHI_AUTH_PROFILE_CERT?.trim();
  if (!headers) return envCert || null;

  let headerVal = "";
  let cookieHeader = "";

  if (headers instanceof Headers) {
    headerVal = headers.get("x-sushi-admin-cert")?.trim() || "";
    cookieHeader = headers.get("cookie") || "";
  } else {
    const rawH = headers["x-sushi-admin-cert"];
    headerVal = (Array.isArray(rawH) ? rawH[0] : rawH || "").trim();
    const rawC = headers.cookie;
    cookieHeader = Array.isArray(rawC) ? rawC.join("; ") : rawC || "";
  }

  if (headerVal) return headerVal;
  const fromCookie = parseCookieValue(cookieHeader, ADMIN_CERT_COOKIE_NAME);
  if (fromCookie) return fromCookie;
  return envCert || null;
}

export async function getEffectiveAuthConfig(
  headers?: Headers | IncomingMessage["headers"] | null,
  explicitAdminCert?: string | null
): Promise<EffectiveAuthConfig> {
  const envUser = process.env.SUSHI_AUTH_USERNAME?.trim() || "";
  const envPass = process.env.SUSHI_AUTH_PASSWORD ?? "";
  const envPassHash = process.env.SUSHI_AUTH_PASSWORD_HASH?.trim() || "";
  const envSecret = process.env.SUSHI_AUTH_SECRET?.trim() || "";
  const disk = await readDiskAuthFile();
  const envPasskeys = parseEnvPasskeys();
  const envAuthorizedKeys = parseEnvAuthorizedKeys();

  const hasEnvCreds = Boolean(
    envUser &&
      (envPass.length > 0 ||
        envPassHash.length > 0 ||
        envAuthorizedKeys.length > 0)
  );

  // 1. Explicit Environment Variable Credentials
  if (hasEnvCreds) {
    const derivedSecret = deriveInstanceSecret(
      `${envUser}:${envPassHash || envPass || envAuthorizedKeys[0]?.fingerprint || ""}`
    );

    const mergedPasskeysMap = new Map<string, StoredPasskeyRecord>();
    for (const pk of [...envPasskeys, ...(disk?.passkeys || [])]) {
      mergedPasskeysMap.set(pk.id, pk);
    }

    const authorizedKeys = mergeAuthorizedKeyLists(
      (disk?.authorizedKeys || []).map((k) => ({ ...k, source: "server" as const })),
      envAuthorizedKeys
    );

    return {
      initialized: true,
      canBootstrapOnDisk: isPersistentDiskAvailable(),
      canBootstrapInteractive: true,
      envConfigured: true,
      username: envUser,
      authSecret: derivedSecret,
      serverPasskeys: Array.from(mergedPasskeysMap.values()),
      authorizedKeys,
      verifyPassword: async (candidate: string) => {
        if (!envPass && !envPassHash) return false;
        if (envPassHash) {
          if (envPassHash.includes(":")) {
            const [salt, expectedHex] = envPassHash.split(":");
            const derived = await scryptHash(candidate, salt);
            const expectedBuf = Buffer.from(expectedHex, "hex");
            return (
              derived.length === expectedBuf.length &&
              crypto.timingSafeEqual(derived, expectedBuf)
            );
          }
          const candSha = crypto
            .createHash("sha256")
            .update(candidate, "utf8")
            .digest("hex");
          return safeEqualStrings(candSha, envPassHash.toLowerCase());
        }
        return safeEqualStrings(candidate, envPass);
      },
    };
  }

  // 2. Persistent Disk Auth File (Self-Hosted VPS / Local Server)
  if (disk) {
    const mergedPasskeysMap = new Map<string, StoredPasskeyRecord>();
    for (const pk of [...envPasskeys, ...disk.passkeys]) {
      mergedPasskeysMap.set(pk.id, pk);
    }

    const authorizedKeys = mergeAuthorizedKeyLists(
      (disk.authorizedKeys || []).map((k) => ({ ...k, source: "server" as const })),
      envAuthorizedKeys
    );

    return {
      initialized: true,
      canBootstrapOnDisk: true,
      canBootstrapInteractive: true,
      envConfigured: false,
      username: disk.username,
      authSecret: envSecret || disk.authSecret,
      serverPasskeys: Array.from(mergedPasskeysMap.values()),
      authorizedKeys,
      verifyPassword: async (candidate: string) => {
        if (!disk.passwordHash) return false;
        const derived = await scryptHash(candidate, disk.passwordSalt);
        const expected = Buffer.from(disk.passwordHash, "hex");
        return (
          derived.length === expected.length &&
          crypto.timingSafeEqual(derived, expected)
        );
      },
    };
  }

  // 3. Stateless Interactive Browser-Bootstrapped Admin Certificate (Vercel!)
  const serverlessSecret = deriveInstanceSecret();
  const rawAdminCert = extractAdminCertFromHeaders(headers, explicitAdminCert);
  const verifiedProfile = verifyAdminProfileCertificate(
    rawAdminCert,
    serverlessSecret
  );

  if (verifiedProfile) {
    const authorizedKeys = mergeAuthorizedKeyLists(
      verifiedProfile.authorizedKeys.map((k) => ({
        ...k,
        source: "certificate" as const,
      })),
      envAuthorizedKeys
    );

    return {
      initialized: true,
      canBootstrapOnDisk: isPersistentDiskAvailable(),
      canBootstrapInteractive: true,
      envConfigured: false,
      username: verifiedProfile.username,
      authSecret: serverlessSecret,
      serverPasskeys: envPasskeys,
      authorizedKeys,
      adminProfilePayload: verifiedProfile,
      verifyPassword: async (candidate: string) => {
        if (!verifiedProfile.passwordHash) return false;
        const derived = await scryptHash(candidate, verifiedProfile.passwordSalt);
        const expected = Buffer.from(verifiedProfile.passwordHash, "hex");
        return (
          derived.length === expected.length &&
          crypto.timingSafeEqual(derived, expected)
        );
      },
    };
  }

  // 4. Only SUSHI_AUTHORIZED_KEYS set without SUSHI_AUTH_USERNAME (pure SSH key whitelist mode!)
  if (envAuthorizedKeys.length > 0) {
    return {
      initialized: true,
      canBootstrapOnDisk: isPersistentDiskAvailable(),
      canBootstrapInteractive: true,
      envConfigured: true,
      username: "admin",
      authSecret: serverlessSecret,
      serverPasskeys: envPasskeys,
      authorizedKeys: envAuthorizedKeys,
      verifyPassword: async () => false,
    };
  }

  // 5. Uninitialized — Ready for interactive First-Run Setup in Browser (on BOTH VPS and Vercel!)
  return {
    initialized: false,
    canBootstrapOnDisk: isPersistentDiskAvailable(),
    canBootstrapInteractive: true,
    envConfigured: false,
    username: "",
    authSecret: serverlessSecret,
    serverPasskeys: envPasskeys,
    authorizedKeys: envAuthorizedKeys,
    verifyPassword: async () => false,
  };
}

/**
 * Bootstraps an admin account on EITHER persistent VPS disk OR stateless Vercel
 * (returning a signed `adminProfileCert` cookie + token).
 */
export async function bootstrapAdminAccount(
  username: string,
  password: string,
  initialAuthorizedKeys: AuthorizedKeyRecord[] = []
): Promise<{
  username: string;
  authSecret: string;
  adminProfileCert: string;
  persistedOnDisk: boolean;
}> {
  const cleanUser = username.trim();
  if (cleanUser.length < 2 || cleanUser.length > 64) {
    throw new Error("Username must be between 2 and 64 characters.");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  const saltHex = crypto.randomBytes(16).toString("hex");
  const derived = await scryptHash(password, saltHex);
  const passwordHash = derived.toString("hex");
  const now = Date.now();

  if (isPersistentDiskAvailable()) {
    const existing = await readDiskAuthFile();
    if (existing) {
      throw new Error("Admin account is already initialized.");
    }
    const authSecret =
      process.env.SUSHI_AUTH_SECRET?.trim() ||
      crypto.randomBytes(32).toString("hex");
    const record: DiskAuthFile = {
      version: 1,
      username: cleanUser,
      passwordSalt: saltHex,
      passwordHash,
      authSecret,
      passkeys: [],
      authorizedKeys: initialAuthorizedKeys,
      createdAt: now,
      updatedAt: now,
    };
    await writeDiskAuthFile(record);
    const adminProfileCert = issueAdminProfileCertificate(
      {
        v: 1,
        username: cleanUser,
        passwordSalt: saltHex,
        passwordHash,
        authorizedKeys: initialAuthorizedKeys,
        updatedAt: now,
      },
      authSecret
    );
    return {
      username: cleanUser,
      authSecret,
      adminProfileCert,
      persistedOnDisk: true,
    };
  }

  // Stateless Vercel deployment: seal profile into an HMAC-SHA256 certificate
  const authSecret = deriveInstanceSecret();
  const adminProfileCert = issueAdminProfileCertificate(
    {
      v: 1,
      username: cleanUser,
      passwordSalt: saltHex,
      passwordHash,
      authorizedKeys: initialAuthorizedKeys,
      updatedAt: now,
    },
    authSecret
  );

  return {
    username: cleanUser,
    authSecret,
    adminProfileCert,
    persistedOnDisk: false,
  };
}

// Keep alias for backward compatibility
export const bootstrapDiskAdminAccount = bootstrapAdminAccount;

export async function updateAdminCredentials(
  cfg: EffectiveAuthConfig,
  nextUsername: string,
  nextPassword?: string
): Promise<{ adminProfileCert?: string }> {
  const cleanUser = nextUsername.trim();
  if (cleanUser.length < 2 || cleanUser.length > 64) {
    throw new Error("Username must be between 2 and 64 characters.");
  }

  if (isPersistentDiskAvailable()) {
    const existing = await readDiskAuthFile();
    if (!existing) {
      throw new Error("No disk account record found.");
    }
    existing.username = cleanUser;
    if (nextPassword && nextPassword.length > 0) {
      if (nextPassword.length < 6) {
        throw new Error("New password must be at least 6 characters.");
      }
      const saltHex = crypto.randomBytes(16).toString("hex");
      const derived = await scryptHash(nextPassword, saltHex);
      existing.passwordSalt = saltHex;
      existing.passwordHash = derived.toString("hex");
    }
    existing.updatedAt = Date.now();
    await writeDiskAuthFile(existing);

    const adminProfileCert = issueAdminProfileCertificate(
      {
        v: 1,
        username: existing.username,
        passwordSalt: existing.passwordSalt,
        passwordHash: existing.passwordHash,
        authorizedKeys: existing.authorizedKeys || [],
        updatedAt: existing.updatedAt,
      },
      existing.authSecret
    );
    return { adminProfileCert };
  }

  if (cfg.adminProfilePayload) {
    let saltHex = cfg.adminProfilePayload.passwordSalt;
    let passwordHash = cfg.adminProfilePayload.passwordHash;
    if (nextPassword && nextPassword.length > 0) {
      if (nextPassword.length < 6) {
        throw new Error("New password must be at least 6 characters.");
      }
      saltHex = crypto.randomBytes(16).toString("hex");
      const derived = await scryptHash(nextPassword, saltHex);
      passwordHash = derived.toString("hex");
    }
    const updatedPayload: SignedAdminProfilePayload = {
      v: 1,
      username: cleanUser,
      passwordSalt: saltHex,
      passwordHash,
      authorizedKeys: cfg.adminProfilePayload.authorizedKeys || [],
      updatedAt: Date.now(),
    };
    return {
      adminProfileCert: issueAdminProfileCertificate(
        updatedPayload,
        cfg.authSecret
      ),
    };
  }

  throw new Error(
    "Credentials configured via environment variables must be updated in your hosting dashboard."
  );
}

export async function addWhitelistedKey(
  cfg: EffectiveAuthConfig,
  record: AuthorizedKeyRecord
): Promise<{
  persistedOnDisk: boolean;
  adminProfileCert?: string;
  signedKeyCert: string;
}> {
  const signedKeyCert = issueSignedAuthorizedKeyCertificate(
    record,
    cfg.username,
    cfg.authSecret
  );

  if (isPersistentDiskAvailable()) {
    let disk = await readDiskAuthFile();
    if (!disk) {
      disk = {
        version: 1,
        username: cfg.username,
        passwordSalt: crypto.randomBytes(16).toString("hex"),
        passwordHash: "",
        authSecret: cfg.authSecret,
        passkeys: [],
        authorizedKeys: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    const keys = disk.authorizedKeys || [];
    const idx = keys.findIndex((k) => k.fingerprint === record.fingerprint);
    if (idx >= 0) {
      keys[idx] = { ...record, source: "server" };
    } else {
      keys.push({ ...record, source: "server" });
    }
    disk.authorizedKeys = keys;
    disk.updatedAt = Date.now();
    await writeDiskAuthFile(disk);
    return { persistedOnDisk: true, signedKeyCert };
  }

  if (cfg.adminProfilePayload) {
    const keys = [...(cfg.adminProfilePayload.authorizedKeys || [])];
    const idx = keys.findIndex((k) => k.fingerprint === record.fingerprint);
    if (idx >= 0) {
      keys[idx] = record;
    } else {
      keys.push(record);
    }
    const updatedPayload: SignedAdminProfilePayload = {
      ...cfg.adminProfilePayload,
      authorizedKeys: keys,
      updatedAt: Date.now(),
    };
    return {
      persistedOnDisk: false,
      adminProfileCert: issueAdminProfileCertificate(
        updatedPayload,
        cfg.authSecret
      ),
      signedKeyCert,
    };
  }

  return { persistedOnDisk: false, signedKeyCert };
}

export async function removeWhitelistedKey(
  cfg: EffectiveAuthConfig,
  fingerprint: string
): Promise<{ removedOnDisk: boolean; adminProfileCert?: string }> {
  if (isPersistentDiskAvailable()) {
    const disk = await readDiskAuthFile();
    if (disk && Array.isArray(disk.authorizedKeys)) {
      const before = disk.authorizedKeys.length;
      disk.authorizedKeys = disk.authorizedKeys.filter(
        (k) => k.fingerprint !== fingerprint && k.id !== fingerprint
      );
      if (disk.authorizedKeys.length !== before) {
        disk.updatedAt = Date.now();
        await writeDiskAuthFile(disk);
        return { removedOnDisk: true };
      }
    }
    return { removedOnDisk: false };
  }

  if (cfg.adminProfilePayload) {
    const nextKeys = (cfg.adminProfilePayload.authorizedKeys || []).filter(
      (k) => k.fingerprint !== fingerprint && k.id !== fingerprint
    );
    const updatedPayload: SignedAdminProfilePayload = {
      ...cfg.adminProfilePayload,
      authorizedKeys: nextKeys,
      updatedAt: Date.now(),
    };
    return {
      removedOnDisk: false,
      adminProfileCert: issueAdminProfileCertificate(
        updatedPayload,
        cfg.authSecret
      ),
    };
  }

  return { removedOnDisk: false };
}

export async function saveServerPasskey(
  record: StoredPasskeyRecord
): Promise<boolean> {
  if (!isPersistentDiskAvailable()) return false;
  let disk = await readDiskAuthFile();
  if (!disk) {
    const cfg = await getEffectiveAuthConfig();
    if (!cfg.initialized) return false;
    disk = {
      version: 1,
      username: cfg.username,
      passwordSalt: crypto.randomBytes(16).toString("hex"),
      passwordHash: "",
      authSecret: cfg.authSecret,
      passkeys: [],
      authorizedKeys: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  const idx = disk.passkeys.findIndex((p) => p.id === record.id);
  if (idx >= 0) {
    disk.passkeys[idx] = record;
  } else {
    disk.passkeys.push(record);
  }
  disk.updatedAt = Date.now();
  await writeDiskAuthFile(disk);
  return true;
}

export async function removeServerPasskey(credentialId: string): Promise<boolean> {
  if (!isPersistentDiskAvailable()) return false;
  const disk = await readDiskAuthFile();
  if (!disk) return false;
  const before = disk.passkeys.length;
  disk.passkeys = disk.passkeys.filter((p) => p.id !== credentialId);
  if (disk.passkeys.length !== before) {
    disk.updatedAt = Date.now();
    await writeDiskAuthFile(disk);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session Cookies & Admin Profile Cookies
// ---------------------------------------------------------------------------

export interface SessionClaims {
  sub: string;
  iat: number;
  exp: number;
}

export function createSessionToken(username: string, secret: string): string {
  const now = Date.now();
  const claims: SessionClaims = {
    sub: username,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  return signPayload(claims as unknown as Record<string, unknown>, secret);
}

export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  expectedUsername?: string
): SessionClaims | null {
  const claims = verifySignedPayload<SessionClaims>(token, secret);
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (Date.now() > claims.exp) {
    return null;
  }
  if (expectedUsername && !safeEqualStrings(claims.sub, expectedUsername)) {
    return null;
  }
  return claims;
}

export function attachSessionCookie(
  res: NextResponse,
  sessionToken: string,
  req?: NextRequest
): void {
  const proto =
    req?.headers.get("x-forwarded-proto") ||
    (req?.nextUrl.protocol === "https:" ? "https" : "http");
  const isSecure = proto === "https" || process.env.NODE_ENV === "production";

  res.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function attachAdminProfileCookie(
  res: NextResponse,
  adminProfileCert: string,
  req?: NextRequest
): void {
  const proto =
    req?.headers.get("x-forwarded-proto") ||
    (req?.nextUrl.protocol === "https:" ? "https" : "http");
  const isSecure = proto === "https" || process.env.NODE_ENV === "production";

  res.cookies.set(ADMIN_CERT_COOKIE_NAME, adminProfileCert, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_CERT_TTL_SEC,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
}

// ---------------------------------------------------------------------------
// WebAuthn Challenge Tokens & Signed Passkey / Key Certificates
// ---------------------------------------------------------------------------

export interface WebAuthnChallengeClaims {
  challenge: string;
  rpID: string;
  origin: string;
  purpose: "register" | "login";
  exp: number;
}

export function createChallengeToken(
  claims: Omit<WebAuthnChallengeClaims, "exp">,
  secret: string
): string {
  return signPayload(
    {
      ...claims,
      exp: Date.now() + CHALLENGE_TTL_MS,
    },
    secret
  );
}

export function verifyChallengeToken(
  token: string | undefined | null,
  expectedPurpose: "register" | "login",
  secret: string
): WebAuthnChallengeClaims | null {
  const claims = verifySignedPayload<WebAuthnChallengeClaims>(token, secret);
  if (!claims || claims.purpose !== expectedPurpose) return null;
  if (Date.now() > claims.exp) return null;
  return claims;
}

interface SignedPasskeyPayload extends StoredPasskeyRecord {
  v: 1;
  username: string;
}

export function issueSignedPasskeyCertificate(
  record: StoredPasskeyRecord,
  username: string,
  secret: string
): string {
  const payload: SignedPasskeyPayload = {
    v: 1,
    username,
    ...record,
  };
  return signPayload(payload as unknown as Record<string, unknown>, secret);
}

export function verifySignedPasskeyCertificates(
  certs: string[] | undefined,
  expectedUsername: string,
  secret: string
): StoredPasskeyRecord[] {
  if (!Array.isArray(certs) || !secret) return [];
  const valid: StoredPasskeyRecord[] = [];
  const seen = new Set<string>();

  for (const cert of certs) {
    if (typeof cert !== "string") continue;
    const payload = verifySignedPayload<SignedPasskeyPayload>(cert, secret);
    if (!payload || payload.v !== 1) continue;
    if (expectedUsername && !safeEqualStrings(payload.username, expectedUsername)) {
      continue;
    }
    if (!payload.id || !payload.publicKey || seen.has(payload.id)) continue;
    seen.add(payload.id);
    valid.push({
      id: payload.id,
      publicKey: payload.publicKey,
      counter: Number(payload.counter || 0),
      transports: payload.transports,
      label: payload.label || "Passkey",
      deviceType: payload.deviceType || "multiDevice",
      backedUp: Boolean(payload.backedUp),
      createdAt: Number(payload.createdAt || Date.now()),
      lastUsedAt: payload.lastUsedAt,
    });
  }
  return valid;
}

interface SignedAuthorizedKeyPayload extends AuthorizedKeyRecord {
  v: 1;
  username: string;
}

export function issueSignedAuthorizedKeyCertificate(
  record: AuthorizedKeyRecord,
  username: string,
  secret: string
): string {
  const payload: SignedAuthorizedKeyPayload = {
    v: 1,
    username,
    ...record,
    source: "certificate",
  };
  return signPayload(payload as unknown as Record<string, unknown>, secret);
}

export function verifySignedAuthorizedKeyCertificates(
  certs: string[] | undefined,
  expectedUsername: string,
  secret: string
): AuthorizedKeyRecord[] {
  if (!Array.isArray(certs) || !secret) return [];
  const valid: AuthorizedKeyRecord[] = [];
  const seen = new Set<string>();

  for (const cert of certs) {
    if (typeof cert !== "string") continue;
    const payload = verifySignedPayload<SignedAuthorizedKeyPayload>(cert, secret);
    if (!payload || payload.v !== 1) continue;
    if (expectedUsername && !safeEqualStrings(payload.username, expectedUsername)) {
      continue;
    }
    if (
      !payload.fingerprint ||
      !payload.publicKeyOpenSSH ||
      seen.has(payload.fingerprint)
    ) {
      continue;
    }
    seen.add(payload.fingerprint);
    valid.push({
      id: payload.fingerprint,
      fingerprint: payload.fingerprint,
      keyType: payload.keyType || "ssh-ed25519",
      publicKeyOpenSSH: payload.publicKeyOpenSSH,
      label: payload.label || "Authorized Key",
      createdAt: Number(payload.createdAt || Date.now()),
      lastUsedAt: payload.lastUsedAt,
      source: "certificate",
    });
  }
  return valid;
}

export function mergeAuthorizedKeys(
  serverKeys: AuthorizedKeyRecord[],
  certKeys: AuthorizedKeyRecord[]
): AuthorizedKeyRecord[] {
  return mergeAuthorizedKeyLists(certKeys, serverKeys);
}

export function mergePasskeySummaries(
  serverKeys: StoredPasskeyRecord[],
  certKeys: StoredPasskeyRecord[]
): PublicPasskeySummary[] {
  const map = new Map<string, PublicPasskeySummary>();
  for (const k of certKeys) {
    map.set(k.id, {
      id: k.id,
      label: k.label,
      deviceType: k.deviceType,
      backedUp: k.backedUp,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      source: "certificate",
    });
  }
  for (const k of serverKeys) {
    map.set(k.id, {
      id: k.id,
      label: k.label,
      deviceType: k.deviceType,
      backedUp: k.backedUp,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      source: "server",
    });
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Request & WebSocket Authentication Guard
// ---------------------------------------------------------------------------

export async function verifyIncomingAuth(
  headers: Headers | IncomingMessage["headers"],
  explicitSessionOrToken?: string | null
): Promise<{ ok: boolean; username?: string; error?: string }> {
  const gatewayTokenEnv = process.env.SUSHI_GATEWAY_TOKEN?.trim();
  let providedGatewayToken = "";
  let providedSessionHeader = explicitSessionOrToken?.trim() || "";
  let cookieHeader = "";

  if (headers instanceof Headers) {
    providedGatewayToken =
      headers.get("x-sushi-token")?.trim() ||
      headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
      "";
    if (!providedSessionHeader) {
      providedSessionHeader = headers.get("x-sushi-session")?.trim() || "";
    }
    cookieHeader = headers.get("cookie") || "";
  } else {
    const rawGw = headers["x-sushi-token"] || headers["authorization"];
    providedGatewayToken = (Array.isArray(rawGw) ? rawGw[0] : rawGw || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!providedSessionHeader) {
      const rawSess = headers["x-sushi-session"];
      providedSessionHeader = (
        Array.isArray(rawSess) ? rawSess[0] : rawSess || ""
      ).trim();
    }
    const rawCookie = headers.cookie;
    cookieHeader = Array.isArray(rawCookie)
      ? rawCookie.join("; ")
      : rawCookie || "";
  }

  if (
    gatewayTokenEnv &&
    providedGatewayToken &&
    safeEqualStrings(providedGatewayToken, gatewayTokenEnv)
  ) {
    return { ok: true, username: "gateway" };
  }

  if (process.env.GATEWAY_ONLY === "true" && gatewayTokenEnv) {
    return { ok: false, error: "Valid SUSHI_GATEWAY_TOKEN required." };
  }

  const cfg = await getEffectiveAuthConfig(headers);
  const cookieSession = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  const candidateTokens = [
    providedSessionHeader,
    cookieSession,
    providedGatewayToken,
  ].filter(Boolean) as string[];

  // On persistent-disk VPS or env-configured instances, require initialized account first
  if (isPersistentDiskAvailable() && !cfg.initialized) {
    return {
      ok: false,
      error: "Authentication required: complete initial admin setup first.",
    };
  }

  const expectedUsername = cfg.initialized ? cfg.username : undefined;
  for (const tok of candidateTokens) {
    const claims = verifySessionToken(tok, cfg.authSecret, expectedUsername);
    if (claims) {
      return { ok: true, username: claims.sub };
    }
  }

  return {
    ok: false,
    error:
      "Authentication required: sign in with Password, Passkey, or Whitelisted Private Key.",
  };
}

export function resolveWebAuthnRpFromRequest(req: NextRequest): {
  rpID: string;
  origin: string;
  rpName: string;
} {
  const forwardedHost = req.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const hostHeader = forwardedHost || req.headers.get("host") || req.nextUrl.host;
  const forwardedProto = req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const proto =
    forwardedProto ||
    req.nextUrl.protocol.replace(":", "") ||
    (hostHeader.startsWith("localhost") || hostHeader.startsWith("127.0.0.1")
      ? "http"
      : "https");

  const rpID = hostHeader.split(":")[0];
  const origin = `${proto}://${hostHeader}`;

  return {
    rpID,
    origin,
    rpName: "Sushi Workspace",
  };
}
