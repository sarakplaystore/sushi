import type { ProtocolType } from "@/types/connection";
import {
  type UnifiedHost,
  accessLinks,
  openableProtocols,
  parseHostDeepLink,
  resolveHostDeepLink,
} from "./unified-hosts";

/**
 * The view behind `/hosts` inside the app.
 *
 * `/hosts` is the one page that lists every machine. The server cannot list them —
 * the vault is end-to-end encrypted and the key lives in the browser — so the page
 * renders **in the workspace**, after the vault is unlocked, from the same merged
 * entries the sidebar uses. This module holds the parts that are pure logic (search,
 * grouping, deep-link resolution, counts, which vault state the page is in) so they
 * can be tested without a DOM, and the component only does presentation.
 *
 * The old server-rendered page is still there for people who are not signed in (and
 * for scripts, via `?format=json`); it is now a page that *redirects* into this view
 * once it can see a session, instead of claiming there are no hosts.
 */

/** Where a host's "one URL" points, e.g. `/?host=unified-…&protocol=sftp`. */
export function hostWorkspaceUrl(
  entry: UnifiedHost,
  protocol?: ProtocolType,
  base = ""
): string {
  const params = new URLSearchParams({ host: entry.id });
  if (protocol) params.set("protocol", protocol);
  return `${base.replace(/\/+$/, "")}/?${params.toString()}`;
}

/** The same URL, made absolute for sharing (falls back to the relative one). */
export function absoluteHostUrl(entry: UnifiedHost, protocol?: ProtocolType): string {
  const url = hostWorkspaceUrl(entry, protocol);
  if (typeof window === "undefined") return url;
  return `${window.location.origin}${url}`;
}

/** One line describing every way into a machine: `SSH :22 · SFTP :22 · RDP :3389`. */
export function protocolSummary(entry: UnifiedHost): string {
  return openableProtocols(entry)
    .map((protocol) => {
      const port = entry.ports[protocol] ?? (protocol === "rdp" ? 3389 : 22);
      return `${protocol.toUpperCase()} :${port}`;
    })
    .join(" · ");
}

export interface AllHostsRow {
  entry: UnifiedHost;
  /** The machine's addresses, always `ssh://user@host:22` shaped. */
  links: Partial<Record<ProtocolType, string>>;
  protocols: ProtocolType[];
  summary: string;
}

export interface AllHostsGroup {
  group: string;
  rows: AllHostsRow[];
}

export interface AllHostsView {
  groups: AllHostsGroup[];
  /** Merged machines after the protocol filter (before search). */
  visibleCount: number;
  /** Every merged machine in the vault. */
  totalCount: number;
  /** Every saved profile those machines stand for. */
  profileCount: number;
  /** Per-protocol counts over the merged machines (what the filter tabs show). */
  byProtocol: Record<ProtocolType, number>;
}

/**
 * Search + protocol filter + grouping for the `/hosts` table.
 *
 * Search matches everything a person might type to find a machine: its name, address,
 * account, folder and tags — and, to keep the page a real index, also the addresses
 * (`ssh://…`, `user@host:22`) so pasting one from a runbook finds the row.
 */
export function buildAllHostsView(
  entries: UnifiedHost[],
  options: { search?: string; protocol?: "all" | ProtocolType } = {}
): AllHostsView {
  const protocol = options.protocol ?? "all";
  const query = (options.search ?? "").trim().toLowerCase();

  const byProtocol: Record<ProtocolType, number> = { ssh: 0, sftp: 0, rdp: 0 };
  for (const entry of entries) {
    for (const way of openableProtocols(entry)) byProtocol[way] += 1;
  }

  const byProtocolFilter =
    protocol === "all"
      ? entries
      : entries.filter((entry) => openableProtocols(entry).includes(protocol));

  const matched = byProtocolFilter
    .map<AllHostsRow>((entry) => {
      const links = accessLinks(entry);
      return {
        entry,
        links,
        protocols: openableProtocols(entry),
        summary: protocolSummary(entry),
      };
    })
    .filter((row) => {
      if (!query) return true;
      const haystack = [
        row.entry.name,
        row.entry.host,
        row.entry.username,
        row.entry.group,
        ...row.entry.tags,
        ...Object.values(row.links),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

  const groups = new Map<string, AllHostsRow[]>();
  for (const row of matched) {
    const group = row.entry.group?.trim() || "Servers";
    const list = groups.get(group);
    if (list) list.push(row);
    else groups.set(group, [row]);
  }

  return {
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, rows]) => ({ group, rows })),
    visibleCount: matched.length,
    totalCount: entries.length,
    profileCount: entries.reduce(
      (total, entry) => total + Object.values(entry.protocols).filter(Boolean).length,
      0
    ),
    byProtocol,
  };
}

/** A link parsed out of `/hosts?host=…&protocol=…` (relative to the app root). */
export interface WorkspaceDeepLink {
  /** `/?host=…&protocol=…` — what the workspace itself understands. */
  workspacePath: string;
  hostId: string;
  protocol: ProtocolType | null;
  /** Set once the vault is open and the link names a machine that exists. */
  entry?: UnifiedHost;
}

/**
 * `/hosts?host=<id>[&protocol=…]` is the link Sushi hands out. Inside the app it must
 * become `/?host=…`, because the workspace reads the host from its own query string.
 * Returns null when the query does not carry a host (the normal `/hosts` visit).
 */
export function workspaceDeepLinkFromSearch(search: string): WorkspaceDeepLink | null {
  const link = parseHostDeepLink(search);
  if (!link) return null;
  const params = new URLSearchParams({ host: link.hostId });
  if (link.protocol) params.set("protocol", link.protocol);
  return {
    workspacePath: `/?${params.toString()}`,
    hostId: link.hostId,
    protocol: link.protocol,
  };
}

/** Attaches the matching merged machine to a parsed deep link, when it exists. */
export function resolveWorkspaceDeepLink(
  link: WorkspaceDeepLink,
  entries: UnifiedHost[]
): WorkspaceDeepLink {
  return { ...link, entry: resolveHostDeepLink(entries, link.hostId) };
}

export type AllHostsStatus =
  /** The vault is open: real names and addresses are on the page. */
  | "ready"
  /** Signed in, vault still being opened. */
  | "loading"
  /** Signed in and the vault opened, but nothing is saved yet. */
  | "empty";

/** Where `/hosts` is in the vault boot: used for the loading / empty copy. */
export function allHostsStatus(options: {
  vaultReady: boolean;
  hostCount: number;
}): AllHostsStatus {
  if (!options.vaultReady) return "loading";
  return options.hostCount > 0 ? "ready" : "empty";
}

/** `3 hosts · 5 profiles · SSH 3 · SFTP 2 · RDP 1` for the page header. */
export function hostsCountLine(view: AllHostsView): string {
  const parts = [
    `${view.totalCount} ${view.totalCount === 1 ? "host" : "hosts"}`,
    `${view.profileCount} ${view.profileCount === 1 ? "profile" : "profiles"}`,
  ];
  for (const protocol of ["ssh", "sftp", "rdp"] as const) {
    if (view.byProtocol[protocol] > 0) {
      parts.push(`${protocol.toUpperCase()} ${view.byProtocol[protocol]}`);
    }
  }
  return parts.join(" · ");
}
