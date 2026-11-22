import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { Server as SshServer } from "ssh2";
import { WebSocket } from "ws";
import { NextRequest } from "next/server";
import { createSessionToken, getEffectiveAuthConfig } from "../src/lib/server/auth";
import { issueShareTicket, shareTicketPublicKey, verifyShareTicket } from "../src/lib/server/share-ticket";
import { SharedSshSession } from "../src/lib/server/shared-ssh";
import { GET as getTicketKey, POST as issueTicket } from "../src/app/api/ssh/share/ticket/route";
import { buildShareJoinUrl, gatewayFromShareSearch, shareManagementHeaders } from "../src/lib/client/shared-ssh";
import { normalizeShareGateway } from "../src/lib/share-gateway";

console.log("==> Vercel frontend + separate gateway: real SSH PTY, sharing, management and scoped account tickets");

const FRONTEND = "https://sushi.example.test";
const TOKEN = "test-gateway-key-not-a-real-secret-0123456789";
const SSH_PASSWORD = "test-ssh-password-not-a-real-secret";
const clients = new Set<SocketClient>();

type Frame = Record<string, any>;
class SocketClient {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  private listeners: Array<(message: Frame) => void> = [];
  constructor(url: string) {
    this.ws = new WebSocket(url, { origin: FRONTEND });
    this.ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      this.frames.push(frame);
      for (const listener of [...this.listeners]) listener(frame);
    });
  }
  static async open(url: string) {
    const client = new SocketClient(url);
    clients.add(client);
    await new Promise<void>((resolve, reject) => { client.ws.once("open", resolve); client.ws.once("error", reject); });
    return client;
  }
  send(frame: Frame) { this.ws.send(JSON.stringify(frame)); }
  wait(predicate: (frame: Frame) => boolean, label: string, from = 0): Promise<Frame> {
    const found = this.frames.slice(from).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((item) => item !== listener);
        reject(new Error(`Timed out: ${label} (${this.frames.map((frame) => frame.type).join(", ")})`));
      }, 10000);
      const listener = (message: Frame) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((item) => item !== listener);
        resolve(message);
      };
      this.listeners.push(listener);
    });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.ws.terminate(); resolve(); }, 2000);
      this.ws.once("close", () => { clearTimeout(timer); resolve(); });
      this.ws.close();
    });
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startGateway(): Promise<{ port: number; child: ChildProcess; logs: () => string }> {
  const port = await freePort();
  // A wholly synthetic gateway environment; do not inspect real provider secrets.
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
      GATEWAY_ONLY: "true", HOST: "127.0.0.1", PORT: String(port),
      SUSHI_GATEWAY_TOKEN: TOKEN, ALLOWED_ORIGIN: FRONTEND,
      GUACD_HOST: "127.0.0.1", GUACD_PORT: "1", SUSHI_SSH_POOL: "off",
      SUSHI_SHARE_SCROLLBACK_BYTES: "8192",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr!.on("data", (chunk) => { output += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway did not start: ${output}`)), 15000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${output}`)); });
    child.stdout!.on("data", () => { if (output.includes("gateway listening")) { clearTimeout(timer); resolve(); } });
  });
  return { port, child, logs: () => output };
}

async function startSsh() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const state = { shells: 0, sizes: [] as Array<{ cols: number; rows: number }> };
  const server = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "tester" && ctx.password === SSH_PASSWORD) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty, _reject, size) => {
        state.sizes.push({ cols: size.cols, rows: size.rows });
        acceptPty?.();
      });
      session.on("window-change", (acceptResize, _reject, size) => {
        state.sizes.push({ cols: size.cols, rows: size.rows });
        acceptResize?.();
      });
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        state.shells += 1;
        stream.write("BEFORE_SHARING_SCREEN\r\n");
        stream.on("data", (data: Buffer) => stream.write(`ECHO:${data.toString()}\r\n`));
      });
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        if (info.command.includes("SUSHI_BG_STOPPED")) stream.write("SUSHI_BG_STOPPED count=1 fifos=2 names=old-job\n");
        else if (info.command.includes("SUSHI_RUN_ALIVE")) stream.write("SUSHI_RUN_ALIVE\nSUSHI_LOG_BYTES=5\nSUSHI_LOG_START\nhello\nSUSHI_LOG_END\n");
        else stream.write("HOST=pty-fixture\nPRETTY=Fixture Linux\nDISTRO=Fixture\nVERSION=1\n");
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, state, port: (server.address() as net.AddressInfo).port };
}

