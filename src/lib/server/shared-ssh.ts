import crypto from "node:crypto";
import type { ClientChannel } from "ssh2";
import type { WebSocket } from "ws";
import type { ConnectedSshSession } from "./ssh-client";
import type { ShareAccountIssuer } from "./share-ticket";

/**
 * Team sharing for one interactive SSH PTY.
 *
 * A Sushi terminal normally owns its shell: one browser tab, one `ssh2` channel, and
 * when the tab closes the shell dies. Sharing wraps that single channel in a
 * `SharedSshSession` that many browsers attach to at once:
 *
 *   - **Everyone sees the same screen.** Shell output is written to every attached
 *     participant, and a bounded scrollback ring buffer is replayed to whoever joins
 *     late so they land on the same prompt instead of a blank terminal.
 *   - **Everyone can type** (when the share was started in write mode). Keystrokes go
 *     into the one real PTY, exactly as if the team were passing a keyboard around.
 *   - **The shell outlives every browser.** Participants detach on disconnect and the
 *     SSH channel stays open on the gateway, so a teammate can close their laptop and
 *     somebody else re-attaches to the same shell hours later and keeps working.
 *
 * This is inherently a *shared credential* feature: whoever joins runs commands as the
 * SSH user whose session is being shared. It only exists on a persistent Node process
 * (VPS, Docker, or a `GATEWAY_ONLY` gateway) — serverless Vercel has no place to keep a
 * live PTY between requests.
 */

