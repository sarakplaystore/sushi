#!/usr/bin/env node
/**
 * Import Sushi's admin settings from a private .env file into a linked Vercel
 * project, then deploy its production Git branch. This runs locally (or in an
 * authenticated CI job), never inside a Vercel build or a browser.
 *
 * Vercel is the durable source of truth after import. Do not update or delete
 * existing auth values here: changing the effective signing secret can lock
 * session-key vaults. The API is called without upsert and secrets travel over
 * stdin, not command-line arguments, logs, or Git.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const AUTH_USER = "SUSHI_AUTH_USERNAME";
const AUTH_PASSWORD = "SUSHI_AUTH_PASSWORD";
const AUTH_PASSWORD_HASH = "SUSHI_AUTH_PASSWORD_HASH";
const AUTH_SECRET = "SUSHI_AUTH_SECRET";
const AUTH_KEYS = [AUTH_USER, AUTH_PASSWORD, AUTH_PASSWORD_HASH, AUTH_SECRET];
const MAX_ENV_FILE_BYTES = 256 * 1024;
const VERCEL_CLI = "vercel@66.5.0";
const DEFAULT_ENV_FILE = ".env";
const NEW_ENV_FILE = ".env.sushi.local";

export function parseAuthEnv(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error("The .env file is too large.");
  }

  // Ambiguous duplicates are more dangerous than rejecting an unusual file.
  // This deliberately fails closed even if a duplicate-like line appears in a
  // multiline value. Values are parsed as literals; no shell is executed.
  for (const key of AUTH_KEYS) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "gm");
    if ([...text.matchAll(pattern)].length > 1) {
      throw new Error(`The .env file defines ${key} more than once.`);
    }
  }
  let parsed;
  try {
    parsed = parseEnv(text);
  } catch {
    throw new Error("Could not parse the .env file.");
  }

  const username = (parsed[AUTH_USER] ?? "").trim();
  const password = parsed[AUTH_PASSWORD] ?? "";
  const passwordHash = (parsed[AUTH_PASSWORD_HASH] ?? "").trim();
  const secret = (parsed[AUTH_SECRET] ?? "").trim();
  if (!username || (!password && !passwordHash)) {
    throw new Error("The .env file must contain SUSHI_AUTH_USERNAME and SUSHI_AUTH_PASSWORD (or SUSHI_AUTH_PASSWORD_HASH).");
  }
  if (password && passwordHash) {
    throw new Error("Specify either SUSHI_AUTH_PASSWORD or SUSHI_AUTH_PASSWORD_HASH, not both.");
  }
  if (passwordHash) {
    const sha256 = /^[a-f0-9]{64}$/i.test(passwordHash);
    const parts = passwordHash.split(":");
    const scrypt = parts.length === 2 && parts[0].length > 0 && parts[0].length % 2 === 0 &&
      /^[a-f0-9]+$/i.test(parts[0]) && /^[a-f0-9]{128}$/i.test(parts[1]);
    if (!sha256 && !scrypt) {
      throw new Error("SUSHI_AUTH_PASSWORD_HASH must be a SHA-256 hex digest or a hex-salt:128-hex-character scrypt hash.");
    }
  }
  const values = { [AUTH_USER]: username };
  if (password) values[AUTH_PASSWORD] = password;
  if (passwordHash) values[AUTH_PASSWORD_HASH] = passwordHash;
  if (secret) values[AUTH_SECRET] = secret;
  if (Object.values(values).some((value) => value.includes("\0"))) {
    throw new Error("Admin values cannot contain a NUL character.");
  }
  if (Object.values(values).some((value) => Buffer.byteLength(value, "utf8") > 60 * 1024)) {
    throw new Error("An admin value is too large for Vercel.");
  }
  return values;
}

export function newAuthEnvText() {
  const password = randomBytes(32).toString("base64url");
  const secret = randomBytes(32).toString("hex");
  return [
    "# Private Sushi production credentials. Never commit or publish this file.",
    "# Back it up securely: the signing secret is needed to open session-key vaults.",
    `${AUTH_USER}=admin`,
    `${AUTH_PASSWORD}=${password}`,
    `${AUTH_SECRET}=${secret}`,
    "",
  ].join("\n");
}

/** Reject credentials inside the checkout unless Git ignores and does not track them. */
export async function assertPrivateEnvFile(filePath, cwd) {
  const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  if (rootResult.status !== 0) throw new Error("Could not check whether the .env file is tracked by Git; no credentials were imported.");
  const root = await fs.realpath(rootResult.stdout.trim());
  const paths = new Set([path.resolve(filePath), await fs.realpath(filePath)]);
  for (const candidate of paths) {
    const relative = path.relative(root, candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const gitPath = relative.split(path.sep).join("/");
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", `:(literal)${gitPath}`], {
      cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    if (tracked.status === 0) throw new Error("The selected credentials file is tracked by Git. Do not import or publish it; move the private file outside the checkout or use an untracked, ignored .env file.");
    if (tracked.status !== 1) throw new Error("Could not check whether the .env file is tracked by Git; no credentials were imported.");
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", gitPath], {
      cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    if (ignored.status === 1) throw new Error("The selected credentials file is not ignored by Git. Move it outside the checkout or use an ignored .env file before importing.");
    if (ignored.status !== 0) throw new Error("Could not check whether the .env file is ignored by Git; no credentials were imported.");
  }
}

export async function createPrivateEnvFile(filePath) {
  // Exclusive creation prevents both accidental rotation and symlink clobbering.
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Error(`The private file ${filePath} already exists; it was not changed.`);
    }
    throw error;
  }
  try {
    const text = newAuthEnvText();
    await handle.writeFile(text, "utf8");
    await handle.sync();
    return text;
  } catch (error) {
    // We created this path exclusively; remove an incomplete file on write error.
    await handle.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    handle = undefined;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

export async function resolveProject(cwd, environment = process.env) {
  const pinnedProject = environment.VERCEL_PROJECT_ID?.trim();
  const pinnedOrg = environment.VERCEL_ORG_ID?.trim();
  if (Boolean(pinnedProject) !== Boolean(pinnedOrg)) {
    throw new Error("Set both VERCEL_PROJECT_ID and VERCEL_ORG_ID, or link the project with the Vercel CLI.");
  }
  if (pinnedProject && pinnedOrg) return validateProjectLink({ projectId: pinnedProject, orgId: pinnedOrg });

  let link;
  try {
    link = JSON.parse(await fs.readFile(path.join(cwd, ".vercel", "project.json"), "utf8"));
  } catch {
    throw new Error("This directory is not linked to a Vercel project. Link the existing project with the Vercel CLI first.");
  }
  return validateProjectLink(link);
}

function validateProjectLink(link) {
  if (!link || typeof link.projectId !== "string" || !/^prj_[A-Za-z0-9]+$/.test(link.projectId) ||
      typeof link.orgId !== "string" || !/^[A-Za-z0-9_-]+$/.test(link.orgId)) {
    throw new Error("The linked Vercel project ID or account ID is invalid.");
  }
  return { projectId: link.projectId, orgId: link.orgId };
}

function withTeam(endpoint, orgId) {
  if (!orgId.startsWith("team_")) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}teamId=${encodeURIComponent(orgId)}`;
}

/** Make one authenticated Vercel API request using the existing CLI session. */
export function callVercelApi(endpoint, { orgId, cwd, method = "GET", body } = {}) {
  // Do not let a local CLI API-URL override send credentials to another host.
  const args = ["--yes", VERCEL_CLI, "api", endpoint, "--raw", "--no-color", "--non-interactive", "--api", "https://api.vercel.com"];
  if (orgId?.startsWith("team_")) args.push("--scope", orgId);
  if (method !== "GET") args.push("--method", method, "--input", "-");
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd,
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
  });
  // API errors can include submitted values. Never echo subprocess output.
  if (result.error || result.status !== 0) {
    throw new Error("Vercel API request failed. Check the CLI login, linked project, permissions, and network; no response body was printed.");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Vercel returned an unexpected response. No response body was printed.");
  }
}

function isProduction(record) {
  const target = record.target;
  // Unknown/legacy target metadata is treated as production, not as absence.
  if (target == null || (Array.isArray(target) && target.length === 0)) return true;
  if (Array.isArray(target)) return target.includes("production");
  if (typeof target === "string") return target === "production";
  return true;
}

function isLinkedShared(record, projectId) {
  const projects = record.projectId ?? record.projectIds;
  if (projects == null || (Array.isArray(projects) && projects.length === 0)) return true;
  if (Array.isArray(projects)) return projects.includes(projectId);
  if (typeof projects === "string") return projects === projectId;
  return true;
}

function completeList(response, field, description) {
  if (!response || !Array.isArray(response[field])) {
    throw new Error(`Could not read ${description}; import stopped without changing credentials.`);
  }
  if (response.pagination?.next || response.has_more || response.hasMore) {
    throw new Error(`${description} were truncated; import stopped without changing credentials.`);
  }
  if (response.hiddenProductionEnvCount !== undefined && response.hiddenProductionEnvCount !== 0) {
    throw new Error(`Some ${description} are hidden by Vercel permissions; import stopped without changing credentials.`);
  }
  return response[field];
}

/** Read all potentially effective project and shared auth-variable metadata. */
export async function readAuthRecords(api, projectId, orgId) {
  const projectEnvPath = withTeam(`/v10/projects/${encodeURIComponent(projectId)}/env`, orgId);
  const projectResponse = await api(projectEnvPath);
  const projectVars = completeList(projectResponse, "envs", "Vercel project variables");
  let sharedVars = [];
  if (orgId.startsWith("team_")) {
    const sharedPath = withTeam("/v1/env", orgId);
    const sharedResponse = await api(sharedPath);
    sharedVars = completeList(sharedResponse, "data", "Vercel shared variables");
  }
  const relevant = [
    ...projectVars.map((record) => ({ ...record, source: "project" })),
    ...sharedVars.filter((record) => isLinkedShared(record, projectId)).map((record) => ({ ...record, source: "shared" })),
  ].filter((record) => AUTH_KEYS.includes(record.key) && isProduction(record));

  const records = new Map();
  for (const record of relevant) {
    if (records.has(record.key)) {
      throw new Error(`Multiple production definitions of ${record.key} exist; import stopped without changing credentials.`);
    }
    records.set(record.key, record);
  }
  return records;
}

async function verifyExistingUsername(api, record, expected, projectId, orgId) {
  if (record.type === "sensitive" || record.visibility === "secret" || !record.id) {
    throw new Error("The existing username cannot be verified. Import stopped without changing credentials.");
  }
  const endpoint = record.source === "shared"
    ? `/v1/env/${encodeURIComponent(record.id)}`
    : `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(record.id)}`;
  const actual = await api(withTeam(endpoint, orgId));
  if (typeof actual?.value !== "string" || actual.value.trim() !== expected) {
    throw new Error("The existing Vercel username does not match the .env file, or cannot be read. No credentials were changed.");
  }
  return actual;
}

function assertCreated(response, keys) {
  const created = Array.isArray(response?.created) ? response.created : response?.created ? [response.created] : [];
  const failed = response?.failed;
  if (!Array.isArray(failed) || failed.length || created.length !== keys.length ||
      keys.some((key) => !created.some((record) => record?.key === key))) {
    throw new Error("Vercel did not confirm every variable was imported. No deployment was started; retain the .env file and inspect the project before retrying.");
  }
}

/**
 * Import only a wholly new account, or complete a verified username-only
 * configuration. A configured account is never modified, including adding a
 * previously absent signing secret (which would change its effective vault key).
 */
export async function importAuthEnv(api, projectId, orgId, values, initialRecords) {
  const records = initialRecords ?? await readAuthRecords(api, projectId, orgId);
  const userRecord = records.get(AUTH_USER);
  const hasPassword = records.has(AUTH_PASSWORD) || records.has(AUTH_PASSWORD_HASH);
  const hasSecret = records.has(AUTH_SECRET);

  if (userRecord && hasPassword) {
    const hasPlainPassword = records.has(AUTH_PASSWORD);
    const hasPasswordHash = records.has(AUTH_PASSWORD_HASH);
    if (hasPlainPassword && hasPasswordHash) {
      throw new Error("The Vercel project has both a password and a password hash. Import stopped without changing credentials; inspect the existing settings first.");
    }
    const filePasswordKey = values[AUTH_PASSWORD] ? AUTH_PASSWORD : AUTH_PASSWORD_HASH;
    const existingPasswordKey = hasPlainPassword ? AUTH_PASSWORD : AUTH_PASSWORD_HASH;
    if (filePasswordKey !== existingPasswordKey || Boolean(values[AUTH_SECRET]) !== hasSecret) {
      throw new Error("The .env file does not describe the existing password/secret settings. No credentials were changed and no deployment was started; preserve the existing effective vault key and inspect the project before retrying.");
    }
    return { imported: [], existing: true, hasExplicitSecret: hasSecret };
  }
  if (hasPassword || hasSecret) {
    throw new Error("The Vercel project has partial admin credentials or a signing secret. Import stopped to protect the existing vault key.");
  }
  if (userRecord) await verifyExistingUsername(api, userRecord, values[AUTH_USER], projectId, orgId);

  // Install the signing key before the password. If an import is interrupted,
  // the app remains unconfigured rather than starting with the wrong vault key.
  const orderedKeys = [AUTH_USER, AUTH_SECRET, AUTH_PASSWORD, AUTH_PASSWORD_HASH];
  const missing = orderedKeys.filter((key) => Object.hasOwn(values, key) && !records.has(key));
  if (!missing.length) throw new Error("No admin credentials were available to import.");
  const endpoint = withTeam(`/v10/projects/${encodeURIComponent(projectId)}/env`, orgId);
  const created = [];
  try {
    for (const key of missing) {
      const payload = {
        key,
        value: values[key],
        // The username may be read by an authorized member for safe resumption.
        // Passwords, hashes and signing secrets are write-only Vercel Secrets.
        type: key === AUTH_USER ? "encrypted" : "sensitive",
        visibility: key === AUTH_USER ? "config" : "secret",
        target: ["production"],
      };
      // Vercel CLI 66.5.0 serializes a JSON array input incorrectly. Sending
      // one object per request is both compatible and easier to recover from.
      const response = await api(endpoint, { method: "POST", body: payload });
      assertCreated(response, [key]);
      created.push(...(Array.isArray(response.created) ? response.created : [response.created]));
    }
  } catch {
    throw new Error("Vercel did not confirm every variable was imported. Some may have been saved; no deployment was started. Retain the .env file and inspect the project before retrying.");
  }

  const after = await readAuthRecords(api, projectId, orgId);
  const expectedKeys = new Set([...records.keys(), ...Object.keys(values)]);
  if (after.size !== expectedKeys.size || [...expectedKeys].some((key) => !after.has(key))) {
    throw new Error("The Vercel admin settings changed during import; no deployment was started.");
  }
  for (const createdRecord of created) {
    const current = after.get(createdRecord.key);
    if ((createdRecord.id && current?.id !== createdRecord.id) ||
        (createdRecord.updatedAt != null && current?.updatedAt !== createdRecord.updatedAt)) {
      throw new Error("A Vercel admin setting changed during import; no deployment was started.");
    }
  }
  if (userRecord) {
    const currentUser = after.get(AUTH_USER);
    if (!currentUser || currentUser.id !== userRecord.id ||
        (userRecord.updatedAt != null && currentUser.updatedAt !== userRecord.updatedAt)) {
      throw new Error("The Vercel username changed during import; no deployment was started.");
    }
    await verifyExistingUsername(api, currentUser, values[AUTH_USER], projectId, orgId);
  }
  return { imported: missing, existing: false, hasExplicitSecret: Boolean(values[AUTH_SECRET]) };
}

function validateGitProject(project, projectId, orgId) {
  if (!project || project.id !== projectId || project.accountId !== orgId ||
      typeof project.name !== "string" || !project.name) {
    throw new Error("The linked Vercel project could not be verified; no credentials were changed.");
  }
}

function getGitSource(project) {
  const link = project.link;
  if (!link || link.type !== "github" || !link.repoId || typeof link.productionBranch !== "string" || !link.productionBranch) {
    throw new Error("Automatic deployment requires a GitHub-linked Vercel project with a production branch. Use --import-only to skip deployment.");
  }
  return { type: "github", repoId: String(link.repoId), ref: link.productionBranch };
}

function githubRepositoryFromRemote(remote) {
  let pathname;
  const scp = remote.match(/^[^/@\s]+@github\.com:([^\s]+)$/i);
  if (scp) {
    pathname = scp[1];
  } else {
    try {
      const url = new URL(remote);
      if (url.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:"].includes(url.protocol) || url.search || url.hash) return null;
      pathname = url.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  const parts = pathname.replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (![owner, repo].every((part) => /^[a-z0-9_.-]+$/i.test(part) && part !== "." && part !== "..")) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/** Do not send admin secrets to a different linked repository by mistake. */
export function verifyProjectRepository(project, cwd) {
  const link = project?.link;
  if (!link || link.type !== "github" || typeof link.org !== "string" || typeof link.repo !== "string") {
    throw new Error("Import requires a GitHub-linked Vercel project. Link the project for this checkout before importing credentials.");
  }
  const expected = `${link.org}/${link.repo}`.toLowerCase();
  const origin = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  const actual = origin.status === 0 ? githubRepositoryFromRemote(origin.stdout.trim()) : null;
  if (!actual || actual !== expected) {
    throw new Error("The linked Vercel project's GitHub repository does not match this checkout's origin. No credentials were changed; link the correct project or use its checkout.");
  }
}

export async function startProductionDeployment(api, project, projectId, orgId) {
  const gitSource = getGitSource(project);
  const response = await api(withTeam("/v13/deployments?forceNew=1", orgId), {
    method: "POST",
    body: { name: project.name, project: projectId, target: "production", gitSource },
  });
  if (!response || typeof response.id !== "string" || !/^dpl_[A-Za-z0-9]+$/.test(response.id)) {
    throw new Error("Vercel did not confirm a deployment. The imported variables remain saved.");
  }
  return response.id;
}

export async function waitForProduction(api, deploymentId, orgId, { timeoutMs = 10 * 60_000, intervalMs = 5_000, sleep = delay, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const deployment = await api(withTeam(`/v13/deployments/${encodeURIComponent(deploymentId)}`, orgId));
    const state = deployment?.readyState ?? deployment?.state;
    if (state === "ERROR" || state === "CANCELED" || state === "BLOCKED") {
      throw new Error(`The new Vercel deployment ended in ${state}. The imported variables remain saved.`);
    }
    if (deployment?.aliasError) throw new Error("The deployment could not be assigned to its production domain.");
    if (state === "READY" && (deployment.aliasAssigned || deployment.readySubstate === "PROMOTED")) {
      return deployment;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Vercel deployment ${deploymentId} did not become ready and promoted in time. Check its status in Vercel.`);
}

