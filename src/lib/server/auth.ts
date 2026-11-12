import crypto from "node:crypto";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { NextRequest, NextResponse } from "next/server";
import type {
  PublicPasskeySummary,
  StoredPasskeyRecord,
} from "@/types/auth";
import { compareAndSwapAuthWithVaultGuard, compareAndSwapStateRecord, getStateStoreKind, hasPersistentStateStore, readStateRecord } from "./state-store";

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
  createdAt: number;
  updatedAt: number;
}

export interface SignedAdminProfilePayload {
  v: 1;
  username: string;
  passwordSalt: string;
  passwordHash: string;
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
  sessionVersion?: string;
  serverPasskeys: StoredPasskeyRecord[];
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

// Remember the exact bytes read so concurrent account changes cannot overwrite
// one another. The metadata is not serialized into the account record.
const authRecordSources = new WeakMap<DiskAuthFile, string>();

/** Bind sessions to the current credentials without exposing their hash. */
function credentialSessionVersion(secret: string, ...parts: string[]): string {
  return crypto.createHmac("sha256", secret)
    .update("sushi-session-credentials-v1\0")
    .update(JSON.stringify(parts))
    .digest("hex");
}

async function readDiskAuthFile(): Promise<DiskAuthFile | null> {
  if (!hasPersistentStateStore()) return null;
  const raw = await readStateRecord("auth");
  if (raw === null) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Persistent account data is corrupt; setup is disabled until it is restored.");
  }
  if (!parsed || parsed.version !== 1 || typeof parsed.username !== "string" ||
      !parsed.username || typeof parsed.authSecret !== "string" || !parsed.authSecret ||
      typeof parsed.passwordSalt !== "string" || typeof parsed.passwordHash !== "string" ||
      (parsed.passkeys !== undefined && !Array.isArray(parsed.passkeys))) {
    throw new Error("Persistent account data is invalid; setup is disabled until it is restored.");
  }
  const record: DiskAuthFile = {
    version: 1,
    username: parsed.username,
    passwordSalt: parsed.passwordSalt,
    passwordHash: parsed.passwordHash,
    authSecret: parsed.authSecret,
    passkeys: Array.isArray(parsed.passkeys) ? (parsed.passkeys as StoredPasskeyRecord[]) : [],
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
  };
  authRecordSources.set(record, raw);
  return record;
}

