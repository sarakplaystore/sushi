import type { ConnectionCredentials } from "@/types/connection";
import type { ExecElevation } from "./exec-script";

/**
 * Bidirectional Serverless SSH exec.
 *
 * On Vercel there is no long-lived PTY: every command is one HTTP request that runs
 * one SSH exec. That used to make any command that asks a question (`apt install` →
 * `[Y/n]`, `ssh-keygen` → passphrase, `rm -i`, a `sudo` prompt, …) a dead end,
 * because nothing could reach the command's stdin and the terminal refused further
 * input while it was running.
 *
 * The fix is to make the *request body* the command's stdin. The body is
 * `application/x-ndjson` and stays open for the whole command:
 *
 *   {"type":"start","credentials":…,"command":"apt install docker"}   ← first line
 *   {"type":"input","data":"y\r"}                                     ← keystrokes
 *   {"type":"signal","signal":"INT"}                                  ← Ctrl+C
 *
 * Responses keep streaming NDJSON on the other side, so one HTTP request is a real
 * two-way channel. Clients that cannot stream request bodies still send a plain
 * JSON body and behave exactly as before.
 */

export interface ExecStartPayload {
  credentials?: ConnectionCredentials;
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  elevate?: ExecElevation;
  /** Ask for a remote keystroke FIFO so keys can arrive through a second exec. */
  keyChannel?: boolean;
}

export type ExecInputEvent =
  | { type: "start"; payload: ExecStartPayload }
  | { type: "input"; data: string }
  | { type: "signal"; signal: "INT" | "TERM" | "KILL" | "HUP" };

const SIGNALS = new Set(["INT", "TERM", "KILL", "HUP"]);

/** Parses one NDJSON request line. Returns null for blank/unparsable lines. */
export function parseExecInputLine(line: string): ExecInputEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as Record<string, unknown>;

  if (message.type === "start") {
    return { type: "start", payload: (message.payload || message) as ExecStartPayload };
  }

  if (message.type === "input" && typeof message.data === "string") {
    return { type: "input", data: message.data };
  }

  if (message.type === "signal" && typeof message.signal === "string") {
    const signal = message.signal.toUpperCase().replace(/^SIG/, "");
    if (SIGNALS.has(signal)) {
      return { type: "signal", signal: signal as "INT" | "TERM" | "KILL" | "HUP" };
    }
  }

  return null;
}

/**
 * Splits a stream chunk into complete NDJSON events, keeping the trailing partial
 * line. Keystroke payloads are tiny but a chunk can still split one in half.
 */
export function decodeExecChunk(
  carry: string,
  chunk: string
): { events: ExecInputEvent[]; carry: string } {
  const combined = carry + chunk;
  const lines = combined.split("\n");
  const rest = lines.pop() ?? "";
  const events: ExecInputEvent[] = [];
  for (const line of lines) {
    const event = parseExecInputLine(line);
    if (event) events.push(event);
  }
  return { events, carry: rest };
}

/**
 * Reads the first `start` event from a streamed request body.
 *
 * The timeout matters: if a proxy (or the platform) buffers request bodies before
 * invoking the function, this read would block until the whole body arrives — which
 * for a long-running command means forever. Timing out lets the route fail fast and
 * the client retry with the plain JSON body instead.
 */
export async function readExecStart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { timeoutMs?: number } = {}
): Promise<{ start: ExecStartPayload | null; carry: string; timedOut: boolean }> {
  const decoder = new TextDecoder();
  const timeoutMs = options.timeoutMs ?? 5000;
  let carry = "";

  const withTimeout = async (): Promise<{ value?: Uint8Array; done: boolean; timedOut: boolean }> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        reader.read().then((r) => ({ ...r, timedOut: false })),
        new Promise<{ value: undefined; done: boolean; timedOut: boolean }>((resolve) => {
          timer = setTimeout(() => resolve({ value: undefined, done: false, timedOut: true }), timeoutMs);
        }),
      ]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // A start line is small; bound the loop so a malformed client cannot hang us.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const { value, done, timedOut } = await withTimeout();
    if (timedOut) return { start: null, carry, timedOut: true };
    if (done) return { start: null, carry, timedOut: false };
    const decoded = decodeExecChunk(carry, decoder.decode(value, { stream: true }));
    carry = decoded.carry;
    for (const event of decoded.events) {
      if (event.type === "start") return { start: event.payload, carry, timedOut: false };
    }
  }
  return { start: null, carry, timedOut: false };
}

/**
 * Pumps stdin events from the request body onto the running SSH channel until the
 * body ends, the command closes, or `isClosed()` turns true.
 */
export async function pumpExecInput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  carry: string,
  handlers: {
    onInput: (data: string) => void;
    onSignal: (signal: "INT" | "TERM" | "KILL" | "HUP") => void;
    isClosed: () => boolean;
  }
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = carry;

  const dispatch = (events: ExecInputEvent[]) => {
    for (const event of events) {
      if (event.type === "input") {
        if (!handlers.isClosed()) handlers.onInput(event.data);
      } else if (event.type === "signal") {
        if (!handlers.isClosed()) handlers.onSignal(event.signal);
      }
      if (handlers.isClosed()) return false;
    }
    return true;
  };

  if (carry) {
    const buffered = decodeExecChunk("", pending);
    pending = buffered.carry;
    if (!dispatch(buffered.events)) return;
  }

  for (;;) {
    if (handlers.isClosed()) return;
    const { value, done } = await reader.read();
    if (done) return;
    const decoded = decodeExecChunk(pending, decoder.decode(value, { stream: true }));
    pending = decoded.carry;
    if (!dispatch(decoded.events)) return;
  }
}
