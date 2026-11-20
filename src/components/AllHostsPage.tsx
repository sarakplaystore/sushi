"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  FolderKanban,
  Monitor,
  Search,
  Server,
  Terminal,
  X,
} from "lucide-react";
import type { ProtocolType } from "@/types/connection";
import type { UnifiedHost } from "@/lib/client/unified-hosts";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import {
  absoluteHostUrl,
  allHostsStatus,
  buildAllHostsView,
  hostsCountLine,
  type AllHostsRow,
} from "@/lib/client/all-hosts";

export interface AllHostsPageProps {
  /** Merged machines — the vault's saved hosts, one entry per machine + account. */
  hosts: UnifiedHost[];
  /** Unlocks names and addresses; false while the vault is still opening. */
  vaultReady: boolean;
  /** Opens a machine in the workspace (a tab), optionally on one protocol. */
  onOpen: (entry: UnifiedHost, protocol?: ProtocolType) => void;
  /** Opens the "new connection" dialog. */
  onNewHost: () => void;
  /** Back to the workspace (the launchpad tab). */
  onBack: () => void;
  /** e.g. `?host=…` when the visitor followed a one-machine link. */
  deepLinkHostId?: string | null;
  /** Set when that link named a host this vault does not have. */
  deepLinkError?: string | null;
}

const FILTERS = ["all", "ssh", "sftp", "rdp"] as const;

/**
 * `/hosts` — **every machine, one page, in the app.**
 *
 * This is the human side of `GET /api/hosts`. That route does not decode the encrypted
 * vault, so the list is rendered after the workspace unlocks it. That is why the page
 * is a workspace view rather than a server-rendered table.
 *
 * Each row is a machine, not a saved profile: a server saved for SSH, SFTP and RDP is
 * one row with all three ways in, the exact ports, and the one link that reaches it.
 */
