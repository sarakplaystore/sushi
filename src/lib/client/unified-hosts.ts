import type { HostProfile, ProtocolType } from "@/types/connection";

/**
 * "One host, three ways in."
 *
 * Sushi stores a profile per saved connection, so the same machine often appears
 * three times: an SSH entry, an SFTP entry and an RDP entry (plus ad-hoc RDP
 * companions derived from the SSH one). That is accurate in the vault but wrong in
 * every list: the sidebar, the launchpad, search, the protocol filter and the API all
 * showed a machine several times, and it was easy to edit one copy and leave the
 * others stale.
 *
 * This module merges those profiles into one {@link UnifiedHost} per machine +
 * account, without touching the vault: the merge is a *view*, so saving, editing and
 * deleting still use the real profiles. Every action (SSH, SFTP, RDP) is reachable
 * from the single entry, and each entry has one stable access URL that can be
 * bookmarked or shared (it opens the host, not the session: credentials never leave
 * the encrypted vault).
 */

/** Which protocols a merged host can be opened with. */
export interface UnifiedProtocols {
  ssh?: HostProfile;
  sftp?: HostProfile;
  rdp?: HostProfile;
}

export interface UnifiedHost {
  /** Stable id: `unified-<host>-<user>` (URL-safe, see `unifiedHostKey`). */
  id: string;
  /** Display name: the SSH profile's name when there is one. */
  name: string;
  host: string;
  username: string;
  group: string;
  accentColor?: string;
  tags: string[];
  protocols: UnifiedProtocols;
  /** Enabled protocols, in display order. */
  available: ProtocolType[];
  /** Port per protocol (SSH and SFTP usually share 22, RDP is 3389). */
  ports: Partial<Record<ProtocolType, number>>;
  /** Newest `updatedAt` across the merged profiles (for sorting / "edited"). */
  updatedAt: number;
  /** Newest `lastConnectedAt` across the merged profiles. */
  lastConnectedAt?: number;
  /**
   * The saved profile to act on for a protocol. For RDP on an SSH-only host this is
   * the SSH profile (the desktop is opened through a derived companion), so the caller
   * always has something concrete to pass to `openSessionTab`.
   */
  primary: HostProfile;
}

/** Machine identity: host + account. Protocol and port are *not* part of it. */
export function unifiedHostKey(profile: Pick<HostProfile, "host" | "username">): string {
  return `${(profile.host || "").trim().toLowerCase()}|${(profile.username || "").trim().toLowerCase()}`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "host"
  );
}

/** URL-safe id for a merged host, used by `/hosts?host=<id>`. */
export function unifiedHostId(profile: Pick<HostProfile, "host" | "username">): string {
  return `unified-${slug(profile.host || "")}-${slug(profile.username || "")}`;
}

const PROTOCOL_ORDER: ProtocolType[] = ["ssh", "sftp", "rdp"];

/**
 * Merges saved profiles into one entry per machine + account.
 *
 * Rules (all reversible — nothing in the vault is rewritten):
 *  - profiles with the same host and username are one entry;
 *  - the SSH profile drives the name/colour/group; an RDP-only entry keeps its own;
 *  - an SSH or SFTP profile makes the machine openable as **both** SSH and SFTP (they
 *    are the same port and the same login in practice), unless the vault also has an
 *    explicit SFTP profile, which then wins for the SFTP action;
 *  - an RDP profile adds the desktop; an SSH-only host still offers RDP through the
 *    derived companion (so `available` contains `rdp` only when a real RDP profile
 *    exists, and the UI derives the companion on demand — see `rdpCompanion`).
 */
