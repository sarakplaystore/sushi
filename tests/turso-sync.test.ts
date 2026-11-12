import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import initSqlJs, { type Database } from "sql.js";
import { NextRequest } from "next/server";
import { GET as getStatus } from "../src/app/api/auth/status/route";
import { POST as setup } from "../src/app/api/auth/setup/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { PUT as changeAccount } from "../src/app/api/auth/account/route";
import { GET as getCapabilities } from "../src/app/api/system/capabilities/route";
import { GET as getVault, POST as postVault } from "../src/app/api/vault/route";
import { bootstrapAdminAccount, getEffectiveAuthConfig, saveServerPasskey, verifyIncomingAuth } from "../src/lib/server/auth";
import { compareAndSwapAuthWithVaultGuard, getStateStoreKind, readStateRecord } from "../src/lib/server/state-store";
import { decryptVaultEnvelope, encryptVaultData, type EncryptedVaultEnvelope, type VaultPlaintext } from "../src/lib/client/crypto-vault";

const envKeys = [
  "DATA_DIR", "VERCEL", "VERCEL_PROJECT_ID", "VERCEL_ENV", "SUSHI_AUTH_USERNAME", "SUSHI_AUTH_PASSWORD",
  "SUSHI_AUTH_PASSWORD_HASH", "SUSHI_AUTH_SECRET", "SUSHI_AUTHORIZED_KEYS", "SUSHI_PASSKEYS_JSON",
  "SUSHI_GATEWAY_TOKEN", "GATEWAY_ONLY", "SUSHI_SERVER_VAULT",
  "SUSHI_REDIS_REST_URL", "SUSHI_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN",
  "SUSHI_TURSO_DATABASE_URL", "SUSHI_TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
  "SUSHI_STORAGE_PREFIX", "SUSHI_STORAGE_BACKEND", "SUSHI_ALLOW_STATELESS_SETUP",
  "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_DATABASE_ID", "SUSHI_FIRESTORE_CREDENTIALS_JSON",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];

function request(route: string, method = "GET", body?: unknown, token?: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-sushi-session": token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response) {
  return (await response.json()) as Record<string, any>;
}

