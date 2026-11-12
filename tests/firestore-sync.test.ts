import assert from "node:assert/strict";
import crypto from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { NextRequest } from "next/server";
import { GET as getStatus } from "../src/app/api/auth/status/route";
import { POST as setup } from "../src/app/api/auth/setup/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { PUT as changeAccount } from "../src/app/api/auth/account/route";
import { GET as getCapabilities } from "../src/app/api/system/capabilities/route";
import { GET as getVault, POST as postVault } from "../src/app/api/vault/route";
import { bootstrapAdminAccount, getEffectiveAuthConfig, saveServerPasskey } from "../src/lib/server/auth";
import { compareAndSwapAuthWithVaultGuard, compareAndSwapStateRecord, getStateStoreKind, initializeEmptyFirestore, readStateRecord } from "../src/lib/server/state-store";
import { decryptVaultEnvelope, encryptVaultData, type VaultPlaintext } from "../src/lib/client/crypto-vault";
import { MockFirestoreRest } from "./mock-firestore";

const envKeys = [
  "DATA_DIR", "VERCEL", "VERCEL_PROJECT_ID", "VERCEL_ENV", "SUSHI_AUTH_USERNAME", "SUSHI_AUTH_PASSWORD", "SUSHI_AUTH_PASSWORD_HASH",
  "SUSHI_AUTH_SECRET", "SUSHI_PASSKEYS_JSON", "SUSHI_GATEWAY_TOKEN", "GATEWAY_ONLY", "SUSHI_SERVER_VAULT",
  "SUSHI_REDIS_REST_URL", "SUSHI_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN",
  "SUSHI_TURSO_DATABASE_URL", "SUSHI_TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
  "SUSHI_STORAGE_PREFIX", "SUSHI_STORAGE_BACKEND", "SUSHI_ALLOW_STATELESS_SETUP", "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_DATABASE_ID",
  "SUSHI_FIRESTORE_CREDENTIALS_JSON", "FIRESTORE_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalGetClient = GoogleAuth.prototype.getClient;

function request(route: string, method = "GET", body?: unknown, token?: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-sushi-session": token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response) { return await response.json() as Record<string, any>; }

const oldPassword = "firestore-account-password-1";
const newPassword = "firestore-new-password-2";
const plain: VaultPlaintext = {
  version: 1,
  hosts: [{ id: "host-a", name: "Cloud SSH", protocol: "ssh", host: "example.test", port: 22,
    username: "root", authMethod: "password", password: "PRIVATE-SSH-PASSWORD", createdAt: 1, updatedAt: 1 }],
  snippets: [],
  sshKeys: [{ id: "ssh-key", name: "key", privateKey: "PRIVATE-SSH-KEY", createdAt: 1 }],
  enforceKeyWhitelist: true,
};
async function encrypted(password = oldPassword) {
  return { ...(await encryptVaultData(plain, password)), keySource: "account" as const };
}

async function main() {
  for (const key of envKeys) delete process.env[key];
  const firestore = new MockFirestoreRest();
  try {
    const host = await firestore.start();
    // The real Firestore SDK uses REST against the fixture. Authentication is
    // mocked only for local HTTP; no production credentials are requested.
    GoogleAuth.prototype.getClient = async () => ({
      fetch: globalThis.fetch,
      getRequestHeaders: async () => new Headers({ authorization: "Bearer owner" }),
      getUniverseDomain: async () => "googleapis.com",
    }) as unknown as Awaited<ReturnType<typeof originalGetClient>>;
    process.env.FIRESTORE_EMULATOR_HOST = host;
    process.env.VERCEL = "1";
    process.env.SUSHI_STORAGE_BACKEND = "firestore";
    process.env.SUSHI_FIRESTORE_PROJECT_ID = "sushi-test-project";
    process.env.SUSHI_STORAGE_PREFIX = "firestore-suite";

    assert.equal(getStateStoreKind(), "firestore");
    const status = await json(await getStatus(request("/api/auth/status")));
    assert.equal(status.initialized, false);
    assert.equal(status.canBootstrapInteractive, true);
    assert.equal(status.storage, "firestore");
    const caps = await json(await getCapabilities(request("/api/system/capabilities")));
    assert.equal(caps.storageBackend, "firestore");
    assert.equal(caps.serverVault, true);
    assert(!JSON.stringify(caps).includes("sushi-test-project"));

    const attempts = await Promise.all([
      setup(request("/api/auth/setup", "POST", { username: "operator", password: oldPassword })),
      setup(request("/api/auth/setup", "POST", { username: "operator", password: oldPassword })),
    ]);
    assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 409]);
    const token = (await json(attempts.find((response) => response.status === 200)!)).sessionToken as string;
    const loginResult = await login(request("/api/auth/login", "POST", { username: "operator", password: oldPassword }));
    assert.equal(loginResult.status, 200);
    const secondToken = (await json(loginResult)).sessionToken as string;
    assert.equal((await json(await getStatus(request("/api/auth/status")))).initialized, true);

    process.env.SUSHI_STORAGE_PREFIX = "firestore-contended";
    firestore.holdNextCommits(2);
    const contended = await Promise.all([
      compareAndSwapStateRecord("vault", null, "first"),
      compareAndSwapStateRecord("vault", null, "second"),
    ]);
    assert.deepEqual(contended.sort(), [false, true]);
    assert.ok(firestore.abortedCommits >= 1, "the real Google SDK retried an aborted transaction");
    process.env.SUSHI_STORAGE_PREFIX = "firestore-suite";

    const initial = await encrypted();
    const saved = await postVault(request("/api/vault", "POST", { envelope: initial, baseRevision: null }, token));
    assert.equal(saved.status, 200);
    const revision = (await json(saved)).revision as string;
    let remote = await json(await getVault(request("/api/vault", "GET", undefined, secondToken)));
    assert.deepEqual((await decryptVaultEnvelope(remote.envelope, oldPassword)).hosts, plain.hosts);
    assert.equal((await decryptVaultEnvelope(remote.envelope, oldPassword)).sshKeys?.[0].privateKey, "PRIVATE-SSH-KEY");
    const contents = firestore.rawChunks();
    assert(!contents.includes("PRIVATE-SSH-PASSWORD"));
    assert(!contents.includes("PRIVATE-SSH-KEY"));
    assert(!contents.includes(oldPassword));

    const [left, right] = await Promise.all([encrypted(), encrypted()]);
    const writes = await Promise.all([
      postVault(request("/api/vault", "POST", { envelope: left, baseRevision: revision }, token)),
      postVault(request("/api/vault", "POST", { envelope: right, baseRevision: revision }, secondToken)),
    ]);
    assert.deepEqual(writes.map((response) => response.status).sort(), [200, 409]);
    remote = await json(await getVault(request("/api/vault", "GET", undefined, token)));

    // The two-record guard must reject a stale vault without changing auth.
    const authRaw = await readStateRecord("auth");
    const vaultRaw = await readStateRecord("vault");
    assert.ok(authRaw && vaultRaw);
    assert.equal(await compareAndSwapAuthWithVaultGuard(authRaw, "do-not-write", "stale-vault"), false);
    assert.equal(await compareAndSwapAuthWithVaultGuard(authRaw, "do-not-write", null), false);
    assert.equal(await readStateRecord("auth"), authRaw);
    assert.equal(await readStateRecord("vault"), vaultRaw);

    // Password changes preserve the prior encryption until the new account
    // password has been verified and the new encrypted snapshot committed.
    const changeBody = { currentPassword: oldPassword, newUsername: "operator", newPassword };
    assert.equal((await changeAccount(request("/api/auth/account", "PUT", changeBody, token))).status, 409);
    const prepared = { ...remote.envelope, keySource: "independent" };
    const preparation = await postVault(request("/api/vault", "POST", { envelope: prepared, baseRevision: remote.revision }, token));
    assert.equal(preparation.status, 200);
    const prepRevision = (await json(preparation)).revision;
    const changed = await changeAccount(request("/api/auth/account", "PUT", changeBody, token));
    assert.equal(changed.status, 200);
    const freshToken = (await json(changed)).sessionToken as string;
    assert.equal((await getVault(request("/api/vault", "GET", undefined, token))).status, 401);
    assert.equal((await getVault(request("/api/vault", "GET", undefined, secondToken))).status, 401);
    const recoverable = await json(await getVault(request("/api/vault", "GET", undefined, freshToken)));
    assert.deepEqual((await decryptVaultEnvelope(recoverable.envelope, oldPassword)).hosts, plain.hosts);
    assert.equal((await postVault(request("/api/vault", "POST", { envelope: await encrypted(newPassword), baseRevision: prepRevision }, freshToken))).status, 200);
    const rotated = await json(await getVault(request("/api/vault", "GET", undefined, freshToken)));
    assert.deepEqual((await decryptVaultEnvelope(rotated.envelope, newPassword)).hosts, plain.hosts);
    await assert.rejects(decryptVaultEnvelope(rotated.envelope, oldPassword));

    await saveServerPasskey({ id: "firestore-passkey", publicKey: "abc", counter: 0, label: "Cloud", deviceType: "multiDevice", backedUp: true, createdAt: Date.now() });
    assert.equal((await getEffectiveAuthConfig()).serverPasskeys.length, 1);
    const tooLarge = { ...rotated.envelope, ciphertext: "A".repeat(4 * 1024 * 1024 + 1) };
    assert.equal((await postVault(request("/api/vault", "POST", { envelope: tooLarge, baseRevision: rotated.revision }, freshToken))).status, 413);
    assert.equal((await json(await getVault(request("/api/vault", "GET", undefined, freshToken)))).revision, rotated.revision);

    firestore.offline = true;
    for (const response of [
      await getStatus(request("/api/auth/status")),
      await getVault(request("/api/vault", "GET", undefined, freshToken)),
      await setup(request("/api/auth/setup", "POST", { username: "attacker", password: oldPassword })),
    ]) {
      assert.equal(response.status, 503);
      assert(!JSON.stringify(await json(response)).includes("fixture credential"));
    }
    firestore.offline = false;
    assert.equal((await json(await getStatus(request("/api/auth/status")))).initialized, true);

    const restoreCorruptAuth = firestore.corruptOnePart("auth", "firestore-suite");
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    assert.equal((await setup(request("/api/auth/setup", "POST", { username: "attacker", password: oldPassword }))).status, 503);
    restoreCorruptAuth();
    const restoreCorruptVault = firestore.corruptOnePart("vault", "firestore-suite");
    assert.equal((await getVault(request("/api/vault", "GET", undefined, freshToken))).status, 503);
    assert.equal((await postVault(request("/api/vault", "POST", { envelope: initial, baseRevision: null }, freshToken))).status, 503);
    restoreCorruptVault();

    // A migration publishes both records together, never overwrites an existing
    // destination, and cannot mix records from two competing migrations.
    process.env.SUSHI_STORAGE_PREFIX = "firestore-copy-race";
    firestore.holdNextCommits(2);
    const copies = await Promise.all([
      initializeEmptyFirestore("account-a", "vault-a"),
      initializeEmptyFirestore("account-b", "vault-b"),
    ]);
    assert.deepEqual(copies.sort(), [false, true]);
    const copiedPair = [await readStateRecord("auth"), await readStateRecord("vault")];
    assert(copiedPair.join(":") === "account-a:vault-a" || copiedPair.join(":") === "account-b:vault-b");
    assert.equal(await initializeEmptyFirestore("overwrite", "overwrite"), false);
    assert.deepEqual([await readStateRecord("auth"), await readStateRecord("vault")], copiedPair);
    process.env.SUSHI_STORAGE_PREFIX = "firestore-copy-real";
    assert.equal(await initializeEmptyFirestore(authRaw, vaultRaw), true);
    assert.equal(await readStateRecord("auth"), authRaw);
    assert.equal(await readStateRecord("vault"), vaultRaw);

    // Namespace isolation and >1 MiB records: chunks are read in a consistent
    // snapshot and old chunks disappear in the same transaction as replacement.
    process.env.SUSHI_STORAGE_PREFIX = "firestore-large";
    assert.equal(await readStateRecord("auth"), null);
    assert.equal(await readStateRecord("vault"), null);
    const large = `${"x".repeat(512 * 1024 - 1)}🍣${"y".repeat(700 * 1024)}`;
    assert.equal(await compareAndSwapStateRecord("vault", null, large), true);
    assert.equal(await readStateRecord("vault"), large);
    const oldParts = [...firestore.documents.keys()].filter((name) => name.includes("/parts/vault-"));
    assert(oldParts.length >= 3);
    assert.equal(await compareAndSwapStateRecord("vault", large, "replacement"), true);
    assert.equal(await readStateRecord("vault"), "replacement");
    // Filter for this namespace via the old parts that disappeared; other
    // namespaces deliberately retain their own encrypted records.
    assert(oldParts.some((name) => !firestore.documents.has(name)));
    assert.equal(await compareAndSwapStateRecord("vault", large, "stale-overwrite"), false);
    firestore.failAfterNextCommit = true;
    await assert.rejects(compareAndSwapStateRecord("vault", "replacement", "committed-but-response-lost"), /could not be confirmed/);
    assert.equal(await readStateRecord("vault"), "committed-but-response-lost");
    process.env.SUSHI_STORAGE_PREFIX = "firestore-suite";
    assert.equal((await json(await getStatus(request("/api/auth/status")))).initialized, true);

    // Missing/invalid Firestore configuration never falls back to Redis/disk,
    // and secret text is not returned in error responses.
    process.env.SUSHI_REDIS_REST_URL = "https://example.invalid";
    process.env.SUSHI_REDIS_REST_TOKEN = "redis-secret";
    process.env.SUSHI_FIRESTORE_PROJECT_ID = "";
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    assert.equal((await setup(request("/api/auth/setup", "POST", { username: "attacker", password: oldPassword }))).status, 503);
    process.env.SUSHI_FIRESTORE_PROJECT_ID = "sushi-test-project";
    process.env.SUSHI_FIRESTORE_CREDENTIALS_JSON = "private-key-must-not-leak";
    const invalidCredentials = await getStatus(request("/api/auth/status"));
    assert.equal(invalidCredentials.status, 503);
    assert(!JSON.stringify(await json(invalidCredentials)).includes("private-key-must-not-leak"));
    delete process.env.SUSHI_FIRESTORE_CREDENTIALS_JSON;
    process.env.SUSHI_STORAGE_BACKEND = "auto";
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    process.env.SUSHI_STORAGE_BACKEND = "disk";
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    delete process.env.SUSHI_REDIS_REST_URL;
    delete process.env.SUSHI_REDIS_REST_TOKEN;

    // An existing signed browser account may seed an empty Firestore namespace
    // when the same server signing secret is retained.
    delete process.env.SUSHI_STORAGE_BACKEND;
    delete process.env.SUSHI_FIRESTORE_PROJECT_ID;
    process.env.SUSHI_ALLOW_STATELESS_SETUP = "true";
    process.env.SUSHI_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
    const legacy = await bootstrapAdminAccount("legacy-browser", oldPassword);
    process.env.SUSHI_STORAGE_BACKEND = "firestore";
    process.env.SUSHI_FIRESTORE_PROJECT_ID = "sushi-test-project";
    process.env.SUSHI_STORAGE_PREFIX = "firestore-migration";
    const migration = await getStatus(request("/api/auth/status", "GET", undefined, undefined, { "x-sushi-admin-cert": legacy.adminProfileCert }));
    assert.equal(migration.status, 200);
    assert.equal((await json(await getStatus(request("/api/auth/status")))).initialized, true);
    assert.equal((await getEffectiveAuthConfig()).username, "legacy-browser");
    assert.equal(await (await getEffectiveAuthConfig()).verifyPassword(oldPassword), true);

    // ADC failures are caught before the SDK starts a background request.
    delete process.env.FIRESTORE_EMULATOR_HOST;
    process.env.SUSHI_STORAGE_PREFIX = "missing-adc";
    GoogleAuth.prototype.getClient = async () => { throw new Error("credential details must remain private"); };
    const missingAdc = await getStatus(request("/api/auth/status"));
    assert.equal(missingAdc.status, 503);
    assert(!JSON.stringify(await json(missingAdc)).includes("credential details"));
    console.log("FIRESTORE SYNC TESTS PASSED (mock REST service, real Google SDK)");
  } finally {
    GoogleAuth.prototype.getClient = originalGetClient;
    await firestore.close();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
