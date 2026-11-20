import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertPrivateEnvFile,
  callVercelApi,
  createPrivateEnvFile,
  importAuthEnv,
  main,
  newAuthEnvText,
  parseAuthEnv,
  readAuthRecords,
  resolveProject,
  startProductionDeployment,
  verifyProjectRepository,
  verifyPublicStatus,
  waitForProduction,
} from "../scripts/deploy-vercel.mjs";

const projectId = "prj_test123";
const orgId = "team_test123";
const U = "SUSHI_AUTH_USERNAME";
const P = "SUSHI_AUTH_PASSWORD";
const H = "SUSHI_AUTH_PASSWORD_HASH";
const S = "SUSHI_AUTH_SECRET";
const PASSWORD = "test-only-password-never-a-real-secret";
const SECRET = "test-only-stable-signing-secret-0123456789";
const values = { [U]: "operator", [P]: PASSWORD, [S]: SECRET };
const envText = `# Private test fixture\n${U}=operator\n${P}=${PASSWORD}\n${S}=${SECRET}\nOTHER_SECRET=do-not-upload\n`;

function fixture(record = {}) {
  return { target: ["production"], type: "encrypted", updatedAt: 1, ...record };
}

function fakeVercel({ projectVars = [], sharedVars = [], failCreate = false, failCreateAt = 0, afterCreate, projectOverride } = {}) {
  let vars = projectVars.map((x) => ({ ...x }));
  let createCount = 0;
  const calls = [];
  const project = {
    id: projectId,
    accountId: orgId,
    name: "sushi-test",
    link: { type: "github", org: "test-owner", repo: "sushi-test", repoId: 123456, productionBranch: "main" },
    ...projectOverride,
  };
  const api = async (endpoint, request = {}) => {
    const url = new URL(endpoint, "https://api.vercel.test");
    calls.push({ endpoint, request });
    assert.equal(url.searchParams.get("teamId"), orgId);
    if (url.pathname === `/v9/projects/${projectId}`) return project;
    if (url.pathname === "/v1/env") return { data: sharedVars, pagination: { next: null } };
    if (url.pathname === `/v10/projects/${projectId}/env` && request.method === "POST") {
      createCount += 1;
      if (failCreate || createCount === failCreateAt) return { created: [], failed: [{ error: { value: "never-print-this" } }] };
      assert.equal(url.searchParams.has("upsert"), false, "no API operation may overwrite existing values");
      assert.ok(request.body && !Array.isArray(request.body), "Vercel CLI must receive a single JSON object");
      const created = { ...request.body, id: `env_created${createCount}`, updatedAt: 10 + createCount };
      vars.push(created);
      if (afterCreate) vars = afterCreate(vars, created);
      return { created, failed: [] };
    }
    if (url.pathname === `/v10/projects/${projectId}/env`) return { envs: vars, pagination: { next: null } };
    if (url.pathname.startsWith(`/v1/projects/${projectId}/env/`)) {
      const id = url.pathname.split("/").at(-1);
      const found = vars.find((entry) => entry.id === id);
      return found ? { ...found, decrypted: true } : {};
    }
    if (url.pathname.startsWith("/v1/env/")) {
      const id = url.pathname.split("/").at(-1);
      return sharedVars.find((entry) => entry.id === id) ?? {};
    }
    if (url.pathname === "/v13/deployments" && request.method === "POST") {
      return { id: "dpl_test123" };
    }
    if (url.pathname === "/v13/deployments/dpl_test123") {
      return { id: "dpl_test123", readyState: "READY", readySubstate: "PROMOTED", aliasAssigned: 123, url: "sushi-test.vercel.app" };
    }
    throw new Error(`unexpected fake request ${url.pathname}`);
  };
  return { api, calls, getVars: () => vars, project };
}

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sushi-vercel-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  assert.equal(spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/test-owner/sushi-test.git"]).status, 0);
  await fs.writeFile(path.join(dir, ".gitignore"), ".env*\n!.env.example\n");
  return dir;
}

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try { await fn(); } finally { console.log = original; }
  return lines.join("\n");
}

