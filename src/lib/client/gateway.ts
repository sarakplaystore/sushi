import type { ProtocolType } from "@/types/connection";
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

/**
 * Builds WebSocket endpoint URL for /ws/ssh or /ws/rdp.
 * Uses relative window.location.host when no external gateway URL is set.
 */
export function buildWebSocketUrl(
  wsPath: "/ws/ssh" | "/ws/rdp",
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
