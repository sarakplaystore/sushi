import assert from "node:assert/strict";
import type { ClientChannel } from "ssh2";
import type { WebSocket } from "ws";
import type { ConnectedSshSession } from "../src/lib/server/ssh-client";
import {
  SharedSshSession,
  clearSharedSessionsForTests,
  getRetainedSshSession,
  getSharedSession,
  listSharedSessions,
  reapIdleSharedSessions,
  registerSharedSession,
  sharedSessionLimits,
} from "../src/lib/server/shared-ssh";

console.log("==> Retained PTY limits, idle lifetime and bounded output");
const previousTtl = process.env.SUSHI_SHARE_IDLE_TTL_MS;
const previousCap = process.env.SUSHI_SHARE_SCROLLBACK_BYTES;
process.env.SUSHI_SHARE_IDLE_TTL_MS = "60000";
process.env.SUSHI_SHARE_SCROLLBACK_BYTES = "8192";
let closed = 0;
let sshEnded = 0;
const sizes: Array<[number, number]> = [];
const stream = {
  close() { closed += 1; },
  write() {},
  setWindow(rows: number, cols: number) { sizes.push([cols, rows]); },
} as unknown as ClientChannel;
const ssh = { client: { end() { sshEnded += 1; } } } as unknown as ConnectedSshSession;
const socket = { readyState: 1, send() {}, close() {} } as unknown as WebSocket;

try {
  clearSharedSessionsForTests();
  const session = new SharedSshSession({
    host: "host.test", port: 22, username: "alice", ssh, stream, cols: 80, rows: 24,
    write: true, passcode: null, privateRetention: true,
  });
  assert.equal(registerSharedSession(session).ok, true);
  assert.equal(sharedSessionLimits().count, 1);
  assert.equal(listSharedSessions().length, 0, "private retention never publishes a team share");
  assert.equal(getSharedSession(session.retainedId), undefined);
  assert.equal(getRetainedSshSession(session.retainedId), session);
  session.handleOutput(Buffer.alloc(10_000, "a"));
  session.handleOutput(Buffer.from("tail"));
  assert(session.replay().length <= 8192, "the scrollback ring is bounded");
  assert(session.replay().toString().endsWith("tail"));

  const owner = session.attach(socket, { role: "owner", cols: 80, rows: 24 });
  assert.deepEqual(sizes[0], [80, 24], "reattachment reasserts size even when unchanged, prompting full-screen redraws");
  const base = Date.now();
  session.lastActivityAt = base - 120_000;
  reapIdleSharedSessions(base);
  assert.equal(session.isDestroyed, false, "an attached terminal is never reaped for idleness");
  session.detach(owner.id);
  session.lastActivityAt = base - 59_999;
  reapIdleSharedSessions(base);
  assert.equal(session.isDestroyed, false, "a recently detached terminal remains available");
  session.lastActivityAt = base - 120_000;
  session.handleOutput(Buffer.from("still active"));
  reapIdleSharedSessions(Date.now());
  assert.equal(session.isDestroyed, false, "output refreshes the detached idle timer");
  reapIdleSharedSessions(session.lastActivityAt + 60_000);
  assert.equal(session.isDestroyed, true, "idle detached terminals are reaped");
  assert.equal(getRetainedSshSession(session.retainedId), undefined);
  assert.equal(closed, 1);
  assert.equal(sshEnded, 1);
  assert.equal(sharedSessionLimits().count, 0);
  console.log("Bounded replay, private registry, resize and idle cleanup passed.");
} finally {
  clearSharedSessionsForTests();
  if (previousTtl === undefined) delete process.env.SUSHI_SHARE_IDLE_TTL_MS;
  else process.env.SUSHI_SHARE_IDLE_TTL_MS = previousTtl;
  if (previousCap === undefined) delete process.env.SUSHI_SHARE_SCROLLBACK_BYTES;
  else process.env.SUSHI_SHARE_SCROLLBACK_BYTES = previousCap;
}