test("parses quoted .env values literally and imports only supported auth keys", () => {
  const parsed = parseAuthEnv(`export ${U}=" operator "\n${P}='p#ss=$HOME with spaces'\n${S}="old:stable=secret"\nOTHER_TOKEN=private\n`);
  assert.deepEqual(parsed, { [U]: "operator", [P]: "p#ss=$HOME with spaces", [S]: "old:stable=secret" });
  const digest = "ab".repeat(32);
  const scrypt = `${"cd".repeat(16)}:${"ef".repeat(64)}`;
  assert.deepEqual(parseAuthEnv(`${U}=operator\n${H}=${digest}\n`), { [U]: "operator", [H]: digest });
  assert.deepEqual(parseAuthEnv(`${U}=operator\n${H}=${scrypt}\n`), { [U]: "operator", [H]: scrypt });
  assert.throws(() => parseAuthEnv(`${U}=operator\n${H}=not-a-valid-hash\n`), /SHA-256/);
  assert.throws(() => parseAuthEnv(`${U}=operator\n${H}=bad:${"ab".repeat(64)}\n`), /scrypt/);
  assert.throws(() => parseAuthEnv(`${U}=operator\n${P}=one\n${P}=two\n`), /more than once/);
  assert.throws(() => parseAuthEnv(`${U}=operator\n${P}=a\n${H}=b\n`), /either/);
  assert.throws(() => parseAuthEnv(`${U}=operator\n${P}=\n`), /must contain/);
  assert.throws(() => parseAuthEnv(`${U}=operator\n${P}="a\0b"\n`), /NUL/);
  assert.throws(() => parseAuthEnv("x".repeat(256 * 1024 + 1)), /too large/);
});

test("fresh credentials are random, kept in an exclusive owner-only file, and never overwritten", async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, ".env.sushi.local");
  const first = parseAuthEnv(newAuthEnvText());
  const second = parseAuthEnv(newAuthEnvText());
  assert.notEqual(first[P], second[P]);
  assert.notEqual(first[S], second[S]);
  assert.ok(first[P].length >= 32 && first[S].length >= 32);
  const content = await createPrivateEnvFile(file);
  assert.equal(await fs.readFile(file, "utf8"), content);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(createPrivateEnvFile(file), /already exists/);
  assert.equal(await fs.readFile(file, "utf8"), content);
  const symlink = path.join(dir, ".env.symlink");
  await fs.symlink(file, symlink);
  await assert.rejects(createPrivateEnvFile(symlink), /already exists/);
  assert.equal(await fs.readFile(file, "utf8"), content);
});

test("link resolution requires an explicit, valid project and org", async (t) => {
  const dir = await temporary(t);
  await assert.rejects(resolveProject(dir, { VERCEL_PROJECT_ID: projectId }), /both/);
  await assert.rejects(resolveProject(dir, {}), /not linked/);
  assert.deepEqual(await resolveProject(dir, { VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId }), { projectId, orgId });
  await fs.mkdir(path.join(dir, ".vercel"));
  await fs.writeFile(path.join(dir, ".vercel", "project.json"), JSON.stringify({ projectId, orgId }));
  assert.deepEqual(await resolveProject(dir, {}), { projectId, orgId });
  await assert.rejects(resolveProject(dir, { VERCEL_PROJECT_ID: "../other", VERCEL_ORG_ID: orgId }), /invalid/);
});

