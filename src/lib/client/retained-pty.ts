import type { HostProfile } from "@/types/connection";
import { normalizeShareGateway } from "@/lib/share-gateway";

/** Local resume metadata only. The session ID alone cannot authenticate to the gateway. */
export interface RetainedPty {
  tabId: string;
  sessionId: string;
  gatewayUrl: string;
  profile: HostProfile;
  savedAt: number;
  idleTtlMs: number;
}

/** A live terminal's last acknowledged state, not merely a saved identifier. */
export interface PtyCloseSafety {
  transport: "ws" | "serverless";
  confirmedSessionId: string | null;
}

export const RETAINED_PTY_KEY = "sushi_retained_pty_v1";
export const RETAINED_PTY_EVENT = "sushi-retained-pty-changed";
const MAX_RECORDS = 100;

function safeProfile(value: HostProfile): HostProfile {
  // An allowlist avoids writing passwords, private keys, passphrases or notes to
  // unencrypted browser storage. The gateway already owns the authenticated PTY.
  return {
    id: value.id, name: value.name, protocol: "ssh", host: value.host,
    port: Number(value.port || 22), username: value.username,
    authMethod: value.authMethod === "privateKey" ? "privateKey" : "password",
    createdAt: Number(value.createdAt) || Date.now(), updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

function parseRecord(value: unknown): RetainedPty | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const profile = item.profile as HostProfile | undefined;
  if (typeof item.tabId !== "string" || !item.tabId || item.tabId.length > 200 ||
      typeof item.sessionId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(item.sessionId) ||
      typeof item.gatewayUrl !== "string" || !profile || typeof profile !== "object" ||
      typeof profile.host !== "string" || !profile.host.trim() || typeof profile.username !== "string" || !profile.username.trim() ||
      typeof profile.id !== "string" || typeof profile.name !== "string") return null;
  try {
    const gatewayUrl = normalizeShareGateway(item.gatewayUrl);
    if (gatewayUrl !== item.gatewayUrl) return null;
    return {
      tabId: item.tabId, sessionId: item.sessionId, gatewayUrl,
      profile: safeProfile(profile),
      savedAt: Number(item.savedAt) > 0 ? Number(item.savedAt) : Date.now(),
      idleTtlMs: Number(item.idleTtlMs) >= 60000 ? Number(item.idleTtlMs) : 43200000,
    };
  } catch { return null; }
}

export function loadRetainedPtys(): RetainedPty[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RETAINED_PTY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseRecord).filter((item): item is RetainedPty => Boolean(item)).slice(0, MAX_RECORDS);
  } catch { return []; }
}

function writeRecords(records: RetainedPty[]): boolean {
  if (typeof window === "undefined" || records.length > MAX_RECORDS) return false;
  try {
    window.localStorage.setItem(RETAINED_PTY_KEY, JSON.stringify(records));
    // Verify persistence rather than claiming that reattachment is possible in
    // a browser that denies storage (private mode, quotas, or a blocked origin).
    if (window.localStorage.getItem(RETAINED_PTY_KEY) !== JSON.stringify(records)) return false;
    window.dispatchEvent(new window.Event(RETAINED_PTY_EVENT));
    return true;
  } catch { return false; }
}

export function saveRetainedPty(record: RetainedPty): boolean {
  const safe = parseRecord({ ...record, profile: safeProfile(record.profile) });
  if (!safe) return false;
  return writeRecords([safe, ...loadRetainedPtys().filter((entry) => entry.tabId !== safe.tabId)]);
}

/** Remove only the expected generation, so an old socket cannot erase a newer PTY. */
export function forgetRetainedPty(tabId: string, expectedSessionId?: string): boolean {
  const records = loadRetainedPtys();
  return writeRecords(records.filter((entry) => entry.tabId !== tabId || (expectedSessionId && entry.sessionId !== expectedSessionId)));
}

export function moveRetainedPty(tabId: string, newTabId: string): boolean {
  const records = loadRetainedPtys();
  const record = records.find((entry) => entry.tabId === tabId);
  if (!record || !newTabId || records.some((entry) => entry.tabId === newTabId)) return false;
  return writeRecords(records.map((entry) => entry.tabId === tabId ? { ...entry, tabId: newTabId } : entry));
}

export function retainedPtyMatches(record: RetainedPty, gatewayUrl: string, profile: HostProfile): boolean {
  try {
    return record.gatewayUrl === normalizeShareGateway(gatewayUrl) &&
      record.profile.host.trim().toLowerCase() === profile.host.trim().toLowerCase() &&
      Number(record.profile.port || 22) === Number(profile.port || 22) &&
      record.profile.username.trim() === profile.username.trim();
  } catch { return false; }
}
