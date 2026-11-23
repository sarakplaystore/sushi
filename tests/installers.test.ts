import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

console.log("==> Testing the one-click installers (Docker image, Python, shell)...");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---- Python installer ------------------------------------------------------------
assert.ok(existsSync("install.py"), "install.py exists at the repo root");
const py = read("install.py");

// It must be dependency-free and importable/compilable by any Python 3.9+.
assert.deepEqual(
  run("python3", ["-c", "import ast,sys; ast.parse(open('install.py').read()); print('ok')"]).trim(),
  "ok",
  "install.py parses cleanly"
);
const stdlibOnly = [
  "argparse", "json", "os", "platform", "shutil", "subprocess", "sys",
  "tarfile", "tempfile", "time", "urllib.error", "urllib.request",
];
for (const mod of stdlibOnly) {
  assert.match(py, new RegExp(`^import ${mod.replace(".", "\\.")}$`, "m"), `install.py imports stdlib ${mod}`);
}
assert.ok(!/^import (requests|yaml|click|rich)\b/m.test(py), "install.py needs no third-party packages");
assert.match(py, /MIN_NODE_MAJOR = 20/, "refuses Node older than 20");
assert.match(py, /HEALTH_PATH = "\/api\/system\/capabilities"/, "health-checks the real endpoint");
assert.match(py, /codeload\.github\.com\/\{REPO\}\/tar\.gz/, "falls back to a tarball when git is missing");
assert.match(py, /npm ci/, "uses npm ci");
assert.match(py, /"npm",\s*"run",\s*"build"/, "builds before starting");
assert.match(py, /start_new_session=True/, "background server survives the installer exiting");
assert.match(py, /sushi\.pid/, "writes a pid file");
assert.match(py, /--docker/, "supports the Docker path");
assert.match(py, /--foreground/, "can run in the foreground");
assert.match(py, /--no-start/, "can install+build without starting");
assert.match(py, /Web UI port/, "prompts for the web UI port when --port/PORT are omitted");
assert.match(py, /dev\/tty/, "reads the controlling terminal when piped or run over SSH");
assert.match(py, /isatty/, "detects when stdin is a terminal");
assert.match(py, /No interactive terminal/, "prints a note and uses the default when no terminal exists");
assert.match(py, /--prebuilt/, "supports the prebuilt image path");
assert.match(py, /--node/, "forces the Node.js install");
assert.match(py, /Install method/, "prompts for the install method");
assert.match(py, /prebuilt/, "recommends the fastest prebuilt image when Docker works");
assert.match(py, /Start Sushi|installer/i, "has a user-facing banner");
assert.match(py, /DISCLAIMER\.md/, "points at the disclaimer");
// Helps, rather than failing silently, when Node is missing.
assert.match(py, /Node\.js is not installed/, "explains a missing Node.js");
assert.match(py, /NODE_HINT/, "gives platform-specific install hints");

// --help must work with no side effects.
const help = run("python3", ["install.py", "--help"]);
for (const flag of ["--dir", "--port", "--host", "--branch", "--docker", "--foreground", "--no-start", "--timeout"]) {
  assert.ok(help.includes(flag), `--help documents ${flag}`);
}
assert.ok(help.includes("prompted interactively"), "--help explains the interactive port prompt");
assert.ok(help.includes("--prebuilt"), "--help documents --prebuilt");
assert.ok(help.includes("--node"), "--help documents --node");
assert.equal(run("python3", ["install.py", "--version"]).trim(), "Sushi installer 1.0.0");

