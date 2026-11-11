import type { ConnectionCredentials } from "@/types/connection";
import { getAuthHeaders, resolveGatewayHttpBase, type GatewaySettings } from "./gateway";

/**
 * Client side of "is my command still running?" (`/api/ssh/exec/run`).
 *
 * A run that used No timeout keeps running on the host after the tab is closed or
 * reloaded. Its keystroke FIFO and `/tmp` log are still there, so one request answers
 * whether it is alive and returns the log tail — that is what lets a reopened session
 * (or the "go back?" prompt) show where the command got to without re-running it.
 *
 * Prefers the attached VPS gateway, exactly like the other exec helpers: on Vercel the
 * gateway is the machine that can actually reach the host.
 */

export interface RunStatusResult {
  ok: boolean;
  /** The wrapper is still on the host, i.e. the command has not finished. */
  running: boolean;
  /** The output log is still readable (kept after the command ends). */
  logExists: boolean;
  logBytes: number;
  /** Log tail as the host wrote it (may contain control sequences). */
  output: string;
  /** Plain-text last lines, for a one-glance preview. */
  preview: string[];
  error?: string;
}

export interface RunStatusTarget {
  credentials: ConnectionCredentials;
  keyChannel?: string;
  runLog?: string;
  tailBytes?: number;
}

/** Never throws: a failed probe reports `ok: false` and the UI keeps its state. */
export async function fetchRunStatus(
  target: RunStatusTarget,
  settings: GatewaySettings,
  options: { timeoutMs?: number } = {}
): Promise<RunStatusResult> {
  const empty: RunStatusResult = {
    ok: false,
    running: false,
    logExists: false,
    logBytes: -1,
    output: "",
    preview: [],
  };
  if (!target.keyChannel && !target.runLog) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const apiBase = resolveGatewayHttpBase(settings.gatewayUrl);
    const res = await fetch(apiBase ? `${apiBase}/api/ssh/exec/run` : "/api/ssh/exec/run", {
      method: "POST",
      headers: getAuthHeaders(settings),
      signal: controller.signal,
      body: JSON.stringify({
        credentials: target.credentials,
        keyChannel: target.keyChannel,
        runLog: target.runLog,
        ...(target.tailBytes ? { tailBytes: target.tailBytes } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<RunStatusResult> & {
      error?: string;
    };
    if (!res.ok || data.ok === false) {
      return { ...empty, error: data.error || `HTTP ${res.status}` };
    }
    return {
      ok: true,
      running: Boolean(data.running),
      logExists: Boolean(data.logExists),
      logBytes: Number(data.logBytes ?? -1),
      output: typeof data.output === "string" ? data.output : "",
      preview: Array.isArray(data.preview) ? data.preview.filter((line) => typeof line === "string") : [],
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : "Could not check the run on the host.",
    };
  } finally {
    clearTimeout(timer);
  }
}
