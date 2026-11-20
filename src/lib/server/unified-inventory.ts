import type { ProtocolType } from "@/types/connection";
import { mergeHosts, openableProtocols, hostAccessUrl, type UnifiedHost } from "@/lib/client/unified-hosts";

/**
 * The inventory behind `GET /api/hosts`: every saved connection, merged so that one
 * machine + account is one entry, with all of its access methods in one object.
 *
 * ## Why this is not "one URL that hands out your servers"
 *
 * Sushi stores an encrypted `{ iv, ciphertext, mode, … }` vault envelope and
 * this endpoint does not decrypt it. The server can derive session-mode keys,
 * however, so the vault is not zero-knowledge encrypted.
 *
 * Without a separately configured clear-text inventory, the endpoint cannot know
 * host names, counts, or protocols from the envelope and returns a placeholder
 * empty list. The workspace lists the real hosts after unlocking the vault.
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
  /** True when this endpoint does not return host names/credentials from the vault. */
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
 * Builds the inventory from supplied merged hosts. `resolve` keeps host/user/name;
 * without it, supplied entries are redacted but remain structurally identifiable.
 * The encrypted vault endpoint supplies no entries because it does not decode them.
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
      ? "This endpoint does not decode the encrypted vault; an empty index does not indicate how many hosts are saved. Open /hosts in Sushi to see and connect to them."
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
