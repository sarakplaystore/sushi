import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { Server as SshServer } from "ssh2";
import { WebSocket } from "ws";

console.log("==> Retained SSH PTY: close the browser, continue a running command, and reattach privately");

const TOKEN = "retained-pty-synthetic-gateway-key";
const ORIGIN = "https://sushi.example.test";
const clients = new Set<Client>();
type Frame = Record<string, any>;

class Client {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  private listeners: Array<(frame: Frame) => void> = [];
  private constructor(url: string) {
    this.ws = new WebSocket(url, { origin: ORIGIN });
    this.ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      this.frames.push(frame);
      for (const listener of [...this.listeners]) listener(frame);
    });
  }
  static async open(url: string) {
    const client = new Client(url);
    clients.add(client);
    await new Promise<void>((resolve, reject) => { client.ws.once("open", resolve); client.ws.once("error", reject); });
    return client;
  }
  send(frame: Frame) { this.ws.send(JSON.stringify(frame)); }
  wait(predicate: (frame: Frame) => boolean, label: string, from = 0): Promise<Frame> {
    const existing = this.frames.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(new Error(`Timed out waiting for ${label}; got ${this.frames.map((m) => m.type).join(", ")}`));
      }, 10000);
      const listener = (frame: Frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== listener);
        resolve(frame);
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function startGateway() {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", HOST: "127.0.0.1",
      PORT: String(port), GATEWAY_ONLY: "true", SUSHI_GATEWAY_TOKEN: TOKEN, ALLOWED_ORIGIN: ORIGIN,
      GUACD_HOST: "127.0.0.1", GUACD_PORT: "1", SUSHI_SSH_POOL: "off", SUSHI_SHARE_SCROLLBACK_BYTES: "8192",
      SUSHI_SHARE_MAX_SESSIONS: "1",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => { log += d.toString(); });
  child.stderr!.on("data", (d) => { log += d.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`gateway startup timeout: ${log}`)), 15000);
    child.once("exit", (code) => { clearTimeout(timer); reject(Error(`gateway exited ${code}: ${log}`)); });
    child.stdout!.on("data", () => { if (log.includes("gateway listening")) { clearTimeout(timer); resolve(); } });
  });
  return { port, child, logs: () => log };
}

async function startSsh() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const state = { shells: 0, commands: 0, finished: 0, closed: 0, inputs: "", sizes: [] as Array<[number, number]> };
  const children = new Set<ChildProcess>();
  const ssh = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.method === "password" && ctx.username === "tester" && ctx.password === "ssh-test-password" ? ctx.accept() : ctx.reject());
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (ok) => ok?.());
      session.on("window-change", (ok, _reject, info) => { state.sizes.push([info.cols, info.rows]); ok?.(); });
      session.on("shell", (ok) => {
        const stream = ok(); state.shells += 1;
        stream.write("READY_SHELL\r\n");
        stream.on("close", () => { state.closed += 1; });
        stream.on("data", (data: Buffer) => {
          const input = data.toString();
          state.inputs += input;
          if (input.includes("long-command")) {
            state.commands += 1;
            const task = spawn("/bin/sh", ["-c", "sleep 0.4; printf 'COMMAND_FINISHED_WHILE_DETACHED\\n'"]);
            children.add(task);
            task.stdout!.on("data", (out: Buffer) => { stream.write(out); });
            task.on("exit", () => { state.finished += 1; children.delete(task); });
            stream.write("COMMAND_STARTED\r\n");
          } else stream.write(`ECHO:${input}\r\n`);
        });
      });
    }));
  });
  await new Promise<void>((r) => ssh.listen(0, "127.0.0.1", r));
  return { ssh, state, children, port: (ssh.address() as net.AddressInfo).port };
}

const isData = (text: string) => (frame: Frame) => frame.type === "data" && Buffer.from(String(frame.data), "base64").toString().includes(text);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await pause(20);
  assert(predicate(), `Timed out: ${label}`);
}

