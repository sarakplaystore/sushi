import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as getStatus } from "../src/app/api/auth/status/route";
import { POST as setup } from "../src/app/api/auth/setup/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as accountAction, PUT as changeAccount } from "../src/app/api/auth/account/route";
import { POST as registerPasskey } from "../src/app/api/auth/passkey/register/route";
import { GET as getVault, POST as postVault } from "../src/app/api/vault/route";
import { bootstrapAdminAccount, createSessionToken, getEffectiveAuthConfig, saveServerPasskey, verifyIncomingAuth } from "../src/lib/server/auth";
import { compareAndSwapAuthWithVaultGuard, readStateRecord } from "../src/lib/server/state-store";
import { decryptVaultEnvelope, encryptVaultData, type EncryptedVaultEnvelope, type VaultPlaintext } from "../src/lib/client/crypto-vault";
import { cacheSyncedVault, cacheSyncedVaultIfUnchanged, getLocalSyncMetadata, sameVaultEnvelope, saveLocalVaultIfUnchanged, subscribeVaultChanges } from "../src/lib/client/vault-sync";

const envKeys = [
  "DATA_DIR", "VERCEL", "VERCEL_PROJECT_ID", "VERCEL_ENV", "SUSHI_AUTH_USERNAME", "SUSHI_AUTH_PASSWORD",
  "SUSHI_AUTH_PASSWORD_HASH", "SUSHI_AUTH_SECRET", "SUSHI_GATEWAY_TOKEN", "GATEWAY_ONLY",
  "SUSHI_REDIS_REST_URL", "SUSHI_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "SUSHI_TURSO_DATABASE_URL", "SUSHI_TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
  "SUSHI_STORAGE_PREFIX", "SUSHI_STORAGE_BACKEND", "SUSHI_SERVER_VAULT", "SUSHI_ALLOW_STATELESS_SETUP",
  "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_DATABASE_ID", "SUSHI_FIRESTORE_CREDENTIALS_JSON",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];

