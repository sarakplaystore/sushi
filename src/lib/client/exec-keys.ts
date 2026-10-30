import type { ConnectionCredentials } from "@/types/connection";
import { getAuthHeaders, type GatewaySettings } from "./gateway";

/**
 * Keystrokes for a command that is already running in serverless mode.
 *
 * A browser can only stream a request body on Chromium over HTTP/2, so on Firefox,
 * Safari, or behind a proxy that buffers bodies there is no way to type into the
 * running exec. Sushi therefore gives such commands a keystroke FIFO on the remote
 * host (`/api/ssh/exec` → `keyChannel`), and every key press becomes its own small
 * request. The remote host — not the serverless instance — holds the state, so this
 * works no matter which instance answers.
 */
export interface ExecKeyChannel {
  /** FIFO reported by `/api/ssh/exec` in its `ready` event. */
  path: string;
  credentials: ConnectionCredentials;
}

export type KeyDeliveryResult = "delivered" | "missing" | "failed";

/** Sends raw terminal bytes (an arrow-key escape sequence, `"\r"`, `"y"`, …). */
export async function sendKeyChannelInput(
  channel: ExecKeyChannel,
  keys: string,
  settings: GatewaySettings,
  timeoutMs = 12000
): Promise<KeyDeliveryResult> {
  if (!keys) return "delivered";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/ssh/exec/keys", {
      method: "POST",
      headers: getAuthHeaders(settings),
      signal: controller.signal,
      body: JSON.stringify({
        credentials: channel.credentials,
        path: channel.path,
        keys,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: KeyDeliveryResult;
    };
    if (data.result === "delivered" || data.result === "missing") return data.result;
    return data.ok ? "delivered" : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merges keystrokes typed in quick succession into one round trip.
 *
 * Every delivery is its own SSH exec, so a word typed at 30 ms per character would
 * otherwise become one round trip per character. Keys that drive a terminal UI
 * (arrows, Enter, Escape) are flushed immediately instead — a menu must react at once.
 */
export function createKeyBatcher(
  flush: (keys: string) => void | Promise<unknown>,
  delayMs = 180
): { push: (data: string) => void; flushNow: () => void; dispose: () => void } {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    timer = null;
    if (!buffer) return;
    const payload = buffer;
    buffer = "";
    void flush(payload);
  };

  return {
    push(data: string) {
      buffer += data;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    flushNow() {
      if (timer) clearTimeout(timer);
      run();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      buffer = "";
    },
  };
}