async function main() {
  const ssh = await startSsh();
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    gateway = await startGateway();
    const wsUrl = `ws://127.0.0.1:${gateway.port}/ws/ssh`;
    const base = `http://127.0.0.1:${gateway.port}`;
    const creds = { host: "127.0.0.1", port: ssh.port, username: "tester", authMethod: "password", password: "ssh-test-password" };
    const managementHeaders = { Origin: ORIGIN, "X-Sushi-Token": TOKEN };
    const shares = async () => (await (await fetch(`${base}/api/ssh/share`, { headers: managementHeaders })).json()).shares as Frame[];
    const caps = await (await fetch(`${base}/api/system/capabilities`)).json();
    assert.equal(caps.retainedSshPty, true);

    const owner = await Client.open(wsUrl);
    owner.send({ type: "auth", gatewayToken: TOKEN, credentials: creds, keepAlive: true, cols: 100, rows: 30 });
    const ready = await owner.wait((m) => m.type === "ready", "retained shell ready");
    const id = String(ready.persistence?.sessionId || "");
    assert.match(id, /^[A-Za-z0-9_-]{24}$/);
    assert(ready.persistence.idleTtlMs >= 60000);
    assert.equal((await shares()).length, 0, "a privately retained PTY is not published as a share");
    owner.send({ type: "input", data: "long-command\r" });
    await owner.wait(isData("COMMAND_STARTED"), "long command began");
    await owner.close();
    await waitFor(() => ssh.state.finished === 1, "the command completed while the browser was closed");
    assert.equal(ssh.state.closed, 0, "closing the browser did not close the SSH PTY");

    const stranger = await Client.open(wsUrl);
    stranger.send({ type: "auth", resumeId: id });
    assert.equal((await stranger.wait((m) => m.type === "error", "resume requires owner authentication")).code, "RESUME_UNAUTHORIZED");
    const joiner = await Client.open(wsUrl);
    joiner.send({ type: "auth", share: { join: id, passcode: "123456", name: "Intruder" } });
    assert.equal((await joiner.wait((m) => m.type === "error", "private session is not a share")).code, "SHARE_NOT_FOUND");

    const resumed = await Client.open(wsUrl);
    resumed.send({ type: "auth", gatewayToken: TOKEN, resumeId: id, cols: 80, rows: 25 });
    const resumedReady = await resumed.wait((m) => m.type === "ready", "authorized reattach");
    assert.equal(resumedReady.resumed, true);
    if (!Buffer.from(resumedReady.replay, "base64").toString().includes("COMMAND_FINISHED_WHILE_DETACHED")) {
      // The command can finish on the fixture just before its SSH bytes arrive at
      // the gateway; in that case they must arrive as live output after ready.
      await resumed.wait(isData("COMMAND_FINISHED_WHILE_DETACHED"), "detached output after ready");
    }
    assert.equal(ssh.state.shells, 1, "reattach did not create a new SSH shell");
    assert.equal(ssh.state.commands, 1, "the command was never rerun");
    await waitFor(() => ssh.state.sizes.some(([cols, rows]) => cols === 80 && rows === 25), "reattach resizes the existing PTY");
    resumed.send({ type: "input", data: "after-resume\r" });
    await resumed.wait(isData("after-resume"), "input reaches the original shell");

    // Multiple authenticated owners see global retention changes consistently.
    const otherOwner = await Client.open(wsUrl);
    otherOwner.send({ type: "auth", gatewayToken: TOKEN, resumeId: id });
    const secondReady = await otherOwner.wait((m) => m.type === "ready", "second owner attached");
    assert.match(Buffer.from(secondReady.replay, "base64").toString(), /COMMAND_FINISHED_WHILE_DETACHED/, "late output is replayed");
    resumed.send({ type: "persistence", action: "disable" });
    await otherOwner.wait((m) => m.type === "persistence" && m.action === "disabled", "other owner sees disable");
    resumed.send({ type: "persistence", action: "enable" });
    await otherOwner.wait((m) => m.type === "persistence" && m.action === "enabled", "other owner sees enable");
    await otherOwner.close();

    // A private retained shell can be shared and unshared without losing it.
    resumed.send({ type: "share", action: "start", passcode: "auto", write: true });
    const published = await resumed.wait((m) => m.type === "share" && m.action === "started", "promoted to share");
    const shareId = String(published.share.shareId);
    assert.notEqual(shareId, id, "private owner-resume ID is never the public share ID");
    assert.equal((await shares()).length, 1);
    const guest = await Client.open(wsUrl);
    guest.send({ type: "auth", share: { join: shareId, passcode: published.passcode, name: "Guest" } });
    await guest.wait((m) => m.type === "ready", "guest joins published shell");
    guest.send({ type: "persistence", action: "end" });
    assert.equal((await guest.wait((m) => m.type === "persistence" && m.action === "error", "guest cannot end retained PTY")).action, "error");
    const beforeGuestDisable = guest.frames.length;
    guest.send({ type: "persistence", action: "disable" });
    await guest.wait((m) => m.type === "persistence" && m.action === "error", "guest cannot disable retention", beforeGuestDisable);
    const guestResume = await Client.open(wsUrl);
    guestResume.send({ type: "auth", resumeId: shareId, gatewayToken: TOKEN });
    assert.equal((await guestResume.wait((m) => m.type === "error", "public share ID cannot resume as owner")).code, "RESUME_NOT_FOUND");
    await resumed.close();
    await guest.wait((m) => m.type === "participants" && m.participants.every((p: Frame) => p.role !== "owner"), "owner detached");

    // Dashboard stop unpublishes (and removes guests), but a private retained PTY
    // must survive even when its owner is not currently connected.
    const stopShare = await fetch(`${base}/api/ssh/share?id=${shareId}`, { method: "DELETE", headers: managementHeaders });
    assert.equal(stopShare.status, 200);
    await guest.wait((m) => m.type === "share-closed", "guest removed when sharing stops");
    assert.equal((await shares()).length, 0);
    const ownerAgain = await Client.open(wsUrl);
    ownerAgain.send({ type: "auth", gatewayToken: TOKEN, resumeId: id });
    await ownerAgain.wait((m) => m.type === "ready", "private PTY survives unpublish");
    ownerAgain.send({ type: "input", data: "after-unpublish\r" });
    await ownerAgain.wait(isData("after-unpublish"), "original routing reaches the reattached owner");
    assert.equal(ssh.state.shells, 1);
    const beforeRepublish = ownerAgain.frames.length;
    ownerAgain.send({ type: "share", action: "start", passcode: "auto" });
    const republished = await ownerAgain.wait((m) => m.type === "share" && m.action === "started", "republished", beforeRepublish);
    assert.notEqual(republished.share.shareId, shareId, "revoked links do not reactivate on re-sharing");
    ownerAgain.send({ type: "share", action: "stop" });
    await ownerAgain.wait((m) => m.type === "share" && m.action === "stopped", "unpublished again");

    ownerAgain.send({ type: "persistence", action: "disable" });
    await ownerAgain.wait((m) => m.type === "persistence" && m.action === "disabled", "retention disabled");
    await ownerAgain.close();
    await waitFor(() => ssh.state.closed === 1, "private PTY closed after retention disabled");
    const stale = await Client.open(wsUrl);
    stale.send({ type: "auth", gatewayToken: TOKEN, resumeId: id });
    assert.equal((await stale.wait((m) => m.type === "error", "ended terminal is not silently recreated")).code, "RESUME_NOT_FOUND");
    assert.equal(ssh.state.shells, 1);

    // Retention can also be enabled after a command is already running; that is
    // essential for interactive jobs that predate a user's decision to detach.
    const late = await Client.open(wsUrl);
    late.send({ type: "auth", gatewayToken: TOKEN, credentials: creds });
    await late.wait((m) => m.type === "ready", "ordinary shell");
    late.send({ type: "input", data: "long-command\r" });
    await late.wait(isData("COMMAND_STARTED"), "second command began");
    late.send({ type: "persistence", action: "enable" });
    const enabled = await late.wait((m) => m.type === "persistence" && m.action === "enabled", "late retention enabled");
    await late.close();
    await waitFor(() => ssh.state.finished === 2, "second command completes while detached");
    const reattached = await Client.open(wsUrl);
    reattached.send({ type: "auth", gatewayToken: TOKEN, resumeId: enabled.sessionId });
    const lateReady = await reattached.wait((m) => m.type === "ready", "late-enabled shell reattached");
    const replay = Buffer.from(lateReady.replay, "base64").toString();
    assert.match(replay, /COMMAND_STARTED/);
    if (!replay.includes("COMMAND_FINISHED_WHILE_DETACHED")) {
      await reattached.wait(isData("COMMAND_FINISHED_WHILE_DETACHED"), "late output delivered after ready");
    }
    const lateObserver = await Client.open(wsUrl);
    lateObserver.send({ type: "auth", gatewayToken: TOKEN, resumeId: enabled.sessionId });
    const observed = await lateObserver.wait((m) => m.type === "ready", "late output replayed");
    assert.match(Buffer.from(observed.replay, "base64").toString(), /COMMAND_FINISHED_WHILE_DETACHED/);
    await lateObserver.close();
    assert.equal(ssh.state.shells, 2);
    assert.equal(ssh.state.commands, 2);
    reattached.send({ type: "persistence", action: "disable" });
    await reattached.wait((m) => m.type === "persistence" && m.action === "disabled", "late retention disabled");
    await reattached.close();
    await waitFor(() => ssh.state.closed === 2, "late-retained shell closed");

    // A full gateway must explicitly reject retention without claiming success;
    // the extra ordinary shell closes normally, while the existing PTY survives.
    const holder = await Client.open(wsUrl);
    holder.send({ type: "auth", gatewayToken: TOKEN, credentials: creds, keepAlive: true });
    const held = await holder.wait((m) => m.type === "ready", "first retained slot");
    assert(held.persistence.sessionId);
    const overflow = await Client.open(wsUrl);
    overflow.send({ type: "auth", gatewayToken: TOKEN, credentials: creds, keepAlive: true });
    const full = await overflow.wait((m) => m.type === "ready", "capacity failure in ready");
    assert(!full.persistence.sessionId);
    assert.match(full.persistence.error, /too many/i);
    await overflow.close();
    await waitFor(() => ssh.state.closed === 3, "unretained overflow shell closed");
    holder.send({ type: "persistence", action: "end" });
    await holder.wait((m) => m.type === "exit", "owner explicitly ended the terminal");
    await waitFor(() => ssh.state.closed === 4, "explicit end closed the retained SSH channel");
    assert(!gateway.logs().includes(TOKEN) && !gateway.logs().includes("ssh-test-password"));
    console.log("Retained PTY, authenticated resume, private/share lifecycle, capacity, replay and opt-out passed.");
  } finally {
    await Promise.all([...clients].map((c) => c.close()));
    for (const child of ssh.children) child.kill("SIGTERM");
    if (gateway && gateway.child.exitCode === null && gateway.child.signalCode === null) {
      await new Promise<void>((resolve) => { gateway!.child.once("exit", () => resolve()); gateway!.child.kill("SIGTERM"); });
    }
    await new Promise<void>((resolve) => ssh.ssh.close(() => resolve()));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
