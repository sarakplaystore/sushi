import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { DEFAULT_GATEWAY_ALLOWED_ORIGIN } from "../src/lib/gateway-defaults.mjs";

console.log("==> Gateway provisioning: local secrets and Railway CLI safety");

const helper = resolve("scripts/provision-gateway.mjs");
const root = mkdtempSync(join(tmpdir(), "sushi-gateway-test-"));
const local = (name: string) => { const dir = join(root, name); mkdirSync(dir); return dir; };
const run = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync(process.execPath, [helper, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 15000,
  });
const combined = (result: ReturnType<typeof run>) => `${result.stdout ?? ""}${result.stderr ?? ""}`;
const readLocal = (dir: string) => parseEnv(readFileSync(join(dir, ".env.gateway.local"), "utf8"));
const privateWrite = (file: string, data: string) => writeFileSync(file, data, { mode: 0o600 });

// Realistic offline Railway CLI: it stores secrets in a temporary fixture, just
// as the provider would, and can expose them in stdout/stderr to test redaction.
const fakeBin = join(root, "bin");
mkdirSync(fakeBin);
const fakeRailway = `#!/usr/bin/env node
const fs = require('node:fs');
const stateFile = process.env.FAKE_RAILWAY_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
state.calls.push(args);
if (args[0] === '--version') {
  save(); console.log(state.version || 'railway 5.75.0'); process.exit(0);
}
if (args[0] === 'config' && args[1] === 'apply') {
  state.applyUnderscore = process.env._ || null;
  save(); console.log('REDACTED PLAN'); process.exit(state.applyFails ? 1 : 0);
}
if (args[0] === 'variable' && args[1] === 'list') {
  state.lists = (state.lists || 0) + 1;
  if (state.injectAtList === state.lists) Object.assign(state.vars, state.injectVars);
  save();
  if (state.listFails) { console.error('sensitive-cli-error:' + state.errorSecret); process.exit(1); }
  if (state.invalidJson) { console.log('not-json:' + state.errorSecret); process.exit(0); }
  if (state.invalidShape) { console.log(JSON.stringify([{ value: state.errorSecret }])); process.exit(0); }
  console.log(JSON.stringify(state.vars)); process.exit(0);
}
if (args[0] === 'variable' && args[1] === 'set') {
  const value = fs.readFileSync(0, 'utf8');
  if (!args.includes('--stdin')) { console.error('not using stdin'); process.exit(2); }
  if (state.setFails === args[2]) { save(); console.error('sensitive-cli-error:' + value); process.exit(1); }
  state.vars[args[2]] = value;
  save(); console.log('sensitive-cli-output:' + value); process.exit(0);
}
save(); console.error('unexpected CLI call'); process.exit(2);
`;
const fakeRailwayPath = join(fakeBin, "railway");
writeFileSync(fakeRailwayPath, fakeRailway, { mode: 0o700 });
chmodSync(fakeRailwayPath, 0o700);

type RailwayState = {
  vars: Record<string, string | null>;
  calls: string[][];
  version?: string;
  lists?: number;
  injectAtList?: number;
  injectVars?: Record<string, string | null>;
  errorSecret?: string;
  listFails?: boolean;
  invalidJson?: boolean;
  invalidShape?: boolean;
  setFails?: string;
  applyFails?: boolean;
  applyUnderscore?: string | null;
};
const stateFile = join(root, "railway.json");
const putState = (vars: RailwayState["vars"], options: Partial<RailwayState> = {}) =>
  privateWrite(stateFile, JSON.stringify({ vars, calls: [], ...options }));
const getState = (): RailwayState => JSON.parse(readFileSync(stateFile, "utf8"));
const railwayEnv = { PATH: `${fakeBin}${delimiter}${process.env.PATH}`, FAKE_RAILWAY_STATE: stateFile, _: "/bin/not-railway" };
const railway = (args: string[] = []) => run(root, ["railway", ...args], railwayEnv);

