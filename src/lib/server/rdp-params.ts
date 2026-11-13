import type { ConnectionCredentials, RdpPerformance, RdpSecurityMode } from "@/types/connection";

/**
 * The `connect` parameters handed to guacd for an RDP session.
 *
 * Kept apart from the socket bridge so every knob can be tested without a daemon:
 * guacd fills the `connect` instruction from the `args` it advertises, so the map
 * below is the only thing that decides how the desktop is delivered.
 */

export const RDP_SECURITY_MODES: RdpSecurityMode[] = ["any", "nla", "tls", "rdp"];

/**
 * Display presets.
 *
 * - `best` — wallpaper, themes, font smoothing, desktop composition, lossless
 *   updates: the prettiest picture, the most bandwidth.
 * - `balanced` (default) — themes and font smoothing only; wallpaper and lossless
 *   updates are off, so a WAN link stays responsive while text still looks clean.
 * - `fast` — 16-bit colour, no themes or smoothing, all caching left on: for a slow
 *   VPS link, a phone hotspot, or `xrdp` over a long haul.
 */
export const RDP_PERFORMANCE_PRESETS: Record<
  RdpPerformance,
  Record<string, string>
> = {
  best: {
    "color-depth": "32",
    "enable-wallpaper": "true",
    "enable-theming": "true",
    "enable-font-smoothing": "true",
    "enable-desktop-composition": "true",
    "enable-menu-animations": "true",
    "force-lossless": "true",
    "disable-bitmap-caching": "false",
    "disable-offscreen-caching": "false",
    "disable-glyph-caching": "false",
  },
  balanced: {
    "color-depth": "24",
    "enable-wallpaper": "false",
    "enable-theming": "true",
    "enable-font-smoothing": "true",
    "enable-desktop-composition": "true",
    "enable-menu-animations": "false",
    "force-lossless": "false",
    "disable-bitmap-caching": "false",
    "disable-offscreen-caching": "false",
    "disable-glyph-caching": "false",
  },
  fast: {
    "color-depth": "16",
    "enable-wallpaper": "false",
    "enable-theming": "false",
    "enable-font-smoothing": "false",
    "enable-desktop-composition": "false",
    "enable-menu-animations": "false",
    "force-lossless": "false",
    "disable-bitmap-caching": "false",
    "disable-offscreen-caching": "false",
    "disable-glyph-caching": "false",
  },
};

export const DEFAULT_RDP_PERFORMANCE: RdpPerformance = "balanced";

/** Width/height accepted by RDP; anything else would make the server refuse the session. */
export const RDP_SIZE_LIMITS = { minWidth: 640, maxWidth: 4096, minHeight: 480, maxHeight: 2160 };

export function normalizeRdpPerformance(value?: string): RdpPerformance {
  return value === "best" || value === "fast" || value === "balanced"
    ? value
    : DEFAULT_RDP_PERFORMANCE;
}

export function normalizeRdpSecurity(value?: string): RdpSecurityMode {
  return RDP_SECURITY_MODES.includes(value as RdpSecurityMode)
    ? (value as RdpSecurityMode)
    : "any";
}

/**
 * An IANA timezone (`Asia/Phnom_Penh`, `UTC`, `America/Argentina/Buenos_Aires`).
 *
 * The value ends up in a Guacamole instruction, and guacd passes it to the RDP
 * server as the session clock, so anything else is dropped rather than forwarded.
 */
export function normalizeTimezone(value?: string): string {
  const tz = (value || "").trim();
  return /^[A-Za-z][A-Za-z0-9_+\-]{0,63}(?:\/[A-Za-z0-9_+\-]{1,63}){0,2}$/.test(tz)
    ? tz
    : "";
}

/** A name the remote session can show: no control characters, at most 32 chars. */
export function normalizeClientName(value: string | undefined, host: string): string {
  const cleaned = (value || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (cleaned) return cleaned.slice(0, 32);
  const fallbackHost = host.trim().slice(0, 32);
  return fallbackHost ? `Sushi (${fallbackHost})`.slice(0, 32) : "Sushi";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Builds the guacd RDP parameters for a session.
 *
 * Only the arguments guacd advertises are filled in by the bridge, so this map may
 * safely carry settings an older guacd build does not know about.
 */
export function sanitizeDriveSegment(raw: string | undefined, fallback = "default"): string {
  const cleaned = (raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

export function buildRdpParams(creds: ConnectionCredentials): Record<string, string> {
  const performance = normalizeRdpPerformance(creds.rdpPerformance);
  const width = clamp(Number(creds.width || 1280), RDP_SIZE_LIMITS.minWidth, RDP_SIZE_LIMITS.maxWidth);
  const height = clamp(Number(creds.height || 720), RDP_SIZE_LIMITS.minHeight, RDP_SIZE_LIMITS.maxHeight);
  const dpi = clamp(Number(creds.dpi || 96), 72, 300);

  // Audio is on unless explicitly disabled; a drive is redirected so files can be
  // dropped onto the desktop, which is also what makes uploads possible.
  const audio = creds.rdpAudio !== false;
  const readOnly = creds.rdpReadOnly === true;
  const drive = creds.rdpDrive !== false;
  const clientName = normalizeClientName(creds.rdpClientName, creds.host || "");

  const params: Record<string, string> = {
    hostname: (creds.host || "").trim(),
    port: String(clamp(Number(creds.port || 3389), 1, 65535)),
    username: (creds.username || "").trim(),
    password: creds.password || "",
    domain: (creds.domain || "").trim(),
    security: normalizeRdpSecurity(creds.rdpSecurity),
    "ignore-cert": creds.ignoreCert !== false ? "true" : "false",
    width: String(width),
    height: String(height),
    dpi: String(dpi),
    // A window resize sends a `size` instruction; `display-update` makes the RDP
    // server follow it instead of scaling the picture.
    "resize-method": "display-update",
    "disable-audio": audio ? "false" : "true",
    "read-only": readOnly ? "true" : "false",
    "client-name": clientName,
    ...RDP_PERFORMANCE_PRESETS[performance],
  };

  if (drive) {
    params["enable-drive"] = "true";
    params["drive-name"] = "Sushi";
    params["drive-path"] = `/tmp/sushi-drive/${sanitizeDriveSegment(creds.host, "host")}-${sanitizeDriveSegment(creds.username, "user")}`;
    // guacd creates the backing folder when it is missing (Guacamole 1.3+).
    params["create-drive-path"] = "true";
  } else {
    params["enable-drive"] = "false";
  }

  return params;
}