export function mergeHosts(profiles: HostProfile[]): UnifiedHost[] {
  const merged = new Map<string, UnifiedHost>();

  for (const profile of profiles) {
    const key = unifiedHostKey(profile);
    const existing = merged.get(key);
    if (!existing) {
      const entry: UnifiedHost = {
        id: unifiedHostId(profile),
        name: profile.name || `${profile.username}@${profile.host}`,
        host: profile.host,
        username: profile.username,
        group: profile.group || "",
        accentColor: profile.accentColor,
        tags: [...(profile.tags || [])],
        protocols: { [profile.protocol]: profile },
        available: [profile.protocol],
        ports: { [profile.protocol]: Number(profile.port) || 22 },
        updatedAt: Number(profile.updatedAt) || 0,
        lastConnectedAt: profile.lastConnectedAt,
        primary: profile,
      };
      merged.set(key, entry);
      continue;
    }

    // A later profile for the same machine: fill in the protocol slot. The first one
    // saved for that protocol wins, so the vault's order stays meaningful.
    if (!existing.protocols[profile.protocol]) {
      existing.protocols[profile.protocol] = profile;
    }
    existing.ports[profile.protocol] = Number(profile.port) || existing.ports[profile.protocol];
    existing.tags = [...new Set([...existing.tags, ...(profile.tags || [])])];
    existing.updatedAt = Math.max(existing.updatedAt, Number(profile.updatedAt) || 0);
    if (profile.lastConnectedAt) {
      existing.lastConnectedAt = Math.max(existing.lastConnectedAt || 0, profile.lastConnectedAt);
    }
    // The SSH profile is the canonical identity of a machine (it carries keys,
    // colour and group); otherwise keep the first profile's metadata.
    if (profile.protocol === "ssh") {
      existing.name = profile.name || existing.name;
      existing.accentColor = profile.accentColor ?? existing.accentColor;
      existing.group = profile.group || existing.group;
      existing.primary = profile;
    }
  }

  for (const entry of merged.values()) {
    const { ssh, sftp, rdp } = entry.protocols;
    entry.available = PROTOCOL_ORDER.filter((protocol) => {
      if (protocol === "ssh") return Boolean(ssh || sftp);
      if (protocol === "sftp") return Boolean(sftp || ssh);
      return Boolean(rdp);
    });
    if (!entry.primary || (ssh && entry.primary.protocol !== "ssh")) {
      entry.primary = ssh ?? sftp ?? rdp ?? entry.primary;
    }
  }

  return [...merged.values()].sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/** The merged entry a profile belongs to (`undefined` when it is not in `hosts`). */
export function findUnifiedHost(
  unified: UnifiedHost[],
  profile: Pick<HostProfile, "host" | "username">
): UnifiedHost | undefined {
  const key = unifiedHostKey(profile);
  return unified.find((entry) => unifiedHostKey(entry) === key);
}

/** Case-insensitive search over the merged entries (name, host, user, group, tags). */
export function filterUnifiedHosts(unified: UnifiedHost[], query: string): UnifiedHost[] {
  const q = query.trim().toLowerCase();
  if (!q) return unified;
  return unified.filter((entry) =>
    [entry.name, entry.host, entry.username, entry.group, ...entry.tags]
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
}

/**
 * Protocol filter for the sidebar. Entries are kept when the machine can be opened
 * with the selected protocol — so "SSH" also lists a host saved as SFTP, because the
 * SSH action exists for it.
 */
export function filterUnifiedHostsByProtocol(
  unified: UnifiedHost[],
  protocol: "all" | ProtocolType
): UnifiedHost[] {
  if (protocol === "all") return unified;
  return unified.filter((entry) => entry.available.includes(protocol));
}

/** Groups merged entries by folder for the sidebar (empty group → "Servers"). */
export function groupUnifiedHosts(unified: UnifiedHost[]): Record<string, UnifiedHost[]> {
  return unified.reduce<Record<string, UnifiedHost[]>>((acc, entry) => {
    const key = entry.group?.trim() || "Servers";
    (acc[key] ||= []).push(entry);
    return acc;
  }, {});
}

/** How many saved profiles a merged entry stands for (used in the UI copy). */
export function unifiedHostProfileCount(entry: UnifiedHost): number {
  return Object.values(entry.protocols).filter(Boolean).length;
}

/**
 * The machine's SSH / SFTP / RDP addresses, e.g. `ssh://root@203.0.113.10:22`.
 * Passwords and keys are never part of a link.
 */
export function accessLinks(entry: UnifiedHost): Partial<Record<ProtocolType, string>> {
  const link = (protocol: ProtocolType) => {
    const port = entry.ports[protocol] ?? (protocol === "rdp" ? 3389 : 22);
    return `${protocol}://${encodeURIComponent(entry.username)}@${entry.host}:${port}`;
  };
  const links: Partial<Record<ProtocolType, string>> = {};
  if (entry.available.includes("ssh")) links.ssh = link("ssh");
  if (entry.available.includes("sftp")) links.sftp = link("sftp");
  if (entry.available.includes("rdp")) links.rdp = link("rdp");
  return links;
}

/**
 * The one URL that gets you straight to this machine in Sushi: `/hosts?host=<id>`
 * (plus `&protocol=` to jump to a specific action). It carries no credentials; the
 * workspace unlocks the vault and then opens the matching session.
 */
export function hostAccessUrl(
  entry: UnifiedHost,
  protocol?: ProtocolType,
  base = ""
): string {
  const params = new URLSearchParams({ host: entry.id });
  if (protocol) params.set("protocol", protocol);
  return `${base.replace(/\/+$/, "")}/hosts?${params.toString()}`;
}

/** Parses `/hosts?host=…&protocol=…` (tolerant of anything a user pastes). */
export function parseHostDeepLink(
  search: string
): { hostId: string; protocol: ProtocolType | null } | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  const hostId = (params.get("host") || "").trim();
  if (!hostId) return null;
  const rawProtocol = (params.get("protocol") || "").trim().toLowerCase();
  const protocol: ProtocolType | null =
    rawProtocol === "ssh" || rawProtocol === "sftp" || rawProtocol === "rdp"
      ? rawProtocol
      : null;
  return { hostId, protocol };
}

/** Finds the merged entry a deep link points at (by id, else by `user@host`). */
export function resolveHostDeepLink(
  unified: UnifiedHost[],
  hostId: string
): UnifiedHost | undefined {
  const direct = unified.find((entry) => entry.id === hostId);
  if (direct) return direct;
  // Also accept `user@host` and `host` so a hand-typed link still works.
  const wanted = hostId.trim().toLowerCase();
  const atIndex = wanted.lastIndexOf("@");
  const user = atIndex > 0 ? wanted.slice(0, atIndex) : null;
  const host = atIndex > 0 ? wanted.slice(atIndex + 1) : wanted;
  return unified.find(
    (entry) =>
      entry.host.toLowerCase() === host &&
      (user === null || entry.username.toLowerCase() === user)
  );
}

/**
 * Which protocols a merged entry can really be opened with, RDP companion included:
 * any SSH/SFTP machine can also be reached as a desktop on 3389 (the same derivation
 * the "Open via RDP" buttons use), so the UI can show all three actions for one row.
 */
export function openableProtocols(entry: UnifiedHost): ProtocolType[] {
  const protocols = new Set<ProtocolType>(entry.available);
  if (entry.protocols.ssh || entry.protocols.sftp) protocols.add("rdp");
  return PROTOCOL_ORDER.filter((protocol) => protocols.has(protocol));
}