export async function verifyPublicStatus(deployment, values, fetchImpl = fetch) {
  const hostname = deployment?.url;
  if (typeof hostname !== "string" || !/^[a-z0-9.-]+\.vercel\.app$/i.test(hostname)) return "unavailable";
  try {
    const response = await fetchImpl(`https://${hostname}/api/auth/status`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return "unavailable"; // e.g. Vercel deployment protection
    const status = await response.json();
    if (!status?.ok || !status?.initialized || !status?.envConfigured) return "unconfigured";
    if (!values[AUTH_PASSWORD]) return "configured"; // A password hash cannot be used to sign in.

    const login = await fetchImpl(`https://${hostname}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: values[AUTH_USER], password: values[AUTH_PASSWORD] }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const data = await login.json().catch(() => null);
    if (login.ok && data?.ok) return "verified";
    if (login.status === 401 && data?.error === "Invalid username or password.") return "mismatch";
    return "configured"; // Protected, rate-limited, or otherwise not verifiable.
  } catch {
    return "unavailable";
  }
}

function printHelp() {
  console.log(`Usage: npm run deploy:vercel -- [--env-file PATH | --new] [--import-only]\n\n` +
    `Imports the Sushi admin entries from .env into an existing linked Vercel project.\n` +
    `--env-file PATH  Read an existing private .env file (default: ${DEFAULT_ENV_FILE}).\n` +
    `--new            Fresh installs only: create ${NEW_ENV_FILE} with random credentials.\n` +
    `--import-only    Import without starting a new Git-based production deployment.\n\n` +
    `Existing credentials are never overwritten. Keep your original signing secret\n` +
    `and encrypted vault backup when migrating. The Vercel CLI must be authenticated;\n` +
    `the linked project must use the same GitHub repository as this checkout's origin.`);
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), environment = process.env, api: injectedApi } = {}) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      "env-file": { type: "string" },
      "new": { type: "boolean", default: false },
      "import-only": { type: "boolean", default: false },
      "help": { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (options.help) { printHelp(); return; }
  if (options.new && options["env-file"]) throw new Error("Use either --new or --env-file, not both.");
  if (environment.VERCEL === "1") throw new Error("Run the .env importer locally or in an authenticated CI job, not inside a Vercel build.");

  const { projectId, orgId } = await resolveProject(cwd, environment);
  const api = injectedApi ?? ((endpoint, request) => callVercelApi(endpoint, { orgId, cwd, ...request }));
  const project = await api(withTeam(`/v9/projects/${encodeURIComponent(projectId)}`, orgId));
  validateGitProject(project, projectId, orgId);
  verifyProjectRepository(project, cwd);
  if (!options["import-only"]) getGitSource(project); // Check before changing any variables.
  const records = await readAuthRecords(api, projectId, orgId);

  let text;
  let envFile;
  if (options.new) {
    if (records.size) {
      const onlyUsername = records.size === 1 && records.get(AUTH_USER);
      if (!onlyUsername) throw new Error("This project already has production admin settings. A new file was not generated; existing credentials were not changed.");
      // A previous, username-only setup can be safely completed if it matches
      // the username we generate. Verify before creating a private file.
      await verifyExistingUsername(api, onlyUsername, "admin", projectId, orgId);
    }
    envFile = path.join(cwd, NEW_ENV_FILE);
    text = await createPrivateEnvFile(envFile);
    console.log(`Created private credentials in ${envFile}. Save this file securely; it is not printed here.`);
  } else {
    envFile = path.resolve(cwd, options["env-file"] || DEFAULT_ENV_FILE);
    try {
      const stat = await fs.stat(envFile);
      if (!stat.isFile() || stat.size > MAX_ENV_FILE_BYTES) throw new Error("invalid size or type");
      text = await fs.readFile(envFile, "utf8");
    } catch {
      throw new Error(`Could not read a private .env file at ${envFile}. Provide --env-file PATH, or use --new only for a fresh install.`);
    }
  }
  await assertPrivateEnvFile(envFile, cwd);
  const values = parseAuthEnv(text);
  const result = await importAuthEnv(api, projectId, orgId, values, records);
  if (result.existing) {
    console.log("Existing Vercel admin credentials were left unchanged; their secret values cannot be compared with this file.");
    if (!result.hasExplicitSecret) console.log("No signing secret was added, so the existing derived vault key is preserved.");
  } else {
    console.log(`Imported ${result.imported.join(", ")} into Vercel production. Values were not printed.`);
    if (!result.hasExplicitSecret) console.log("No separate signing secret was supplied; changing the credentials later will change the derived vault key.");
  }
  if (options["import-only"]) {
    console.log(result.existing
      ? "No credentials were imported or changed."
      : "Import complete. A new deployment is required for the changes to take effect.");
    return;
  }

  const deploymentId = await startProductionDeployment(api, project, projectId, orgId);
  console.log(`Production deployment ${deploymentId} started from the linked Git branch.`);
  const deployment = await waitForProduction(api, deploymentId, orgId);
  const status = await verifyPublicStatus(deployment, values);
  if (status === "unconfigured") throw new Error("The deployment is ready but its auth status is still unconfigured. Check the deployment settings.");
  if (status === "mismatch") throw new Error("The deployment is ready, but the .env username or password does not match the existing Vercel credentials. No credentials were overwritten.");
  const safeUrl = typeof deployment.url === "string" && /^[a-z0-9.-]+\.vercel\.app$/i.test(deployment.url)
    ? `https://${deployment.url}` : deploymentId;
  console.log(`Production deployment ready: ${safeUrl}`);
  if (status === "verified") console.log("Admin sign-in and the .env credentials were verified.");
  else if (status === "configured") console.log("Admin sign-in is configured, but the .env password could not be verified.");
  else console.log("Could not verify the public auth endpoint (it may be protected); check the deployed app.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Vercel import: ${error instanceof Error ? error.message : "Unexpected error."}`);
    process.exitCode = 1;
  });
}
