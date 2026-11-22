import { getAuthHeaders, type GatewaySettings } from "./gateway";
import { isShareId, normalizeShareGateway } from "@/lib/share-gateway";

/**
 * Client-side helpers for team-shared SSH sessions.
 *
 * The wire shapes here mirror `src/lib/server/shared-ssh.ts`: one shell, many
 * attached browsers. Everything in this file is presentation and plumbing — no
 * credentials ever travel through it, because joining a share hands you a shell that
 * is already authenticated on the host.
 */

export interface SharedParticipantView {
  id: string;
  name: string;
  role: "owner" | "guest";
  canWrite: boolean;
  joinedAt: number;
  lastInputAt: number;
  cols: number;
  rows: number;
}

export interface SharedSessionView {
  shareId: string;
  host: string;
  port: number;
  username: string;
  label: string;
  createdAt: number;
  lastActivityAt: number;
  status: "live" | "ended";
  /** Guests may send keystrokes. */
  write: boolean;
  requiresPasscode: boolean;
  /** This gateway pinned the frontend's public verifier for scoped account tickets. */
  accountTickets?: boolean;
  scrollbackBytes: number;
  participants: SharedParticipantView[];
  /** Set on the socket that owns the share. */
  participantId?: string;
}

export interface ShareListResponse {
  ok: boolean;
  shares?: SharedSessionView[];
  requiresGateway?: boolean;
  error?: string;
  limits?: { maxSessions: number; idleTtlMs: number; scrollbackBytes: number; count: number };
}

const SHARE_NAME_KEY = "sushi.share.displayName.v1";
const SHARE_PASSCODE_PREFIX = "sushi.share.passcode.";

/** The URL names the actual gateway, never its token, a session token or a code. */
export function buildShareJoinUrl(shareId: string, gatewayUrl = ""): string {
  if (!isShareId(shareId)) throw new Error("Invalid share ID.");
  const gateway = normalizeShareGateway(gatewayUrl);
  const path = `/share/${encodeURIComponent(shareId)}`;
  const query = gateway ? `?${new URLSearchParams({ gateway }).toString()}` : "";
  return `${typeof window === "undefined" ? "" : window.location.origin}${path}${query}`;
}

/** Do not silently fall back to a visitor's unrelated saved gateway. */
export function gatewayFromShareSearch(search: string): string {
  const values = new URLSearchParams(search).getAll("gateway");
  if (values.length === 0) return "";
  if (values.length !== 1 || !values[0].trim()) throw new Error("Invalid gateway address in the share link.");
  return normalizeShareGateway(values[0]);
}

export function shareManagementUrl(settings: GatewaySettings): string {
  return `${normalizeShareGateway(settings.gatewayUrl)}/api/ssh/share`;
}

/** Remote gateways need only their protocol key, not the frontend's account session. */
export function shareManagementHeaders(settings: GatewaySettings): Record<string, string> {
  if (!settings.gatewayUrl.trim()) return getAuthHeaders(settings);
  return {
    "Content-Type": "application/json",
    ...(settings.gatewayToken ? { "X-Sushi-Token": settings.gatewayToken } : {}),
  };
}

const siteAuthHeaders = () => getAuthHeaders({ gatewayUrl: "", gatewayToken: "" });

/** Register this site's public verifier with a remote gateway when starting a share. */
export async function fetchShareAccountIssuer(gatewayUrl: string): Promise<{ publicKey: string; audience: string }> {
  const audience = normalizeShareGateway(gatewayUrl);
  if (!audience) throw new Error("A gateway address is required.");
  const res = await fetch("/api/ssh/share/ticket", { headers: siteAuthHeaders(), cache: "no-store" });
  const data = await res.json().catch(() => ({})) as { publicKey?: unknown; error?: string };
  if (!res.ok || typeof data.publicKey !== "string") {
    throw new Error(data.error || "Could not verify your Sushi account for gateway sharing.");
  }
  return { publicKey: data.publicKey, audience };
}

/** Only a scoped, short-lived ticket (never the account session) leaves this site. */
export async function fetchShareAccountTicket(shareId: string, gatewayUrl: string): Promise<string> {
  const res = await fetch("/api/ssh/share/ticket", {
    method: "POST", headers: siteAuthHeaders(), cache: "no-store",
    body: JSON.stringify({ shareId, gateway: normalizeShareGateway(gatewayUrl) }),
  });
  const data = await res.json().catch(() => ({})) as { ticket?: unknown; error?: string };
  if (!res.ok || typeof data.ticket !== "string") throw new Error(data.error || "Could not verify your Sushi account.");
  return data.ticket;
}

/** Remembered so the next join does not ask again. */
export function loadShareDisplayName(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(SHARE_NAME_KEY) || "";
  } catch {
    return "";
  }
}

export function saveShareDisplayName(name: string): void {
  if (typeof window === "undefined") return;
  try {
    if (name.trim()) localStorage.setItem(SHARE_NAME_KEY, name.trim());
  } catch {
    // ignore
  }
}

/**
 * Passcodes live in sessionStorage (not localStorage): a code should survive a
 * reconnect in the same tab, and not linger on a shared machine afterwards.
 */
export function rememberSharePasscode(shareId: string, passcode: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(`${SHARE_PASSCODE_PREFIX}${shareId}`, passcode);
  } catch {
    // ignore
  }
}

export function recallSharePasscode(shareId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return sessionStorage.getItem(`${SHARE_PASSCODE_PREFIX}${shareId}`) || "";
  } catch {
    return "";
  }
}

export function forgetSharePasscode(shareId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(`${SHARE_PASSCODE_PREFIX}${shareId}`);
  } catch {
    // ignore
  }
}

/** "just now" / "4m" / "2h 10m" — how long the shared shell has been alive. */
export function formatShareAge(fromMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - fromMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatShareScrollback(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Sorts the host first, then guests oldest-join first, for a stable list. */
export function sortParticipants(participants: SharedParticipantView[]): SharedParticipantView[] {
  return [...participants].sort((a, b) => {
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
    return a.joinedAt - b.joinedAt;
  });
}
