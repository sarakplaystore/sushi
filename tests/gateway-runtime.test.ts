import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Server as SshServer } from "ssh2";
import WebSocket from "ws";
import { DEFAULT_GATEWAY_ALLOWED_ORIGIN } from "../src/lib/gateway-defaults.mjs";
import { getCorsHeaders } from "../src/lib/server/security";
import { createGatewayWebSockets } from "../src/lib/server/ws-gateway";

console.log("==> Gateway runtime: provisioned token, HTTP CORS, WebSocket origins and a real PTY");

const root = resolve(".");
const temp = mkdtempSync(join(tmpdir(), "sushi-gateway-runtime-"));
const helper = resolve("scripts/provision-gateway.mjs");

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

type RunningGateway = { port: number; child: ChildProcess; logs: () => string; stop: () => Promise<void> };
async function startGateway(overrides: Record<string, string | undefined>, envFile?: string): Promise<RunningGateway> {
  const port = await freePort();
  const env = { ...process.env };
  for (const key of ["ALLOWED_ORIGIN", "SUSHI_GATEWAY_TOKEN", "SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48", "SUSHI_AUTH_USERNAME", "SUSHI_AUTH_PASSWORD", "VERCEL"]) delete env[key];
  Object.assign(env, {
    NODE_ENV: "production", GATEWAY_ONLY: "true", HOST: "127.0.0.1", PORT: String(port),
    GUACD_HOST: "127.0.0.1", GUACD_PORT: "1", BLOCK_PRIVATE_NETWORKS: "false", ...overrides,
  });
  // This is the documented Node-only startup path. `node --run` does not pass
  // --env-file values to its subprocess on some Node versions.
  const args = [...(envFile ? [`--env-file=${envFile}`] : []), "--import", "tsx", "server.ts"];
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (data) => { output += data.toString(); });
  child.stderr!.on("data", (data) => { output += data.toString(); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway startup timed out: ${output}`)), 15000);
      const onExit = (code: number | null) => { clearTimeout(timer); reject(new Error(`gateway exited (${code}): ${output}`)); };
      child.once("exit", onExit);
      child.stdout!.on("data", () => {
        if (output.includes("gateway listening")) {
          clearTimeout(timer);
          child.removeListener("exit", onExit);
          resolve();
        }
      });
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return {
    port, child, logs: () => output,
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    }),
  };
}

function expectTemplateGuardToReject(token?: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", GATEWAY_ONLY: "true", HOST: "127.0.0.1", PORT: "0",
    SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48: "true" };
  delete env.SUSHI_GATEWAY_TOKEN;
  if (token !== undefined) env.SUSHI_GATEWAY_TOKEN = token;
  const result = spawnSync(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: root, env, encoding: "utf8", timeout: 8000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 1, "the template guard must fail startup, not wait or listen");
  assert.match(output, /SUSHI_GATEWAY_TOKEN must be a generated 48-character lowercase hex value/);
  assert.doesNotMatch(output, /gateway listening/);
  if (token) assert(!output.includes(token), "a rejected token or template expression is never logged");
}

async function upgradeStatus(port: number, pathname: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, origin === undefined ? {} : { origin });
    let settled = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("WebSocket upgrade timed out")); }, 5000);
    const finish = (status: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve(status); } };
    ws.on("open", () => { finish(101); ws.terminate(); });
    ws.on("unexpected-response", (_request, response) => { response.resume(); finish(response.statusCode || 0); });
    ws.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

async function sshAuth(port: number, origin: string, token: string, credentials?: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ssh`, { origin });
    let settled = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("SSH auth timed out")); }, 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", gatewayToken: token, credentials })));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "error" || message.type === "ready") {
        if (!settled) { settled = true; clearTimeout(timer); ws.close(); resolve(message); }
      }
    });
    ws.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