function request(route: string, method = "GET", body?: unknown, token?: string, extra: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-sushi-session": token } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response) { return await response.json() as Record<string, any>; }

const originalPassword = "strong-account-password-1";
const newPassword = "another-strong-password-2";
const plaintext: VaultPlaintext = {
  version: 1,
  hosts: [{
    id: "host-a", name: "Production SSH", protocol: "ssh", host: "example.test", port: 22,
    username: "root", authMethod: "password", password: "ssh-private-password", createdAt: 1, updatedAt: 1,
  }],
  snippets: [],
  sshKeys: [{ id: "key-1", name: "admin key", privateKey: "SSH-PRIVATE-KEY-SECRET", createdAt: 1 }],
  enforceKeyWhitelist: true,
};
async function envelope(password = originalPassword): Promise<EncryptedVaultEnvelope> {
  return { ...(await encryptVaultData(plaintext, password)), keySource: "account" };
}

// The mock speaks the Redis REST command protocol used by Upstash. It allows
// exercising the real storage code and Lua CAS paths without external services.
const redis = new Map<string, string>();
let redisOffline = false;
const redisServer = http.createServer(async (req, res) => {
  if (redisOffline) { res.writeHead(503).end(); return; }
  if (req.headers.authorization !== "Bearer test-only-token") { res.writeHead(403).end(); return; }
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.from(part));
  const args = JSON.parse(Buffer.concat(parts).toString()) as (string | number)[];
  let result: string | number | null = null;
  if (args[0] === "GET") {
    result = redis.get(String(args[1])) ?? null;
  } else if (args[0] === "EVAL" && args[2] === 1) {
    const key = String(args[3]);
    const existing = redis.get(key) ?? null;
    const matches = args[4] === "missing" ? existing === null : existing === args[5];
    if (matches) redis.set(key, String(args[6]));
    result = matches ? 1 : 0;
  } else if (args[0] === "EVAL" && args[2] === 2) {
    const auth = redis.get(String(args[3])) ?? null;
    const vault = redis.get(String(args[4])) ?? null;
    const authMatches = args[5] === "missing" ? auth === null : auth === args[6];
    const vaultMatches = args[7] === "missing" ? vault === null : vault === args[8];
    const matches = authMatches && vaultMatches;
    if (matches) redis.set(String(args[3]), String(args[9]));
    result = matches ? 1 : 0;
  } else {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unsupported command" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
});

async function runBackendSuite(label: string) {
  console.log(`==> ${label}: global setup and encrypted multi-device vault`);
  const firstStatus = await json(await getStatus(request("/api/auth/status")));
  assert.equal(firstStatus.initialized, false);
  assert.equal(firstStatus.canBootstrapInteractive, true);

  // Simultaneous setup attempts must never create two accounts.
  const attempts = await Promise.all([
    setup(request("/api/auth/setup", "POST", { username: "operator", password: originalPassword })),
    setup(request("/api/auth/setup", "POST", { username: "operator", password: originalPassword })),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const created = await json(attempts.find((r) => r.status === 200)!);
  const token = created.sessionToken as string;
  assert.ok(token);
  const otherBrowser = await json(await getStatus(request("/api/auth/status")));
  assert.equal(otherBrowser.initialized, true);
  assert.equal(otherBrowser.authenticated, false);
  const signIn = await login(request("/api/auth/login", "POST", { username: "operator", password: originalPassword }));
  assert.equal(signIn.status, 200);
  const secondToken = (await json(signIn)).sessionToken as string;
  assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": secondToken }))).ok, true, "session also authorizes protocols");
  const sameOrigin = { origin: "http://localhost", host: "localhost" };
  const otherOrigin = { origin: "https://attacker.example", host: "localhost" };
  const wrongScheme = { origin: "http://sushi.example", host: "sushi.example", "x-forwarded-proto": "https" };
  const proxiedPreview = { origin: "https://3000-example.e2b.app", host: "localhost:3000", "x-forwarded-host": "3000-example.e2b.app", "x-forwarded-proto": "https" };
  assert.equal((await getVault(request("/api/vault", "GET", undefined, token, sameOrigin))).status, 200);
  assert.equal((await getVault(request("/api/vault", "GET", undefined, token, proxiedPreview))).status, 200);
  assert.equal((await getVault(request("/api/vault", "GET", undefined, token, otherOrigin))).status, 401);
  assert.equal((await getVault(request("/api/vault", "GET", undefined, token, { origin: "null", host: "localhost" }))).status, 401);
  assert.equal((await getVault(request("/api/vault", "GET", undefined, token, wrongScheme))).status, 401);
  assert.equal((await accountAction(request("/api/auth/account", "POST", { action: "list" }, token, otherOrigin))).status, 401);
  // A protocol-gateway token is not an admin login or permission to read the vault.
  process.env.SUSHI_GATEWAY_TOKEN = "gateway-only-secret";
  const gatewayHeaders = { "x-sushi-token": "gateway-only-secret" };
  assert.equal((await json(await getStatus(request("/api/auth/status", "GET", undefined, undefined, gatewayHeaders)))).authenticated, false);
  assert.equal((await getVault(request("/api/vault", "GET", undefined, undefined, gatewayHeaders))).status, 401);
  assert.equal((await accountAction(request("/api/auth/account", "POST", { action: "list" }, undefined, gatewayHeaders))).status, 401);
  assert.equal((await registerPasskey(request("/api/auth/passkey/register", "POST", { step: "options" }, undefined, gatewayHeaders))).status, 401);
  delete process.env.SUSHI_GATEWAY_TOKEN;

  let remote = await json(await getVault(request("/api/vault", "GET", undefined, token)));
  assert.equal(remote.enabled, true);
  assert.equal(remote.envelope, null);
  assert.equal(remote.revision, null);
  const encrypted = await envelope();
  const createdVault = await postVault(request("/api/vault", "POST", { envelope: encrypted, baseRevision: null }, token));
  assert.equal(createdVault.status, 200);
  const initialRevision = (await json(createdVault)).revision as string;
  remote = await json(await getVault(request("/api/vault", "GET", undefined, secondToken)));
  assert.equal(remote.revision, initialRevision);
  assert.deepEqual((await decryptVaultEnvelope(remote.envelope, originalPassword)).hosts, plaintext.hosts);
  assert.equal((await decryptVaultEnvelope(remote.envelope, originalPassword)).sshKeys?.[0].privateKey, "SSH-PRIVATE-KEY-SECRET");
  await assert.rejects(decryptVaultEnvelope(remote.envelope, "wrong-password"));
  const rawStorage = label === "disk"
    ? await fs.readFile(path.join(process.env.DATA_DIR!, "vault.enc.json"), "utf8")
    : Array.from(redis.values()).join("\n");
  assert(!rawStorage.includes("ssh-private-password"));
  assert(!rawStorage.includes("SSH-PRIVATE-KEY-SECRET"));
  assert(!rawStorage.includes(originalPassword));
  assert.equal((await postVault(request("/api/vault", "POST", { envelope: encrypted }, token))).status, 428);

  // Concurrent devices write against the same base: only one may win.
  const [leftEnvelope, rightEnvelope] = await Promise.all([envelope(), envelope()]);
  const writes = await Promise.all([
    postVault(request("/api/vault", "POST", { envelope: leftEnvelope, baseRevision: initialRevision }, token)),
    postVault(request("/api/vault", "POST", { envelope: rightEnvelope, baseRevision: initialRevision }, secondToken)),
  ]);
  assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
  remote = await json(await getVault(request("/api/vault", "GET", undefined, token)));
  assert.notEqual(remote.revision, initialRevision);

  // An old client cannot change a password while an account-bound vault exists.
  let passwordChange = await changeAccount(request("/api/auth/account", "PUT", {
    currentPassword: originalPassword, newUsername: "operator", newPassword,
  }, token));
  assert.equal(passwordChange.status, 409);
  assert.equal(await (await getEffectiveAuthConfig()).verifyPassword(originalPassword), true);

  // New clients first preserve the old password as an independent vault key,
  // then change the account, then re-encrypt with the new account password.
  const prepared = { ...remote.envelope, keySource: "independent" };
  const prepRes = await postVault(request("/api/vault", "POST", { envelope: prepared, baseRevision: remote.revision }, token));
  assert.equal(prepRes.status, 200);
  const prepRevision = (await json(prepRes)).revision;
  const authBytes = await readStateRecord("auth");
  assert.ok(authBytes);
  assert.equal(await compareAndSwapAuthWithVaultGuard(authBytes, "should-not-be-written", "wrong-vault-revision"), false);
  assert.equal(await readStateRecord("auth"), authBytes);
  passwordChange = await changeAccount(request("/api/auth/account", "PUT", {
    currentPassword: originalPassword, newUsername: "operator", newPassword,
  }, token));
  assert.equal(passwordChange.status, 200);
  const updatedToken = (await json(passwordChange)).sessionToken as string;
  assert.equal((await getVault(request("/api/vault", "GET", undefined, token))).status, 401, "password change must revoke the old session");
  assert.equal((await getVault(request("/api/vault", "GET", undefined, secondToken))).status, 401, "password change must revoke other devices");
  assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": secondToken }))).ok, false, "old sessions cannot authorize protocols after password change");
  assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": updatedToken }))).ok, true);
  assert.equal((await getVault(request("/api/vault", "GET", undefined, updatedToken))).status, 200, "the changing device receives a new session");
  assert.equal(await (await getEffectiveAuthConfig()).verifyPassword(originalPassword), false);
  assert.equal(await (await getEffectiveAuthConfig()).verifyPassword(newPassword), true);
  // If the final step were interrupted, the prior password still opens the
  // independent snapshot even though authentication now uses the new one.
  const recoverable = await json(await getVault(request("/api/vault", "GET", undefined, updatedToken)));
  assert.deepEqual((await decryptVaultEnvelope(recoverable.envelope, originalPassword)).hosts, plaintext.hosts);
  const rotated = await envelope(newPassword);
  const finish = await postVault(request("/api/vault", "POST", { envelope: rotated, baseRevision: prepRevision }, updatedToken));
  assert.equal(finish.status, 200);
  const freshLogin = await json(await login(request("/api/auth/login", "POST", { username: "operator", password: newPassword })));
  const freshVault = await json(await getVault(request("/api/vault", "GET", undefined, freshLogin.sessionToken)));
  assert.deepEqual((await decryptVaultEnvelope(freshVault.envelope, newPassword)).hosts, plaintext.hosts);
  await assert.rejects(decryptVaultEnvelope(freshVault.envelope, originalPassword));
  console.log(`    ${label}: setup race, credential sync, CAS conflicts and password recovery passed`);
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sushi-sync-test-"));
  try {
    // The browser cache contains ciphertext and revision metadata, never the
    // account password or the SSH credentials used to create it.
    const local = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
    } });
    const cachedEnvelope = await envelope();
    assert.equal(cacheSyncedVault(cachedEnvelope, "revision-1"), true);
    assert.equal(getLocalSyncMetadata()?.revision, "revision-1");
    assert(sameVaultEnvelope(cachedEnvelope, JSON.parse(local.get("sushi_encrypted_vault_v1")!)));
    assert(!Array.from(local.values()).join("").includes(originalPassword));
    assert(!Array.from(local.values()).join("").includes("ssh-private-password"));
    assert(!Array.from(local.values()).join("").includes("SSH-PRIVATE-KEY-SECRET"));

    // Simulate two tabs contending for the same Web Lock. Exactly one stale
    // write may win, and a remote-cache refresh must not clobber a newer local
    // encrypted copy either.
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let lockTail: Promise<void> = Promise.resolve();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
      request: async (_name: string, action: () => unknown) => {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await action(); } finally { release(); }
      },
    } } });
    const localA = await envelope();
    const localB = await envelope();
    const writes = await Promise.allSettled([
      saveLocalVaultIfUnchanged(cachedEnvelope, localA),
      saveLocalVaultIfUnchanged(cachedEnvelope, localB),
    ]);
    assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(writes.filter((result) => result.status === "rejected").length, 1);
    const winner = JSON.parse(local.get("sushi_encrypted_vault_v1")!) as EncryptedVaultEnvelope;
    assert(sameVaultEnvelope(winner, localA) || sameVaultEnvelope(winner, localB));
    assert.equal(await cacheSyncedVaultIfUnchanged(cachedEnvelope, await envelope(), "stale-revision"), false);
    assert(sameVaultEnvelope(JSON.parse(local.get("sushi_encrypted_vault_v1")!), winner));
    assert.equal(getLocalSyncMetadata(), null);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await assert.rejects(saveLocalVaultIfUnchanged(winner, await envelope()), /safely coordinate vault writes/);
    assert(sameVaultEnvelope(JSON.parse(local.get("sushi_encrypted_vault_v1")!), winner));
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;

    // Same-origin tab changes should refresh immediately; focus and the timer
    // only refresh a visible document, and unsubscribing removes all listeners.
    const fakeWindow = new EventTarget() as EventTarget & { setInterval: (callback: () => void, ms: number) => number; clearInterval: (id: number) => void };
    const fakeDocument = new EventTarget() as EventTarget & { visibilityState: string };
    fakeDocument.visibilityState = "visible";
    let tick = () => {};
    let timerCleared = false;
    fakeWindow.setInterval = (callback, ms) => { assert.equal(ms, 15000); tick = callback; return 42; };
    fakeWindow.clearInterval = (id) => { assert.equal(id, 42); timerCleared = true; };
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
    let refreshes = 0;
    const unsubscribe = subscribeVaultChanges(() => { refreshes++; });
    const storageEvent = (key: string | null) => Object.assign(new Event("storage"), { key });
    fakeWindow.dispatchEvent(storageEvent("unrelated"));
    assert.equal(refreshes, 0);
    fakeWindow.dispatchEvent(storageEvent("sushi_encrypted_vault_v1"));
    fakeWindow.dispatchEvent(storageEvent(null));
    assert.equal(refreshes, 2);
    fakeDocument.visibilityState = "hidden";
    fakeWindow.dispatchEvent(new Event("focus"));
    tick();
    assert.equal(refreshes, 2);
    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    fakeWindow.dispatchEvent(new Event("focus"));
    tick();
    assert.equal(refreshes, 5);
    unsubscribe();
    assert.equal(timerCleared, true);
    fakeWindow.dispatchEvent(storageEvent("sushi_encrypted_vault_v1"));
    assert.equal(refreshes, 5);
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;

    process.env.DATA_DIR = path.join(temp, "disk");
    await runBackendSuite("disk");

    // A pre-upgrade file has no revision and must remain readable and safely
    // updateable using the stable legacy digest returned by GET.
    const legacy = await envelope(newPassword);
    await fs.writeFile(path.join(process.env.DATA_DIR, "vault.enc.json"), JSON.stringify(legacy));
    const token = (await json(await login(request("/api/auth/login", "POST", { username: "operator", password: newPassword })))).sessionToken;
    const legacyRead = await json(await getVault(request("/api/vault", "GET", undefined, token)));
    assert.match(legacyRead.revision, /^legacy-[a-f0-9]{64}$/);
    assert.equal((await postVault(request("/api/vault", "POST", { envelope: await envelope(newPassword), baseRevision: legacyRead.revision }, token))).status, 200);
    await fs.writeFile(path.join(process.env.DATA_DIR, "vault.enc.json"), "{corrupt");
    assert.equal((await getVault(request("/api/vault", "GET", undefined, token))).status, 503);
    assert.equal((await postVault(request("/api/vault", "POST", { envelope: await envelope(newPassword), baseRevision: null }, token))).status, 503);
    assert.equal(await fs.readFile(path.join(process.env.DATA_DIR, "vault.enc.json"), "utf8"), "{corrupt");
    await fs.writeFile(path.join(process.env.DATA_DIR, "auth.json"), "{corrupt");
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    assert.equal((await setup(request("/api/auth/setup", "POST", { username: "attacker", password: originalPassword }))).status, 503);

    await new Promise<void>((resolve) => redisServer.listen(0, "127.0.0.1", resolve));
    const address = redisServer.address();
    if (!address || typeof address === "string") throw new Error("Redis mock did not start");
    const redisUrl = `http://127.0.0.1:${address.port}`;
    process.env.VERCEL = "1";
    process.env.UPSTASH_REDIS_REST_URL = redisUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-only-token";
    process.env.SUSHI_STORAGE_PREFIX = "sync-test";
    await runBackendSuite("redis");
    await saveServerPasskey({ id: "passkey-1", publicKey: "abc", counter: 0, label: "Test", deviceType: "multiDevice", backedUp: true, createdAt: Date.now() });
    assert.equal((await getEffectiveAuthConfig()).serverPasskeys.length, 1);
    assert(Array.from(redis.keys()).every((key) => key.startsWith("{sync-test}:")));

    const cloudToken = (await json(await login(request("/api/auth/login", "POST", { username: "operator", password: newPassword })))).sessionToken;
    redisOffline = true;
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    assert.equal((await getVault(request("/api/vault", "GET", undefined, cloudToken))).status, 503);
    assert.equal((await setup(request("/api/auth/setup", "POST", { username: "attacker", password: originalPassword }))).status, 503);
    redisOffline = false;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-only-token";

    // Existing Vercel browser certificates can seed an empty shared store once;
    // subsequent browsers find that same account without any certificate.
    redis.clear();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.SUSHI_ALLOW_STATELESS_SETUP = "true";
    process.env.SUSHI_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
    const legacyAccount = await bootstrapAdminAccount("old-browser", originalPassword);
    process.env.UPSTASH_REDIS_REST_URL = redisUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-only-token";
    const migrated = await getStatus(request("/api/auth/status", "GET", undefined, undefined, { "x-sushi-admin-cert": legacyAccount.adminProfileCert }));
    assert.equal(migrated.status, 200);
    assert.equal((await json(await getStatus(request("/api/auth/status")))).initialized, true);
    assert.equal((await getEffectiveAuthConfig()).username, "old-browser");
    assert.equal(await (await getEffectiveAuthConfig()).verifyPassword(originalPassword), true);

    // Environment-managed password changes must revoke sessions even when the
    // hosting provider keeps a fixed explicit session-signing secret.
    process.env.SUSHI_AUTH_USERNAME = "env-admin";
    process.env.SUSHI_AUTH_PASSWORD = originalPassword;
    const envConfig = await getEffectiveAuthConfig();
    const envToken = createSessionToken(envConfig.username, envConfig.authSecret, envConfig.sessionVersion);
    const unversioned = createSessionToken(envConfig.username, envConfig.authSecret);
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": envToken }))).ok, true);
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": unversioned }))).ok, false);
    process.env.SUSHI_AUTH_PASSWORD = newPassword;
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": envToken }))).ok, false);
    console.log("    Redis outage, configuration, session revocation and legacy-account migration passed");
  } finally {
    if (redisServer.listening) await new Promise<void>((resolve, reject) => redisServer.close((err) => err ? reject(err) : resolve()));
    await fs.rm(temp, { recursive: true, force: true });
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
  console.log("VAULT SYNC TESTS PASSED");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
