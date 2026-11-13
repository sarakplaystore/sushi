"use client";

import { useMemo, useRef } from "react";
import {
  FolderKanban,
  Monitor,
  Pencil,
  Plus,
  Search,
  Terminal,
  X,
} from "lucide-react";
import type { ProtocolType } from "@/types/connection";
import {
  type UnifiedHost,
  filterUnifiedHosts,
  filterUnifiedHostsByProtocol,
  groupUnifiedHosts,
  openableProtocols,
} from "@/lib/client/unified-hosts";

/**
 * The host list — search, protocol filter and one row per merged machine.
 *
 * It lives in its own component because it is now shown twice: inside the sidebar
 * drawer on desktop, and as the main screen on a phone / home-screen web app (where a
 * drawer is the wrong first thing to show: it hides the hero and takes a tap to
 * dismiss). Both surfaces share one implementation, so filters, badges and row actions
 * can never drift apart.
 */
export interface HostNavListProps {
  /** Merged hosts, before the search box and the protocol filter are applied. */
  hosts: UnifiedHost[];
  protocolFilter: "all" | ProtocolType;
  onProtocolFilterChange: (protocol: "all" | ProtocolType) => void;
  search: string;
  onSearchChange: (value: string) => void;
  /** Search box ref, so ⌘K / Ctrl+K can focus it wherever the list is rendered. */
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  /** Opens a merged host, optionally on a specific protocol. */
  onOpen: (entry: UnifiedHost, protocol?: ProtocolType) => void;
  /** Edit the machine / this connection (also where host removal lives). */
  onEdit: (entry: UnifiedHost) => void;
  /** Opens the "new connection" dialog (shown next to search). */
  onNewHost?: () => void;
  /** A dense variant for the drawer, a roomier one for a full screen. */
  variant?: "drawer" | "page";
}

const FILTERS = ["all", "ssh", "sftp", "rdp"] as const;