async function writeDiskAuthFile(data: DiskAuthFile, vaultGuard?: { raw: string | null }): Promise<void> {
  const previous = authRecordSources.get(data) ?? null;
  const next = JSON.stringify(data, null, 2);
  const saved = vaultGuard
    ? await compareAndSwapAuthWithVaultGuard(previous, next, vaultGuard.raw)
    : await compareAndSwapStateRecord("auth", previous, next);
  if (!saved) {
    if (previous === null) throw new Error("Admin account is already initialized.");
    throw new Error("Account or vault changed in another request. Refresh and try again.");
  }
  authRecordSources.set(data, next);
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
  if (!parsed || parsed.v !== 1 || typeof parsed.username !== "string" ||
      !parsed.username || typeof parsed.passwordSalt !== "string" ||
      typeof parsed.passwordHash !== "string") {
    return null;
  }
  return {
    v: 1,
    username: parsed.username,
    passwordSalt: parsed.passwordSalt,
    passwordHash: parsed.passwordHash,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
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

  const hasEnvCreds = Boolean(
    envUser && (envPass.length > 0 || envPassHash.length > 0)
  );

  // 1. Explicit Environment Variable Credentials
  if (hasEnvCreds) {
    const derivedSecret = deriveInstanceSecret(
      `${envUser}:${envPassHash || envPass}`
    );

    const mergedPasskeysMap = new Map<string, StoredPasskeyRecord>();
    for (const pk of [...envPasskeys, ...(disk?.passkeys || [])]) {
      mergedPasskeysMap.set(pk.id, pk);
    }

    return {
      initialized: true,
      canBootstrapOnDisk: isPersistentDiskAvailable(),
      canBootstrapInteractive: true,
      envConfigured: true,
      username: envUser,
      authSecret: derivedSecret,
      sessionVersion: credentialSessionVersion(derivedSecret, envUser, envPassHash || envPass),
      serverPasskeys: Array.from(mergedPasskeysMap.values()),
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

  // 2. Persistent State Store Auth Record (Self-Hosted Disk, Turso, Firestore, or Redis)
  if (disk) {
    const mergedPasskeysMap = new Map<string, StoredPasskeyRecord>();
    for (const pk of [...envPasskeys, ...disk.passkeys]) {
      mergedPasskeysMap.set(pk.id, pk);
    }

    return {
      initialized: true,
      canBootstrapOnDisk: isPersistentDiskAvailable(),
      canBootstrapInteractive: true,
      envConfigured: false,
      username: disk.username,
      authSecret: envSecret || disk.authSecret,
      sessionVersion: credentialSessionVersion(envSecret || disk.authSecret, disk.username, disk.passwordSalt, disk.passwordHash),
      serverPasskeys: Array.from(mergedPasskeysMap.values()),
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

  // 3. Stateless Interactive Browser-Bootstrapped Admin Certificate (Legacy Vercel opt-in)
  const serverlessSecret = deriveInstanceSecret();
  const rawAdminCert = extractAdminCertFromHeaders(headers, explicitAdminCert);
  const verifiedProfile = verifyAdminProfileCertificate(
    rawAdminCert,
    serverlessSecret
  );

  if (verifiedProfile) {
    const storeKind = getStateStoreKind();
    if (storeKind === "redis" || storeKind === "turso" || storeKind === "firestore") {
      if (!verifiedProfile.passwordSalt || !verifiedProfile.passwordHash) {
        throw new Error("The existing browser account cannot be migrated without its password profile.");
      }
      const now = Date.now();
      const record: DiskAuthFile = {
        version: 1,
        username: verifiedProfile.username,
        passwordSalt: verifiedProfile.passwordSalt,
        passwordHash: verifiedProfile.passwordHash,
        authSecret: serverlessSecret,
        passkeys: [],
        createdAt: now,
        updatedAt: verifiedProfile.updatedAt || now,
      };
      // Another browser may have initialized the store at the same time. In
      // either case, re-read the authoritative record instead of overwriting it.
      await compareAndSwapStateRecord("auth", null, JSON.stringify(record, null, 2));
      return getEffectiveAuthConfig(headers, explicitAdminCert);
    }

    return {
      initialized: true,
      canBootstrapOnDisk: isPersistentDiskAvailable(),
      canBootstrapInteractive: true,
      envConfigured: false,
      username: verifiedProfile.username,
      authSecret: serverlessSecret,
      sessionVersion: credentialSessionVersion(serverlessSecret, verifiedProfile.username, verifiedProfile.passwordSalt, verifiedProfile.passwordHash),
      serverPasskeys: envPasskeys,
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

  // 4. Uninitialized — Ready for interactive First-Run Setup in Browser
  return {
    initialized: false,
    canBootstrapOnDisk: isPersistentDiskAvailable(),
    canBootstrapInteractive: hasPersistentStateStore() || process.env.SUSHI_ALLOW_STATELESS_SETUP === "true",
    envConfigured: false,
    username: "",
    authSecret: serverlessSecret,
    serverPasskeys: envPasskeys,
    verifyPassword: async () => false,
  };
}

/**
 * Bootstraps an admin account on persistent state storage (or stateless Vercel opt-in,
 * returning a signed `adminProfileCert` cookie + token).
 */
export async function bootstrapAdminAccount(
  username: string,
  password: string
): Promise<{
  username: string;
  authSecret: string;
  adminProfileCert: string;
  persistedOnDisk: boolean;
  sessionVersion: string;
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

  if (hasPersistentStateStore()) {
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
        updatedAt: now,
      },
      authSecret
    );
    return {
      username: cleanUser,
      authSecret,
      adminProfileCert,
      persistedOnDisk: getStateStoreKind() === "disk",
      sessionVersion: credentialSessionVersion(authSecret, cleanUser, saltHex, passwordHash),
    };
  }

  if (process.env.SUSHI_ALLOW_STATELESS_SETUP !== "true") {
    throw new Error("Configure persistent shared storage before creating an account on Vercel.");
  }

  // Stateless Vercel deployment: seal profile into an HMAC-SHA256 certificate
  const authSecret = deriveInstanceSecret();
  const adminProfileCert = issueAdminProfileCertificate(
    {
      v: 1,
      username: cleanUser,
      passwordSalt: saltHex,
      passwordHash,
      updatedAt: now,
    },
    authSecret
  );

  return {
    username: cleanUser,
    authSecret,
    adminProfileCert,
    persistedOnDisk: false,
    sessionVersion: credentialSessionVersion(authSecret, cleanUser, saltHex, passwordHash),
  };
}

// Keep alias for backward compatibility
export const bootstrapDiskAdminAccount = bootstrapAdminAccount;

export async function updateAdminCredentials(
  cfg: EffectiveAuthConfig,
  nextUsername: string,
  nextPassword?: string,
  currentPassword?: string,
  vaultGuard?: { raw: string | null }
): Promise<{ adminProfileCert?: string; sessionVersion: string }> {
  const cleanUser = nextUsername.trim();
  if (cleanUser.length < 2 || cleanUser.length > 64) {
    throw new Error("Username must be between 2 and 64 characters.");
  }

  if (hasPersistentStateStore()) {
    const existing = await readDiskAuthFile();
    if (!existing) {
      throw new Error("No persistent account record found.");
    }
    if (currentPassword !== undefined) {
      const derived = await scryptHash(currentPassword, existing.passwordSalt);
      const expected = Buffer.from(existing.passwordHash, "hex");
      if (derived.length !== expected.length || !crypto.timingSafeEqual(derived, expected)) {
        throw new Error("Account credentials changed in another request. Sign in again.");
      }
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
    await writeDiskAuthFile(existing, vaultGuard);

    const adminProfileCert = issueAdminProfileCertificate(
      {
        v: 1,
        username: existing.username,
        passwordSalt: existing.passwordSalt,
        passwordHash: existing.passwordHash,
        updatedAt: existing.updatedAt,
      },
      existing.authSecret
    );
    return {
      adminProfileCert,
      sessionVersion: credentialSessionVersion(cfg.authSecret, existing.username, existing.passwordSalt, existing.passwordHash),
    };
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
      updatedAt: Date.now(),
    };
    return {
      adminProfileCert: issueAdminProfileCertificate(
        updatedPayload,
        cfg.authSecret
      ),
      sessionVersion: credentialSessionVersion(cfg.authSecret, cleanUser, saltHex, passwordHash),
    };
  }

  throw new Error(
    "Credentials configured via environment variables must be updated in your hosting dashboard."
  );
}

export async function saveServerPasskey(
  record: StoredPasskeyRecord
): Promise<boolean> {
  if (!hasPersistentStateStore()) return false;
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
  if (!hasPersistentStateStore()) return false;
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
  sv?: string;
}

export function createSessionToken(username: string, secret: string, sessionVersion?: string): string {
  const now = Date.now();
  const claims: SessionClaims = {
    sub: username,
    iat: now,
    exp: now + SESSION_TTL_MS,
    ...(sessionVersion ? { sv: sessionVersion } : {}),
  };
  return signPayload(claims as unknown as Record<string, unknown>, secret);
}

export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  expectedUsername?: string,
  expectedSessionVersion?: string
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
  if (expectedSessionVersion && (typeof claims.sv !== "string" || !safeEqualStrings(claims.sv, expectedSessionVersion))) {
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
// WebAuthn Challenge Tokens & Signed Passkey Certificates
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

/** Account and vault operations require an admin session, not a gateway token.
 * Gateway tokens authorize protocol access on a companion VPS only. */
export async function verifyAdminSession(headers: Headers): Promise<{ ok: boolean; username?: string; error?: string }> {
  // The general gateway CORS policy can allow other origins. Account and vault
  // cookies must not be usable by an unrelated origin (including same-site
  // subdomains) merely because a gateway is configured with ALLOWED_ORIGIN=*.
  const origin = headers.get("origin");
  if (origin) {
    const host = (headers.get("x-forwarded-host") || headers.get("host") || "").split(",")[0].trim().toLowerCase();
    const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
    try {
      const parsed = new URL(origin);
      if (!host || parsed.host.toLowerCase() !== host ||
          (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
          (forwardedProto && parsed.protocol !== `${forwardedProto}:`)) {
        return { ok: false, error: "Account and vault requests must originate from this Sushi site." };
      }
    } catch {
      return { ok: false, error: "Account and vault requests must originate from this Sushi site." };
    }
  }
  const cfg = await getEffectiveAuthConfig(headers);
  if (cfg.initialized) {
    const sessionHeader = headers.get("x-sushi-session")?.trim();
    const sessionCookie = parseCookieValue(headers.get("cookie") || "", SESSION_COOKIE_NAME);
    for (const token of [sessionHeader, sessionCookie]) {
      const claims = verifySessionToken(token, cfg.authSecret, cfg.username, cfg.sessionVersion);
      if (claims) return { ok: true, username: claims.sub };
    }
  }
  return { ok: false, error: "Authentication required: sign in to the admin account." };
}

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

  const wrongGatewayToken =
    "Gateway token rejected: it doesn't match this gateway's SUSHI_GATEWAY_TOKEN. Copy the exact value from the gateway's .env into Sushi → Gateway settings.";

  if (process.env.GATEWAY_ONLY === "true" && gatewayTokenEnv) {
    return {
      ok: false,
      error: providedGatewayToken
        ? wrongGatewayToken
        : "This Sushi gateway requires its access token: enter the gateway's SUSHI_GATEWAY_TOKEN in Sushi → Gateway settings.",
    };
  }

  const cfg = await getEffectiveAuthConfig(headers);
  const cookieSession = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  const candidateTokens = [
    providedSessionHeader,
    cookieSession,
    providedGatewayToken,
  ].filter(Boolean) as string[];

  // On persistent-disk VPS or env-configured instances, sessions are only valid once
  // the admin account exists (never trust tokens signed with a fallback secret).
  const awaitingSetup = !cfg.initialized;

  if (!awaitingSetup) {
    const expectedUsername = cfg.initialized ? cfg.username : undefined;
    for (const tok of candidateTokens) {
      const claims = verifySessionToken(tok, cfg.authSecret, expectedUsername, cfg.sessionVersion);
      if (claims) {
        return { ok: true, username: claims.sub };
      }
    }
  }

  // A gateway token was sent (typically a Vercel-hosted Sushi using this server as
  // its VPS gateway) but it could not be accepted — explain how to fix it.
  if (providedGatewayToken) {
    return {
      ok: false,
      error: gatewayTokenEnv
        ? wrongGatewayToken
        : "This server has no SUSHI_GATEWAY_TOKEN configured, so it can't accept connections from another Sushi frontend. Set SUSHI_GATEWAY_TOKEN in its .env (the same value as in Sushi → Gateway settings) and restart it.",
    };
  }

  if (awaitingSetup) {
    return {
      ok: false,
      error: "Authentication required: complete initial admin setup first.",
    };
  }

  return {
    ok: false,
    error:
      "Authentication required: sign in with Password or Passkey.",
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
