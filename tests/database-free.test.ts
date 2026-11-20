import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as getStatus } from "../src/app/api/auth/status/route";
import { POST as setup } from "../src/app/api/auth/setup/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as getVault, POST as postVault } from "../src/app/api/vault/route";
import { GET as getCapabilities } from "../src/app/api/system/capabilities/route";
import {
  createSessionToken,
  getEffectiveAuthConfig,
  issueAdminProfileCertificate,
  verifyIncomingAuth,
} from "../src/lib/server/auth";
import { getStateStoreKind } from "../src/lib/server/state-store";
import { decryptVaultEnvelope, encryptVaultData, loadLocalEnvelope, type VaultPlaintext } from "../src/lib/client/crypto-vault";
import { fetchSessionVaultKey, readLocalVaultSnapshot, saveLocalVaultIfUnchanged } from "../src/lib/client/vault-sync";
import { readPortableBackup, replaceLocalVaultFromBackup } from "../src/lib/client/local-vault-recovery";

const envKeys = [
  "DATA_DIR", "VERCEL", "SUSHI_AUTH_USERNAME", "SUSHI_AUTH_PASSWORD", "SUSHI_AUTH_PASSWORD_HASH",
  "SUSHI_AUTH_SECRET", "SUSHI_AUTH_PROFILE_CERT", "SUSHI_GATEWAY_TOKEN", "GATEWAY_ONLY",
  "SUSHI_SERVER_VAULT", "SUSHI_STORAGE_BACKEND", "SUSHI_ALLOW_STATELESS_SETUP",
  "SUSHI_TURSO_DATABASE_URL", "SUSHI_TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
  "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_DATABASE_ID", "SUSHI_FIRESTORE_CREDENTIALS_JSON",
  "SUSHI_REDIS_REST_URL", "SUSHI_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "SUSHI_LEGACY_TURSO_CONFIGURED",
  "SUSHI_LEGACY_FIRESTORE_CONFIGURED", "SUSHI_LEGACY_REDIS_CONFIGURED",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];