/** How long a shell with nobody attached is kept before it is reaped. */
function idleTtlMs(): number {
  const raw = Number(process.env.SUSHI_SHARE_IDLE_TTL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 12 * 60 * 60 * 1000;
}

/** Scrollback kept per shared shell for late joiners. */
function scrollbackCapBytes(): number {
  const raw = Number(process.env.SUSHI_SHARE_SCROLLBACK_BYTES);
  return Number.isFinite(raw) && raw >= 8 * 1024 ? raw : 256 * 1024;
}

/** Hard cap on concurrently shared shells, so a leak cannot exhaust the gateway. */
function maxSessions(): number {
  const raw = Number(process.env.SUSHI_SHARE_MAX_SESSIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(500, Math.floor(raw)) : 50;
}

/** Wrong passcodes tolerated per share before it starts refusing. */
const MAX_FAILED_PASSCODES = 8;
const FAILED_WINDOW_MS = 10 * 60 * 1000;

const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export interface SharedParticipant {
  id: string;
  name: string;
  role: "owner" | "guest";
  canWrite: boolean;
  joinedAt: number;
  lastInputAt: number;
  cols: number;
  rows: number;
}

export interface SharedSessionSummary {
  shareId: string;
  host: string;
  port: number;
  username: string;
  label: string;
  createdAt: number;
  lastActivityAt: number;
  status: "live" | "ended";
  /** Guests may send keystrokes (the share was started in write mode). */
  write: boolean;
  requiresPasscode: boolean;
  accountTickets: boolean;
  scrollbackBytes: number;
  participants: SharedParticipant[];
}

export interface SharedSessionLimits {
  maxSessions: number;
  idleTtlMs: number;
  scrollbackBytes: number;
  count: number;
}

interface ParticipantEntry extends SharedParticipant {
  ws: WebSocket;
}

export interface SharedSessionOptions {
  host: string;
  port: number;
  username: string;
  label?: string;
  ssh: ConnectedSshSession;
  stream: ClientChannel;
  cols: number;
  rows: number;
  /** Guests may type (true) or only watch (false). */
  write: boolean;
  /** `auto` mints a 6-digit code, a string uses it, `null` = Sushi account only. */
  passcode?: "auto" | string | null;
  /** Pinned verifier for account joins from the frontend that published the share. */
  accountIssuer?: ShareAccountIssuer | null;
}

/**
 * Passcodes are only ever compared in memory (a shared shell dies with the process),
 * so the HMAC key is a throwaway per-process secret rather than a persisted one.
 */
const PASSCODE_SECRET = crypto.randomBytes(32);

function hashPasscode(shareId: string, code: string): Buffer {
  return crypto
    .createHmac("sha256", PASSCODE_SECRET)
    .update(`${shareId}:${code}`)
    .digest();
}

export function generateSharePasscode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function createShareId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

export class SharedSshSession {
  readonly shareId: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly label: string;
  readonly accountIssuer: ShareAccountIssuer | null;
  readonly createdAt = Date.now();

  private readonly participants = new Map<string, ParticipantEntry>();
  private readonly ring: Buffer[] = [];
  private ringBytes = 0;
  private passcodeHash: Buffer | null;
  private failedAttempts = 0;
  private failedWindowStart = 0;
  private cols: number;
  private rows: number;
  private destroyed = false;

  lastActivityAt = Date.now();
  status: "live" | "ended" = "live";
  write: boolean;
  ssh: ConnectedSshSession;
  stream: ClientChannel;

  constructor(options: SharedSessionOptions) {
    this.shareId = createShareId();
    this.host = options.host;
    this.port = options.port;
    this.username = options.username;
    this.label = options.label?.trim() || `${options.username}@${options.host}:${options.port}`;
    this.accountIssuer = options.accountIssuer ?? null;
    this.ssh = options.ssh;
    this.stream = options.stream;
    this.cols = clamp(options.cols, MIN_COLS, MAX_COLS);
    this.rows = clamp(options.rows, MIN_ROWS, MAX_ROWS);
    this.write = options.write;

    // `undefined` means "the caller did not say" (mint a code); an explicit `null`
    // means "no code at all" — only signed-in Sushi accounts may join.
    const requested = options.passcode === undefined ? "auto" : options.passcode;
    if (requested === null) {
      this.passcodeHash = null;
    } else {
      const code = requested === "auto" ? generateSharePasscode() : requested;
      this.passcodeHash = hashPasscode(this.shareId, code);
    }
  }

  // ---- participants ----------------------------------------------------------

  get participantCount(): number {
    return this.participants.size;
  }

  get hasAttachedOwner(): boolean {
    for (const entry of this.participants.values()) {
      if (entry.role === "owner") return true;
    }
    return false;
  }

  get requiresPasscode(): boolean {
    return this.passcodeHash !== null;
  }

  /**
   * Set by the socket that published the shell. Stopping a share from the HTTP API
   * happens on that socket's behalf, so it has to be told to go back to a private
   * terminal instead of still piping bytes into a share that no longer exists.
   */
  onRevokedByApi: (() => void) | null = null;

  attach(
    ws: WebSocket,
    opts: { role: "owner" | "guest"; name?: string; canWrite?: boolean; cols?: number; rows?: number }
  ): ParticipantEntry {
    const id = crypto.randomUUID();
    const entry: ParticipantEntry = {
      id,
      ws,
      role: opts.role,
      name: (opts.name || "").trim() || (opts.role === "owner" ? "Host" : `Guest ${this.participants.size + 1}`),
      canWrite: opts.canWrite ?? this.write,
      joinedAt: Date.now(),
      lastInputAt: 0,
      cols: clamp(opts.cols ?? this.cols, MIN_COLS, MAX_COLS),
      rows: clamp(opts.rows ?? this.rows, MIN_ROWS, MAX_ROWS),
    };
    this.participants.set(id, entry);
    this.lastActivityAt = Date.now();
    this.applySize();
    return entry;
  }

  detach(id: string): void {
    this.participants.delete(id);
    this.lastActivityAt = Date.now();
    this.applySize();
    this.broadcastParticipants();
  }

  rename(id: string, name: string): void {
    const entry = this.participants.get(id);
    if (!entry) return;
    entry.name = name.trim() || entry.name;
    this.broadcastParticipants();
  }

  participantsList(): SharedParticipant[] {
    return [...this.participants.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      canWrite: p.canWrite,
      joinedAt: p.joinedAt,
      lastInputAt: p.lastInputAt,
      cols: p.cols,
      rows: p.rows,
    }));
  }

  // ---- shell traffic ---------------------------------------------------------

  handleOutput(chunk: Buffer): void {
    if (this.destroyed) return;
    this.lastActivityAt = Date.now();
    this.appendScrollback(chunk);
    const data = chunk.toString("base64");
    for (const entry of this.participants.values()) {
      this.send(entry, { type: "data", data });
    }
  }

  handleInput(id: string, data: string): void {
    const entry = this.participants.get(id);
    if (!entry || this.destroyed) return;
    // Per-participant: the host keeps typing in a share that is read-only for guests.
    if (!entry.canWrite) return;
    if (typeof data !== "string" || data.length === 0) return;
    this.lastActivityAt = Date.now();
    entry.lastInputAt = Date.now();
    try {
      this.stream.write(data);
    } catch {
      // the channel is going away; the close handler will tell everyone
      return;
    }
    // Show who is driving without echoing what they typed.
    for (const other of this.participants.values()) {
      if (other.id === id) continue;
      this.send(other, { type: "activity", by: entry.name, at: entry.lastInputAt });
    }
  }

  handleResize(id: string, cols: number, rows: number): void {
    const entry = this.participants.get(id);
    if (!entry) return;
    entry.cols = clamp(cols, MIN_COLS, MAX_COLS);
    entry.rows = clamp(rows, MIN_ROWS, MAX_ROWS);
    this.lastActivityAt = Date.now();
    this.applySize();
  }

  /** The PTY keeps the smallest attached screen so nobody's lines wrap. */
  private applySize(): void {
    if (this.destroyed || this.status !== "live") return;
    let cols = Number.POSITIVE_INFINITY;
    let rows = Number.POSITIVE_INFINITY;
    for (const entry of this.participants.values()) {
      cols = Math.min(cols, entry.cols);
      rows = Math.min(rows, entry.rows);
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.stream.setWindow(rows, cols, 0, 0);
    } catch {
      // ignore
    }
  }

  get terminalSize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  // ---- scrollback ------------------------------------------------------------

  private appendScrollback(chunk: Buffer): void {
    const cap = scrollbackCapBytes();
    if (chunk.length >= cap) {
      this.ring.length = 0;
      this.ring.push(Buffer.from(chunk.subarray(chunk.length - cap)));
      this.ringBytes = cap;
      return;
    }
    this.ring.push(chunk);
    this.ringBytes += chunk.length;
    while (this.ringBytes > cap && this.ring.length > 1) {
      const dropped = this.ring.shift();
      if (!dropped) break;
      this.ringBytes -= dropped.length;
    }
  }

  get scrollbackBytes(): number {
    return this.ringBytes;
  }

  /** Everything still buffered, so a late joiner sees the same screen. */
  replay(): Buffer {
    return this.ring.length ? Buffer.concat(this.ring) : Buffer.alloc(0);
  }

  // ---- access ----------------------------------------------------------------

  verifyPasscode(code: string | undefined | null): { ok: boolean; error?: string } {
    if (!code || !/^\d{6}$/.test(code.trim())) {
      return { ok: false, error: "Enter the 6-digit share code." };
    }
    if (Date.now() - this.failedWindowStart > FAILED_WINDOW_MS) {
      this.failedAttempts = 0;
      this.failedWindowStart = Date.now();
    }
    if (this.failedAttempts >= MAX_FAILED_PASSCODES) {
      return {
        ok: false,
        error: "Too many wrong codes for this shared session. Ask the host to stop and share it again.",
      };
    }
    if (!this.passcodeHash) {
      return { ok: false, error: "This session is only open to signed-in Sushi accounts." };
    }
    const candidate = hashPasscode(this.shareId, code.trim());
    const ok =
      candidate.length === this.passcodeHash.length &&
      crypto.timingSafeEqual(candidate, this.passcodeHash);
    if (!ok) {
      this.failedAttempts += 1;
      this.failedWindowStart = this.failedWindowStart || Date.now();
      return { ok: false, error: "Wrong share code." };
    }
    this.failedAttempts = 0;
    return { ok: true };
  }

  /** Mints a fresh code and hands it back once (it is not recoverable afterwards). */
  rotatePasscode(mode: "auto" | string | null = "auto"): string | null {
    if (mode === null) {
      this.passcodeHash = null;
      this.failedAttempts = 0;
      return null;
    }
    let code = mode === "auto" ? generateSharePasscode() : mode;
    if (mode === "auto" && this.passcodeHash) {
      // Rotation must actually invalidate the previous code, even in the rare
      // event that the random generator initially picks the same six digits.
      while (crypto.timingSafeEqual(hashPasscode(this.shareId, code), this.passcodeHash)) {
        code = generateSharePasscode();
      }
    }
    this.passcodeHash = hashPasscode(this.shareId, code);
    this.failedAttempts = 0;
    this.failedWindowStart = 0;
    return code;
  }

  // ---- messaging -------------------------------------------------------------

  private send(entry: ParticipantEntry, payload: Record<string, unknown>): void {
    if (entry.ws.readyState !== 1 /* WebSocket.OPEN */) return;
    try {
      entry.ws.send(JSON.stringify(payload));
    } catch {
      // a dying socket is cleaned up by the gateway's own close handler
    }
  }

  sendTo(id: string, payload: Record<string, unknown>): void {
    const entry = this.participants.get(id);
    if (entry) this.send(entry, payload);
  }

  broadcast(payload: Record<string, unknown>): void {
    for (const entry of this.participants.values()) {
      this.send(entry, payload);
    }
  }

  broadcastParticipants(): void {
    this.broadcast({ type: "participants", participants: this.participantsList() });
  }

  /** API rotations must update the publisher without giving a new code to guests. */
  notifyPublisherOfRotation(code: string | null): void {
    for (const entry of this.participants.values()) {
      if (entry.role === "owner") {
        this.send(entry, { type: "share", action: "rotated", passcode: code || undefined, share: this.summary() });
      }
    }
  }

  // ---- teardown --------------------------------------------------------------

  /**
   * Stops sharing but keeps the host's shell: guests are disconnected and the share
   * ID stops working, while the owner's terminal carries on in its own tab.
   *
   * `notifyOwner` is used when the request came from the HTTP API (or another
   * surface) rather than from the host's own socket, which still needs to be told.
   */
  revoke(reason = "The host stopped sharing this session.", opts: { notifyOwner?: boolean } = {}): void {
    if (this.destroyed) return;
    removeSharedSession(this.shareId);
    for (const entry of [...this.participants.values()]) {
      if (entry.role === "owner") {
        if (opts.notifyOwner) {
          this.send(entry, { type: "share", action: "stopped", reason });
        }
        continue;
      }
      this.send(entry, { type: "share-closed", reason });
      try {
        entry.ws.close(1000, "Share ended");
      } catch {
        // ignore
      }
    }
    this.participants.clear();
    if (opts.notifyOwner) this.onRevokedByApi?.();
  }

  /** Ends the SSH channel and disconnects everybody (the shell is really gone). */
  destroy(reason = "The shared session ended."): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.status = "ended";
    removeSharedSession(this.shareId);
    this.broadcast({ type: "exit", reason });
    for (const entry of [...this.participants.values()]) {
      try {
        entry.ws.close(1000, "Shared session ended");
      } catch {
        // ignore
      }
    }
    this.participants.clear();
    try {
      this.stream.close();
    } catch {
      // ignore
    }
    try {
      this.ssh.client.end();
    } catch {
      // ignore
    }
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  summary(): SharedSessionSummary {
    return {
      shareId: this.shareId,
      host: this.host,
      port: this.port,
      username: this.username,
      label: this.label,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      status: this.status,
      write: this.write,
      requiresPasscode: this.requiresPasscode,
      accountTickets: Boolean(this.accountIssuer),
      scrollbackBytes: this.scrollbackBytes,
      participants: this.participantsList(),
    };
  }
}

