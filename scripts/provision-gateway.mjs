#!/usr/bin/env node
// Provision once, outside the gateway process: a token generated at container
// startup would change on restart and differ between replicas. Never print
// Railway's variable-list output, errors, or generated tokens.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_GATEWAY_ALLOWED_ORIGIN } from "../src/lib/gateway-defaults.mjs";

const LOCAL_FILE = ".env.gateway.local";
const LOCK_FILE = ".env.gateway.lock.local";
const RAILWAY_FILE = fileURLToPath(new URL("../.railway/railway.ts", import.meta.url));
const TOKEN_KEY = "SUSHI_GATEWAY_TOKEN";
const ORIGIN_KEY = "ALLOWED_ORIGIN";
const MIN_RAILWAY_VERSION = [5, 47, 2]; // First CLI that lists sealed keys as null.
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function fail(message) {
  throw new Error(message);
}

function usage() {
  console.log(`Usage:
  node scripts/provision-gateway.mjs local [--origin https://your-sushi.example]
  node scripts/provision-gateway.mjs railway [--apply] [--service NAME]
      [--environment NAME] [--origin https://your-sushi.example]

local creates/updates ${LOCAL_FILE} (owner-only, gitignored) for Docker or Node.
railway adds missing service variables to the linked project/environment; --apply
first runs interactive railway config apply for the entire environment, which can
remove unrelated resources/variables. Prefer a new, dedicated project for --apply;
for an existing gateway, omit --apply. Railway CLI 5.47.2+ is required; combining
--apply and --environment requires CLI 5.64.0+.
--origin sets the initial origin only; existing values and sealed keys are kept.
The token is never printed. See README.md for deployment and recovery steps.`);
}

function parseOrigin(value) {
  let url;
  try {
    if (!value || /\s/.test(value)) throw new Error();
    url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        url.origin === "null") throw new Error();
  } catch {
    fail("--origin must be a single http(s) origin, without credentials, a path, query, or fragment.");
  }
  return url.origin;
}

function parseArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  const [mode, ...rest] = args;
  if (mode !== "local" && mode !== "railway") fail("Choose 'local' or 'railway'; use --help for usage.");
  const options = { mode, origin: DEFAULT_GATEWAY_ALLOWED_ORIGIN, originExplicit: false, service: "sushi-gateway", apply: false };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (seen.has(key)) fail("An option was supplied more than once.");
    seen.add(key);
    if (key === "--apply" && mode === "railway") {
      options.apply = true;
    } else if (["--origin", "--service", "--environment"].includes(key)) {
      const value = rest[++i];
      if (!value || value.startsWith("-")) fail("A required option value is missing.");
      if (key !== "--origin" && mode !== "railway") fail("This option is only available for Railway.");
      if (key === "--origin") {
        options.origin = parseOrigin(value);
        options.originExplicit = true;
      }
      if (key === "--service") options.service = value;
      if (key === "--environment") options.environment = value;
    } else {
      fail("Unknown option; use --help for usage.");
    }
  }
  if (options.apply && options.service !== "sushi-gateway") {
    fail("--apply creates sushi-gateway; omit --service or provision a custom service without --apply.");
  }
  return options;
}

function inspectExisting(variables) {
  if (has(variables, TOKEN_KEY) && variables[TOKEN_KEY] === "") {
    fail(`${TOKEN_KEY} already exists but is empty. It was not replaced; set a strong token explicitly or remove that empty entry and retry.`);
  }
  if (has(variables, TOKEN_KEY) && typeof variables[TOKEN_KEY] === "string" && !variables[TOKEN_KEY].trim()) {
    fail(`${TOKEN_KEY} already exists but is blank. It was not replaced; set a strong token explicitly or remove that blank entry and retry.`);
  }
  if (has(variables, ORIGIN_KEY) && typeof variables[ORIGIN_KEY] === "string" &&
      (!variables[ORIGIN_KEY].trim() || variables[ORIGIN_KEY].trim() === "*")) {
    console.warn(`${ORIGIN_KEY} is empty or '*': existing setting preserved, but browser origins are unrestricted.`);
  }
}