export function AllHostsPage({
  hosts,
  vaultReady,
  onOpen,
  onNewHost,
  onBack,
  deepLinkHostId,
  deepLinkError,
}: AllHostsPageProps) {
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState<"all" | ProtocolType>("all");
  const [copied, setCopied] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  // ⌘K / Ctrl+K focuses the search box here too, like the sidebar's.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const view = useMemo(
    () => buildAllHostsView(hosts, { search, protocol }),
    [hosts, protocol, search]
  );
  const status = allHostsStatus({ vaultReady, hostCount: hosts.length });

  const copy = (value: string, key: string) => {
    void copyTextToClipboard(value).then((ok) => {
      if (!ok) return;
      setCopied(key);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1600);
    });
  };

  return (
    <div className="h-full w-full overflow-y-auto overscroll-contain bg-[#090b10] px-3 pb-10 pt-4 sm:px-6 sm:pt-6">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <header className="space-y-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-white/8 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to workspace
          </button>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-lg font-semibold text-white">
                <Server className="h-4 w-4 text-[#ff6b57]" />
                All hosts
              </h1>
              <p className="mt-0.5 text-xs text-slate-400">
                One row per machine and account — every way in, with its ports and one
                link that reopens it.
              </p>
            </div>
            <button
              type="button"
              onClick={onNewHost}
              className="shrink-0 rounded-xl bg-[#ff6b57] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e]"
            >
              New host
            </button>
          </div>
          {deepLinkError ? (
            <p
              role="alert"
              className="rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-3 py-2 text-[11px] text-rose-100"
            >
              {deepLinkError}
            </p>
          ) : (
            deepLinkHostId &&
            status === "loading" && (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[11px] text-amber-100">
                Opening “{deepLinkHostId}” once the vault unlocks…
              </p>
            )
          )}
        </header>

        {status === "loading" ? (
          <div
            role="status"
            className="rounded-2xl border border-white/10 bg-[#111520] p-6 text-sm text-slate-400"
          >
            Opening your vault to read host names…
          </div>
        ) : status === "empty" ? (
          <div className="rounded-2xl border border-dashed border-white/12 bg-white/[0.015] p-6 text-center">
            <p className="text-sm font-medium text-slate-200">No saved hosts yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
              Add an SSH, SFTP or RDP server and it appears here — one row per machine,
              with SSH, SFTP and RDP side by side.
            </p>
            <button
              type="button"
              onClick={onNewHost}
              className="mt-3 rounded-xl bg-[#ff6b57] px-3 py-2 text-xs font-semibold text-white hover:bg-[#ff7f6e]"
            >
              Add your first host
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  ref={searchRef}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, address, account, folder, tag or link (⌘K)"
                  aria-label="Search hosts"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="w-full rounded-xl border border-white/10 bg-[#111520] py-2.5 pl-9 pr-9 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-500 hover:bg-white/8 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div
                role="tablist"
                aria-label="Filter by protocol"
                className="grid shrink-0 grid-cols-4 gap-1 rounded-xl bg-[#0c1017] p-1 text-xs"
              >
                {FILTERS.map((value) => {
                  const active = protocol === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setProtocol(value)}
                      className={`rounded-lg px-3 py-1.5 font-medium uppercase transition ${
                        active
                          ? "bg-white/12 text-white"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {value}
                    </button>
                  );
                })}
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              {hostsCountLine(view)}
              {(search || protocol !== "all") &&
                ` · showing ${view.visibleCount} of ${view.totalCount}`}
            </p>

            {view.groups.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.015] p-6 text-center">
                <p className="text-sm font-medium text-slate-300">No matching hosts</p>
                <p className="mt-1 text-xs text-slate-500">
                  Try another name, address, folder, tag or protocol.
                </p>
              </div>
            ) : (
              view.groups.map((group) => (
                <section key={group.group} className="space-y-1.5">
                  <h2 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {group.group}
                  </h2>
                  <div className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/10 bg-[#0c1017]">
                    {group.rows.map((row) => (
                      <HostTableRow
                        key={row.entry.id}
                        row={row}
                        copied={copied}
                        onCopy={copy}
                        onOpen={onOpen}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}

            <p className="text-[11px] leading-relaxed text-slate-500">
              Links carry no credentials — they reopen the machine in Sushi with your
              vault. For machines this page does not list (nothing is shared with the
              server), <code className="text-sky-300">GET /api/hosts</code> returns the
              same shape as JSON.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function HostTableRow({
  row,
  copied,
  onCopy,
  onOpen,
}: {
  row: AllHostsRow;
  copied: string | null;
  onCopy: (value: string, key: string) => void;
  onOpen: AllHostsPageProps["onOpen"];
}) {
  const { entry, links, protocols } = row;
  const Icon = entry.protocols.rdp && !entry.protocols.ssh ? Monitor : entry.protocols.ssh ? Terminal : FolderKanban;
  const link = absoluteHostUrl(entry);

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 transition hover:bg-white/[0.03]">
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]"
        style={{ color: entry.accentColor || "#34d399" }}
      >
        <Icon className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-slate-100">{entry.name}</span>
          {entry.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="shrink-0 rounded bg-white/8 px-1 text-[9px] font-semibold uppercase text-slate-400"
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="font-mono-code truncate text-[11px] text-slate-500">
          {Object.values(links).join("  ·  ") || `${entry.username}@${entry.host}`}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {protocols.map((way) => {
          const WayIcon = way === "rdp" ? Monitor : way === "sftp" ? FolderKanban : Terminal;
          return (
            <button
              key={way}
              type="button"
              onClick={() => onOpen(entry, way)}
              className={`flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[10px] font-semibold uppercase transition hover:bg-white/8 ${
                way === "rdp"
                  ? "text-[#ff9587]"
                  : way === "sftp"
                    ? "text-sky-300"
                    : "text-emerald-300"
              }`}
              aria-label={`Open ${entry.name} via ${way.toUpperCase()}`}
              title={`${way.toUpperCase()} · port ${entry.ports[way] ?? (way === "rdp" ? 3389 : 22)}`}
            >
              <WayIcon className="h-3 w-3" />
              {way}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onCopy(link, entry.id)}
          className="ml-1 flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[10px] font-semibold text-slate-300 transition hover:bg-white/8 hover:text-white"
          aria-label={`Copy the link to ${entry.name}`}
          title="Copy this machine's one link (no credentials in it)"
        >
          {copied === entry.id ? (
            <>
              <Check className="h-3 w-3 text-emerald-300" />
              copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              link
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => onOpen(entry)}
          className="flex items-center gap-1 rounded-lg bg-white/8 px-2 py-1 text-[10px] font-semibold text-white transition hover:bg-white/14"
          aria-label={`Open ${entry.name}`}
        >
          Open
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
