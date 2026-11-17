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

/** The URL a teammate opens to sit in front of the same shell. */
export function buildShareJoinUrl(shareId: string): string {
  if (typeof window === "undefined") return `/share/${shareId}`;
  return `${window.location.origin}/share/${shareId}`;
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