// ---- registry ----------------------------------------------------------------

const REGISTRY_KEY = "__SUSHI_SHARED_SSH_SESSIONS__";
let reaperStarted = false;

function registry(): Map<string, SharedSshSession> {
  const scope = globalThis as Record<string, unknown>;
  let map = scope[REGISTRY_KEY] as Map<string, SharedSshSession> | undefined;
  if (!map) {
    map = new Map<string, SharedSshSession>();
    scope[REGISTRY_KEY] = map;
  }
  return map;
}

/**
 * Detached shells are the whole point of sharing, so nobody should have to remember
 * to clean them up: an idle share (no participant for `SUSHI_SHARE_IDLE_TTL_MS`) is
 * closed and its SSH connection released. The timer never holds the process open.
 */
function startReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...registry().values()]) {
      if (session.participantCount > 0) continue;
      if (now - session.lastActivityAt < idleTtlMs()) continue;
      session.destroy(`Shared session closed after ${Math.round(idleTtlMs() / 3600000)}h idle.`);
    }
  }, 60_000);
  timer.unref?.();
}

export function registerSharedSession(session: SharedSshSession): { ok: boolean; error?: string } {
  const map = registry();
  if (map.size >= maxSessions()) {
    return {
      ok: false,
      error: `Too many shared sessions on this gateway (limit ${maxSessions()}). Stop an existing share first.`,
    };
  }
  map.set(session.shareId, session);
  startReaper();
  return { ok: true };
}