// Node's --env-file and Docker Compose do not parse every dotenv expression
// alike: for example, Compose interpolates unquoted `$` and rejects an
// unterminated quote that Node may treat as literal text. Refuse ambiguous
// existing files rather than silently supplying a different token to each host.
function parsePortableLocalEnv(source) {
  const incompatible = () => fail(`${LOCAL_FILE} uses syntax that Node and Docker Compose may interpret differently. No changes made; use simple KEY=value or single-quoted literals without escapes.`);
  const portable = Object.create(null);
  for (const line of source.split(/\r?\n/)) {
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const assignment = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!assignment) incompatible();
    const [, key, raw] = assignment;
    let value;
    if (raw.startsWith("'") || raw.startsWith('"')) {
      const quote = raw[0];
      const end = raw.indexOf(quote, 1);
      if (end < 0 || !/^[ \t]*(?:#.*)?$/.test(raw.slice(end + 1))) incompatible();
      value = raw.slice(1, end);
      if (/[^\x20-\x7e]|\\/.test(value) || (quote === '"' && value.includes("$"))) incompatible();
    } else {
      const comment = raw.indexOf(" #");
      value = comment < 0 ? raw : raw.slice(0, comment).trimEnd();
      if (/[^\x20-\x7e]|[#$'"`\\]/.test(value) || (comment < 0 && raw.includes("#"))) incompatible();
    }
    portable[key] = value;
  }
  const parsed = parseEnv(source);
  if (Object.keys(parsed).length !== Object.keys(portable).length ||
      Object.entries(portable).some(([key, value]) => parsed[key] !== value)) incompatible();
  return parsed;
}

function setupLocal({ origin, originExplicit }) {
  if (process.platform === "win32") {
    fail("Use Linux, macOS, or WSL for the owner-only local environment file.");
  }
  let lock;
  try {
    lock = openSync(LOCK_FILE, "wx", 0o600);
  } catch {
    fail(`Cannot acquire ${LOCK_FILE}. If another setup is not running, remove a stale lock and retry.`);
  }
  try {
    let original = "";
    let existing = false;
    let oldStat;
    try {
      oldStat = lstatSync(LOCAL_FILE);
      existing = true;
    } catch (error) {
      if (error.code !== "ENOENT") fail(`Cannot inspect ${LOCAL_FILE}.`);
    }
    if (existing) {
      if (!oldStat.isFile() || oldStat.isSymbolicLink()) fail(`${LOCAL_FILE} must be a regular file, not a symlink.`);
      if ((oldStat.mode & 0o077) !== 0) fail(`${LOCAL_FILE} is accessible to other users. Restrict it to mode 600 before retrying.`);
      let fd;
      try {
        fd = openSync(LOCAL_FILE, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = fstatSync(fd);
        if (stat.dev !== oldStat.dev || stat.ino !== oldStat.ino) fail(`${LOCAL_FILE} changed during setup; retry.`);
        original = readFileSync(fd, "utf8");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }

    const values = parsePortableLocalEnv(original);
    inspectExisting(values);
    if (originExplicit && has(values, ORIGIN_KEY)) {
      console.log("ALLOWED_ORIGIN already exists; --origin did not replace it. Edit the file deliberately to change it.");
    }
    const additions = [];
    if (!has(values, TOKEN_KEY)) additions.push(`${TOKEN_KEY}=${randomBytes(24).toString("hex")}`);
    if (!has(values, ORIGIN_KEY)) additions.push(`${ORIGIN_KEY}=${origin}`);
    if (additions.length) {
      const suffix = `${original && !original.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`;
      // Appending must not change any existing value under either runtime.
      const checked = parsePortableLocalEnv(original + suffix);
      for (const [key, value] of Object.entries(values)) {
        if (!has(checked, key) || checked[key] !== value) fail(`${LOCAL_FILE} has ambiguous syntax; no changes made.`);
      }
      for (const assignment of additions) {
        const separator = assignment.indexOf("=");
        if (checked[assignment.slice(0, separator)] !== assignment.slice(separator + 1)) {
          fail(`${LOCAL_FILE} has ambiguous syntax; no changes made.`);
        }
      }
      if (!existing) {
        // Exclusive creation and mode 0600; never overwrite an existing file.
        writeFileSync(LOCAL_FILE, suffix, { flag: "wx", mode: 0o600 });
      } else {
        let fd;
        try {
          fd = openSync(LOCAL_FILE, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0));
          const stat = fstatSync(fd);
          if (stat.dev !== oldStat.dev || stat.ino !== oldStat.ino || stat.size !== oldStat.size ||
              stat.mtimeMs !== oldStat.mtimeMs || stat.ctimeMs !== oldStat.ctimeMs || (stat.mode & 0o077) !== 0) {
            fail(`${LOCAL_FILE} changed during setup; retry.`);
          }
          appendFileSync(fd, suffix);
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
    }
    console.log(`${LOCAL_FILE}: gateway settings are present; existing settings preserved.`);
    console.log("Read the token privately from that file; do not commit or share it in chat.");
  } finally {
    closeSync(lock);
    unlinkSync(LOCK_FILE);
  }
}

function railwayCommand(args, options = {}) {
  const result = spawnSync("railway", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60000,
    ...options,
  });
  return result;
}

function versionAtLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

function requireRailwayVersion() {
  const result = railwayCommand(["--version"], { timeout: 15000 });
  // Require an identifiable release; older releases silently omitted sealed
  // variables, which would make a secret appear missing and risk rotating it.
  const match = result.status === 0 && /^railway\s+v?(\d+)\.(\d+)\.(\d+)\s*$/i.exec(result.stdout || "");
  if (!match) fail("Cannot identify the Railway CLI version. Install Railway CLI 5.47.2 or newer and retry.");
  const version = match.slice(1).map(Number);
  if (!versionAtLeast(version, MIN_RAILWAY_VERSION)) {
    fail("Railway CLI 5.47.2 or newer is required so sealed variables are not mistaken for missing ones.");
  }
  return version;
}

function setupRailway({ origin, originExplicit, service, environment, apply }) {
  const version = requireRailwayVersion();
  if (apply && environment && !versionAtLeast(version, [5, 64, 0])) {
    fail("Railway CLI 5.64.0 or newer is required to combine --apply with --environment. Upgrade or link the environment first.");
  }
  const envArgs = environment ? ["--environment", environment] : [];
  const scope = ["--service", service, ...envArgs];
  if (apply) {
    console.log("CAUTION: --apply manages the entire Railway environment; the plan can remove unrelated resources or variables.");
    console.log("Use a dedicated project, review every change, and cancel if any are unintended. For an existing gateway, omit --apply.");
    // Work around older railway/iac versions that mistake a shell's `_` for the
    // CLI executable. Keep the CLI's normal interactive confirmation intact.
    // Explicitly target this checkout's manifest instead of an unrelated file
    // that Railway might otherwise discover in the current directory.
    const childEnv = { ...process.env };
    delete childEnv._;
    const result = railwayCommand(["config", "apply", "--file", RAILWAY_FILE, ...envArgs], {
      stdio: "inherit", env: childEnv, timeout: 0,
    });
    if (result.status !== 0) fail("Railway config apply did not succeed; no variables were provisioned.");
  }

  function list() {
    const result = railwayCommand(["variable", "list", ...scope, "--json"]);
    if (result.status !== 0) {
      fail("Could not safely read Railway variable names. Check the linked project, environment, service, and CLI login; no output was printed.");
    }
    let values;
    try {
      values = JSON.parse(result.stdout);
    } catch {
      fail("Railway returned an unrecognized variable list; no variables were changed.");
    }
    if (!values || typeof values !== "object" || Array.isArray(values) ||
        Object.values(values).some((value) => value !== null && typeof value !== "string")) {
      fail("Railway returned an unrecognized variable list; no variables were changed.");
    }
    return values;
  }

  let values = list();
  inspectExisting(values);
  if (originExplicit && has(values, ORIGIN_KEY)) {
    console.log("ALLOWED_ORIGIN already exists; --origin did not replace it. Change it deliberately in Railway if needed.");
  }
  for (const [key, newValue] of [
    // Configure authentication first: Railway may deploy after each write.
    [TOKEN_KEY, () => randomBytes(24).toString("hex")],
    [ORIGIN_KEY, () => origin],
  ]) {
    if (has(values, key)) continue; // null means a sealed, existing key.
    // Re-read just before the write. Railway's upsert is not a compare-and-set,
    // so operators must still avoid concurrent edits to these two keys.
    values = list();
    inspectExisting(values);
    if (has(values, key)) continue;
    const result = railwayCommand(["variable", "set", key, "--stdin", ...scope], { input: newValue() });
    if (result.status !== 0) {
      fail(`Could not set ${key}. The outcome may be uncertain; inspect Railway before retrying. No CLI output was printed.`);
    }
    console.log(`${key}: added to Railway.`);
    values[key] = true; // Presence only; never retain or print the value.
  }
  console.log("Existing variables, including sealed keys, were preserved. Deploy staged changes if Railway asks.");
  console.log("Copy the gateway token privately from the service's Variables tab or use your saved copy if sealed.");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  else if (options.mode === "local") setupLocal(options);
  else setupRailway(options);
} catch (error) {
  // Never print child-process output or a stack containing variable values.
  console.error(`Gateway setup: ${error instanceof Error ? error.message : "setup failed"}`);
  process.exitCode = 1;
}
