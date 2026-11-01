import { createHash } from "node:crypto";
import type { ClientChannel, PseudoTtyOptions } from "ssh2";
import type { ConnectionCredentials, SshSystemInfo } from "@/types/connection";
import {
  connectSsh,
  type ConnectedSshSession,
} from "./ssh-client";
import { SYSINFO_SCRIPT, parseSysinfo } from "./sysinfo";

/**
 * Keeps SSH connections open between commands.
 *
 * Serverless SSH runs one command per HTTP request, and every request used to pay
 * for a brand-new SSH connection: TCP handshake, key exchange, authentication. From
 * a Vercel function that is five or six round trips to the host *before* the command
 * even starts — 1–2 s on a distant VPS, and far more than the command itself for
 * `ls`, `cat`, `docker ps` and the like.
 *
 * Sushi now keeps the connection for a short while and runs the next command over
 * it (`client.exec` only opens a new channel on an existing connection). A keyboard
 * press delivered to a running command (`/api/ssh/exec/keys`) reuses it too, so
 * typing into a whiptail menu is no longer one SSH handshake per key.
 *
 * The pool is per server instance, in memory only:
 *
 * - a connection is reused only for the same host, port, user and credentials;
 * - idle connections are closed after {@link IDLE_TTL_MS} and never kept longer
 *   than {@link MAX_AGE_MS};
 * - at most {@link MAX_CONNECTIONS} connections are kept per instance — beyond that
 *   a request gets its own connection that is closed when the command ends;
 * - a command that needs the connection to itself (`exclusive`) never shares it with
 *   another running command, so Ctrl+C cannot interfere with a second tab;
 * - a connection that errored, was aborted or failed to open a channel is dropped,
 *   and the command is retried once on a fresh connection (the command never ran,
 *   so retrying is safe).
 *
 * Set `SUSHI_SSH_POOL=off` to disable reuse (every request then opens a connection,
 * like before), `SUSHI_SSH_POOL_IDLE_MS` / `SUSHI_SSH_POOL_MAX` to tune it.
 */

const POOL_DISABLED = process.env.SUSHI_SSH_POOL === "off";

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** How long an idle connection is kept for the next command. */
const IDLE_TTL_MS = numberFromEnv("SUSHI_SSH_POOL_IDLE_MS", 90_000);
/** A connection is never reused after this long, healthy or not. */
const MAX_AGE_MS = numberFromEnv("SUSHI_SSH_POOL_MAX_AGE_MS", 10 * 60_000);
/** Idle connections kept per server instance. */
const MAX_CONNECTIONS = Math.max(1, numberFromEnv("SUSHI_SSH_POOL_MAX", 8));

interface PoolEntry {
  key: string;
  session: ConnectedSshSession;
  createdAt: number;
  lastUsedAt: number;
  /** Commands / requests currently using this connection. */
  active: number;
  /** Set when the connection died or must not be reused. */
  dead: boolean;
  /** Set once the entry has been closed (closing twice is a no-op). */
  closed: boolean;
  idleTimer: NodeJS.Timeout | null;
}

export interface SshLease {
  session: ConnectedSshSession;
  /** True when no handshake was needed: this connection was already open. */
  reused: boolean;
  /** Milliseconds the handshake took, 0 when it was reused. */
  connectMs: number;
  /** Marks the connection unusable; it is closed when the last user is done. */
  markBroken: () => void;
  release: () => void;
}

export interface AcquireSshOptions {
  timeoutMs?: number;
  /**
   * The caller runs something long-lived (a command with a PTY) and wants the
   * connection to itself: a busy connection is never shared in this mode.
   */
  exclusive?: boolean;
}

/** Credentials never appear in the key: only a hash, truncated. */
function poolKey(creds: ConnectionCredentials): string {
  const hash = createHash("sha256");
  hash.update(String(creds.host || "").trim().toLowerCase());
  hash.update(`\0${Number(creds.port || 22)}`);
  hash.update(`\0${String(creds.username || "").trim()}`);
  hash.update(`\0${creds.authMethod || ""}`);
  if (creds.authMethod === "privateKey" || creds.privateKey?.trim()) {
    hash.update(`\0key\0${creds.privateKey || ""}\0${creds.passphrase || ""}`);
  } else {
    hash.update(`\0pw\0${creds.password || ""}`);
  }
  return hash.digest("hex").slice(0, 32);
}

/** Entries grouped by target; a busy target can hold several connections. */
const entries = new Map<string, PoolEntry[]>();
/** In-flight handshakes, so a burst of requests opens one connection, not five. */
const connecting = new Map<string, Promise<ConnectedSshSession>>();

const stats = { created: 0, reused: 0, closed: 0 };

function listEntries(key: string): PoolEntry[] {
  const list = entries.get(key);
  if (!list) return [];
  return list;
}

function removeEntry(entry: PoolEntry): void {
  const list = entries.get(entry.key);
  if (list) {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) entries.delete(entry.key);
  }
}