// ---- shell installer ------------------------------------------------------------
const sh = read("scripts/install-vps.sh");
assert.deepEqual(run("bash", ["-n", "scripts/install-vps.sh"]), "", "install-vps.sh is valid bash (bash -n)");
assert.ok(sh.startsWith("#!/usr/bin/env bash"), "bash shebang");
assert.match(sh, /^set -euo pipefail$/m, "strict mode");
assert.match(sh, /get\.docker\.com/, "installs Docker when missing");
assert.match(sh, /SUSHI_AUTH_SECRET=\$\(openssl rand -hex 32/, "generates a random auth secret");
assert.match(sh, /run_compose up -d --build/, "builds and starts the stack");
assert.match(sh, /docker-compose\.prebuilt\.yml/, "supports the prebuilt image path");
assert.match(sh, /systemctl enable sushi\.service/, "installs a systemd unit so it survives reboot");
assert.match(sh, /reverse_proxy 127\.0\.0\.1/, "can put Caddy HTTPS in front");
assert.match(sh, /api\/system\/capabilities/, "health-checks after starting");
assert.match(sh, /if \[ ! -f \.env \]/, "never deletes an existing .env");
assert.match(sh, /apt-get|dnf|apk/, "handles multiple distros");
assert.match(sh, /--port|--https|--prebuilt|--node/, "documents its flags");
assert.match(sh, /--build/, "supports the build-from-source path");
assert.match(sh, /Install method/, "prompts for the install method");
assert.match(sh, /prebuilt/, "recommends the prebuilt image when Docker works");
const shHelp = run("bash", ["scripts/install-vps.sh", "--help"]);
assert.ok(shHelp.includes("--prebuilt") && shHelp.includes("--https"), "--help shows real options");
assert.ok(shHelp.includes("--build") && shHelp.includes("--node"), "shell --help documents the methods");
assert.ok(!/set -euo pipefail/.test(shHelp), "--help does not leak the script body");

// ---- prebuilt compose + image publishing ---------------------------------------
const compose = parseYaml(read("docker-compose.prebuilt.yml")) as {
  services: Record<string, { image?: string; volumes?: string[]; healthcheck?: { test: string[] } }>;
  volumes: Record<string, unknown>;
};
assert.equal(
  compose.services.sushi.image,
  "${SUSHI_IMAGE:-ghcr.io/sarakplaystore/sushi:latest}",
  "pulls the published image by default"
);
assert.deepEqual(compose.services.sushi.volumes, ["sushi-data:/app/data"], "keeps data in a named volume");
assert.equal(compose.services.guacd.image, "guacamole/guacd:1.5.5", "bundles guacd for live RDP");
assert.ok("sushi-data" in compose.volumes, "declares the volume");
assert.ok(compose.services.sushi.healthcheck?.test.join(" ").includes("/api/system/capabilities"), "compose healthcheck");

const workflow = parseYaml(read(".github/workflows/docker-publish.yml")) as {
  on: Record<string, unknown>;
  jobs: Record<string, { permissions?: Record<string, string>; steps: { uses?: string; with?: Record<string, string> }[] }>;
};
assert.ok(workflow.on.push, "publishes on push");
assert.ok("workflow_dispatch" in workflow.on, "can be run manually");
const job = workflow.jobs["build-and-push"];
assert.equal(job.permissions?.packages, "write", "has permission to push to GHCR");
const buildStep = job.steps.find((s) => s.uses?.includes("docker/build-push-action"));
assert.ok(buildStep, "uses build-push-action");
assert.equal(buildStep?.with?.platforms, "linux/amd64,linux/arm64", "multi-arch image");
assert.equal(String(buildStep?.with?.push), "true", "pushes the image");

// The Dockerfile must stay buildable and non-root — the published image depends on it.
const dockerfile = read("Dockerfile");
assert.match(dockerfile, /^FROM node:22-alpine AS deps/m, "Node 22 base");
assert.match(dockerfile, /USER sushi/, "runs as a non-root user");
assert.match(dockerfile, /COPY --from=builder[^\n]*\/app\/public \.\/public/, "ships public assets");
assert.match(dockerfile, /HEALTHCHECK[\s\S]*api\/system\/capabilities/, "image healthcheck");
assert.match(dockerfile, /ENV DATA_DIR=\/app\/data/, "data dir is fixed for the volume mount");

// ---- README install matrix -----------------------------------------------------
const readme = read("README.md");
for (const command of [
  "scripts/install-vps.sh",
  "docker-compose.prebuilt.yml",
  "ghcr.io/sarakplaystore/sushi:latest",
  "python3 install.py",
  "vercel.com/new/clone",
]) {
  assert.ok(readme.includes(command), `README documents: ${command}`);
}
assert.match(readme, /###\s*0\.\s*One-click deploys/, "README leads Quick Start with one-click options");

console.log("One-click installer tests passed.");
