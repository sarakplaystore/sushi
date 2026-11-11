import type { ProtocolType } from "@/types/connection";
import { mergeHosts, openableProtocols, hostAccessUrl, type UnifiedHost } from "@/lib/client/unified-hosts";

/**
 * The inventory behind `GET /api/hosts`: every saved connection, merged so that one
 * machine + account is one entry, with all of its access methods in one object.
 *
 * ## Why this is not "one URL that hands out your servers"
 *
 * Sushi's vault is end-to-end encrypted: the server only ever stores
 * `{ iv, ciphertext, mode, … }` and has no key to open it (the key comes from the
 * admin password in the browser, or from a device key that never leaves it). A
 * server-side endpoint therefore *cannot* decrypt host names or credentials, and
 * making it return them in clear would mean storing them in clear — the one thing the
 * vault exists to prevent.
 *
 * So the single URL is the *index*: every host, one entry per machine, with its
 * protocols, ports and access links, plus whether a server-side vault exists and how
 * to unlock it. The browser fills in names/credentials after unlocking (the workspace
 * already does exactly that); scripts and integrations get a stable, complete shape
 * from one request, and `SUSHI_HOSTS_LAYOUT=resolved` adds clear-text details only for
 * deployments that deliberately store an unencrypted inventory (see
 * `resolveUnifiedHosts`).
 */

export interface UnifiedInventoryLink {
  protocol: ProtocolType;
  /** `ssh://root@203.0.113.10:22` — never contains a password or key. */
  url: string;
  port: number;
  /** Can this protocol be opened right now? */
  openable: boolean;
  /** `saved` = its own profile exists, `derived` = opened through a companion. */
  kind: "saved" | "derived";
}

export interface UnifiedInventoryHost {
  /** Stable id, also used by `/hosts?host=<id>`. */
  id: string;
  /** One URL that gets you to this machine in Sushi (no credentials in it). */
  accessUrl: string;
  /** Machine + account identity. Redacted to `host #1` when the vault is encrypted. */
  host: string | null;
  username: string | null;
  name: string | null;
  group: string | null;
  tags: string[];
  protocols: ProtocolType[];
  /** Every way in, including the derived RDP companion for SSH/SFTP machines. */
  links: UnifiedInventoryLink[];
  updatedAt: number | null;
  lastConnectedAt: number | null;
  /** How many saved profiles this entry merges. */
  profileCount: number;
}

export interface UnifiedInventory {
  ok: true;
  /** Where the data came from. */
  source: "vault" | "server-vault";
  /** True when host names/credentials are only available in the browser. */
  encrypted: boolean;
  /** One URL for everything (this document). */
  self: string;
  /** One page in Sushi listing every host (see `/hosts`). */
  page: string;
  counts: {
    hosts: number;
    profiles: number;
    byProtocol: Record<ProtocolType, number>;
  };
  hosts: UnifiedInventoryHost[];
  hint: string;
}

const SELF_PATH = "/api/hosts";
const PAGE_PATH = "/hosts";

/** Redacted placeholder that keeps entries distinct without leaking the host. */
function redacted(index: number): string {
  return `host #${index + 1}`;
}

function linksFor(entry: UnifiedHost): UnifiedInventoryLink[] {
  return openableProtocols(entry).map((protocol) => {
    const saved = Boolean(entry.protocols[protocol]);
    const port = entry.ports[protocol] ?? (protocol === "rdp" ? 3389 : 22);
    return {
      protocol,
      url: `${protocol}://${encodeURIComponent(entry.username)}@${entry.host}:${port}`,
      port,
      openable: true,
      kind: saved ? "saved" : "derived",
    };
  });
}

function countsFor(hosts: UnifiedInventoryHost[]) {
  const byProtocol: Record<ProtocolType, number> = { ssh: 0, sftp: 0, rdp: 0 };
  for (const host of hosts) {
    for (const link of host.links) byProtocol[link.protocol] += 1;
  }
  return {
    hosts: hosts.length,
    profiles: hosts.reduce((total, host) => total + host.profileCount, 0),
    byProtocol,
  };
}

/**
 * Builds the inventory from merged hosts. `resolve` keeps host/user/name; without it
 * every entry is redacted but still identifiable (id, protocols, ports, counts) — which
 * is what a locked, end-to-end encrypted vault can honestly publish.
 */
export function buildUnifiedInventory(
  entries: UnifiedHost[],
  options: { resolve: boolean; encrypted: boolean; source: "vault" | "server-vault" }
): UnifiedInventory {
  const hosts: UnifiedInventoryHost[] = entries.map((entry, index) => {
    const name = options.resolve ? entry.name : null;
    const host = options.resolve ? entry.host : null;
    const username = options.resolve ? entry.username : null;
    return {
      id: entry.id,
      accessUrl: hostAccessUrl(entry, undefined, ""),
      host: host ?? (options.encrypted ? redacted(index) : null),
      username,
      name: name ?? (options.encrypted ? redacted(index) : null),
      group: options.resolve ? entry.group || null : null,
      tags: options.resolve ? entry.tags : [],
      protocols: entry.available,
      links: options.resolve
        ? linksFor(entry)
        : openableProtocols(entry).map((protocol) => ({
            protocol,
            url: "",
            port: entry.ports[protocol] ?? (protocol === "rdp" ? 3389 : 22),
            openable: true,
            kind: entry.protocols[protocol] ? "saved" : "derived",
          })),
      updatedAt: entry.updatedAt || null,
      lastConnectedAt: entry.lastConnectedAt ?? null,
      profileCount: Object.values(entry.protocols).filter(Boolean).length,
    };
  });

  return {
    ok: true,
    source: options.source,
    encrypted: options.encrypted,
    self: SELF_PATH,
    page: PAGE_PATH,
    counts: countsFor(hosts),
    hosts,
    hint: options.encrypted
      ? "Host names and credentials are end-to-end encrypted in the vault, so this index lists one entry per machine with its protocols and access URLs. Open /hosts in Sushi (or unlock the vault) to see names and connect."
      : "Every saved connection, merged into one entry per machine and account. accessUrl opens it in Sushi; links shows each protocol.",
  };
}

/** Convenience for callers that already have raw profiles. */
export function unifiedInventoryFromProfiles(
  profiles: Parameters<typeof mergeHosts>[0],
  options: { resolve: boolean; encrypted: boolean; source: "vault" | "server-vault" }
): UnifiedInventory {
  return buildUnifiedInventory(mergeHosts(profiles), options);
}
