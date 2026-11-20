import type { ProtocolType, SystemCapabilities } from "@/types/connection";
import {
  getStoredAdminProfileCert,
  getStoredSessionToken,
} from "./auth-storage";

export interface GatewaySettings {
  gatewayUrl: string; // e.g. "" (local/same-origin) or "https://sushi-gw.example.com"
  gatewayToken: string;
}

const GATEWAY_SETTINGS_KEY = "sushi_gateway_settings_v1";

export function loadGatewaySettings(): GatewaySettings {
  const envDefault = process.env.NEXT_PUBLIC_GATEWAY_URL?.trim() || "";
  if (typeof window === "undefined") {
    return { gatewayUrl: envDefault, gatewayToken: "" };
  }
  try {
    const raw = localStorage.getItem(GATEWAY_SETTINGS_KEY);
    if (!raw) {
      return { gatewayUrl: envDefault, gatewayToken: "" };
    }
    const parsed = JSON.parse(raw) as Partial<GatewaySettings>;
    return {
      gatewayUrl: (parsed.gatewayUrl ?? envDefault).trim(),
      gatewayToken: (parsed.gatewayToken ?? "").trim(),
    };
  } catch {
    return { gatewayUrl: envDefault, gatewayToken: "" };
  }
}

export function saveGatewaySettings(settings: GatewaySettings): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    GATEWAY_SETTINGS_KEY,
    JSON.stringify({
      gatewayUrl: settings.gatewayUrl.trim().replace(/\/+$/, ""),
      gatewayToken: settings.gatewayToken.trim(),
    })
  );
}

/**
 * Converts a gateway base URL (or empty string for same-origin) to HTTP base URL.
 */
export function resolveGatewayHttpBase(gatewayUrl?: string): string {
  const raw = (gatewayUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.startsWith("wss://")) return "https://" + raw.slice(6);
  if (raw.startsWith("ws://")) return "http://" + raw.slice(5);
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `https://${raw}`;
}

/** How long Sushi waits for a gateway to answer before treating it as absent. */
export const GATEWAY_PROBE_TIMEOUT_MS = 8000;

export interface GatewayProbeResult {
  ok: boolean;
  /** The gateway's own capabilities, when it answered in time. */
  caps?: SystemCapabilities;
  /** Human-readable failure reason (`ok: false` only). */
  error?: string;
  /** True when the gateway simply did not answer in time. */
  timedOut?: boolean;
}

/**
 * Reads a remote gateway's `/api/system/capabilities`.
 *
 * Two details matter for managed hosts (a Render free instance sleeps after ~15
 * minutes idle, an unscaled Railway service can be cold):
 *
 *  - **It always settles.** A sleeping gateway can take a minute to boot, and this
 *    runs during vault boot — an unbounded `fetch` there would hang the whole app
 *    open, so the request is aborted after `GATEWAY_PROBE_TIMEOUT_MS` and reported
 *    as `timedOut` instead of stalling.
 *  - **It never uses a cached answer.** `cache: "no-store"` keeps a CDN or browser
 *    from reporting a gateway as healthy (or `websocketSsh: true`) when the
 *    deployment behind it has changed.
 *
 * Note that this HTTP probe succeeding does not by itself prove the WebSocket PTY
 * works — it proves the process is awake and what it claims to serve.
 */
export async function fetchGatewayCapabilities(
  settings: GatewaySettings,
  timeoutMs = GATEWAY_PROBE_TIMEOUT_MS
): Promise<GatewayProbeResult> {
  const raw = settings.gatewayUrl.trim();
  if (!raw) return { ok: false, error: "No gateway URL is set." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${resolveGatewayHttpBase(raw)}/api/system/capabilities`, {
      headers: getAuthHeaders(settings),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `Gateway returned HTTP ${res.status}` };
    return { ok: true, caps: (await res.json()) as SystemCapabilities };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        timedOut: true,
        error: `Gateway did not answer within ${Math.round(timeoutMs / 1000)} s. If it is on a plan that sleeps when idle, wake it and try again.`,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Gateway connection failed.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds WebSocket endpoint URL for /ws/ssh or /ws/rdp.
 * Uses relative window.location.host when no external gateway URL is set.
 */
export function buildWebSocketUrl(
  wsPath: "/ws/ssh" | "/ws/rdp" | "/ws/rdp-cleanpath",
  settings: GatewaySettings
): string {
  const raw = settings.gatewayUrl.trim().replace(/\/+$/, "");
  let baseWs: string;

  if (!raw) {
    const proto =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "wss:"
        : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "";
    baseWs = `${proto}//${host}`;
  } else if (raw.startsWith("ws://") || raw.startsWith("wss://")) {
    baseWs = raw;
  } else if (raw.startsWith("https://")) {
    baseWs = "wss://" + raw.slice(8);
  } else if (raw.startsWith("http://")) {
    baseWs = "ws://" + raw.slice(7);
  } else {
    baseWs = `wss://${raw}`;
  }

  return `${baseWs}${wsPath}`;
}

