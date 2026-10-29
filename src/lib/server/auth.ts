import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { NextRequest, NextResponse } from "next/server";
import type { PublicPasskeySummary, StoredPasskeyRecord } from "@/types/auth";

export const SESSION_COOKIE_NAME = "sushi_session";
export const CHALLENGE_COOKIE_NAME = "sushi_webauthn_challenge";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHALLENGE_TTL_MS = 3 * 60 * 1000; // 3 minutes

interface DiskAuthFile {
  version: 1;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  authSecret: string;
  passkeys: StoredPasskeyRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface EffectiveAuthConfig {
  initialized: boolean;
  canBootstrapOnDisk: boolean;
  envConfigured: boolean;
  username: string;
  verifyPassword: (candidate: string) => Promise<boolean>;
  authSecret: string;
  serverPasskeys: StoredPasskeyRecord[];
}

// Simple per-IP login brute-force tracker
const failedLoginBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const bucket = failedLoginBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    return { allowed: true };
  }
  if (bucket.count >= 10) {
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

async function readDiskAuthFile(): Promise<DiskAuthFile | null> {
  if (!isPersistentDiskAvailable()) return null;
  try {
    const raw = await fs.readFile(getAuthFilePath(), "utf8");
    const parsed = JSON.parse(raw) as DiskAuthFile;
    if (!parsed?.username || !parsed?.passwordHash) return null;
    return {
      ...parsed,
      passkeys: Array.isArray(parsed.passkeys) ? parsed.passkeys : [],
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
      return parsed.filter((p) => p && typeof p.id === "string" && typeof p.publicKey === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export async function getEffectiveAuthConfig(): Promise<EffectiveAuthConfig> {
  const envUser = process.env.SUSHI_AUTH_USERNAME?.trim() || "";
  const envPass = process.env.SUSHI_AUTH_PASSWORD ?? "";
  const envPassHash = process.env.SUSHI_AUTH_PASSWORD_HASH?.trim() || "";
  const envSecret = process.env.SUSHI_AUTH_SECRET?.trim() || "";
  const disk = await readDiskAuthFile();
  const envPasskeys = parseEnvPasskeys();

  const hasEnvCreds = Boolean(envUser && (envPass.length > 0 || envPassHash.length > 0));

  if (hasEnvCreds) {
    // Derive deterministic secret if SUSHI_AUTH_SECRET wasn't explicitly set
    const derivedSecret =
      envSecret ||
      Buffer.from(
        crypto.hkdfSync(
          "sha256",
          `${envUser}:${envPassHash || envPass}`,
          "sushi-auth-hkdf-salt-v1",
          "sushi-session-hmac-secret",
          32
        )
      ).toString("hex");

    const mergedPasskeysMap = new Map<string, StoredPasskeyRecord>();
    for (const pk of [...envPasskeys, ...(disk?.passkeys || [])]) {
      mergedPasskeysMap.set(pk.id, pk);
    }

    return {
      initialized: true,
      canBootstrapOnDisk: isPersistentDiskAvailable(),
      envConfigured: true,
      username: envUser,
      authSecret: derivedSecret,
      serverPasskeys: Array.from(mergedPasskeysMap.values()),
      verifyPassword: async (candidate: string) => {
        if (envPassHash) {
          // Format: "<saltHex>:<scryptHex>" or sha256 hex
          if (envPassHash.includes(":")) {
            const [salt, expectedHex] = envPassHash.split(":");
            const derived = await scryptHash(candidate, salt);
            const expectedBuf = Buffer.from(expectedHex, "hex");
            return (
              derived.length === expectedBuf.length &&
              crypto.timingSafeEqual(derived, expectedBuf)
            );
          }
          const candSha = crypto.createHash("sha256").update(candidate, "utf8").digest("hex");
          return safeEqualStrings(candSha, envPassHash.toLowerCase());
        }
        return safeEqualStrings(candidate, envPass);
      },
    };
  }

  if (disk) {
    const mergedPasskeysMap = new Map<string, StoredPasskeyRecord>();
    for (const pk of [...envPasskeys, ...disk.passkeys]) {
      mergedPasskeysMap.set(pk.id, pk);
    }

    return {
      initialized: true,
      canBootstrapOnDisk: true,
      envConfigured: false,
      username: disk.username,
      authSecret: envSecret || disk.authSecret,
      serverPasskeys: Array.from(mergedPasskeysMap.values()),
      verifyPassword: async (candidate: string) => {
        const derived = await scryptHash(candidate, disk.passwordSalt);
        const expected = Buffer.from(disk.passwordHash, "hex");
        return (
          derived.length === expected.length &&
          crypto.timingSafeEqual(derived, expected)
        );
      },
    };
  }

  return {
    initialized: false,
    canBootstrapOnDisk: isPersistentDiskAvailable(),
    envConfigured: false,
    username: "",
    authSecret: envSecret || "",
    serverPasskeys: envPasskeys,
    verifyPassword: async () => false,
  };
}

export async function bootstrapDiskAdminAccount(
  username: string,
  password: string
): Promise<DiskAuthFile> {
  if (!isPersistentDiskAvailable()) {
    throw new Error(
      "Stateless Vercel deployments configure admin credentials via SUSHI_AUTH_USERNAME and SUSHI_AUTH_PASSWORD environment variables."
    );
  }
  const existing = await readDiskAuthFile();
  if (existing) {
    throw new Error("Admin account is already initialized.");
  }

  const cleanUser = username.trim();
  if (cleanUser.length < 2 || cleanUser.length > 64) {
    throw new Error("Username must be between 2 and 64 characters.");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  const saltHex = crypto.randomBytes(16).toString("hex");
  const derived = await scryptHash(password, saltHex);
  const now = Date.now();

  const record: DiskAuthFile = {
    version: 1,
    username: cleanUser,
    passwordSalt: saltHex,
    passwordHash: derived.toString("hex"),
    authSecret:
      process.env.SUSHI_AUTH_SECRET?.trim() ||
      crypto.randomBytes(32).toString("hex"),
    passkeys: [],
    createdAt: now,
    updatedAt: now,
  };

  await writeDiskAuthFile(record);
  return record;
}

export async function updateDiskCredentials(
  nextUsername: string,
  nextPassword?: string
): Promise<void> {
  if (!isPersistentDiskAvailable()) {
    throw new Error(
      "Account credentials are managed via environment variables on serverless deployments."
    );
  }
  const existing = await readDiskAuthFile();
  if (!existing) {
    throw new Error("No disk account record found.");
  }
  const cleanUser = nextUsername.trim();
  if (cleanUser.length < 2 || cleanUser.length > 64) {
    throw new Error("Username must be between 2 and 64 characters.");
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
}

export async function saveServerPasskey(record: StoredPasskeyRecord): Promise<boolean> {
  if (!isPersistentDiskAvailable()) return false;
  let disk = await readDiskAuthFile();
  if (!disk) {
    // Env-configured VPS: create auxiliary auth file holding passkeys
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
// HMAC-Signed Tokens (Session Tokens, WebAuthn Challenges, Stateless Passkeys)
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

function verifySignedPayload<T>(token: string | undefined | null, secret: string): T | null {
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
  if (!claims || typeof claims.sub !== "string" || typeof claims.exp !== "number") {
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

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
}

// WebAuthn Challenge Tokens (stateless, works across cold starts on Vercel)
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

// Server-Signed Passkey Certificates (enables zero-DB WebAuthn Passkeys on Vercel!)
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
    if (!safeEqualStrings(payload.username, expectedUsername)) continue;
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

function parseCookieValue(cookieHeader: string | undefined | null, name: string): string | null {
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

export async function verifyIncomingAuth(
  headers: Headers | IncomingMessage["headers"],
  explicitSessionOrToken?: string | null
): Promise<{ ok: boolean; username?: string; error?: string }> {
  // 1. Check optional SUSHI_GATEWAY_TOKEN (for headless/remote gateway mode)
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
      providedSessionHeader = (Array.isArray(rawSess) ? rawSess[0] : rawSess || "").trim();
    }
    const rawCookie = headers.cookie;
    cookieHeader = Array.isArray(rawCookie) ? rawCookie.join("; ") : rawCookie || "";
  }

  if (gatewayTokenEnv && providedGatewayToken && safeEqualStrings(providedGatewayToken, gatewayTokenEnv)) {
    return { ok: true, username: "gateway" };
  }

  // In standalone GATEWAY_ONLY mode when SUSHI_GATEWAY_TOKEN is set, require token
  if (process.env.GATEWAY_ONLY === "true") {
    if (gatewayTokenEnv) {
      return { ok: false, error: "Valid SUSHI_GATEWAY_TOKEN required." };
    }
  }

  // 2. Check User Auth Session (Username/Password or Passkey login session)
  const cfg = await getEffectiveAuthConfig();
  if (!cfg.initialized) {
    return {
      ok: false,
      error: "Authentication required: complete initial admin setup first.",
    };
  }

  const cookieSession = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  const candidateTokens = [providedSessionHeader, cookieSession, providedGatewayToken].filter(
    Boolean
  ) as string[];

  for (const tok of candidateTokens) {
    const claims = verifySessionToken(tok, cfg.authSecret, cfg.username);
    if (claims) {
      return { ok: true, username: claims.sub };
    }
  }

  return {
    ok: false,
    error: "Authentication required: please sign in with username/password or Passkey.",
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
