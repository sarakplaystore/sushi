"use client";

import { CirclePlay, Infinity as InfinityIcon, X } from "lucide-react";
import type { RetainedPty } from "@/lib/client/retained-pty";

/** A saved identifier is not proof the gateway or shell is still running. */
export function RetainedPtyList({
  entries,
  onResume,
  onForget,
}: {
  entries: RetainedPty[];
  onResume: (entry: RetainedPty) => void;
  onForget: (entry: RetainedPty) => void;
}) {
  if (!entries.length) return null;
  return (
    <section aria-label="Saved WebSocket terminals" className="space-y-2">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <InfinityIcon className="h-3.5 w-3.5 text-emerald-300" />
          Saved WebSocket terminals
        </h2>
        <p className="mt-0.5 text-[11px] text-slate-400">
          Resume the same shell on this browser if its gateway and SSH session are still running.
        </p>
      </div>
      {entries.map((entry) => (
        <div key={entry.tabId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2">
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-slate-100">{entry.profile.name}</span>
            <span className="font-mono-code block truncate text-[10px] text-slate-400">
              {entry.profile.username}@{entry.profile.host}:{entry.profile.port}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => onResume(entry)}
              className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/25">
              <CirclePlay className="h-3 w-3" /> Resume terminal
            </button>
            <button type="button" onClick={() => onForget(entry)}
              className="rounded-lg p-1 text-slate-500 hover:bg-white/8 hover:text-rose-300"
              title="Forget this saved terminal (does not stop it)"
              aria-label={`Forget saved terminal ${entry.profile.name}`}>
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}