const originalPassword = "turso-account-password-1";
const newPassword = "turso-rotated-password-2";
const plaintext: VaultPlaintext = {
  version: 1,
  hosts: [
    {
      id: "host-turso-1",
      name: "Tokyo Edge SSH",
      protocol: "ssh",
      host: "edge.example.test",
      port: 22,
      username: "ubuntu",
      authMethod: "password",
      password: "TURSO-SSH-SECRET-PASSWORD",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  snippets: [],
  sshKeys: [{ id: "key-turso-1", name: "deploy key", privateKey: "TURSO-SSH-PRIVATE-KEY", createdAt: 1 }],
  enforceKeyWhitelist: true,
};

async function makeEnvelope(password = originalPassword): Promise<EncryptedVaultEnvelope> {
  return { ...(await encryptVaultData(plaintext, password)), keySource: "account" };
}

function decodeHranaArg(arg: { type: string; value?: string | number }): string | number | null {
  if (arg.type === "null") return null;
  if (arg.type === "text") {
    assert.equal(typeof arg.value, "string");
    return arg.value as string;
  }
  if (arg.type === "integer") {
    assert.equal(typeof arg.value, "string", "Hrana v2 encodes integers as decimal strings");
    return Number(arg.value);
  }
  if (arg.type === "float") {
    assert.equal(typeof arg.value, "number");
    return arg.value as number;
  }
  throw new Error(`Unsupported Hrana arg type: ${arg.type}`);
}

function encodeHranaCell(val: unknown): { type: string; value?: string | number } {
  if (val === null || val === undefined) return { type: "null" };
  if (typeof val === "string") return { type: "text", value: val };
  if (typeof val === "number") {
    return Number.isInteger(val)
      ? { type: "integer", value: String(val) }
      : { type: "float", value: val };
  }
  throw new Error(`Unsupported SQLite cell type: ${typeof val}`);
}

async function main() {
  const SQL = await initSqlJs();
  const db: Database = new SQL.Database();
  let tursoOffline = false;
  let pipelineCalls = 0;

  // Speaks the real Turso Hrana v2 HTTP pipeline wire protocol (/v2/pipeline)
  // backed by an actual SQLite engine (sql.js).
  const server = http.createServer(async (req, res) => {
    if (tursoOffline) {
      res.writeHead(503).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/v2/pipeline") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== "Bearer turso-test-token") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    pipelineCalls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      requests: Array<{
        type: string;
        stmt?: {
          sql: string;
          args: Array<{ type: string; value?: string | number }>;
          named_args: unknown[];
          want_rows: boolean;
        };
      }>;
    };

    const results: unknown[] = [];
    for (const item of body.requests) {
      if (item.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      assert.equal(item.type, "execute");
      const stmtSpec = item.stmt!;
      try {
        const bound = stmtSpec.args.map(decodeHranaArg);
        const prepared = db.prepare(stmtSpec.sql);
        try {
          prepared.bind(bound);
          const colNames = prepared.getColumnNames();
          const rows: Array<Array<{ type: string; value?: string | number }>> = [];
          while (prepared.step()) {
            const rawRow = prepared.get();
            if (stmtSpec.want_rows) {
              rows.push(rawRow.map(encodeHranaCell));
            }
          }
          const affected = stmtSpec.want_rows ? 0 : db.getRowsModified();
          results.push({
            type: "ok",
            response: {
              type: "execute",
              result: {
                cols: colNames.map((name) => ({ name, decltype: null })),
                rows,
                affected_row_count: affected,
                last_insert_rowid: null,
              },
            },
          });
        } finally {
          prepared.free();
        }
      } catch (err) {
        results.push({
          type: "error",
          error: { message: err instanceof Error ? err.message : String(err), code: "SQLITE_ERROR" },
        });
      }
    }

    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ baton: null, base_url: null, results })
    );
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Turso mock server failed to start");
    const libsqlUrl = `libsql://127.0.0.1:${address.port}?tls=0`;

    // 1. Auto-detection on Vercel with standard Vercel Turso Marketplace env vars
    process.env.VERCEL = "1";
    process.env.VERCEL_PROJECT_ID = "prj_turso_test";
    process.env.VERCEL_ENV = "production";
    process.env.TURSO_DATABASE_URL = libsqlUrl;
    process.env.TURSO_AUTH_TOKEN = "turso-test-token";
    process.env.SUSHI_STORAGE_PREFIX = "turso-suite";

    assert.equal(getStateStoreKind(), "turso");
    const initialStatus = await json(await getStatus(request("/api/auth/status")));
    assert.equal(initialStatus.ok, true);
    assert.equal(initialStatus.initialized, false);
    assert.equal(initialStatus.canBootstrapInteractive, true);
    assert.equal(initialStatus.storage, "turso");

    const caps = await json(await getCapabilities(request("/api/system/capabilities")));
    assert.equal(caps.storageBackend, "turso");
    assert.equal(caps.serverVault, true);

    // 2. If table is dropped while process is warm, auto-recovery recreates it transparently
    db.run("DROP TABLE sushi_state_v1");
    assert.equal(await readStateRecord("auth"), null);

    // 3. Simultaneous setup attempts: exactly one wins
    const setupAttempts = await Promise.all([
      setup(request("/api/auth/setup", "POST", { username: "operator", password: originalPassword })),
      setup(request("/api/auth/setup", "POST", { username: "operator", password: originalPassword })),
    ]);
    assert.deepEqual(setupAttempts.map((r) => r.status).sort(), [200, 409]);
    const created = await json(setupAttempts.find((r) => r.status === 200)!);
    const tokenA = created.sessionToken as string;
    assert.ok(tokenA);

    const signIn = await login(request("/api/auth/login", "POST", { username: "operator", password: originalPassword }));
    assert.equal(signIn.status, 200);
    const tokenB = (await json(signIn)).sessionToken as string;

    // 4. Encrypted vault round-trip & CAS conflict check
    const initialEnvelope = await makeEnvelope();
    const saveRes = await postVault(request("/api/vault", "POST", { envelope: initialEnvelope, baseRevision: null }, tokenA));
    assert.equal(saveRes.status, 200);
    const rev1 = (await json(saveRes)).revision as string;

    const remote = await json(await getVault(request("/api/vault", "GET", undefined, tokenB)));
    assert.equal(remote.enabled, true);
    assert.equal(remote.revision, rev1);
    assert.deepEqual((await decryptVaultEnvelope(remote.envelope, originalPassword)).hosts, plaintext.hosts);

    // Inspect raw SQLite rows: namespaced keys, zero plaintext credentials
    const rawDump = JSON.stringify(db.exec("SELECT record_key, record_value FROM sushi_state_v1"));
    assert(rawDump.includes("turso-suite:auth:v1"));
    assert(rawDump.includes("turso-suite:vault:v1"));
    assert(!rawDump.includes("TURSO-SSH-SECRET-PASSWORD"));
    assert(!rawDump.includes("TURSO-SSH-PRIVATE-KEY"));
    assert(!rawDump.includes(originalPassword));

    const [envLeft, envRight] = await Promise.all([makeEnvelope(), makeEnvelope()]);
    const concurrentWrites = await Promise.all([
      postVault(request("/api/vault", "POST", { envelope: envLeft, baseRevision: rev1 }, tokenA)),
      postVault(request("/api/vault", "POST", { envelope: envRight, baseRevision: rev1 }, tokenB)),
    ]);
    assert.deepEqual(concurrentWrites.map((r) => r.status).sort(), [200, 409]);

    // 5. Password rotation with atomic vault guard
    const latestVault = await json(await getVault(request("/api/vault", "GET", undefined, tokenA)));
    const independentEnvelope = { ...latestVault.envelope, keySource: "independent" };
    const prepRes = await postVault(
      request("/api/vault", "POST", { envelope: independentEnvelope, baseRevision: latestVault.revision }, tokenA)
    );
    assert.equal(prepRes.status, 200);
    const prepRevision = (await json(prepRes)).revision as string;

    const authBytes = await readStateRecord("auth");
    assert.ok(authBytes);
    assert.equal(await compareAndSwapAuthWithVaultGuard(authBytes, "must-not-commit", "stale-vault-json"), false);
    assert.equal(await readStateRecord("auth"), authBytes);

    const pwRes = await changeAccount(
      request("/api/auth/account", "PUT", { currentPassword: originalPassword, newUsername: "operator", newPassword }, tokenA)
    );
    assert.equal(pwRes.status, 200);
    const rotatedToken = (await json(pwRes)).sessionToken as string;
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": tokenB }))).ok, false);
    assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-session": rotatedToken }))).ok, true);

    const rotatedEnvelope = await makeEnvelope(newPassword);
    assert.equal(
      (await postVault(request("/api/vault", "POST", { envelope: rotatedEnvelope, baseRevision: prepRevision }, rotatedToken))).status,
      200
    );

    await saveServerPasskey({
      id: "turso-passkey-1",
      publicKey: "abc",
      counter: 0,
      label: "Turso Passkey",
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: Date.now(),
    });
    assert.equal((await getEffectiveAuthConfig()).serverPasskeys.length, 1);

    // 6. Outages, bad credentials, partial env vars, corrupt rows, and multi-backend conflict fail closed
    tursoOffline = true;
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    assert.equal((await getVault(request("/api/vault", "GET", undefined, rotatedToken))).status, 503);
    assert.equal((await setup(request("/api/auth/setup", "POST", { username: "attacker", password: originalPassword }))).status, 503);
    tursoOffline = false;

    process.env.TURSO_AUTH_TOKEN = "wrong-token-never-echo-me";
    const badTokenRes = await getStatus(request("/api/auth/status"));
    assert.equal(badTokenRes.status, 503);
    assert(!JSON.stringify(await json(badTokenRes)).includes("wrong-token-never-echo-me"));

    delete process.env.TURSO_AUTH_TOKEN;
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);

    process.env.TURSO_DATABASE_URL = "libsql://example.turso.io?authToken=embedded-secret-do-not-leak";
    process.env.TURSO_AUTH_TOKEN = "turso-test-token";
    const embeddedRes = await getStatus(request("/api/auth/status"));
    assert.equal(embeddedRes.status, 503);
    assert(!JSON.stringify(await json(embeddedRes)).includes("embedded-secret-do-not-leak"));

    process.env.TURSO_DATABASE_URL = "http://remote.turso.io";
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);

    // Both Redis and Turso configured in auto mode fails closed unless SUSHI_STORAGE_BACKEND is explicit
    process.env.TURSO_DATABASE_URL = libsqlUrl;
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    assert.equal((await getStatus(request("/api/auth/status"))).status, 503);
    process.env.SUSHI_STORAGE_BACKEND = "turso";
    assert.equal((await getStatus(request("/api/auth/status"))).status, 200);
    delete process.env.SUSHI_STORAGE_BACKEND;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    // Corrupt vault/auth row fails closed without overwriting data
    const savedVaultRow = await readStateRecord("vault");
    db.run("UPDATE sushi_state_v1 SET record_value = '{corrupt' WHERE record_key = 'turso-suite:vault:v1'");
    assert.equal((await getVault(request("/api/vault", "GET", undefined, rotatedToken))).status, 503);
    assert.equal(
      (await postVault(request("/api/vault", "POST", { envelope: rotatedEnvelope, baseRevision: null }, rotatedToken))).status,
      503
    );
    db.run("UPDATE sushi_state_v1 SET record_value = ? WHERE record_key = 'turso-suite:vault:v1'", [savedVaultRow]);

    // 7. Existing stateless browser certificate seeds an empty Turso namespace once
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.SUSHI_ALLOW_STATELESS_SETUP = "true";
    process.env.SUSHI_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
    const legacy = await bootstrapAdminAccount("legacy-vercel-op", originalPassword);

    process.env.TURSO_DATABASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.TURSO_AUTH_TOKEN = "turso-test-token";
    process.env.SUSHI_STORAGE_PREFIX = "turso-migrated";
    const migrated = await getStatus(
      request("/api/auth/status", "GET", undefined, undefined, { "x-sushi-admin-cert": legacy.adminProfileCert })
    );
    assert.equal(migrated.status, 200);
    assert.equal((await json(await getStatus(request("/api/auth/status")))).initialized, true);
    assert.equal((await getEffectiveAuthConfig()).username, "legacy-vercel-op");
    assert.equal(await (await getEffectiveAuthConfig()).verifyPassword(originalPassword), true);

    assert.ok(pipelineCalls > 5);
    console.log("TURSO SYNC TESTS PASSED (real SQLite via Hrana v2 /v2/pipeline)");
  } finally {
    db.close();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
