import type { ConnectionCredentials, SshSystemInfo } from "@/types/connection";
import { getAuthHeaders, resolveGatewayHttpBase, type GatewaySettings } from "./gateway";

/**
 * "What am I connected to?" — the distro + version and hosting platform of a host,
 * fetched once per connection and cached for a few minutes so opening more tabs on
 * the same host does not open another SSH connection every time.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  info: SshSystemInfo | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(creds: ConnectionCredentials): string {
  return `${creds.username}@${creds.host}:${creds.port || 22}`;
}

/** Clears the cache (tests, or after a host's credentials change). */
export function clearSysinfoCache(): void {
  cache.clear();
}

/**
 * Reads the remote system information, falling back to the cache, and never throws:
 * a host with a restricted shell simply has no OS badge.
 */
export async function loadSshSystemInfo(
  creds: ConnectionCredentials,
  settings: GatewaySettings,
  options: { timeoutMs?: number; force?: boolean } = {}
): Promise<SshSystemInfo | null> {
  const key = cacheKey(creds);
  const cached = cache.get(key);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.info;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    // Prefer the attached VPS gateway: it is the machine that can actually reach the
    // host when Sushi runs on Vercel and the host lives on a private network.
    const apiBase = resolveGatewayHttpBase(settings.gatewayUrl);
    const res = await fetch(apiBase ? `${apiBase}/api/ssh/sysinfo` : "/api/ssh/sysinfo", {
      method: "POST",
      headers: getAuthHeaders(settings),
      signal: controller.signal,
      body: JSON.stringify({ credentials: creds }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      info?: SshSystemInfo;
    };
    const info = data.ok && data.info ? data.info : null;
    cache.set(key, { info, at: Date.now() });
    return info;
  } catch {
    // Network error / timeout: keep whatever we had, do not cache the failure.
    return cached?.info ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short label for the session header: the distro with its version, e.g.
 * "Ubuntu 24.04.1 LTS". Long `PRETTY_NAME`s are shortened ("Debian GNU/Linux"
 * becomes "Debian") so the pill stays readable next to the other badges.
 */
export function formatOsLabel(info: SshSystemInfo | null | undefined): string {
  if (!info) return "";
  const pretty = (info.os || "").trim();
  if (pretty) {
    return pretty
      .replace(/^Debian GNU\/Linux/i, "Debian")
      .replace(/^Red Hat Enterprise Linux/i, "RHEL")
      .replace(/^Amazon Linux/i, "Amazon Linux")
      .replace(/\s*\((?:[^)]*)\)\s*$/, "") // drop the "(bookworm)" suffix
      .trim();
  }
  return [info.distro, info.version].filter(Boolean).join(" ").trim();
}

/** `Ubuntu 24.04.1 LTS · Oracle Cloud` — the full line shown in the header pill. */
export function formatSystemLine(info: SshSystemInfo | null | undefined): string {
  const os = formatOsLabel(info);
  const provider = info?.provider?.trim();
  if (os && provider) return `${os} · ${provider}`;
  return os || provider || "";
}

/** Everything the tooltip shows, one fact per line. */
export function formatSystemDetails(info: SshSystemInfo | null | undefined): string[] {
  if (!info) return [];
  const lines: string[] = [];
  if (formatOsLabel(info)) lines.push(`OS: ${formatOsLabel(info)}`);
  if (info.codename) lines.push(`Release: ${info.codename}`);
  if (info.kernel) lines.push(`Kernel: ${info.kernel}${info.arch ? ` (${info.arch})` : ""}`);
  if (info.provider) {
    lines.push(
      `Platform: ${info.provider}${info.providerId ? ` [${info.providerId}]` : ""}`
    );
  } else if (info.virtualization && info.virtualization !== "none") {
    lines.push(`Platform: ${info.virtualization}`);
  }
  if (info.hostname) lines.push(`Hostname: ${info.hostname}`);
  if (info.cpu || info.memoryMb) {
    lines.push(
      [
        info.cpu ? `${info.cpu} vCPU` : "",
        info.memoryMb
          ? info.memoryMb >= 1024
            ? `${(info.memoryMb / 1024).toFixed(info.memoryMb >= 10240 ? 0 : 1)} GB RAM`
            : `${info.memoryMb} MB RAM`
          : "",
      ]
        .filter(Boolean)
        .join(" · ")
    );
  }
  if (info.uptime) lines.push(`Uptime: ${info.uptime}`);
  return lines;
}

/** One-line summary printed in the terminal when a session starts. */
export function formatTerminalSystemLine(info: SshSystemInfo | null | undefined): string {
  if (!info) return "";
  const parts = [formatOsLabel(info)];
  if (info.provider) parts.push(info.provider);
  if (info.kernel) parts.push(info.kernel);
  return parts.filter(Boolean).join(" · ");
}
