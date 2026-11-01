import type { RdpPerformance } from "@/types/connection";

/**
 * Session preferences and the small pure helpers behind the RDP pane.
 *
 * Kept out of the React component so the behaviour that is easy to get wrong —
 * which size to ask the server for, which errors are worth retrying, what a
 * Guacamole status code means to a human — can be tested without a browser.
 */

export interface RdpPrefs {
  /** Display preset sent to guacd. Changing it reconnects the stream. */
  performance: RdpPerformance;
  /** Play the remote's sounds in this browser. Changing it reconnects. */
  audio: boolean;
  /** View-only: the remote ignores input. Changing it reconnects. */
  readOnly: boolean;
  /** Redirect a drive so files can be dropped onto the desktop. Changing it reconnects. */
  drive: boolean;
  /** Ask the server to match the window size instead of scaling the picture. */
  fitWindow: boolean;
}

export const DEFAULT_RDP_PREFS: RdpPrefs = {
  performance: "balanced",
  audio: true,
  readOnly: false,
  drive: true,
  fitWindow: true,
};

export const RDP_PREFS_STORAGE_KEY = "sushi_rdp_prefs_v1";

/** Reads the saved preferences, falling back to the defaults field by field. */
export function parseRdpPrefs(raw: unknown): RdpPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RDP_PREFS };
  const value = raw as Partial<Record<keyof RdpPrefs, unknown>>;
  const performance =
    value.performance === "best" || value.performance === "fast" || value.performance === "balanced"
      ? value.performance
      : DEFAULT_RDP_PREFS.performance;
  return {
    performance,
    audio: typeof value.audio === "boolean" ? value.audio : DEFAULT_RDP_PREFS.audio,
    readOnly: typeof value.readOnly === "boolean" ? value.readOnly : DEFAULT_RDP_PREFS.readOnly,
    drive: typeof value.drive === "boolean" ? value.drive : DEFAULT_RDP_PREFS.drive,
    fitWindow: typeof value.fitWindow === "boolean" ? value.fitWindow : DEFAULT_RDP_PREFS.fitWindow,
  };
}

export function loadRdpPrefs(): RdpPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_RDP_PREFS };
  try {
    const raw = window.localStorage.getItem(RDP_PREFS_STORAGE_KEY);
    return raw ? parseRdpPrefs(JSON.parse(raw)) : { ...DEFAULT_RDP_PREFS };
  } catch {
    return { ...DEFAULT_RDP_PREFS };
  }
}

export function saveRdpPrefs(prefs: RdpPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RDP_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage disabled (private mode): the session still works with these values.
  }
}

export const RDP_FIT_LIMITS = {
  minWidth: 640,
  maxWidth: 4096,
  minHeight: 480,
  maxHeight: 2160,
};

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The remote resolution that fills the given viewport.
 *
 * RDP wants even numbers, and the server refuses anything below 640×480 or above
 * 4096×2160, so the result is clamped instead of being rejected upstream.
 */
export function fitRemoteSize(
  availableWidth: number,
  availableHeight: number,
  limits: typeof RDP_FIT_LIMITS = RDP_FIT_LIMITS
): { width: number; height: number } {
  const width = even(
    Math.min(limits.maxWidth, Math.max(limits.minWidth, Math.floor(availableWidth || 0)))
  );
  const height = even(
    Math.min(limits.maxHeight, Math.max(limits.minHeight, Math.floor(availableHeight || 0)))
  );
  return { width, height };
}

/**
 * Whether a resize is worth a round trip.
 *
 * A one-pixel drag must not resize the remote desktop, and a resize loop (server
 * resizes → display resizes → server resizes) must not start.
 */
export function shouldResizeRemote(
  current: { width: number; height: number } | null,
  next: { width: number; height: number },
  threshold = 12
): boolean {
  if (!current) return true;
  return (
    Math.abs(current.width - next.width) >= threshold ||
    Math.abs(current.height - next.height) >= threshold
  );
}

/**
 * The size to ask the server for, or null when the desktop already matches.
 *
 * Guards against the feedback loop that a scrollbar (or a rounding drift) causes:
 * the request is skipped when the remote is within `threshold` of the pane, so the
 * desktop cannot oscillate between two sizes.
 */
export function nextRemoteSize(
  current: { width: number; height: number } | null,
  pane: { width: number; height: number },
  threshold = 12
): { width: number; height: number } | null {
  const target = fitRemoteSize(pane.width, pane.height);
  return shouldResizeRemote(current, target, threshold) ? target : null;
}

/** Human message for a Guacamole status code, or the server's own words. */
export function describeRdpStatus(code: number, fallback?: string): string {
  switch (code) {
    case 0x0000:
      return "The desktop session ended.";
    case 0x0100:
      return "The bridge does not support that request.";
    case 0x0200:
      return "The remote desktop server reported an error.";
    case 0x0201:
      return "The remote desktop server is busy. Try again in a moment.";
    case 0x0202:
      return "The remote desktop did not answer in time. Is the machine still booting, or is RDP blocked by a firewall?";
    case 0x0203:
      return "The RDP connection failed upstream (the desktop dropped the session).";
    case 0x0204:
      return "The RDP bridge could not find the requested resource.";
    case 0x0206:
      return "The RDP connection was closed by the remote side.";
    case 0x0207:
      return "guacd could not reach the host on port 3389. Is xrdp / Remote Desktop running and the port open?";
    case 0x0208:
      return "The remote desktop is unavailable right now.";
    case 0x0209:
      return "This account is already using the desktop with different settings (Windows allows one session per user).";
    case 0x020a:
      return "The desktop session timed out.";
    case 0x020b:
      return "The desktop session was closed.";
    case 0x0300:
      return "The RDP bridge rejected the request payload.";
    case 0x0301:
      return "Your Sushi session is no longer valid — sign in again in this tab.";
    case 0x0303:
      return "The remote desktop refused the login. Check the desktop username, password and domain, and whether the server requires NLA.";
    case 0x0308:
      return "The browser did not respond in time; the desktop was disconnected.";
    case 0x030d:
      return "The browser is sending input faster than the bridge can handle.";
    case 0x030f:
      return "The desktop sent data this browser cannot render.";
    case 0x031d:
      return "Too many simultaneous connections to this desktop.";
    default:
      return fallback?.trim() || "The desktop connection failed.";
  }
}

/**
 * Network hiccups are worth a retry; a wrong password or an expired session is not.
 */
export function shouldRetryRdpStatus(code: number): boolean {
  return (
    code === 0x0200 ||
    code === 0x0201 ||
    code === 0x0202 ||
    code === 0x0203 ||
    code === 0x0206 ||
    code === 0x0207 ||
    code === 0x0208 ||
    code === 0x020a ||
    code === 0x020b ||
    code === 0x0308
  );
}

/** 1 s, 2 s, 4 s, 8 s … capped at 15 s. */
export function reconnectDelayMs(attempt: number): number {
  const safe = Math.max(1, Math.floor(attempt));
  return Math.min(15000, 1000 * 2 ** (safe - 1));
}

/** `1920 × 1080` — the size pill in the toolbar. */
export function formatRemoteSize(width: number, height: number): string {
  if (!width || !height) return "—";
  return `${width} × ${height}`;
}