export function HostNavList({
  hosts,
  protocolFilter,
  onProtocolFilterChange,
  search,
  onSearchChange,
  searchInputRef,
  onOpen,
  onEdit,
  onNewHost,
  variant = "drawer",
}: HostNavListProps) {
  const localSearchRef = useRef<HTMLInputElement | null>(null);
  const inputRef = searchInputRef ?? localSearchRef;

  const filtered = useMemo(
    () => filterUnifiedHosts(filterUnifiedHostsByProtocol(hosts, protocolFilter), search),
    [hosts, protocolFilter, search]
  );
  const grouped = useMemo(() => groupUnifiedHosts(filtered), [filtered]);
  const roomy = variant === "page";

  return (
    <div
      className={
        roomy ? "mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col" : "contents"
      }
    >
      {/* Search + protocol Filter */}
      <div className={roomy ? "space-y-3" : "shrink-0 space-y-2.5 p-3"}>
        <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            ref={inputRef}
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search hosts (⌘K)"
            aria-label="Search hosts"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className={`w-full rounded-xl border border-white/10 bg-[#111520] pl-9 pr-9 text-white placeholder-slate-500 outline-none focus:border-white/25 ${
              roomy ? "py-2.5 text-sm" : "py-1.5 text-xs"
            }`}
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-500 hover:bg-white/8 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {onNewHost && (
          <button
            type="button"
            onClick={onNewHost}
            aria-label="Add new remote host"
            title="Add new remote host"
            className={`flex shrink-0 items-center justify-center rounded-xl bg-[#ff6b57] text-white transition hover:bg-[#ff7f6e] ${
              roomy ? "h-10 w-10" : "h-8 w-8"
            }`}
          >
            <Plus className={roomy ? "h-5 w-5" : "h-4 w-4"} />
          </button>
        )}
        </div>

        <div
          role="tablist"
          aria-label="Filter by protocol"
          className={`grid grid-cols-4 gap-1 rounded-xl bg-[#090b10] p-1 ${
            roomy ? "text-xs" : "text-[11px]"
          }`}
        >
          {FILTERS.map((protocol) => {
            const active = protocolFilter === protocol;
            return (
              <button
                key={protocol}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onProtocolFilterChange(protocol)}
                className={`rounded-lg font-medium uppercase transition ${
                  roomy ? "py-1.5" : "py-1"
                } ${active ? "bg-white/12 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {protocol}
              </button>
            );
          })}
        </div>
      </div>

      {/* One row per machine, grouped like the vault */}
      <div
        className={
          roomy
            ? "mt-3 min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            : "workspace-sidebar-hosts min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-1"
        }
      >
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-4 text-center">
            <p className="text-xs font-medium text-slate-300">
              {hosts.length === 0 ? "No Saved Hosts Yet" : "No Matching Hosts"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              {hosts.length === 0
                ? "Add an SSH, SFTP, or RDP server to store it in your AES-256 vault."
                : "Try another name, address, folder or protocol."}
            </p>
          </div>
        ) : (
          Object.entries(grouped).map(([groupName, groupItems]) => (
            <div key={groupName} className="space-y-1">
              {groupName && (
                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {groupName}
                </div>
              )}
              {groupItems.map((entry) => (
                <HostRow
                  key={entry.id}
                  entry={entry}
                  roomy={roomy}
                  onOpen={onOpen}
                  onEdit={onEdit}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function HostRow({
  entry,
  roomy,
  onOpen,
  onEdit,
}: {
  entry: UnifiedHost;
  roomy: boolean;
  onOpen: HostNavListProps["onOpen"];
  onEdit: HostNavListProps["onEdit"];
}) {
  const ProtoIcon = entry.protocols.rdp
    ? Monitor
    : entry.protocols.ssh
      ? Terminal
      : FolderKanban;
  const protocols = openableProtocols(entry);
  const primary = entry.primary;
  const machineHasManyProfiles = Object.values(entry.protocols).filter(Boolean).length > 1;

  return (
    <div className="group flex min-w-0 items-center gap-1 rounded-xl px-2 py-1.5 transition hover:bg-white/[0.06]">
      <button
        type="button"
        onClick={() => onOpen(entry)}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        title={`${entry.username}@${entry.host} — ${protocols.join(" / ").toUpperCase()}`}
      >
        <span
          className={`flex shrink-0 items-center justify-center rounded-lg bg-white/[0.04] ${
            roomy ? "h-8 w-8" : "h-7 w-7"
          }`}
          style={{ color: entry.accentColor || "#34d399" }}
        >
          <ProtoIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-100">
              {entry.name}
            </span>
            {/* One badge per way in, so a merged host is obvious */}
            <span className="flex shrink-0 items-center gap-0.5">
              {protocols.map((protocol) => (
                <span
                  key={protocol}
                  className="rounded bg-white/8 px-1 text-[9px] font-semibold uppercase text-slate-400"
                  title={`${protocol.toUpperCase()} · ${
                    entry.ports[protocol] ?? (protocol === "rdp" ? 3389 : 22)
                  }`}
                >
                  {protocol}
                </span>
              ))}
            </span>
          </div>
          <div className="font-mono-code truncate text-[10px] text-slate-500">
            {entry.username}@{entry.host}:{entry.ports.ssh ?? entry.ports.sftp ?? primary.port}
          </div>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        {/* Every protocol is one tap away on the same row. On a phone the SSH / SFTP
            buttons are always visible (no hover to reveal them). */}
        {protocols.includes("rdp") && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(entry, "rdp");
            }}
            className="rounded p-1 text-[#ff6b57]/75 transition hover:bg-[#ff6b57]/20 hover:text-[#ff9587]"
            title={
              entry.protocols.rdp
                ? "Open desktop (RDP)"
                : "Open desktop via derived RDP companion (port 3389)"
            }
            aria-label={`Open ${entry.name} via RDP`}
          >
            <Monitor className="h-3 w-3" />
          </button>
        )}
        {protocols.includes("sftp") && (
          <div
            className={`items-center gap-0.5 ${
              roomy ? "flex" : "hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex"
            }`}
          >
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(entry, "sftp");
              }}
              className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-sky-300"
              aria-label={`Open ${entry.name} as SFTP`}
              title="Open as SFTP"
            >
              <FolderKanban className="h-3 w-3" />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(entry);
          }}
          className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          aria-label={`Edit ${entry.name}`}
          title={
            machineHasManyProfiles
              ? "Edit or remove this connection (each protocol keeps its own profile)"
              : "Edit or remove host"
          }
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