function frontendRequest(method: string, path: string, session?: string, body?: object, origin = FRONTEND) {
  return new NextRequest(`${FRONTEND}${path}`, {
    method,
    headers: {
      host: "sushi.example.test", origin, "x-forwarded-proto": "https", "content-type": "application/json",
      ...(session ? { "x-sushi-session": session } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const isData = (needle: string) => (frame: Frame) => frame.type === "data" &&
  Buffer.from(String(frame.data), "base64").toString().includes(needle);

async function main() {
  // Emulate Vercel's account signer separately from the actual gateway process.
  Object.assign(process.env, {
    VERCEL: "1", SUSHI_AUTH_USERNAME: "test-admin", SUSHI_AUTH_PASSWORD: "local-only-password",
    SUSHI_AUTH_SECRET: "local-only-test-signing-secret-for-share-tickets", SUSHI_STORAGE_BACKEND: "auto",
  });
  delete process.env.SUSHI_GATEWAY_TOKEN;

  // Even a single oversized SSH chunk must not exceed the configured replay cap.
  process.env.SUSHI_SHARE_SCROLLBACK_BYTES = "8192";
  const bounded = new SharedSshSession({
    host: "fixture", port: 22, username: "tester", ssh: {} as any, stream: {} as any,
    cols: 80, rows: 24, write: true,
  });
  bounded.handleOutput(Buffer.concat([Buffer.alloc(10000, 65), Buffer.from("TAIL")]));
  assert.equal(bounded.scrollbackBytes, 8192);
  assert.equal(bounded.replay().length, 8192);
  assert(bounded.replay().toString().endsWith("TAIL"));
  bounded.handleOutput(Buffer.from("NEXT"));
  assert(bounded.replay().length <= 8192);
  assert(bounded.replay().toString().endsWith("NEXT"));
  delete process.env.SUSHI_SHARE_SCROLLBACK_BYTES;

  const config = await getEffectiveAuthConfig();
  const session = createSessionToken(config.username, config.authSecret, config.sessionVersion);
  assert.equal((await getTicketKey(frontendRequest("GET", "/api/ssh/share/ticket"))).status, 401);
  assert.equal((await getTicketKey(frontendRequest("GET", "/api/ssh/share/ticket", TOKEN))).status, 401,
    "gateway key is not a frontend account");
  assert.equal((await getTicketKey(frontendRequest("GET", "/api/ssh/share/ticket", session, undefined, "https://evil.test"))).status, 401);
  const keyRes = await getTicketKey(frontendRequest("GET", "/api/ssh/share/ticket", session));
  assert.equal(keyRes.status, 200);
  const { publicKey } = await keyRes.json();
  assert.equal(publicKey, shareTicketPublicKey(config.authSecret));
  assert.equal(keyRes.headers.get("cache-control"), "private, no-store");

  const ssh = await startSsh();
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    gateway = await startGateway();
    const base = `http://127.0.0.1:${gateway.port}`;
    const wsUrl = `ws://127.0.0.1:${gateway.port}/ws/ssh`;
    const creds = { host: "127.0.0.1", port: ssh.port, username: "tester", authMethod: "password", password: SSH_PASSWORD };
    const authHeaders = { Origin: FRONTEND, "X-Sushi-Token": TOKEN };
    const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);

    const caps = await (await request("/api/system/capabilities")).json();
    assert.equal(caps.websocketSsh, true);
    assert.equal(caps.sharedSsh, true);
    assert.equal(caps.shareAccountTickets, true);
    assert.equal(caps.rdpCleanPath, true);
    assert.equal(caps.rdpProbe, true);
    const probeWithoutKey = await request("/api/rdp/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(probeWithoutKey.status, 401);
    const probeMissingHost = await request("/api/rdp/probe", { method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(probeMissingHost.status, 400, "the gateway routes authenticated RDP probes to the real handler");
    assert.equal((await request("/api/ssh/share")).status, 401);
    assert.equal((await request("/api/ssh/share", { headers: { "X-Sushi-Session": session } })).status, 401,
      "frontend session must not administer a separate gateway");
    assert.equal((await request("/api/vault", { headers: authHeaders })).status, 404, "gateway never serves vault APIs");
    const preflight = await request("/api/ssh/share", { method: "OPTIONS", headers: { Origin: FRONTEND } });
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /PATCH/);
    assert.equal(preflight.headers.get("access-control-allow-origin"), FRONTEND);
    const headers = { ...authHeaders, "Content-Type": "application/json" };
    for (const [path, payload, assertBody] of [
      ["/api/ssh/test", { credentials: creds }, (body: any) => assert.equal(body.ok, true)],
      ["/api/ssh/sysinfo", { credentials: creds }, (body: any) => assert.equal(body.info.hostname, "pty-fixture")],
      ["/api/ssh/exec/run", { credentials: creds, keyChannel: "/tmp/.sushi-keys-0123456789abcdef", runLog: "/tmp/.sushi-run-0123456789abcdef.log" }, (body: any) => { assert.equal(body.running, true); assert.equal(body.output, "hello"); }],
      ["/api/ssh/exec/stop", { credentials: creds }, (body: any) => { assert.equal(body.stoppedCount, 1); assert.equal(body.cleanedChannels, 2); }],
    ] as Array<[string, object, (body: any) => void]>) {
      const unauthorized = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      assert.equal(unauthorized.status, 401, `${path} requires the gateway key`);
      const response = await request(path, { method: "POST", headers, body: JSON.stringify(payload) });
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      assertBody(await response.json());
    }

    // The host opens a real PTY first, then clicks Share. A new guest must be
    // replayed the screen emitted before the share was created.
    const owner = await SocketClient.open(wsUrl);
    owner.send({ type: "auth", gatewayToken: TOKEN, cols: 110, rows: 30, credentials: creds });
    await owner.wait((m) => m.type === "ready", "owner ready");
    await owner.wait(isData("BEFORE_SHARING_SCREEN"), "pre-share banner");
    owner.send({ type: "input", data: "before-share\r" });
    await owner.wait(isData("before-share"), "pre-share input echo");
    owner.send({ type: "share", action: "start", write: true, passcode: "auto", accountIssuer: { publicKey, audience: base } });
    const started = await owner.wait((m) => m.type === "share" && m.action === "started", "share created");
    const id = started.share.shareId as string;
    const passcode = started.passcode as string;
    assert.match(passcode, /^\d{6}$/);
    assert.equal(started.share.accountTickets, true);
    assert.equal(ssh.state.shells, 1);

    const link = buildShareJoinUrl(id, base);
    assert.equal(gatewayFromShareSearch(new URL(link, FRONTEND).search), base);
    assert(!link.includes(TOKEN) && !link.includes(session) && !link.includes(passcode));
    assert.equal(normalizeShareGateway("wss://gateway.example.test/"), "https://gateway.example.test");
    for (const dangerous of ["https://user:password@gateway.test", "https://gateway.test/?token=key", "https://gateway.test/#key", "javascript://gateway.test"]) {
      assert.throws(() => normalizeShareGateway(dangerous), `reject ${dangerous}`);
    }
    assert.throws(() => gatewayFromShareSearch("?gateway=&gateway=https%3A%2F%2Fevil.test"));
    const remoteHeaders = shareManagementHeaders({ gatewayUrl: base, gatewayToken: TOKEN });
    assert.equal(remoteHeaders["X-Sushi-Token"], TOKEN);
    assert.equal(remoteHeaders["X-Sushi-Session"], undefined);
    assert.equal(remoteHeaders["X-Sushi-Admin-Cert"], undefined);

    const listRes = await request("/api/ssh/share", { headers: authHeaders });
    assert.equal(listRes.headers.get("cache-control"), "private, no-store");
    assert.equal((await listRes.json()).shares[0].shareId, id);
    const bad = await SocketClient.open(wsUrl);
    bad.send({ type: "auth", share: { join: id, passcode: "000000", name: "Bad" } });
    assert.equal((await bad.wait((m) => m.type === "error", "bad code")).code, "BAD_PASSCODE");

    const guest = await SocketClient.open(wsUrl);
    guest.send({ type: "auth", cols: 80, rows: 24, share: { join: id, passcode, name: "Guest" } });
    const guestReady = await guest.wait((m) => m.type === "ready", "guest ready");
    assert.equal(guestReady.viaAccount, false);
    assert.match(Buffer.from(guestReady.replay, "base64").toString(), /BEFORE_SHARING_SCREEN/);
    assert.match(Buffer.from(guestReady.replay, "base64").toString(), /before-share/);
    guest.send({ type: "input", data: "guest-command\r" });
    await owner.wait(isData("guest-command"), "owner sees guest input");
    guest.send({ type: "resize", cols: 80, rows: 19 });
    const end = Date.now() + 5000;
    while (!ssh.state.sizes.some((size) => size.cols === 80 && size.rows === 19) && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(ssh.state.sizes.some((size) => size.cols === 80 && size.rows === 19), "row-only resize reaches the SSH PTY");

    const beforeAttack = guest.frames.length;
    guest.send({ type: "share", action: "rotate" });
    const deniedRotate = await guest.wait((m) => m.type === "share" && m.action === "error", "guest cannot rotate", beforeAttack);
    assert.match(deniedRotate.message, /Only the host/);
    const beforeStopAttack = guest.frames.length;
    guest.send({ type: "share", action: "stop" });
    await guest.wait((m) => m.type === "share" && m.action === "error", "guest cannot stop", beforeStopAttack);
    assert.equal((await (await request("/api/ssh/share", { headers: authHeaders })).json()).shares.length, 1);

    // Authenticated REST management operates on the gateway's live registry.
    const rotate = await request("/api/ssh/share", { method: "PATCH", headers, body: JSON.stringify({ id, passcode: "auto" }) });
    assert.equal(rotate.status, 200);
    const newCode = (await rotate.json()).passcode as string;
    assert.match(newCode, /^\d{6}$/);
    assert.notEqual(newCode, passcode);
    const ownerRotation = await owner.wait((m) => m.type === "share" && m.action === "rotated", "publisher learns API rotation");
    assert.equal(ownerRotation.passcode, newCode);
    assert(!guest.frames.some((m) => m.type === "share" && m.action === "rotated"), "new code is not sent to guests");
    const stale = await SocketClient.open(wsUrl);
    stale.send({ type: "auth", share: { join: id, passcode, name: "Stale" } });
    assert.equal((await stale.wait((m) => m.type === "error", "rotated code rejected")).code, "BAD_PASSCODE");
    const renewed = await SocketClient.open(wsUrl);
    renewed.send({ type: "auth", share: { join: id, passcode: newCode, name: "Renewed" } });
    await renewed.wait((m) => m.type === "ready", "rotated code accepted");
    await renewed.close();

    const accountOnly = await request("/api/ssh/share", { method: "PATCH", headers, body: JSON.stringify({ id, passcode: null }) });
    assert.equal(accountOnly.status, 200, "a share with a pinned verifier may become account-only");
    const codeAfterRemoval = await SocketClient.open(wsUrl);
    codeAfterRemoval.send({ type: "auth", share: { join: id, passcode: newCode, name: "No longer allowed" } });
    assert.equal((await codeAfterRemoval.wait((m) => m.type === "error", "removed code refused")).code, "PASSCODE_REQUIRED");

    // An admin account may join without learning the gateway key. The ticket is
    // issued by the Vercel-side account guard and pinned to this gateway/share.
    const ticketResponse = await issueTicket(frontendRequest("POST", "/api/ssh/share/ticket", session, { shareId: id, gateway: base }));
    assert.equal(ticketResponse.status, 200);
    const { ticket } = await ticketResponse.json();
    assert(!ticket.includes(TOKEN) && !ticket.includes(session));
    const issuer = { publicKey, audience: base };
    assert(verifyShareTicket(ticket, id, issuer));
    assert(!verifyShareTicket(ticket, "differentShareId", issuer));
    assert(!verifyShareTicket(issueShareTicket(config.authSecret, id, "https://evil.test"), id, issuer));
    assert(!verifyShareTicket(issueShareTicket(config.authSecret, id, base, Date.now() - 61000), id, issuer));
    assert(!verifyShareTicket(issueShareTicket("wrong-signing-secret", id, base), id, issuer));
    assert(!verifyShareTicket(`${ticket.slice(0, -1)}!`, id, issuer));
    const colleague = await SocketClient.open(wsUrl);
    colleague.send({ type: "auth", share: { join: id, name: "Colleague", ticket } });
    const colleagueReady = await colleague.wait((m) => m.type === "ready", "ticket joins without gateway key");
    assert.equal(colleagueReady.viaAccount, true);
    assert.equal(colleagueReady.share.participants.find((p: any) => p.name === "Colleague").role, "guest");
    assert.equal(ssh.state.shells, 1, "all browsers use one shell");

    // With the publisher detached, even a signed-in participant is not an owner;
    // stopping via the dashboard must close the actual shell, not orphan it.
    await owner.close();
    await guest.wait((m) => m.type === "participants" && m.participants.every((p: any) => p.role !== "owner"), "publisher detached");
    const stopped = await request(`/api/ssh/share?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders });
    assert.equal(stopped.status, 200);
    await guest.wait((m) => m.type === "exit", "guest sees share ended");
    await colleague.wait((m) => m.type === "exit", "account participant sees share ended");
    assert.equal((await (await request("/api/ssh/share", { headers: authHeaders })).json()).shares.length, 0);
    assert.equal((await request(`/api/ssh/share?id=${id}`, { method: "DELETE", headers: authHeaders })).status, 404);

    // An account-only share refuses a forged, wrong-audience or expired ticket;
    // the first-message gatewayToken path remains supported for trusted clients.
    const owner2 = await SocketClient.open(wsUrl);
    owner2.send({ type: "auth", gatewayToken: TOKEN, credentials: creds });
    await owner2.wait((m) => m.type === "ready", "second owner");
    owner2.send({ type: "input", data: `${"X".repeat(10000)}FLOOD_END\r` });
    await owner2.wait(isData("FLOOD_END"), "oversized pre-share output");
    owner2.send({ type: "share", action: "start", passcode: "none", accountIssuer: issuer });
    const accountShare = await owner2.wait((m) => m.type === "share" && m.action === "started", "account share");
    const accountId = accountShare.share.shareId as string;
    for (const invalid of [
      issueShareTicket(config.authSecret, accountId, "https://evil.test"),
      issueShareTicket(config.authSecret, accountId, base, Date.now() - 61000),
      issueShareTicket("attacker", accountId, base),
    ]) {
      const stranger = await SocketClient.open(wsUrl);
      stranger.send({ type: "auth", share: { join: accountId, name: "Intruder", ticket: invalid } });
      assert.equal((await stranger.wait((m) => m.type === "error", "invalid ticket refused")).code, "PASSCODE_REQUIRED");
    }
    const firstMessageToken = await SocketClient.open(wsUrl);
    firstMessageToken.send({ type: "auth", gatewayToken: TOKEN, share: { join: accountId, name: "Trusted client" } });
    assert.equal((await firstMessageToken.wait((m) => m.type === "ready", "first-message gateway key works")).viaAccount, true);
    const proper = await issueTicket(frontendRequest("POST", "/api/ssh/share/ticket", session, { shareId: accountId, gateway: base }));
    const signedGuest = await SocketClient.open(wsUrl);
    signedGuest.send({ type: "auth", share: { join: accountId, name: "Signed in", ticket: (await proper.json()).ticket } });
    const signedReady = await signedGuest.wait((m) => m.type === "ready", "account-only ticket works");
    const boundedReplay = Buffer.from(String(signedReady.replay), "base64");
    assert(boundedReplay.length <= 8192, "pre-share output is bounded before it enters the share");
    assert(boundedReplay.toString().includes("FLOOD_END"), "the newest output is preserved");
    const stoppedWhileOwnerConnected = await request(`/api/ssh/share?id=${accountId}`, { method: "DELETE", headers: authHeaders });
    assert.equal(stoppedWhileOwnerConnected.status, 200);
    await owner2.wait((m) => m.type === "share" && m.action === "stopped", "publisher returns to private PTY");
    await signedGuest.wait((m) => m.type === "share-closed", "guest notified");
    owner2.send({ type: "input", data: "private-after-stop\r" });
    await owner2.wait(isData("private-after-stop"), "publisher shell remains usable");

    // Older publishers can make code shares without pinning a verifier, but an
    // API client must not remove their only guest-access method by accident.
    const beforeLegacyShare = owner2.frames.length;
    owner2.send({ type: "share", action: "start", passcode: "auto" });
    const legacyShare = await owner2.wait((m) => m.type === "share" && m.action === "started", "legacy-style share", beforeLegacyShare);
    const legacyId = String(legacyShare.share.shareId);
    const legacyCode = String(legacyShare.passcode);
    assert.equal(legacyShare.share.accountTickets, false);
    const deniedRemoval = await request("/api/ssh/share", { method: "PATCH", headers, body: JSON.stringify({ id: legacyId, passcode: null }) });
    assert.equal(deniedRemoval.status, 409, "the gateway refuses removal without an account verifier");
    const legacyGuest = await SocketClient.open(wsUrl);
    legacyGuest.send({ type: "auth", share: { join: legacyId, passcode: legacyCode, name: "Legacy code guest" } });
    await legacyGuest.wait((m) => m.type === "ready", "original code still works");
    assert.equal((await request(`/api/ssh/share?id=${legacyId}`, { method: "DELETE", headers: authHeaders })).status, 200);
    assert(!gateway.logs().includes(TOKEN));
    assert(!gateway.logs().includes(SSH_PASSWORD));
    console.log("Separate gateway sharing, scoped account joins, permissions and management passed.");
  } finally {
    await Promise.all([...clients].map((client) => client.close()));
    if (gateway && gateway.child.exitCode === null && gateway.child.signalCode === null) {
      await new Promise<void>((resolve) => { gateway!.child.once("exit", () => resolve()); gateway!.child.kill("SIGTERM"); });
    }
    await new Promise<void>((resolve) => ssh.server.close(() => resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