async function rdpAuthCloseReason(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rdp?token=${encodeURIComponent(token)}`,
      "guacamole", { origin: DEFAULT_GATEWAY_ALLOWED_ORIGIN });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("RDP auth timed out")); }, 5000);
    ws.on("close", (_code, reason) => { clearTimeout(timer); resolve(reason.toString()); });
    ws.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function realPty(port: number, token: string, sshPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ssh`, { origin: "https://other-ui.example" });
    let ready = false;
    let output = "";
    let settled = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("PTY output timed out")); }, 15000);
    ws.on("open", () => ws.send(JSON.stringify({
      type: "auth", gatewayToken: token,
      credentials: { host: "127.0.0.1", port: sshPort, username: "tester", authMethod: "password", password: "test-password" },
    })));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; message?: string; data?: string };
      if (message.type === "error" && !settled) {
        settled = true; clearTimeout(timer); ws.terminate(); reject(new Error(message.message));
      }
      if (message.type === "ready") ready = true;
      if (message.type === "data" && message.data) output += Buffer.from(message.data, "base64").toString();
      if (!settled && ready && output.includes("PROVISIONED_GATEWAY_PTY_OK")) {
        settled = true; clearTimeout(timer); ws.close(); resolve();
      }
    });
    ws.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

async function main() {
  const setup = spawnSync(process.execPath, [helper, "local", "--origin", "https://other-ui.example"], {
    cwd: temp, encoding: "utf8",
  });
  assert.equal(setup.status, 0, setup.stderr);
  const envFile = join(temp, ".env.gateway.local");
  const token = parseEnv(readFileSync(envFile, "utf8")).SUSHI_GATEWAY_TOKEN;
  assert.ok(token);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert(!`${setup.stdout}${setup.stderr}`.includes(token));

  // Template mode is opt-in: never accept the public expression as a password,
  // nor listen at all if Railway has not supplied the expected token format.
  for (const invalid of [undefined, "", '${{secret(48, "abcdef0123456789")}}',
    "f".repeat(47), "f".repeat(49), "g".repeat(48), "A".repeat(48)]) {
    expectTemplateGuardToReject(invalid);
  }

  // No ALLOWED_ORIGIN at all: the actual gateway process supplies the default.
  // The local helper's random hex token stands in for a platform-generated one;
  // this tests the gateway, not Railway's generation behavior.
  let gateway = await startGateway({ SUSHI_GATEWAY_TOKEN: token, SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48: "true" });
  try {
    const allowed = await fetch(`http://127.0.0.1:${gateway.port}/api/system/capabilities`, {
      headers: { Origin: DEFAULT_GATEWAY_ALLOWED_ORIGIN },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), DEFAULT_GATEWAY_ALLOWED_ORIGIN);
    assert.equal((await allowed.json()).requiresGatewayToken, true);
    const other = await fetch(`http://127.0.0.1:${gateway.port}/health`, { headers: { Origin: "https://untrusted.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), DEFAULT_GATEWAY_ALLOWED_ORIGIN,
      "a browser from the other origin cannot read this response");
    for (const path of ["/ws/ssh", "/ws/rdp", "/ws/rdp-cleanpath"]) {
      assert.equal(await upgradeStatus(gateway.port, path, "https://untrusted.example"), 403, `${path} rejects a foreign browser origin`);
      assert.equal(await upgradeStatus(gateway.port, path, DEFAULT_GATEWAY_ALLOWED_ORIGIN), 101, `${path} permits the configured origin`);
      assert.equal(await upgradeStatus(gateway.port, path), 101, `${path} permits non-browser clients without Origin`);
    }
    const wrong = await sshAuth(gateway.port, DEFAULT_GATEWAY_ALLOWED_ORIGIN, "wrong-token");
    assert.match(String(wrong.message), /Gateway token rejected/);
    const correct = await sshAuth(gateway.port, DEFAULT_GATEWAY_ALLOWED_ORIGIN, token);
    assert.match(String(correct.message), /Missing SSH host or username/, "the correct token passes gateway authentication");
    assert(!gateway.logs().includes(token));
  } finally {
    await gateway.stop();
  }

  // A restart with the same environment must keep accepting the same token.
  // A different new deployment must not accept the first deployment's token.
  gateway = await startGateway({ SUSHI_GATEWAY_TOKEN: token, SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48: "true" });
  try {
    const correct = await sshAuth(gateway.port, DEFAULT_GATEWAY_ALLOWED_ORIGIN, token);
    assert.match(String(correct.message), /Missing SSH host or username/);
    assert(!gateway.logs().includes(token));
  } finally {
    await gateway.stop();
  }
  const otherToken = randomBytes(24).toString("hex");
  assert.notEqual(otherToken, token);
  gateway = await startGateway({ SUSHI_GATEWAY_TOKEN: otherToken, SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48: "true" });
  try {
    assert.match(String((await sshAuth(gateway.port, DEFAULT_GATEWAY_ALLOWED_ORIGIN, token)).message), /Gateway token rejected/);
    assert.match(String((await sshAuth(gateway.port, DEFAULT_GATEWAY_ALLOWED_ORIGIN, otherToken)).message), /Missing SSH host or username/);
    assert(!gateway.logs().includes(otherToken));
  } finally {
    await gateway.stop();
  }

  // Existing gateways do not opt into the template-only guard. Render's
  // generated base64 values, including +, / and =, remain supported by both
  // the SSH first message and URL-encoded RDP WebSocket authentication.
  const renderStyleToken = "test+base64/token==";
  gateway = await startGateway({ SUSHI_GATEWAY_TOKEN: renderStyleToken });
  try {
    const correct = await sshAuth(gateway.port, DEFAULT_GATEWAY_ALLOWED_ORIGIN, renderStyleToken);
    assert.match(String(correct.message), /Missing SSH host or username/);
    assert.equal(await rdpAuthCloseReason(gateway.port, "wrong"), "769", "wrong RDP token is rejected");
    assert.equal(await rdpAuthCloseReason(gateway.port, renderStyleToken), "512",
      "base64 token passed authentication; only the intentionally missing RDP payload is rejected");
  } finally {
    await gateway.stop();
  }

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const ssh = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "tester" && ctx.password === "test-password") ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("PROVISIONED_GATEWAY_PTY_OK\r\n");
      });
    }));
  });
  await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  const sshPort = (ssh.address() as net.AddressInfo).port;
  let fileGateway: RunningGateway | undefined;
  try {
    fileGateway = await startGateway({ SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48: "true" }, envFile);
    assert.equal(await upgradeStatus(fileGateway.port, "/ws/ssh", DEFAULT_GATEWAY_ALLOWED_ORIGIN), 403,
      "the persisted origin overrides the default");
    assert.equal(await upgradeStatus(fileGateway.port, "/ws/ssh", "https://other-ui.example"), 101);
    await realPty(fileGateway.port, token, sshPort);
    assert(!fileGateway.logs().includes(token), "gateway startup and requests do not log the generated token");
  } finally {
    if (fileGateway) await fileGateway.stop();
    await new Promise<void>((resolve) => ssh.close(() => resolve()));
  }

  // Explicit permissive overrides are retained for existing deployments.
  for (const permissive of ["*", ""]) {
    gateway = await startGateway({ SUSHI_GATEWAY_TOKEN: token, ALLOWED_ORIGIN: permissive });
    try {
      assert.equal(await upgradeStatus(gateway.port, "/ws/ssh", "https://any.example"), 101);
      const response = await fetch(`http://127.0.0.1:${gateway.port}/health`, { headers: { Origin: "https://any.example" } });
      assert.equal(response.headers.get("access-control-allow-origin"), "https://any.example");
    } finally {
      await gateway.stop();
    }
  }

  // The companion restriction must not alter a full self-hosted Sushi server.
  const previousGatewayMode = process.env.GATEWAY_ONLY;
  const previousOrigin = process.env.ALLOWED_ORIGIN;
  process.env.GATEWAY_ONLY = "false";
  delete process.env.ALLOWED_ORIGIN;
  assert.equal(getCorsHeaders("https://full-app.example")["Access-Control-Allow-Origin"], "https://full-app.example");
  process.env.ALLOWED_ORIGIN = "https://an-explicit-origin.example";
  const fullDispatcher = createGatewayWebSockets();
  const fullServer = http.createServer((_req, res) => res.end("ok"));
  fullServer.on("upgrade", (req, socket, head) => fullDispatcher.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => fullServer.listen(0, "127.0.0.1", resolve));
  try {
    const fullPort = (fullServer.address() as net.AddressInfo).port;
    assert.equal(await upgradeStatus(fullPort, "/ws/ssh", "https://full-app.example"), 101,
      "full self-hosted WebSockets keep their existing behavior");
  } finally {
    await new Promise<void>((resolve) => fullServer.close(() => resolve()));
    if (previousGatewayMode === undefined) delete process.env.GATEWAY_ONLY;
    else process.env.GATEWAY_ONLY = previousGatewayMode;
    if (previousOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = previousOrigin;
  }
  console.log("Gateway runtime tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  rmSync(temp, { recursive: true, force: true });
});