test("project repository must match this checkout before any credentials are imported", async (t) => {
  const dir = await temporary(t);
  const fake = fakeVercel();
  assert.doesNotThrow(() => verifyProjectRepository(fake.project, dir));
  assert.equal(spawnSync("git", ["-C", dir, "remote", "set-url", "origin", "git@github.com:test-owner/sushi-test.git"]).status, 0);
  assert.doesNotThrow(() => verifyProjectRepository(fake.project, dir));
  assert.equal(spawnSync("git", ["-C", dir, "remote", "set-url", "origin", "https://github.com/other/unrelated.git"]).status, 0);
  assert.throws(() => verifyProjectRepository(fake.project, dir), /does not match/);
  const options = { cwd: dir, environment: { VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId }, api: fake.api };
  await assert.rejects(main(["--new", "--import-only"], options), /does not match/);
  assert.equal(fake.calls.some((call) => call.request.method === "POST"), false);
  await assert.rejects(fs.access(path.join(dir, ".env.sushi.local")), /ENOENT/);
});

test("credentials in a checkout must be untracked and ignored, including symlink targets", async (t) => {
  const dir = await temporary(t);
  const ignored = path.join(dir, ".env");
  await fs.writeFile(ignored, envText);
  await assertPrivateEnvFile(ignored, dir);
  assert.equal(spawnSync("git", ["-C", dir, "add", "-f", ".env"]).status, 0);
  await assert.rejects(assertPrivateEnvFile(ignored, dir), /tracked by Git/);
  const unignored = path.join(dir, "secrets.txt");
  await fs.writeFile(unignored, envText);
  await assert.rejects(assertPrivateEnvFile(unignored, dir), /not ignored/);
  const link = path.join(dir, ".env.link");
  await fs.symlink(unignored, link);
  await assert.rejects(assertPrivateEnvFile(link, dir), /not ignored/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sushi-private-env-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const external = path.join(outside, "settings.txt");
  await fs.writeFile(external, envText);
  await assertPrivateEnvFile(external, dir);
});

test("fresh import stores production-only secrets without leaking unrelated values or using upsert", async () => {
  const fake = fakeVercel();
  const result = await importAuthEnv(fake.api, projectId, orgId, values);
  assert.deepEqual(result.imported, [U, S, P]);
  const posts = fake.calls.filter((call) => call.request.method === "POST");
  assert.equal(posts.some((post) => post.endpoint.includes("upsert")), false);
  assert.deepEqual(posts.map((post) => post.request.body), [
    { key: U, value: "operator", type: "encrypted", visibility: "config", target: ["production"] },
    { key: S, value: SECRET, type: "sensitive", visibility: "secret", target: ["production"] },
    { key: P, value: PASSWORD, type: "sensitive", visibility: "secret", target: ["production"] },
  ]);
  assert.equal(JSON.stringify(posts).includes("OTHER_SECRET"), false);
});

test("a matching username-only project is completed without replacing its username", async () => {
  const original = fixture({ key: U, value: "operator", id: "env_existing" });
  const fake = fakeVercel({ projectVars: [original] });
  const result = await importAuthEnv(fake.api, projectId, orgId, values);
  assert.deepEqual(result.imported, [S, P]);
  assert.deepEqual(fake.getVars().find((v) => v.key === U), original);
  assert.deepEqual(fake.calls.filter((call) => call.request.method === "POST").map((call) => call.request.body.key), [S, P]);
});

test("a mismatched, unreadable, or changing username prevents deployment and never overwrites it", async () => {
  const wrong = fakeVercel({ projectVars: [fixture({ key: U, value: "other", id: "env_existing" })] });
  await assert.rejects(importAuthEnv(wrong.api, projectId, orgId, values), /does not match/);
  assert.equal(wrong.calls.some((call) => call.request.method === "POST"), false);

  const hidden = fakeVercel({ projectVars: [fixture({ key: U, id: "env_existing", type: "sensitive" })] });
  await assert.rejects(importAuthEnv(hidden.api, projectId, orgId, values), /cannot be verified/);
  assert.equal(hidden.calls.some((call) => call.request.method === "POST"), false);

  const changed = fakeVercel({
    projectVars: [fixture({ key: U, value: "operator", id: "env_existing" })],
    afterCreate: (vars) => vars.map((v) => v.key === U ? { ...v, updatedAt: 2 } : v),
  });
  await assert.rejects(importAuthEnv(changed.api, projectId, orgId, values), /username changed/);
});

test("existing credentials are never changed or given a new vault signing secret", async () => {
  const existing = [fixture({ key: U, id: "u", value: "operator" }), fixture({ key: P, id: "p", type: "sensitive" })];
  const fake = fakeVercel({ projectVars: existing });
  const derivedValues = { [U]: "operator", [P]: PASSWORD };
  const result = await importAuthEnv(fake.api, projectId, orgId, derivedValues);
  assert.equal(result.existing, true);
  assert.equal(result.hasExplicitSecret, false);
  assert.deepEqual(result.imported, []);
  assert.equal(fake.calls.some((call) => call.request.method === "POST"), false);
  assert.deepEqual(fake.getVars(), existing);
  // A stale backup must not misleadingly claim an explicit key is in use.
  await assert.rejects(importAuthEnv(fake.api, projectId, orgId, values), /does not describe/);

  const hash = fakeVercel({ projectVars: [existing[0], fixture({ key: H, id: "hash", type: "sensitive" })] });
  assert.equal((await importAuthEnv(hash.api, projectId, orgId, { [U]: "operator", [H]: "ab".repeat(32) })).existing, true);
  await assert.rejects(importAuthEnv(hash.api, projectId, orgId, derivedValues), /does not describe/);
  assert.equal(hash.calls.some((call) => call.request.method === "POST"), false);

  const both = fakeVercel({ projectVars: [...existing, fixture({ key: H, id: "hash", type: "sensitive" })] });
  await assert.rejects(importAuthEnv(both.api, projectId, orgId, derivedValues), /both a password and a password hash/);
  assert.equal(both.calls.some((call) => call.request.method === "POST"), false);
});

test("partial secrets and duplicate or incomplete listings fail closed", async () => {
  for (const key of [P, H, S]) {
    const fake = fakeVercel({ projectVars: [fixture({ key, id: "existing", type: "sensitive" })] });
    await assert.rejects(importAuthEnv(fake.api, projectId, orgId, values), /partial admin credentials/);
    assert.equal(fake.calls.some((call) => call.request.method === "POST"), false);
  }
  const duplicate = fakeVercel({
    projectVars: [fixture({ key: U, id: "project-user" })],
    sharedVars: [fixture({ key: U, id: "shared-user", projectId: [projectId] })],
  });
  await assert.rejects(readAuthRecords(duplicate.api, projectId, orgId), /Multiple production definitions/);
  await assert.rejects(readAuthRecords(async (endpoint) => endpoint.includes("/v10/")
    ? { envs: [], pagination: { next: 42 } } : { data: [] }, projectId, orgId), /truncated/);
  await assert.rejects(readAuthRecords(async () => ({}), projectId, orgId), /Could not read/);
  await assert.rejects(readAuthRecords(async (endpoint) => endpoint.includes("/v10/")
    ? { envs: [], hiddenProductionEnvCount: 1 } : { data: [] }, projectId, orgId), /hidden by Vercel permissions/);
});

test("preview and unrelated shared settings do not get mistaken for production", async () => {
  const fake = fakeVercel({
    projectVars: [fixture({ key: S, id: "preview", target: ["preview"] })],
    sharedVars: [fixture({ key: P, id: "other-project", projectId: ["prj_other"] })],
  });
  assert.equal((await readAuthRecords(fake.api, projectId, orgId)).size, 0);
  const imported = await importAuthEnv(fake.api, projectId, orgId, values);
  assert.deepEqual(imported.imported, [U, S, P]);
});

test("concurrent changes and partial API writes stop before deployment", async () => {
  const concurrent = fakeVercel({ afterCreate: (vars, created) => created.key === P
    ? [...vars, fixture({ key: H, id: "new-hash" })] : vars });
  await assert.rejects(importAuthEnv(concurrent.api, projectId, orgId, values), /changed during import/);
  assert.equal(concurrent.calls.some((call) => call.endpoint.includes("/v13/deployments")), false);

  const failed = fakeVercel({ failCreate: true });
  await assert.rejects(importAuthEnv(failed.api, projectId, orgId, values), (error) => {
    assert.match(error.message, /did not confirm every variable/);
    assert.equal(error.message.includes("never-print-this"), false);
    return true;
  });

  // Failure after saving the key must never save a password or start a deploy.
  const partial = fakeVercel({ failCreateAt: 3 });
  await assert.rejects(importAuthEnv(partial.api, projectId, orgId, values), /Some may have been saved/);
  assert.deepEqual(partial.getVars().map((record) => record.key), [U, S]);
  assert.equal(partial.calls.some((call) => call.endpoint.includes("/v13/deployments")), false);
  await assert.rejects(importAuthEnv(partial.api, projectId, orgId, values), /partial admin credentials/);
});

test("deployment is Git-based, uses the production branch, and never contains file values", async () => {
  const fake = fakeVercel();
  assert.equal(await startProductionDeployment(fake.api, fake.project, projectId, orgId), "dpl_test123");
  const request = fake.calls.find((call) => call.request.method === "POST").request;
  assert.deepEqual(request.body.gitSource, { type: "github", repoId: "123456", ref: "main" });
  assert.equal(request.body.target, "production");
  assert.equal(JSON.stringify(request.body).includes(PASSWORD), false);
  assert.equal(JSON.stringify(request.body).includes(SECRET), false);
  await assert.rejects(startProductionDeployment(fake.api, { ...fake.project, link: null }, projectId, orgId), /GitHub-linked/);
  assert.equal((await waitForProduction(fake.api, "dpl_test123", orgId)).readyState, "READY");
  await assert.rejects(waitForProduction(async () => ({ readyState: "ERROR" }), "dpl_test123", orgId), /ERROR/);
  await assert.rejects(waitForProduction(async () => ({ readyState: "READY", aliasError: {} }), "dpl_test123", orgId), /production domain/);
  let clock = 0;
  await assert.rejects(waitForProduction(async () => ({ readyState: "BUILDING" }), "dpl_test123", orgId, {
    timeoutMs: 3, intervalMs: 1, now: () => clock, sleep: async () => { clock += 1; },
  }), /did not become ready/);
});

test("public verification uses only a Vercel HTTPS hostname and never follows redirects", async () => {
  const requests = [];
  const fetcher = async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith("/status")) return new Response(JSON.stringify({ ok: true, initialized: true, envConfigured: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, sessionToken: "test-session-not-logged" }), { status: 200 });
  };
  assert.equal(await verifyPublicStatus({ url: "sushi-test.vercel.app" }, values, fetcher), "verified");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].opts.redirect, "manual");
  assert.deepEqual(JSON.parse(requests[1].opts.body), { username: "operator", password: PASSWORD });
  assert.equal(await verifyPublicStatus({ url: "evil.example" }, values, fetcher), "unavailable");
  assert.equal(requests.length, 2);
  assert.equal(await verifyPublicStatus({ url: "sushi-test.vercel.app" }, values, async () => new Response("", { status: 403 })), "unavailable");
  assert.equal(await verifyPublicStatus({ url: "sushi-test.vercel.app" }, values, async (url) => url.endsWith("/status")
    ? new Response(JSON.stringify({ ok: true, initialized: false }), { status: 200 })
    : new Response("", { status: 500 })), "unconfigured");
  assert.equal(await verifyPublicStatus({ url: "sushi-test.vercel.app" }, values, async (url) => url.endsWith("/status")
    ? new Response(JSON.stringify({ ok: true, initialized: true, envConfigured: true }), { status: 200 })
    : new Response(JSON.stringify({ error: "Invalid username or password." }), { status: 401 })), "mismatch");
});

