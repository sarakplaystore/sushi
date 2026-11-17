import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Server as SshServer } from "ssh2";
import { WebSocket } from "ws";
import { createGatewayWebSockets } from "../src/lib/server/ws-gateway";
import {
  clearSharedSessionsForTests,
  findSharedSessionByHost,
  listSharedSessions,
  sharedSessionLimits,
  stopSharedSession,
} from "../src/lib/server/shared-ssh";
import { sortParticipants } from "../src/lib/client/shared-ssh";

/**
 * Team sharing, end to end: a real SSH server (ssh2 `Server`), the real gateway
 * WebSocket endpoint, and two browsers' worth of sockets that have to end up in
 * front of the same PTY.
 *
 * The behaviour under test is the part that cannot be unit-tested away: one shell,
 * several keyboards, scrollback replay for whoever joins late, and a shell that
 * outlives every browser attached to it.
 */

console.log("==> Testing shared SSH sessions (team sharing)...");

const GATEWAY_TOKEN = "shared-ssh-test-token-0123456789";
process.env.SUSHI_GATEWAY_TOKEN = GATEWAY_TOKEN;

type Msg = Record<string, any>;

/** Collects every frame a socket receives so tests can assert on the stream. */
class Client {
  readonly ws: WebSocket;
  readonly messages: Msg[] = [];
  private waiters: Array<(msg: Msg) => boolean> = [];
  private closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8")) as Msg;
      if (msg.type === "pong") return;
      this.messages.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        if (this.waiters[i](msg)) this.waiters.splice(i, 1);
      }
    });
    this.ws.on("close", () => {
      this.closed = true;
    });
  }

  static async open(url: string): Promise<Client> {
    const client = new Client(url);
    await new Promise<void>((resolve, reject) => {
      client.ws.once("open", () => resolve());
      client.ws.once("error", reject);
    });
    return client;
  }

  send(payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(payload));
  }

  /** Resolves with the first (past or future) frame matching `predicate`. */
  waitFor<T extends Msg = Msg>(
    predicate: (msg: Msg) => boolean,
    label: string,
    timeoutMs = 8000
  ): Promise<T> {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${label} (frames: ${JSON.stringify(this.messages.map((m) => m.type))})`)),
        timeoutMs
      );
      this.waiters.push((msg) => {
        if (!predicate(msg)) return false;
        clearTimeout(timer);
        resolve(msg as T);
        return true;
      });
    });
  }

  /** All terminal output seen so far, decoded from the base64 frames. */
  output(): string {
    return this.messages
      .filter((m) => m.type === "data")
      .map((m) => Buffer.from(String(m.data), "base64").toString("utf8"))
      .join("");
  }

  close(): Promise<void> {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

/** A tiny fake host: a banner on connect, an echo for every line typed. */
async function startSshServer(): Promise<{ port: number; close: () => void; shells: number }> {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const state = { shells: 0, lastResize: { cols: 0, rows: 0 } };
  const server = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "team" && ctx.password === "sushipass") {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("window-change", (acceptResize, _reject, info) => {
          state.lastResize = { cols: info?.cols ?? 0, rows: info?.rows ?? 0 };
          acceptResize?.();
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          state.shells += 1;
          stream.write("Welcome to the shared box\r\n");
          stream.on("data", (data: Buffer) => {
            const line = data.toString("utf8").replace(/\r|\n/g, "").trim();
            if (!line) {
              stream.write("\r\n");
              return;
            }
            if (line === "exit") {
              stream.exit(0);
              stream.close();
              return;
            }
            stream.write(`echo:${line}\r\n`);
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => server.close(),
    get shells() {
      return state.shells;
    },
  };
}

const creds = (port: number) => ({
  host: "127.0.0.1",
  port,
  username: "team",
  authMethod: "password" as const,
  password: "sushipass",
});

async function main() {
  clearSharedSessionsForTests();
  const ssh = await startSshServer();

  const gateway = createGatewayWebSockets();
  const httpServer = http.createServer((_req, res) => res.end("ok"));
  httpServer.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const gwPort = (httpServer.address() as net.AddressInfo).port;
  const wsUrl = `ws://127.0.0.1:${gwPort}/ws/ssh`;

  const failures: string[] = [];
  const check = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`  ✓ ${label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${label}: ${message}`);
      console.log(`  ✗ ${label} — ${message}`);
    }
  };

  // ---------------------------------------------------------------------------
  // 1. The host publishes a shell and gets a share id + 6-digit code.
  // ---------------------------------------------------------------------------
  const owner = await Client.open(wsUrl);
  owner.send({
    type: "auth",
    gatewayToken: GATEWAY_TOKEN,
    cols: 100,
    rows: 30,
    credentials: creds(ssh.port),
    share: { create: { write: true }, name: "Priya" },
  });
  const started = await owner.waitFor(
    (m) => m.type === "share" && m.action === "started",
    "share started frame"
  );
  const shareId = String(started.share.shareId);
  const passcode = String(started.passcode);

  assert.ok(shareId.length > 8, "a share id is minted");
  assert.match(passcode, /^\d{6}$/, "a 6-digit share code is minted");
  assert.equal(started.share.write, true, "the share allows typing by default");
  assert.equal(started.share.requiresPasscode, true, "the share is protected by a code");
  assert.equal(started.share.participants.length, 1, "the host is the first participant");
  assert.equal(started.share.participants[0].name, "Priya", "the host's name is used");
  assert.equal(listSharedSessions().length, 1, "the share is listed on the gateway");
  assert.equal(
    findSharedSessionByHost("127.0.0.1", ssh.port, "team")?.shareId,
    shareId,
    "the share can be found by host"
  );
  console.log("  ✓ host published the shell and got a share code");

  // ---------------------------------------------------------------------------
  // 2. A wrong code is refused, and does not attach a participant.
  // ---------------------------------------------------------------------------
  await check("wrong share code is rejected", async () => {
    const stranger = await Client.open(wsUrl);
    stranger.send({
      type: "auth",
      cols: 80,
      rows: 24,
      share: { join: shareId, passcode: "000000", name: "Nope" },
    });
    const err = await stranger.waitFor((m) => m.type === "error", "auth error");
    assert.equal(err.code, "BAD_PASSCODE", "the error names the bad code");
    assert.equal(
      listSharedSessions()[0].participants.length,
      1,
      "the rejected joiner did not attach"
    );
    await stranger.close();
  });

  // ---------------------------------------------------------------------------
  // 3. A teammate joins with the code and lands on the SAME screen (scrollback).
  // ---------------------------------------------------------------------------
  const guest = await Client.open(wsUrl);
  guest.send({
    type: "auth",
    cols: 90,
    rows: 24,
    share: { join: shareId, passcode, name: "Ana" },
  });
  const guestReady = await guest.waitFor((m) => m.type === "ready", "guest ready");
  assert.equal(guestReady.write, true, "the guest may type");
  assert.equal(guestReady.viaAccount, false, "the guest joined with a code, not an account");
  assert.ok(
    Buffer.from(String(guestReady.replay), "base64").toString("utf8").includes("Welcome to the shared box"),
    "the late joiner is replayed the scrollback it missed"
  );
  assert.equal(guestReady.share.label, "team@127.0.0.1:" + ssh.port, "the share is labelled");

  const roster = await owner.waitFor(
    (m) => m.type === "participants" && m.participants.length === 2,
    "the host sees two participants"
  );
  assert.equal(
    roster.participants.map((p: any) => p.name).sort().join(","),
    "Ana,Priya",
    "both people are in the roster"
  );
  assert.equal(ssh.shells, 1, "both browsers share ONE ssh shell");
  console.log("  ✓ teammate joined the same shell and was replayed the scrollback");

  // ---------------------------------------------------------------------------
  // 4. Either keyboard drives the shell; both screens see the result.
  // ---------------------------------------------------------------------------
  await check("the guest's keystrokes reach the shell for everyone", async () => {
    const beforeOwner = owner.output().length;
    guest.send({ type: "input", data: "from-ana\r" });
    await owner.waitFor(
      (m) => m.type === "data" && Buffer.from(String(m.data), "base64").toString("utf8").includes("from-ana"),
      "the host sees the guest's command"
    );
    assert.ok(owner.output().length > beforeOwner, "the host's screen really changed");
    const activity = await owner.waitFor(
      (m) => m.type === "activity",
      "the host is told who is typing"
    );
    assert.equal(activity.by, "Ana", "the activity notice names the typist");

    owner.send({ type: "input", data: "from-priya\r" });
    await guest.waitFor(
      (m) => m.type === "data" && Buffer.from(String(m.data), "base64").toString("utf8").includes("from-priya"),
      "the guest sees the host's command"
    );
  });

  // ---------------------------------------------------------------------------
  // 5. The shell outlives every browser: the host leaves, the guest carries on.
  // ---------------------------------------------------------------------------
  await check("the shell survives the host disconnecting (detached)", async () => {
    await owner.close();
    // The host's socket close is processed on the server a tick later; the roster
    // broadcast is the signal that the detach really happened.
    await guest.waitFor(
      (m) => m.type === "participants" && m.participants.length === 1,
      "the roster drops to the remaining guest"
    );
    const session = listSharedSessions()[0];
    assert.equal(session.participants.length, 1, "only the guest remains attached");
    assert.equal(session.status, "live", "the shared shell is still live");

    guest.send({ type: "input", data: "still-here\r" });
    await guest.waitFor(
      (m) => m.type === "data" && Buffer.from(String(m.data), "base64").toString("utf8").includes("still-here"),
      "the shell still answers after the host left"
    );
    assert.equal(ssh.shells, 1, "no second shell was opened");
  });

  // ---------------------------------------------------------------------------
  // 6. Somebody new can keep working in that shell hours later.
  // ---------------------------------------------------------------------------
  const latecomer = await Client.open(wsUrl);
  latecomer.send({
    type: "auth",
    cols: 80,
    rows: 24,
    share: { join: shareId, passcode, name: "Miguel" },
  });
  const lateReady = await latecomer.waitFor((m) => m.type === "ready", "late joiner ready");
  assert.ok(
    Buffer.from(String(lateReady.replay), "base64").toString("utf8").includes("still-here"),
    "the newcomer inherits the session's history, not a blank screen"
  );
  console.log("  ✓ a new teammate continued in the same detached shell");

  // ---------------------------------------------------------------------------
  // 7. Read-only shares drop guest keystrokes but keep the host's.
  // ---------------------------------------------------------------------------
  await check("a read-only share ignores guest keystrokes", async () => {
    const owner2 = await Client.open(wsUrl);
    owner2.send({
      type: "auth",
      gatewayToken: GATEWAY_TOKEN,
      cols: 100,
      rows: 30,
      credentials: creds(ssh.port),
    });
    await owner2.waitFor((m) => m.type === "ready", "second host ready");
    owner2.send({ type: "share", action: "start", write: false, passcode: "auto" });
    const started2 = await owner2.waitFor(
      (m) => m.type === "share" && m.action === "started",
      "second share started"
    );
    assert.equal(started2.share.write, false, "the share is read-only");

    const watcher = await Client.open(wsUrl);
    watcher.send({
      type: "auth",
      cols: 80,
      rows: 24,
      share: { join: started2.share.shareId, passcode: String(started2.passcode), name: "Watcher" },
    });
    const watcherReady = await watcher.waitFor((m) => m.type === "ready", "watcher ready");
    assert.equal(watcherReady.write, false, "the browser is told it may not type");

    // The watcher types; the shell must not answer, while the host still can.
    watcher.send({ type: "input", data: "nope\r" });
    owner2.send({ type: "input", data: "host-only\r" });
    await owner2.waitFor(
      (m) => m.type === "data" && Buffer.from(String(m.data), "base64").toString("utf8").includes("host-only"),
      "the host's command runs"
    );
    assert.ok(
      !owner2.output().includes("echo:nope"),
      "the read-only guest's keystrokes never reached the shell"
    );
    await watcher.close();
    await owner2.close();
  });

  // ---------------------------------------------------------------------------
  // 8. Account-only shares refuse a code-less stranger, accept a signed-in user.
  // ---------------------------------------------------------------------------
  await check("an account-only share needs a Sushi session, not a code", async () => {
    const owner3 = await Client.open(wsUrl);
    owner3.send({
      type: "auth",
      gatewayToken: GATEWAY_TOKEN,
      cols: 100,
      rows: 30,
      credentials: creds(ssh.port),
    });
    await owner3.waitFor((m) => m.type === "ready", "third host ready");
    owner3.send({ type: "share", action: "start", write: true, passcode: "none" });
    const started3 = await owner3.waitFor(
      (m) => m.type === "share" && m.action === "started",
      "account-only share started"
    );
    assert.equal(started3.share.requiresPasscode, false, "no code is issued");
    assert.equal(started3.passcode, undefined, "no code is handed out");

    const anonymous = await Client.open(wsUrl);
    anonymous.send({
      type: "auth",
      cols: 80,
      rows: 24,
      share: { join: started3.share.shareId, name: "Stranger" },
    });
    const refused = await anonymous.waitFor((m) => m.type === "error", "anonymous rejected");
    assert.equal(refused.code, "PASSCODE_REQUIRED", "the error says an account is required");
    assert.match(String(refused.message), /signed in/i, "the message points at signing in");
    await anonymous.close();

    // Same link, signed-in socket (gateway token stands in for the account here).
    const colleague = await Client.open(
      `${wsUrl}?token=${encodeURIComponent(GATEWAY_TOKEN)}`
    );
    colleague.send({
      type: "auth",
      cols: 80,
      rows: 24,
      share: { join: started3.share.shareId, name: "Sam" },
    });
    const colleagueReady = await colleague.waitFor((m) => m.type === "ready", "colleague ready");
    assert.equal(colleagueReady.viaAccount, true, "the account path is honoured");
    await colleague.close();
    await owner3.close();
  });

  // ---------------------------------------------------------------------------
  // 9. Stopping a share disconnects the guests and releases the share id.
  // ---------------------------------------------------------------------------
  await check("stopping the share ends it for everyone", async () => {
    const before = listSharedSessions().length;
    const result = stopSharedSession(shareId, "Test is stopping the share.");
    assert.equal(result.ok, true, "the stop is accepted");
    assert.equal(listSharedSessions().length, before - 1, "the share left the registry");
    const closed = await guest.waitFor(
      (m) => m.type === "exit" || m.type === "share-closed",
      "guests are told the share ended"
    );
    assert.ok(closed.reason, "the reason is included");
    const gone = await Client.open(wsUrl);
    gone.send({ type: "auth", cols: 80, rows: 24, share: { join: shareId, passcode } });
    const missing = await gone.waitFor((m) => m.type === "error", "stale link rejected");
    assert.equal(missing.code, "SHARE_NOT_FOUND", "the old link no longer works");
    await gone.close();
    await guest.close();
    await latecomer.close();
  });

  // ---------------------------------------------------------------------------
  // 10. Rotating the code invalidates the old one.
  // ---------------------------------------------------------------------------
  await check("rotating the code invalidates the previous one", async () => {
    const host = await Client.open(wsUrl);
    host.send({
      type: "auth",
      gatewayToken: GATEWAY_TOKEN,
      cols: 100,
      rows: 30,
      credentials: creds(ssh.port),
      share: { create: { write: true }, name: "Rotator" },
    });
    const first = await host.waitFor(
      (m) => m.type === "share" && m.action === "started",
      "share started for rotation"
    );
    const oldCode = String(first.passcode);
    host.send({ type: "share", action: "rotate" });
    const rotated = await host.waitFor(
      (m) => m.type === "share" && m.action === "rotated",
      "rotated frame"
    );
    assert.notEqual(String(rotated.passcode), oldCode, "a fresh code is issued");

    const stale = await Client.open(wsUrl);
    stale.send({ type: "auth", share: { join: first.share.shareId, passcode: oldCode } });
    const staleErr = await stale.waitFor((m) => m.type === "error", "old code rejected");
    assert.equal(staleErr.code, "BAD_PASSCODE", "the old code stopped working");
    await stale.close();

    const fresh = await Client.open(wsUrl);
    fresh.send({
      type: "auth",
      share: { join: first.share.shareId, passcode: String(rotated.passcode), name: "Fresh" },
    });
    await fresh.waitFor((m) => m.type === "ready", "the new code works");
    await fresh.close();
    await host.close();
  });

  // ---------------------------------------------------------------------------
  // 11. Host-side UI helpers and limits.
  // ---------------------------------------------------------------------------
  await check("participant ordering puts the host first", async () => {
    const ordered = sortParticipants([
      { id: "2", name: "Ana", role: "guest", canWrite: true, joinedAt: 20, lastInputAt: 0, cols: 80, rows: 24 },
      { id: "1", name: "Priya", role: "owner", canWrite: true, joinedAt: 10, lastInputAt: 0, cols: 80, rows: 24 },
      { id: "3", name: "Miguel", role: "guest", canWrite: true, joinedAt: 5, lastInputAt: 0, cols: 80, rows: 24 },
    ]);
    assert.deepEqual(
      ordered.map((p) => p.name),
      ["Priya", "Miguel", "Ana"],
      "host first, then guests oldest-join first"
    );
    const limits = sharedSessionLimits();
    assert.ok(limits.maxSessions >= 1 && limits.idleTtlMs > 0, "limits are reported");
  });

  // ---- teardown -------------------------------------------------------------
  clearSharedSessionsForTests();
  assert.equal(listSharedSessions().length, 0, "cleanup drops every share");
  httpServer.close();
  ssh.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} shared-SSH check(s) FAILED:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\n==> Shared SSH session tests passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