export function getAuthHeaders(settings: GatewaySettings): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const sessionToken = getStoredSessionToken();
  if (sessionToken) {
    headers["X-Sushi-Session"] = sessionToken;
  }
  const adminCert = getStoredAdminProfileCert();
  if (adminCert) {
    headers["X-Sushi-Admin-Cert"] = adminCert;
  }
  if (settings.gatewayToken) {
    headers["X-Sushi-Token"] = settings.gatewayToken;
  }
  return headers;
}

export interface ParsedQuickTarget {
  protocol: ProtocolType;
  username: string;
  host: string;
  port: number;
  initialPath?: string;
}

/**
 * Parses CLI strings or URIs such as:
 * - "ssh ubuntu@198.51.100.12 -p 2222"
 * - "sftp://deploy@example.com:22/var/www"
 * - "rdp://Administrator@10.0.0.25:3389"
 * - "root@192.0.2.10:22"
 */
export function parseQuickConnectInput(input: string): ParsedQuickTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // URI form: ssh://, sftp://, rdp://
  const uriMatch = /^(ssh|sftp|rdp):\/\/(?:([^@/\s]+)@)?([^:/\s]+)(?::(\d+))?(\/.*)?$/i.exec(
    trimmed
  );
  if (uriMatch) {
    const protocol = uriMatch[1].toLowerCase() as ProtocolType;
    const defaultPort = protocol === "rdp" ? 3389 : 22;
    const defaultUser = protocol === "rdp" ? "Administrator" : "root";
    return {
      protocol,
      username: decodeURIComponent(uriMatch[2] || defaultUser),
      host: uriMatch[3],
      port: uriMatch[4] ? Number(uriMatch[4]) : defaultPort,
      initialPath: uriMatch[5] || undefined,
    };
  }

  // CLI form: "ssh -p 2222 user@host" or "sftp user@host"
  let working = trimmed;
  let protocol: ProtocolType = "ssh";
  if (/^sftp\s+/i.test(working)) {
    protocol = "sftp";
    working = working.replace(/^sftp\s+/i, "");
  } else if (/^rdp\s+/i.test(working)) {
    protocol = "rdp";
    working = working.replace(/^rdp\s+/i, "");
  } else if (/^ssh\s+/i.test(working)) {
    protocol = "ssh";
    working = working.replace(/^ssh\s+/i, "");
  }

  let explicitPort: number | undefined;
  const portFlag = /(?:-p|-P)\s*(\d+)/.exec(working);
  if (portFlag) {
    explicitPort = Number(portFlag[1]);
    working = working.replace(portFlag[0], "").trim();
  }

  const tokens = working.split(/\s+/).filter((t) => !t.startsWith("-"));
  const target = tokens[0] || "";
  if (!target) return null;

  const userHostMatch = /^(?:([^@\s]+)@)?([^:/\s]+)(?::(\d+))?(?::(\/.*))?$/.exec(target);
  if (!userHostMatch) return null;

  const defaultPort = protocol === "rdp" ? 3389 : 22;
  const defaultUser = protocol === "rdp" ? "Administrator" : "root";

  return {
    protocol,
    username: userHostMatch[1] || defaultUser,
    host: userHostMatch[2],
    port: explicitPort || (userHostMatch[3] ? Number(userHostMatch[3]) : defaultPort),
    initialPath: userHostMatch[4] || undefined,
  };
}
