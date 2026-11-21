import assert from "node:assert/strict";
import http from "node:http";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";
import { GET as getStatus, POST as postStatus } from "../src/app/api/auth/status/route";
import { POST as setup } from "../src/app/api/auth/setup/route";
import type { AuthStatusResponse } from "../src/types/auth";

const envKeys = [
  "DATA_DIR", "VERCEL", "VERCEL_ENV", "VERCEL_PROJECT_ID", "GATEWAY_ONLY",
  "SUSHI_AUTH_USERNAME", "SUSHI_AUTH_PASSWORD", "SUSHI_AUTH_PASSWORD_HASH", "SUSHI_AUTH_SECRET", "SUSHI_PASSKEYS_JSON",
  "SUSHI_GATEWAY_TOKEN", "SUSHI_ALLOW_STATELESS_SETUP", "SUSHI_STORAGE_BACKEND", "SUSHI_STORAGE_PREFIX",
  "SUSHI_REDIS_REST_URL", "SUSHI_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "SUSHI_TURSO_DATABASE_URL", "SUSHI_TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_DATABASE_ID",
  "SUSHI_FIRESTORE_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "FIRESTORE_EMULATOR_HOST",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function clearEnv() {
  for (const key of envKeys) delete process.env[key];
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "production";
}

function request(method = "GET", body?: unknown) {
  return new NextRequest("https://sushi.test/api/auth/status", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseBody(response: Response) {
  return await response.json() as Record<string, any>;
}

async function testServerDiagnostics() {
  console.log("==> Storage setup: safe diagnostics and fail-closed account status");
  clearEnv();
  const initial = await getStatus(request());
  assert.equal(initial.status, 200);
  assert.match(initial.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(
    (({ initialized, canBootstrapInteractive, mode, storage }) => ({ initialized, canBootstrapInteractive, mode, storage }))(await responseBody(initial)),
    { initialized: false, canBootstrapInteractive: false, mode: "vercel", storage: "none" }
  );
  const blocked = await setup(request("POST", { username: "unwanted", password: "strong-password" }));
  assert.equal(blocked.status, 503, "no storage must still block interactive account creation");

  // Missing pairs identify the exact supported names, not the URL/token values.
  process.env.TURSO_DATABASE_URL = "libsql://secret-database-name.turso.io";
  let result = await getStatus(request());
  let body = await responseBody(result);
  assert.equal(result.status, 503);
  assert.deepEqual(body.storageProblem, { mode: "vercel", reason: "configuration", backend: "turso" });
  assert.match(body.error, /TURSO_DATABASE_URL/);
  assert.match(body.error, /TURSO_AUTH_TOKEN/);
  assert(!JSON.stringify(body).includes("secret-database-name"));
  assert.match(result.headers.get("cache-control") || "", /no-store/);
  result = await postStatus(request("POST", {}));
  assert.deepEqual((await responseBody(result)).storageProblem, { mode: "vercel", reason: "configuration", backend: "turso" });

  process.env.TURSO_DATABASE_URL = "libsql://user:embedded-secret@secret-database.turso.io";
  process.env.TURSO_AUTH_TOKEN = "private-turso-token";
  body = await responseBody(await getStatus(request()));
  assert.equal(body.storageProblem.reason, "configuration");
  for (const secret of ["embedded-secret", "secret-database.turso.io", "private-turso-token"]) {
    assert(!JSON.stringify(body).includes(secret), `status must not expose ${secret}`);
  }

  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.UPSTASH_REDIS_REST_TOKEN = "private-redis-token";
  body = await responseBody(await getStatus(request()));
  assert.deepEqual(body.storageProblem, { mode: "vercel", reason: "configuration", backend: "redis" });
  assert.match(body.error, /UPSTASH_REDIS_REST_URL/);
  assert.match(body.error, /UPSTASH_REDIS_REST_TOKEN/);
  assert(!JSON.stringify(body).includes("private-redis-token"));

  // Two configured providers fail closed rather than silently selecting a new store.
  process.env.UPSTASH_REDIS_REST_URL = "https://private-redis.example";
  process.env.TURSO_DATABASE_URL = "libsql://private-turso.example";
  process.env.TURSO_AUTH_TOKEN = "private-turso-token";
  body = await responseBody(await getStatus(request()));
  assert.deepEqual(body.storageProblem, { mode: "vercel", reason: "configuration", backend: null });
  assert.match(body.error, /Multiple shared storage backends/);
  for (const secret of ["private-redis.example", "private-redis-token", "private-turso.example", "private-turso-token"]) {
    assert(!JSON.stringify(body).includes(secret));
  }

  clearEnv();
  process.env.SUSHI_STORAGE_BACKEND = "firestore";
  process.env.SUSHI_FIRESTORE_PROJECT_ID = "sushi-test-project";
  process.env.SUSHI_FIRESTORE_CREDENTIALS_JSON = "private-firestore-credential-json";
  body = await responseBody(await getStatus(request()));
  assert.deepEqual(body.storageProblem, { mode: "vercel", reason: "configuration", backend: "firestore" });
  assert(!JSON.stringify(body).includes("private-firestore-credential-json"));

  clearEnv();
  let mode: "offline" | "corrupt" | "healthy" = "offline";
  const commands: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as string[];
    commands.push(command[0]);
    if (mode === "offline") {
      res.writeHead(503).end("private provider response");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: mode === "corrupt" ? "{invalid-account-data" : null }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock Redis did not start");
    process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${address.port}`;
    process.env.UPSTASH_REDIS_REST_TOKEN = "private-live-token";

    result = await getStatus(request());
    body = await responseBody(result);
    assert.equal(result.status, 503);
    assert.deepEqual(body.storageProblem, { mode: "vercel", reason: "unavailable", backend: "redis" });
    assert(!JSON.stringify(body).includes("private provider response"));
    assert(!JSON.stringify(body).includes("private-live-token"));
    assert.equal((await setup(request("POST", { username: "unwanted", password: "strong-password" }))).status, 503);

    mode = "corrupt";
    result = await postStatus(request("POST", {}));
    body = await responseBody(result);
    assert.equal(result.status, 503);
    assert.match(body.error, /account data is corrupt/i);
    assert(!JSON.stringify(body).includes("invalid-account-data"));
    assert.equal((await setup(request("POST", { username: "unwanted", password: "strong-password" }))).status, 503);
    assert(commands.every((command) => command === "GET"), "failed checks/setup must not write over stored data");

    mode = "healthy";
    result = await postStatus(request("POST", {}));
    body = await responseBody(result);
    assert.equal(result.status, 200);
    assert.equal(body.storage, "redis");
    assert.equal(body.initialized, false);
    assert.equal(body.canBootstrapInteractive, true, "a successful real store read enables setup");
    assert(!("storageProblem" in body));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function jsonReply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const noStore: AuthStatusResponse = {
  ok: true, authenticated: false, initialized: false, canBootstrapOnDisk: false,
  canBootstrapInteractive: false, envConfigured: false, mode: "vercel", storage: "none", passkeyCount: 0,
};

async function testGuideAndWorkspace() {
  console.log("==> Storage setup: provider selection, real retry states, recovery and navigation");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://sushi.example.test/" });
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldFetch = globalThis.fetch;
  const oldGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
  })) {
    oldGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const clipboard: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { clipboard.push(text); } } });

  const replies: Array<() => Promise<Response>> = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), "/api/auth/status", "setup guide should not provision or mutate a database");
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected status request");
    return await reply();
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const { SushiWorkspace } = await import("../src/components/SushiWorkspace");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  const text = () => container.textContent || "";
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
    assert(found, `button not found: ${label}`);
    return found as HTMLButtonElement;
  };
  const click = async (label: string) => { await act(async () => { button(label).click(); await flush(); }); };
  dom.window.localStorage.setItem("sushi_encrypted_vault_v1", "do-not-touch-existing-vault");

  try {
    replies.push(async () => jsonReply(noStore));
    await act(async () => { root.render(<SushiWorkspace />); await flush(); });
    assert.match(text(), /Connect shared storage/);
    assert.match(text(), /No shared storage detected/);
    assert.match(text(), /Redeploy, then check/);
    assert.match(text(), /new database will not contain your account or vault/);
    assert.equal(container.querySelector('a[href="https://vercel.com/marketplace/tursocloud/database"]')?.getAttribute("target"), "_blank");
    assert.equal(container.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Turso"), true);

    await click("Redis REST");
    assert.match(text(), /KV_REST_API_URL/);
    assert.match(text(), /UPSTASH_REDIS_REST_TOKEN/);
    assert(container.querySelector('a[href="https://vercel.com/marketplace/upstash/upstash-kv"]'));
    await click("Copy settings");
    assert.deepEqual(clipboard, ["KV_REST_API_URL\nKV_REST_API_TOKEN"]);
    assert.match(text(), /Copied/);

    const pending = deferred<Response>();
    replies.push(() => pending.promise);
    await click("Check connection");
    assert.equal(button("Checking connection").disabled, true, "the button stays busy until the actual request settles");
    const callsWhilePending = calls.length;
    button("Checking connection").click();
    assert.equal(calls.length, callsWhilePending, "a pending check cannot be double-submitted");
    await act(async () => { pending.resolve(jsonReply(noStore)); await flush(); });
    assert.equal(button("Check connection").disabled, false);
    assert.match(text(), /Still no shared storage detected/);
    assert.equal(container.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Redis REST"), true);

    replies.push(async () => jsonReply({ ok: false, error: "Firestore project ID is missing.", storageProblem: { mode: "vercel", reason: "configuration", backend: "firestore" } }, 503));
    await click("Check connection");
    assert.match(text(), /Storage settings need attention/);
    assert.match(text(), /Firestore project ID is missing/);
    assert.match(text(), /SUSHI_STORAGE_BACKEND=firestore/);
    assert.equal(container.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Firestore"), true);
    assert.match(text(), /do not replace the database or its namespace/i);
    Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await click("Copy settings");
    assert.match(text(), /Could not copy/);
    assert.doesNotMatch(text(), /Copied/);

    replies.push(async () => { throw new Error("offline"); });
    await click("Check connection");
    assert.match(text(), /Could not reach Sushi/);
    assert.match(text(), /Connect shared storage/, "network failure should keep the guide open");
    assert.equal(container.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Firestore"), true);

    replies.push(async () => jsonReply({ ok: false, error: "Turso storage is unavailable or rejected its credentials.", storageProblem: { mode: "vercel", reason: "unavailable", backend: "turso" } }, 503));
    await click("Check connection");
    assert.match(text(), /Account storage could not be checked/);
    assert.match(text(), /connection has not been verified/i);
    assert.equal(container.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Turso"), true);
    assert.doesNotMatch(text(), /Connected\s*$/);

    // A reachable existing account goes to sign-in, not the create-account form.
    replies.push(async () => jsonReply({ ...noStore, storage: "turso", initialized: true, canBootstrapInteractive: true }));
    await click("Check connection");
    assert.doesNotMatch(text(), /Connect shared storage/);
    assert.match(text(), /Sign In|Sign in/i);
    assert.doesNotMatch(text(), /Create Sushi Admin Account/);
    assert.equal(dom.window.localStorage.getItem("sushi_encrypted_vault_v1"), "do-not-touch-existing-vault");

    // A Vercel configuration error on the very first response still opens the guide.
    replies.push(async () => jsonReply({ ok: false, error: "Set both Redis variables.", storageProblem: { mode: "vercel", reason: "configuration", backend: "redis" } }, 503));
    await act(async () => { root.render(<SushiWorkspace key="first-error" />); await flush(); });
    assert.match(text(), /Storage settings need attention/);
    assert.match(text(), /Set both Redis variables/);
    assert.equal(container.querySelector('button[aria-pressed="true"]')?.textContent?.includes("Redis REST"), true);
    assert.equal(container.querySelector('input[type="password"]'), null, "the guide must never request provider secrets");

    // A successfully read empty store opens setup with an explicit recovery warning.
    replies.push(async () => jsonReply({ ...noStore, storage: "redis", canBootstrapInteractive: true }));
    await click("Check connection");
    assert.match(text(), /Create Sushi Admin Account/);
    assert.match(text(), /If you expected an existing account, stop and reconnect/);
    assert.equal(dom.window.localStorage.getItem("sushi_encrypted_vault_v1"), "do-not-touch-existing-vault");

    // A self-hosted error should not show Vercel-specific instructions.
    replies.push(async () => jsonReply({ ok: false, error: "Persistent account data is corrupt.", storageProblem: { mode: "vps", reason: "unavailable", backend: "disk" } }, 503));
    await act(async () => { root.render(<SushiWorkspace key="vps-error" />); await flush(); });
    assert.match(text(), /Account status unavailable/);
    assert.doesNotMatch(text(), /Connect shared storage/);
    assert(calls.every((call) => call.init?.method === "POST" && call.init.cache === "no-store"));
    assert.equal(replies.length, 0);
  } finally {
    await act(async () => { root.unmount(); await flush(); });
    globalThis.fetch = oldFetch;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
    for (const [key, descriptor] of oldGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
}

async function main() {
  try {
    await testServerDiagnostics();
    await testGuideAndWorkspace();
    console.log("STORAGE SETUP TESTS PASSED");
  } finally {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