try {
  const dir = local("new-local");
  let result = run(dir, ["local"]);
  assert.equal(result.status, 0, combined(result));
  let file = readLocal(dir);
  const firstToken = file.SUSHI_GATEWAY_TOKEN;
  assert.ok(firstToken);
  assert.match(firstToken, /^[0-9a-f]{48}$/, "24 random bytes encoded as hex");
  assert.equal(file.ALLOWED_ORIGIN, DEFAULT_GATEWAY_ALLOWED_ORIGIN);
  assert.equal(statSync(join(dir, ".env.gateway.local")).mode & 0o777, 0o600);
  assert(!combined(result).includes(firstToken), "new token is not printed");
  result = run(dir, ["local", "--origin", "https://other.example"]);
  assert.equal(result.status, 0, combined(result));
  assert.match(combined(result), /--origin did not replace it/);
  assert.deepEqual(readLocal(dir), file, "rerunning never rotates the token or replaces the origin");
  assert(!combined(result).includes(firstToken));
  assert(!existsSync(join(dir, ".env.gateway.lock.local")), "the lock is removed after setup");
  const locked = local("locked-local");
  privateWrite(join(locked, ".env.gateway.lock.local"), "");
  result = run(locked, ["local"]);
  assert.notEqual(result.status, 0, "a second local provisioner cannot proceed while a lock exists");
  assert(!existsSync(join(locked, ".env.gateway.local")));
  assert(existsSync(join(locked, ".env.gateway.lock.local")), "the other process's lock is not removed");

  const other = local("different-local");
  result = run(other, ["local", "--origin", "https://other.example:8443/"]);
  assert.equal(result.status, 0, combined(result));
  file = readLocal(other);
  assert.equal(file.ALLOWED_ORIGIN, "https://other.example:8443");
  assert.match(file.SUSHI_GATEWAY_TOKEN ?? "", /^[0-9a-f]{48}$/);
  assert.notEqual(file.SUSHI_GATEWAY_TOKEN, firstToken, "independent deployments get unique tokens");

  const partial = local("partial-local");
  const partialFile = join(partial, ".env.gateway.local");
  privateWrite(partialFile, "# existing settings\nSUSHI_GATEWAY_TOKEN=already-owned-secret\nOTHER=retained\n");
  result = run(partial, ["local", "--origin", "https://my-ui.example"]);
  assert.equal(result.status, 0, combined(result));
  assert.deepEqual(readLocal(partial), {
    SUSHI_GATEWAY_TOKEN: "already-owned-secret", OTHER: "retained", ALLOWED_ORIGIN: "https://my-ui.example",
  });
  assert(!combined(result).includes("already-owned-secret"));
  const originOnly = local("origin-only");
  privateWrite(join(originOnly, ".env.gateway.local"), "ALLOWED_ORIGIN=https://keep.example\n");
  result = run(originOnly, ["local", "--origin", "https://ignored.example"]);
  assert.equal(result.status, 0, combined(result));
  assert.equal(readLocal(originOnly).ALLOWED_ORIGIN, "https://keep.example");
  assert.match(readLocal(originOnly).SUSHI_GATEWAY_TOKEN ?? "", /^[0-9a-f]{48}$/);

  const blank = local("blank-local");
  privateWrite(join(blank, ".env.gateway.local"), "SUSHI_GATEWAY_TOKEN=\n");
  result = run(blank, ["local"]);
  assert.notEqual(result.status, 0, "an existing blank token is not overwritten");
  assert.deepEqual(readLocal(blank), { SUSHI_GATEWAY_TOKEN: "" });
  const publicFile = local("public-local");
  privateWrite(join(publicFile, ".env.gateway.local"), "SUSHI_GATEWAY_TOKEN=existing-private-token\n");
  chmodSync(join(publicFile, ".env.gateway.local"), 0o644);
  result = run(publicFile, ["local"]);
  assert.notEqual(result.status, 0);
  assert.match(combined(result), /mode 600/);
  assert(!combined(result).includes("existing-private-token"));
  const symlink = local("symlink-local");
  privateWrite(join(symlink, "target"), "SUSHI_GATEWAY_TOKEN=symlink-private-token\n");
  symlinkSync("target", join(symlink, ".env.gateway.local"));
  result = run(symlink, ["local"]);
  assert.notEqual(result.status, 0);
  assert.match(combined(result), /not a symlink/);
  assert.equal(readFileSync(join(symlink, "target"), "utf8"), "SUSHI_GATEWAY_TOKEN=symlink-private-token\n");
  for (const [name, contents] of [
    ["unterminated", 'OTHER="unterminated'],
    ["interpolation", "SUSHI_GATEWAY_TOKEN=existing$SECRET\n"],
    ["inline-hash", "OTHER=bare#part\n"],
    ["double-quote-escape", 'OTHER="literal\\\\ttext"\n'],
    ["bare-name", "SUSHI_GATEWAY_TOKEN\n"],
  ]) {
    const ambiguous = local(`ambiguous-${name}`);
    const path = join(ambiguous, ".env.gateway.local");
    privateWrite(path, contents);
    result = run(ambiguous, ["local"]);
    assert.notEqual(result.status, 0, `unsafe dotenv syntax is refused: ${name}`);
    assert.match(combined(result), /Node and Docker Compose may interpret differently/);
    assert.equal(readFileSync(path, "utf8"), contents, "ambiguous files are never rewritten");
    assert(!combined(result).includes("existing$SECRET"), "existing secrets are not printed");
  }
  const quoted = local("quoted-local");
  privateWrite(join(quoted, ".env.gateway.local"), "SUSHI_GATEWAY_TOKEN='literal$plus#hash' # retain literally\n");
  result = run(quoted, ["local"]);
  assert.equal(result.status, 0, combined(result));
  assert.equal(readLocal(quoted).SUSHI_GATEWAY_TOKEN, "literal$plus#hash");
  assert.equal(readLocal(quoted).ALLOWED_ORIGIN, DEFAULT_GATEWAY_ALLOWED_ORIGIN);

  const invalid = local("invalid-origin");
  for (const value of ["*", "https://ui.example/path", "https://user:pass@ui.example", "https://ui.example?query=1", "file:///tmp/foo"]) {
    result = run(invalid, ["local", "--origin", value]);
    assert.notEqual(result.status, 0, `invalid origin is rejected: ${value}`);
    assert(!existsSync(join(invalid, ".env.gateway.local")));
  }

  // First apply, including scoped environment, creates a strong secret but
  // never places its bytes in argv, stdout, stderr, or the CLI's inherited `_`.
  putState({ OTHER_SECRET: "unrelated-existing-secret" });
  result = railway(["--apply", "--environment", "staging"]);
  assert.equal(result.status, 0, combined(result));
  let state = getState();
  assert.equal(state.vars.ALLOWED_ORIGIN, DEFAULT_GATEWAY_ALLOWED_ORIGIN);
  assert.match(state.vars.SUSHI_GATEWAY_TOKEN!, /^[0-9a-f]{48}$/);
  const railwayToken = state.vars.SUSHI_GATEWAY_TOKEN!;
  assert(!combined(result).includes(railwayToken));
  assert(!combined(result).includes("unrelated-existing-secret"));
  assert(state.calls.some((args) => args[0] === "config" && args[1] === "apply" &&
    args[args.indexOf("--file") + 1] === resolve(".railway/railway.ts") &&
    args[args.indexOf("--environment") + 1] === "staging"));
  assert.match(combined(result), /entire Railway environment/);
  assert.equal(state.applyUnderscore, null);
  const sets = state.calls.filter((args) => args[0] === "variable" && args[1] === "set");
  assert.equal(sets.length, 2);
  assert.equal(sets[0][2], "SUSHI_GATEWAY_TOKEN", "configure authentication before a potential deploy");
  assert(sets.every((args) => args.includes("--stdin") && args.includes("--service") && args.includes("staging")));
  assert(!JSON.stringify(sets).includes(railwayToken), "token never appears in CLI arguments");
  assert(!JSON.stringify(sets).includes(DEFAULT_GATEWAY_ALLOWED_ORIGIN), "origin also goes through stdin");
  result = railway(["--environment", "staging", "--origin", "https://ignored.example"]);
  assert.equal(result.status, 0, combined(result));
  assert.match(combined(result), /--origin did not replace it/);
  state = getState();
  assert.equal(state.vars.SUSHI_GATEWAY_TOKEN, railwayToken);
  assert.equal(state.vars.ALLOWED_ORIGIN, DEFAULT_GATEWAY_ALLOWED_ORIGIN);
  assert.equal(state.calls.filter((args) => args[0] === "variable" && args[1] === "set").length, 2);

  putState({ SUSHI_GATEWAY_TOKEN: null, ALLOWED_ORIGIN: "https://existing.example" });
  result = railway(["--origin", "https://another.example"]);
  assert.equal(result.status, 0, combined(result));
  state = getState();
  assert.equal(state.vars.SUSHI_GATEWAY_TOKEN, null, "sealed token counts as present");
  assert.equal(state.vars.ALLOWED_ORIGIN, "https://existing.example");
  assert(!state.calls.some((args) => args[1] === "set"));
  putState({ SUSHI_GATEWAY_TOKEN: null });
  result = railway();
  assert.equal(result.status, 0, combined(result));
  assert.equal(getState().vars.SUSHI_GATEWAY_TOKEN, null, "adding an origin never rotates a sealed token");
  assert.equal(getState().vars.ALLOWED_ORIGIN, DEFAULT_GATEWAY_ALLOWED_ORIGIN);
  putState({ ALLOWED_ORIGIN: null });
  result = railway();
  assert.equal(result.status, 0, combined(result));
  assert.equal(getState().vars.ALLOWED_ORIGIN, null, "adding a token never replaces a sealed origin");
  assert.match(getState().vars.SUSHI_GATEWAY_TOKEN ?? "", /^[0-9a-f]{48}$/);
  putState({ SUSHI_GATEWAY_TOKEN: "previous-gateway-token", ALLOWED_ORIGIN: null });
  result = railway();
  assert.equal(result.status, 0, combined(result));
  assert(!combined(result).includes("previous-gateway-token"));
  assert(!getState().calls.some((args) => args[1] === "set"), "sealed origin is preserved as well");

  putState({ SUSHI_GATEWAY_TOKEN: "" });
  result = railway();
  assert.notEqual(result.status, 0, "blank token is reported instead of silently replaced");
  assert(!getState().calls.some((args) => args[1] === "set"));
  putState({ SUSHI_GATEWAY_TOKEN: "existing-token", ALLOWED_ORIGIN: "*" });
  result = railway();
  assert.equal(result.status, 0);
  assert.match(combined(result), /origins are unrestricted/);
  assert(!getState().calls.some((args) => args[1] === "set"));

  // Rechecking immediately before a write protects against another actor who
  // has already added a key; Railway itself has no atomic create-if-absent.
  putState({}, { injectAtList: 2, injectVars: { SUSHI_GATEWAY_TOKEN: "racing-existing-secret" } });
  result = railway();
  assert.equal(result.status, 0, combined(result));
  assert.equal(getState().vars.SUSHI_GATEWAY_TOKEN, "racing-existing-secret");
  assert(!getState().calls.some((args) => args[2] === "SUSHI_GATEWAY_TOKEN" && args[1] === "set"));
  assert(!combined(result).includes("racing-existing-secret"));

  for (const version of ["railway 5.47.1", "railway 4.99.9", "unknown 99.99.99", "railway 5.47.2-beta.1"]) {
    putState({ SUSHI_GATEWAY_TOKEN: null }, { version });
    result = railway(["--apply"]);
    assert.notEqual(result.status, 0, `refuse unsafe/unrecognized CLI: ${version}`);
    assert.equal(getState().calls.length, 1, "old CLI fails before apply or reading variables");
  }
  putState({}, { version: "railway 5.47.2" });
  result = railway(["--origin", "https://new-ui.example", "--service", "custom-service"]);
  assert.equal(result.status, 0, combined(result));
  assert.equal(getState().vars.ALLOWED_ORIGIN, "https://new-ui.example");
  assert(getState().calls.filter((args) => args[0] === "variable").every((args) => args.includes("custom-service")));
  putState({}, { version: "railway 5.47.2" });
  result = railway(["--environment", "staging"]);
  assert.equal(result.status, 0, combined(result));
  assert(getState().calls.filter((args) => args[0] === "variable").every((args) => args.includes("staging")),
    "older CLI can scope variable-only provisioning");
  for (const version of ["railway 5.47.2", "railway 5.63.3"]) {
    putState({}, { version });
    result = railway(["--apply", "--environment", "staging"]);
    assert.notEqual(result.status, 0, "older config apply does not support --environment");
    assert.match(combined(result), /5\.64\.0 or newer/);
    assert.equal(getState().calls.length, 1, "refuse before applying to the wrong environment");
  }
  putState({}, { version: "railway 5.47.2" });
  result = railway(["--apply"]);
  assert.equal(result.status, 0, combined(result));
  assert(getState().calls.some((args) => args[0] === "config" && args[1] === "apply"));
  putState({}, { version: "railway 5.64.0" });
  result = railway(["--apply", "--environment", "staging"]);
  assert.equal(result.status, 0, combined(result));
  assert(getState().calls.some((args) => args[0] === "config" && args[1] === "apply" &&
    args[args.indexOf("--environment") + 1] === "staging"));

  for (const failure of ["listFails", "invalidJson", "invalidShape"] as const) {
    putState({}, { [failure]: true, errorSecret: "do-not-print-provider-secret" });
    result = railway();
    assert.notEqual(result.status, 0);
    assert(!combined(result).includes("do-not-print-provider-secret"));
    assert(!getState().calls.some((args) => args[1] === "set"));
  }
  putState({}, { setFails: "ALLOWED_ORIGIN" });
  result = railway();
  assert.notEqual(result.status, 0);
  assert.match(combined(result), /outcome may be uncertain/);
  assert(!combined(result).includes("sensitive-cli-error"));
  const partialState = getState();
  const partialToken = partialState.vars.SUSHI_GATEWAY_TOKEN;
  assert.match(partialToken ?? "", /^[0-9a-f]{48}$/, "token was set before the failed origin write");
  assert.equal(partialState.vars.ALLOWED_ORIGIN, undefined);
  putState(partialState.vars);
  result = railway();
  assert.equal(result.status, 0, combined(result));
  assert.equal(getState().vars.SUSHI_GATEWAY_TOKEN, partialToken, "retry never rotates the partial setup's token");
  assert.equal(getState().vars.ALLOWED_ORIGIN, DEFAULT_GATEWAY_ALLOWED_ORIGIN);
  putState({}, { applyFails: true });
  result = railway(["--apply"]);
  assert.notEqual(result.status, 0);
  assert(!getState().calls.some((args) => args[0] === "variable"));
  result = railway(["--apply", "--service", "different"]);
  assert.notEqual(result.status, 0);

  console.log("Gateway provisioning tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