export function getSharedSession(shareId: string): SharedSshSession | undefined {
  return registry().get(shareId.trim());
}

export function removeSharedSession(shareId: string): void {
  registry().delete(shareId);
}

export function listSharedSessions(): SharedSessionSummary[] {
  return [...registry().values()].map((s) => s.summary());
}

/**
 * Stops a share from the HTTP API. A shell whose host is still attached is only
 * un-published (the host keeps working); one that is running detached with nobody in
 * it is ended for real, because that is the only way to release its SSH connection.
 */
export function stopSharedSession(shareId: string, reason?: string): { ok: boolean; error?: string } {
  const session = getSharedSession(shareId.trim());
  if (!session) return { ok: false, error: "No active share with that ID." };
  if (session.hasAttachedOwner) {
    session.revoke(reason || "The share was stopped from the Sushi dashboard.", {
      notifyOwner: true,
    });
  } else {
    session.destroy(reason || "The shared session was stopped.");
  }
  return { ok: true };
}

export function rotateSharedPasscode(
  shareId: string,
  mode: "auto" | string | null = "auto"
): { ok: boolean; passcode?: string | null; error?: string } {
  const session = getSharedSession(shareId.trim());
  if (!session) return { ok: false, error: "No active share with that ID." };
  const passcode = session.rotatePasscode(mode);
  session.notifyPublisherOfRotation(passcode);
  return { ok: true, passcode };
}

/** Used by the terminal to offer "rejoin" for a shell that is still being shared. */
export function findSharedSessionByHost(
  host: string,
  port: number,
  username: string
): SharedSshSession | undefined {
  const target = `${username}@${host}:${port}`;
  return [...registry().values()].find(
    (s) => s.status === "live" && `${s.username}@${s.host}:${s.port}` === target
  );
}

export function sharedSessionLimits(): SharedSessionLimits {
  return {
    maxSessions: maxSessions(),
    idleTtlMs: idleTtlMs(),
    scrollbackBytes: scrollbackCapBytes(),
    count: registry().size,
  };
}

/** Test hook: drops every share so a fresh run starts from a clean registry. */
export function clearSharedSessionsForTests(): void {
  for (const session of [...registry().values()]) {
    session.destroy("cleared");
  }
  registry().clear();
}