function closeEntry(entry: PoolEntry, destroy = false): void {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  removeEntry(entry);
  try {
    // A dead connection has no graceful close left: drop the socket.
    if (destroy || entry.dead) entry.session.client.destroy();
    else entry.session.client.end();
  } catch {
    // already gone
  }
  stats.closed += 1;
}

function scheduleIdleClose(entry: PoolEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.dead || entry.active === 0) closeEntry(entry);
  }, IDLE_TTL_MS);
  // Never keep the Node process (or a test run) alive just for an idle socket.
  entry.idleTimer.unref?.();
}

function markEntryDead(entry: PoolEntry): void {
  if (entry.closed) return;
  entry.dead = true;
  if (entry.active === 0) closeEntry(entry);
}

function isUsable(entry: PoolEntry, exclusive: boolean): boolean {
  if (entry.dead) return false;
  if (exclusive && entry.active > 0) return false;
  if (Date.now() - entry.createdAt > MAX_AGE_MS) return false;
  return true;
}

/** Most recently used first: the connection most likely to be fully warm. */
function pickEntry(key: string, exclusive: boolean): PoolEntry | null {
  const candidates = listEntries(key)
    .filter((entry) => isUsable(entry, exclusive))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return candidates[0] ?? null;
}

function track(entry: PoolEntry): void {
  const { client } = entry.session;
  const gone = () => markEntryDead(entry);
  // `error` already has a listener from connectSsh; these keep the pool honest
  // when the peer disappears or the socket is torn down under us.
  client.on("close", gone);
  client.on("end", gone);
  client.on("error", gone);
}

function register(key: string, session: ConnectedSshSession): PoolEntry {
  const now = Date.now();
  const entry: PoolEntry = {
    key,
    session,
    createdAt: now,
    lastUsedAt: now,
    active: 0,
    dead: false,
    closed: false,
    idleTimer: null,
  };
  track(entry);

  const list = entries.get(key) ?? [];
  // Make room: drop the least recently used idle connection first.
  if (totalConnections() >= MAX_CONNECTIONS) {
    const idle = allEntries()
      .filter((candidate) => candidate.active === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) {
      // Everything is busy: this connection lives for one command only.
      entry.dead = false;
      entry.idleTimer = null;
      return entry;
    }
    closeEntry(idle);
  }
  list.push(entry);
  entries.set(key, list);
  return entry;
}

function totalConnections(): number {
  let count = 0;
  for (const list of entries.values()) count += list.length;
  return count;
}

function allEntries(): PoolEntry[] {
  return Array.from(entries.values()).flat();
}

function makeLease(entry: PoolEntry, reused: boolean, connectMs: number): SshLease {
  entry.active += 1;
  entry.lastUsedAt = Date.now();
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  let released = false;
  let broken = false;
  return {
    session: entry.session,
    reused,
    connectMs,
    markBroken: () => {
      broken = true;
      entry.dead = true;
    },
    release: () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
      entry.lastUsedAt = Date.now();
      if (entry.dead || broken) {
        if (entry.active === 0) closeEntry(entry, true);
        return;
      }
      // Only pooled entries are in the map; one-off connections are not.
      if (!listEntries(entry.key).includes(entry)) {
        closeEntry(entry, true);
        return;
      }
      if (entry.active > 0) return;
      if (Date.now() - entry.createdAt > MAX_AGE_MS) {
        closeEntry(entry);
        return;
      }
      scheduleIdleClose(entry);
    },
  };
}

/**
 * Returns a lease on an SSH connection to `creds`, opening one only when there is
 * no warm connection to reuse.
 */
export async function acquireSsh(
  creds: ConnectionCredentials,
  options: AcquireSshOptions = {}
): Promise<SshLease> {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (POOL_DISABLED) {
    // One connection per request, closed afterwards (the pre-pool behaviour).
    const started = Date.now();
    const session = await connectSsh(creds, timeoutMs);
    const oneOff: PoolEntry = {
      key: "",
      session,
      createdAt: started,
      lastUsedAt: started,
      active: 0,
      dead: false,
      closed: false,
      idleTimer: null,
    };
    return makeLease(oneOff, false, Date.now() - started);
  }

  const key = poolKey(creds);
  const reusable = pickEntry(key, Boolean(options.exclusive));
  if (reusable) {
    stats.reused += 1;
    return makeLease(reusable, true, 0);
  }

  // A shared request may attach to a handshake that is already in flight (the
  // terminal asks for `pwd` and the machine info at the same time).
  const started = Date.now();
  let session: ConnectedSshSession;
  const pending = connecting.get(key);
  if (pending && !Boolean(options.exclusive)) {
    session = await pending;
  } else {
    const handshake = connectSsh(creds, timeoutMs);
    connecting.set(key, handshake);
    try {
      session = await handshake;
    } finally {
      if (connecting.get(key) === handshake) connecting.delete(key);
    }
    stats.created += 1;
  }

  // The handshake may belong to a connection another request just registered.
  const existing = listEntries(key).find(
    (entry) =>
      entry.session.client === session.client && isUsable(entry, Boolean(options.exclusive))
  );
  if (existing) {
    stats.reused += 1;
    return makeLease(existing, true, 0);
  }

  const entry = register(key, session);
  return makeLease(entry, false, Date.now() - started);
}