function req(url: string, method = "GET", body?: unknown, token?: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-sushi-session": token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const password = "a-long-unique-test-password";
const plain: VaultPlaintext = {
  version: 1,
  hosts: [{ id: "one", name: "production", protocol: "ssh", host: "example.test", port: 22, username: "root", authMethod: "password", password: "private-host-password", createdAt: 1, updatedAt: 1 }],
  snippets: [],
  sshKeys: [],
};

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sushi-no-database-"));
  const savedFetch = globalThis.fetch;
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    process.env.DATA_DIR = path.join(temp, "disk");
    assert.equal(getStateStoreKind(), "disk");
    const created = await setup(req("/api/auth/setup", "POST", { username: "operator", password }));
    assert.equal(created.status, 200);
    const oldToken = (await created.json()).sessionToken as string;
    const oldConfig = await getEffectiveAuthConfig();
    const diskAuth = await fs.readFile(path.join(process.env.DATA_DIR, "auth.json"), "utf8");
    const oldKeyResult = await getVault(req("/api/vault", "GET", undefined, oldToken));
    const oldKey = (await oldKeyResult.json()).vaultKey as string;
    const cachedSessionVault = { ...(await encryptVaultData(plain, oldKey)), keySource: "session" as const };

    // Any prior database configuration fails closed. Neither account setup nor
    // login may silently create a new, unrelated account or contact a provider.
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("unexpected network access"); };
    for (const name of [
      "SUSHI_TURSO_DATABASE_URL", "SUSHI_TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
      "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_DATABASE_ID", "SUSHI_FIRESTORE_CREDENTIALS_JSON",
      "SUSHI_REDIS_REST_URL", "SUSHI_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
      "KV_REST_API_URL", "KV_REST_API_TOKEN", "SUSHI_LEGACY_TURSO_CONFIGURED",
      "SUSHI_LEGACY_FIRESTORE_CONFIGURED", "SUSHI_LEGACY_REDIS_CONFIGURED",
    ]) {
      process.env[name] = "do-not-leak-this-secret";
      const status = await getStatus(req("/api/auth/status"));
      assert.equal(status.status, 503, `${name} must fail closed`);
      const data = await status.json();
      assert.match(data.error, /back up|back up your account/i);
      assert(!JSON.stringify(data).includes("do-not-leak-this-secret"));
      assert.equal((await setup(req("/api/auth/setup", "POST", { username: "attacker", password }))).status, 503);
      assert.equal(await fs.readFile(path.join(process.env.DATA_DIR, "auth.json"), "utf8"), diskAuth);
      delete process.env[name];
    }
    for (const backend of ["turso", "firestore", "redis"]) {
      process.env.SUSHI_STORAGE_BACKEND = backend;
      assert.equal((await getStatus(req("/api/auth/status"))).status, 503);
      delete process.env.SUSHI_STORAGE_BACKEND;
    }
    assert.equal(calls, 0, "legacy settings must never create a provider connection");
    globalThis.fetch = savedFetch;

    // No durable filesystem on Vercel. Legacy stateless setup and even a validly
    // signed browser profile cannot provision a second account on the server.
    process.env.VERCEL = "1";
    process.env.DATA_DIR = path.join(temp, "must-not-be-created");
    process.env.SUSHI_AUTH_SECRET = oldConfig.authSecret;
    process.env.SUSHI_ALLOW_STATELESS_SETUP = "true";
    assert.equal(getStateStoreKind(), "none");
    const oldProfile = issueAdminProfileCertificate({ v: 1, username: "rogue", passwordSalt: "aa", passwordHash: "bb", updatedAt: Date.now() }, oldConfig.authSecret);
    const uninitialized = await getStatus(req("/api/auth/status", "GET", undefined, undefined, { "x-sushi-admin-cert": oldProfile }));
    assert.equal(uninitialized.status, 200);
    assert.equal((await uninitialized.json()).initialized, false);
    assert.equal((await getEffectiveAuthConfig(new Headers({ "x-sushi-admin-cert": oldProfile }))).canBootstrapInteractive, false);
    assert.equal((await setup(req("/api/auth/setup", "POST", { username: "rogue", password }))).status, 400);
    const rogueToken = createSessionToken("rogue", oldConfig.authSecret);
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": rogueToken, "x-sushi-admin-cert": oldProfile }))).ok, false);
    assert.equal((await getVault(req("/api/vault"))).status, 401);
    process.env.SUSHI_STORAGE_BACKEND = "disk";
    assert.equal((await getStatus(req("/api/auth/status"))).status, 503);
    delete process.env.SUSHI_STORAGE_BACKEND;

    process.env.SUSHI_AUTH_USERNAME = "operator";
    process.env.SUSHI_AUTH_PASSWORD = password;
    const status = await getStatus(req("/api/auth/status"));
    const statusJson = await status.json();
    assert.equal(statusJson.initialized, true);
    assert.equal(statusJson.envConfigured, true);
    assert.equal(statusJson.canBootstrapInteractive, false);
    assert.equal(statusJson.storage, "none");
    assert.equal(statusJson.authenticated, false);
    assert.equal((await login(req("/api/auth/login", "POST", { username: "operator", password: "wrong" }))).status, 401);
    const loggedIn = await login(req("/api/auth/login", "POST", { username: "operator", password }));
    assert.equal(loggedIn.status, 200);
    const token = (await loggedIn.json()).sessionToken as string;
    process.env.TURSO_AUTH_TOKEN = "legacy-secret";
    assert.equal((await getStatus(req("/api/auth/status", "GET", undefined, token))).status, 503);
    assert.equal((await getVault(req("/api/vault", "GET", undefined, token))).status, 503);
    delete process.env.TURSO_AUTH_TOKEN;
    const capabilityData = await (await getCapabilities(req("/api/system/capabilities"))).json();
    assert.equal(capabilityData.serverVault, false);
    assert.equal(capabilityData.storageBackend, "none");
    const localVaultResponse = await getVault(req("/api/vault", "GET", undefined, token));
    const localVaultData = await localVaultResponse.json();
    assert.equal(localVaultData.enabled, false);
    assert.equal(localVaultData.envelope, null);
    assert.equal(localVaultData.vaultKey, oldKey, "preserving the original secret recovers session-key browser caches");
    assert.deepEqual((await decryptVaultEnvelope(cachedSessionVault, localVaultData.vaultKey)).hosts, plain.hosts);
    assert.equal((await getVault(req("/api/vault", "GET", undefined, token, { origin: "https://attacker.example", host: "localhost" }))).status, 401);
    assert.equal((await postVault(req("/api/vault", "POST", { envelope: cachedSessionVault, baseRevision: null }, token))).status, 400);
    await assert.rejects(fs.access(process.env.DATA_DIR), /ENOENT/);

    // Exercise the browser-local session key fetch, including rejection of an
    // unauthenticated request, without enabling remote vault persistence.
    const local = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, String(value)),
      removeItem: (key: string) => local.delete(key),
    } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_name: string, action: () => unknown) => action() } } });
    const gateway = { gatewayUrl: "", gatewayToken: "" };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/api/vault");
      return getVault(new NextRequest("http://localhost/api/vault", { headers: options?.headers }));
    };
    local.set("sushi.auth.sessionToken.v1", token);
    assert.equal(await fetchSessionVaultKey(gateway), oldKey);
    local.delete("sushi.auth.sessionToken.v1");
    await assert.rejects(fetchSessionVaultKey(gateway), /authentication/i);

    // A portable backup can recover an unreadable browser vault without
    // overwriting it on a bad passphrase or a stale-tab write.
    local.set("sushi_encrypted_vault_v1", JSON.stringify(cachedSessionVault));
    const backup = await encryptVaultData(plain, "portable-backup-password");
    await assert.rejects(readPortableBackup(JSON.stringify(backup), "wrong"));
    const notAVault = await encryptVaultData({ version: 1, hosts: "invalid" } as unknown as VaultPlaintext, "portable-backup-password");
    await assert.rejects(readPortableBackup(JSON.stringify(notAVault), "portable-backup-password"), /not a valid Sushi vault/i);
    assert.deepEqual(loadLocalEnvelope(), cachedSessionVault);
    const decoded = await readPortableBackup(JSON.stringify(backup), "portable-backup-password");
    assert.deepEqual(decoded.hosts, plain.hosts);
    const expectedRaw = readLocalVaultSnapshot();
    const competing = await encryptVaultData(plain, "another-key");
    await saveLocalVaultIfUnchanged(cachedSessionVault, competing);
    await assert.rejects(replaceLocalVaultFromBackup(decoded, expectedRaw), /changed in another tab/i);
    assert.deepEqual(loadLocalEnvelope(), competing);
    await replaceLocalVaultFromBackup(decoded, readLocalVaultSnapshot());
    let recovered = loadLocalEnvelope()!;
    assert.equal(recovered.mode, "device");
    assert.deepEqual((await decryptVaultEnvelope(recovered, null)).hosts, plain.hosts);
    assert(!local.get("sushi_encrypted_vault_v1")!.includes("private-host-password"));

    // Damaged JSON can be downloaded and compared exactly rather than treated as
    // an empty vault. A stale recovery must not replace it.
    local.set("sushi_encrypted_vault_v1", "{damaged vault bytes");
    local.set("sushi_vault_sync_v1", JSON.stringify({ revision: "old", iv: "old" }));
    assert.throws(() => loadLocalEnvelope(), /could not be read/i);
    const damaged = readLocalVaultSnapshot();
    await assert.rejects(replaceLocalVaultFromBackup(decoded, null), /changed in another tab/i);
    assert.equal(readLocalVaultSnapshot(), damaged);
    await replaceLocalVaultFromBackup(decoded, damaged);
    recovered = loadLocalEnvelope()!;
    assert.deepEqual((await decryptVaultEnvelope(recovered, null)).hosts, plain.hosts);
    assert.equal(local.has("sushi_vault_sync_v1"), false);

    // An empty string is a damaged record, not an absent record: it must not be
    // silently treated as an empty vault by boot, cache, or recovery.
    local.set("sushi_encrypted_vault_v1", "");
    assert.throws(() => loadLocalEnvelope(), /could not be read/i);
    await assert.rejects(replaceLocalVaultFromBackup(decoded, null), /changed in another tab/i);
    assert.equal(readLocalVaultSnapshot(), "");
    await replaceLocalVaultFromBackup(decoded, "");
    assert.deepEqual((await decryptVaultEnvelope(loadLocalEnvelope()!, null)).hosts, plain.hosts);

    // Environment credential rotation revokes sessions even with a fixed secret.
    const envConfig = await getEffectiveAuthConfig();
    const envToken = createSessionToken(envConfig.username, envConfig.authSecret, envConfig.sessionVersion);
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": envToken }))).ok, true);
    process.env.SUSHI_AUTH_PASSWORD = `${password}-rotated`;
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": envToken }))).ok, false);
    console.log("DATABASE-FREE STORAGE, AUTHENTICATION AND RECOVERY TESTS PASSED");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else delete (globalThis as { window?: unknown }).window;
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage); else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator); else delete (globalThis as { navigator?: unknown }).navigator;
    await fs.rm(temp, { recursive: true, force: true });
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