test("CLI sends API bodies on stdin rather than argv and suppresses error responses", async (t) => {
  const dir = await temporary(t);
  const fakeBin = path.join(dir, "npx");
  const capture = path.join(dir, "capture.json");
  await fs.writeFile(fakeBin, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst body = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(process.env.SUSHI_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), body }));\nif (process.env.SUSHI_TEST_FAIL) { console.error('sensitive-error-' + body); process.exit(1); }\nconsole.log(JSON.stringify({ok:true}));\n`, { mode: 0o700 });
  const savedPath = process.env.PATH;
  const savedCapture = process.env.SUSHI_TEST_CAPTURE;
  const savedFail = process.env.SUSHI_TEST_FAIL;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  process.env.SUSHI_TEST_CAPTURE = capture;
  try {
    assert.deepEqual(callVercelApi("/v10/projects/test/env", { cwd: dir, orgId, method: "POST", body: values }), { ok: true });
    const captured = JSON.parse(await fs.readFile(capture, "utf8"));
    assert.equal(captured.args.includes("--input"), true);
    assert.equal(captured.args.includes("-"), true);
    assert.equal(captured.args[captured.args.indexOf("--api") + 1], "https://api.vercel.com");
    assert.equal(JSON.stringify(captured.args).includes(PASSWORD), false);
    assert.equal(JSON.stringify(captured.args).includes(SECRET), false);
    assert.deepEqual(JSON.parse(captured.body), values);
    process.env.SUSHI_TEST_FAIL = "1";
    assert.throws(() => callVercelApi("/v10/projects/test/env", { cwd: dir, orgId, method: "POST", body: values }), (error) => {
      assert.equal(error.message.includes(PASSWORD), false);
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.message.includes("sensitive-error"), false);
      return true;
    });
  } finally {
    process.env.PATH = savedPath;
    if (savedCapture === undefined) delete process.env.SUSHI_TEST_CAPTURE; else process.env.SUSHI_TEST_CAPTURE = savedCapture;
    if (savedFail === undefined) delete process.env.SUSHI_TEST_FAIL; else process.env.SUSHI_TEST_FAIL = savedFail;
  }
});

test("end-to-end import deploys after successful validation without logging credentials", async (t) => {
  const dir = await temporary(t);
  await fs.writeFile(path.join(dir, ".env"), envText, { mode: 0o600 });
  const fake = fakeVercel();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => url.endsWith("/status")
    ? new Response(JSON.stringify({ ok: true, initialized: true, envConfigured: true }), { status: 200 })
    : new Response(JSON.stringify({ ok: true }), { status: 200 });
  try {
    const output = await captureLogs(() => main([], { cwd: dir, environment: { VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId }, api: fake.api }));
    assert.match(output, /sign-in and the .env credentials were verified/);
    assert.equal(output.includes(PASSWORD), false);
    assert.equal(output.includes(SECRET), false);
    assert.equal(fake.calls.filter((call) => call.endpoint.includes("/v13/deployments?")).length, 1);
    assert.equal(JSON.stringify(fake.calls.find((call) => call.endpoint.includes("/v13/deployments?")).request.body).includes(PASSWORD), false);
  } finally { globalThis.fetch = savedFetch; }
});

test("fresh-install command creates one private file and reuses the saved Vercel settings without rotation", async (t) => {
  const dir = await temporary(t);
  const fake = fakeVercel();
  const options = { cwd: dir, environment: { VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId }, api: fake.api };
  const output = await captureLogs(() => main(["--new", "--import-only"], options));
  const file = path.join(dir, ".env.sushi.local");
  const parsed = parseAuthEnv(await fs.readFile(file, "utf8"));
  assert.ok(parsed[P].length >= 32 && parsed[S].length >= 32);
  assert.equal(output.includes(parsed[P]), false);
  assert.equal(output.includes(parsed[S]), false);
  assert.equal(fake.getVars().find((entry) => entry.key === P).value, parsed[P]);
  assert.equal(fake.getVars().find((entry) => entry.key === S).value, parsed[S]);
  const prior = fake.getVars().map((entry) => ({ ...entry }));
  await assert.rejects(main(["--new", "--import-only"], options), /already has production admin settings/);
  const again = await captureLogs(() => main(["--env-file", ".env.sushi.local", "--import-only"], options));
  assert.match(again, /No credentials were imported or changed/);
  assert.deepEqual(fake.getVars(), prior);
  assert.equal(parseAuthEnv(await fs.readFile(file, "utf8"))[S], parsed[S]);
});

test("fresh setup can complete a verified admin username-only project", async (t) => {
  const dir = await temporary(t);
  const fake = fakeVercel({ projectVars: [fixture({ key: U, id: "prior-user", value: "admin" })] });
  const options = { cwd: dir, environment: { VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId }, api: fake.api };
  await captureLogs(() => main(["--new", "--import-only"], options));
  const parsed = parseAuthEnv(await fs.readFile(path.join(dir, ".env.sushi.local"), "utf8"));
  assert.equal(parsed[U], "admin");
  assert.equal(fake.getVars().find((entry) => entry.key === U).id, "prior-user");
  assert.equal(fake.getVars().find((entry) => entry.key === P).value, parsed[P]);
  assert.equal(fake.getVars().find((entry) => entry.key === S).value, parsed[S]);

  const wrongDir = await temporary(t);
  const wrong = fakeVercel({ projectVars: [fixture({ key: U, id: "prior-user", value: "other" })] });
  await assert.rejects(main(["--new", "--import-only"], { ...options, cwd: wrongDir, api: wrong.api }), /does not match/);
  await assert.rejects(fs.access(path.join(wrongDir, ".env.sushi.local")), /ENOENT/);
});

test("new credentials are not generated when an account exists, a project is missing, or a deployment cannot be sourced", async (t) => {
  const dir = await temporary(t);
  const options = { cwd: dir, environment: { VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId } };
  const existing = fakeVercel({ projectVars: [
    fixture({ key: U, id: "existing", value: "operator" }),
    fixture({ key: P, id: "existing-password", type: "sensitive" }),
  ] });
  await assert.rejects(main(["--new"], { ...options, api: existing.api }), /already has production admin settings/);
  await assert.rejects(fs.access(path.join(dir, ".env.sushi.local")), /ENOENT/);
  const noGit = fakeVercel({ projectOverride: { link: null } });
  await assert.rejects(main(["--new"], { ...options, api: noGit.api }), /GitHub-linked/);
  await assert.rejects(fs.access(path.join(dir, ".env.sushi.local")), /ENOENT/);
  const wrongAccount = fakeVercel({ projectOverride: { accountId: "team_other" } });
  await assert.rejects(main(["--new"], { ...options, api: wrongAccount.api }), /could not be verified/);
  assert.equal(wrongAccount.calls.some((call) => call.request.method === "POST"), false);
  await assert.rejects(fs.access(path.join(dir, ".env.sushi.local")), /ENOENT/);
  await assert.rejects(main(["--new"], { ...options, api: async () => { throw new Error("project missing"); } }), /project missing/);
  await assert.rejects(fs.access(path.join(dir, ".env.sushi.local")), /ENOENT/);
  await assert.rejects(main(["--new"], { ...options, environment: { ...options.environment, VERCEL: "1" }, api: noGit.api }), /not inside a Vercel build/);
});

test("private env names, generated credentials, and vault files are ignored", async () => {
  for (const filename of [".env", ".env.production", ".env.local", ".env.sushi.local"]) {
    const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", filename]);
    assert.equal(result.status, 0, `${filename} must be gitignored`);
  }
  assert.notEqual(spawnSync("git", ["check-ignore", "--no-index", "--quiet", ".env.example"]).status, 0);
  const vercelIgnore = await fs.readFile(new URL("../.vercelignore", import.meta.url), "utf8");
  const dockerIgnore = await fs.readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  assert.match(vercelIgnore, /^\.env\*$/m);
  assert.match(vercelIgnore, /^data\/\*\.json$/m);
  assert.match(dockerIgnore, /^\.env\*$/m);
});