/** Number of open pooled connections and the reuse counters (for tests). */
export function sshPoolStats(): {
  connections: number;
  active: number;
  created: number;
  reused: number;
  closed: number;
} {
  const all = allEntries();
  return {
    connections: all.length,
    active: all.filter((entry) => entry.active > 0).length,
    ...stats,
  };
}

/** Closes every pooled connection (tests, and shutdown). */
export function closeSshPool(): void {
  for (const entry of allEntries()) closeEntry(entry, true);
  entries.clear();
  connecting.clear();
}

export interface OpenExecChannelOptions {
  script: string;
  /** Allocate a PTY for the command (the usual interactive terminal). */
  pty?: PseudoTtyOptions | null;
  timeoutMs?: number;
}

export interface ExecChannelLease {
  channel: ClientChannel;
  lease: SshLease;
}

/** Errors that mean the SSH connection itself is gone, not the command. */
function isConnectionFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /not connected|not ready|connection (?:closed|lost|ended)|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timed out|destroyed|no response/i.test(
    message
  );
}

function openChannel(
  client: ConnectedSshSession["client"],
  options: OpenExecChannelOptions
): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    const execOptions = options.pty ? { pty: options.pty } : {};
    client.exec(options.script, execOptions, (err, channel) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(channel);
    });
  });
}

/**
 * Opens one command channel on `lease`.
 *
 * When a *reused* connection refuses the channel (a serverless instance that was
 * frozen until its socket died, a NAT that dropped the flow) the connection is
 * discarded and the channel is opened once more on a fresh one, which is returned
 * in the result. The command never started, so nothing runs twice.
 */
export async function openExecChannel(
  lease: SshLease,
  creds: ConnectionCredentials,
  options: OpenExecChannelOptions
): Promise<ExecChannelLease> {
  try {
    const channel = await openChannel(lease.session.client, options);
    return { channel, lease };
  } catch (err) {
    const retry = lease.reused;
    if (retry || isConnectionFailure(err)) lease.markBroken();
    lease.release();
    if (!retry) throw err;
    const fresh = await acquireSsh(creds, {
      timeoutMs: options.timeoutMs,
      exclusive: true,
    });
    try {
      const channel = await openChannel(fresh.session.client, options);
      return { channel, lease: fresh };
    } catch (retryErr) {
      fresh.markBroken();
      fresh.release();
      throw retryErr;
    }
  }
}

/** Acquire a connection and open one command channel on it. */
export async function openSshExecChannel(
  creds: ConnectionCredentials,
  options: OpenExecChannelOptions
): Promise<ExecChannelLease> {
  const lease = await acquireSsh(creds, {
    timeoutMs: options.timeoutMs,
    exclusive: true,
  });
  return openExecChannel(lease, creds, options);
}

export interface RunSshCommandOptions {
  script: string;
  timeoutMs?: number;
  /** Give up (and report what arrived so far) after this long. */
  maxWaitMs?: number;
  /**
   * Take the connection for this request alone. Off by default: key presses and the
   * machine-info probe are tiny, and they must be able to ride on the connection a
   * running command is already using.
   */
  exclusive?: boolean;
}

/**
 * Runs one short command on a pooled connection and collects its output.
 * Used for key delivery and the machine-info probe: both are single-line answers
 * that used to cost a full handshake each.
 */
export async function runSshCommand(
  creds: ConnectionCredentials,
  options: RunSshCommandOptions
): Promise<{ output: string; exitCode: number | null }> {
  const acquired = await acquireSsh(creds, {
    timeoutMs: options.timeoutMs,
    exclusive: Boolean(options.exclusive),
  });
  const { channel, lease } = await openExecChannel(acquired, creds, {
    script: options.script,
    timeoutMs: options.timeoutMs,
  });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      lease.release();
      resolve({ output, exitCode });
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      lease.markBroken();
      lease.release();
      reject(err);
    };
    const timer = options.maxWaitMs
      ? setTimeout(() => {
          // Give up on the answer, but do not leave the channel running.
          try {
            channel.close();
          } catch {
            // already closed
          }
          finish(null);
        }, options.maxWaitMs)
      : null;
    timer?.unref?.();

    channel.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    channel.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    channel.on("close", (code: number | null) => finish(code ?? 0));
    channel.on("error", (err: Error) => fail(err));
  });
}

/**
 * Distro / version / cloud provider of the remote machine, over the pooled
 * connection the terminal is already using.
 */
export async function fetchSshSystemInfoPooled(
  creds: ConnectionCredentials
): Promise<SshSystemInfo | null> {
  try {
    const { output } = await runSshCommand(creds, {
      script: SYSINFO_SCRIPT,
      timeoutMs: 12000,
      maxWaitMs: 8000,
    });
    const info = parseSysinfo(output);
    return info.os || info.hostname ? info : null;
  } catch {
    return null;
  }
}
