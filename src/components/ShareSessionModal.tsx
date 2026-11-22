"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Info,
  Keyboard,
  Link2,
  Loader2,
  Radio,
  RefreshCw,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import type { GatewaySettings } from "@/lib/client/gateway";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import {
  type ShareListResponse,
  type SharedSessionView,
  buildShareJoinUrl,
  formatShareAge,
  shareManagementHeaders,
  shareManagementUrl,
  sortParticipants,
} from "@/lib/client/shared-ssh";

export interface ShareStartOptions {
  /** Guests may send keystrokes, not just watch. */
  write: boolean;
  /** `passcode` = anyone with the link + a 6-digit code, `account` = Sushi sign-in. */
  access: "passcode" | "account";
}

interface ShareSessionModalProps {
  open: boolean;
  onClose: () => void;
  /** The share this tab is hosting, when it is sharing. */
  activeShare: SharedSessionView | null;
  /** The 6-digit code minted when the share started (shown once, then rotatable). */
  passcode: string | null;
  hostLabel: string;
  /** A live WebSocket PTY is required: sharing is impossible in serverless mode. */
  canShare: boolean;
  busy: boolean;
  error: string | null;
  onStart: (options: ShareStartOptions) => void | Promise<void>;
  onStop: (shareId?: string) => void | Promise<void>;
  onRotate: () => void;
  onOpenGatewayModal: () => void;
  gatewaySettings: GatewaySettings;
}

export function ShareSessionModal({
  open,
  onClose,
  activeShare,
  passcode,
  hostLabel,
  canShare,
  busy,
  error,
  onStart,
  onStop,
  onRotate,
  onOpenGatewayModal,
  gatewaySettings,
}: ShareSessionModalProps) {
  const [write, setWrite] = useState(true);
  const [access, setAccess] = useState<"passcode" | "account">("passcode");
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [shares, setShares] = useState<SharedSessionView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [requiresGateway, setRequiresGateway] = useState(false);
  const [idleHours, setIdleHours] = useState<number | null>(null);

  const joinUrl = useMemo(() => {
    try {
      return activeShare ? buildShareJoinUrl(activeShare.shareId, gatewaySettings.gatewayUrl) : "";
    } catch {
      return "";
    }
  }, [activeShare, gatewaySettings.gatewayUrl]);

  // Ages ("4m", "2h 10m") have to tick or they read as frozen.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const refreshShares = useCallback(async () => {
    try {
      const res = await fetch(shareManagementUrl(gatewaySettings), {
        headers: shareManagementHeaders(gatewaySettings),
        credentials: gatewaySettings.gatewayUrl.trim() ? "omit" : "same-origin",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as ShareListResponse;
      if (!res.ok || data.ok === false) {
        throw new Error(res.status === 404 && gatewaySettings.gatewayUrl.trim()
          ? "Update the gateway to list and manage shared sessions."
          : data.error || `Could not read shared sessions (HTTP ${res.status}).`);
      }
      setShares(data.shares ?? []);
      setRequiresGateway(Boolean(data.requiresGateway));
      if (data.limits?.idleTtlMs) setIdleHours(Math.round(data.limits.idleTtlMs / 3_600_000));
      setListError(null);
    } catch (error) {
      setShares(null);
      setListError(error instanceof Error ? error.message : "Could not read the list of shared sessions.");
    }
  }, [gatewaySettings]);

  useEffect(() => {
    if (!open) return;
    void refreshShares();
  }, [open, refreshShares, activeShare?.shareId, activeShare?.participants.length]);

  const copy = async (kind: "link" | "code", value: string) => {
    if (!value) return;
    await copyTextToClipboard(value);
    setCopied(kind);
    setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1600);
  };

  if (!open) return null;

  const participants = activeShare ? sortParticipants(activeShare.participants) : [];
  const otherShares = (shares ?? []).filter((s) => s.shareId !== activeShare?.shareId);

  return (
    <div className="modal-safe-area fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Users className="h-4 w-4 shrink-0 text-[#ff6b57]" />
            <h2 className="truncate text-base font-semibold text-white">
              {activeShare ? "Shared with your team" : "Share this terminal"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share modal"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {!canShare && !activeShare && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3.5">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <div className="space-y-2 text-[13px] leading-relaxed text-amber-100">
                  <p className="font-medium">This terminal is running on the serverless shell.</p>
                  <p className="text-amber-100/80">
                    Team sharing needs a real WebSocket PTY that stays open between browsers, which
                    only a Sushi VPS, Docker install, or attached gateway (VPS, Railway or Render)
                    provides.
                  </p>
                  <button
                    type="button"
                    onClick={onOpenGatewayModal}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-100 transition hover:bg-amber-500/20"
                  >
                    <Radio className="h-3.5 w-3.5" />
                    Attach a gateway
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
              {error}
            </p>
          )}

          {/* ---- not sharing yet ------------------------------------------------ */}
          {!activeShare && canShare && (
            <div className="space-y-4">
              <p className="text-[13px] leading-relaxed text-slate-300">
                Everyone who joins lands in <span className="font-medium text-white">this exact shell</span>{" "}
                on <span className="font-mono-code text-slate-200">{hostLabel}</span> — same screen,
                same working directory, same running commands. It keeps running on the server after
                you close this tab, so a teammate can pick it back up later.
              </p>

              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <input
                  type="checkbox"
                  checked={write}
                  onChange={(e) => setWrite(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#ff6b57]"
                />
                <span className="space-y-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-white">
                    <Keyboard className="h-3.5 w-3.5 text-slate-400" />
                    Let teammates type
                  </span>
                  <span className="block text-[12px] leading-relaxed text-slate-400">
                    Unchecked they only watch. Either way, everything they do runs as{" "}
                    <span className="font-mono-code text-slate-300">{hostLabel}</span> on the host.
                  </span>
                </span>
              </label>

              <div className="space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Who can join
                </span>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setAccess("passcode")}
                    className={`rounded-xl border p-3 text-left transition ${
                      access === "passcode"
                        ? "border-[#ff6b57]/50 bg-[#ff6b57]/10"
                        : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
                    }`}
                  >
                    <span className="block text-[13px] font-medium text-white">
                      Anyone with the link
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-slate-400">
                      A 6-digit share code is generated. No Sushi account needed.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAccess("account")}
                    className={`rounded-xl border p-3 text-left transition ${
                      access === "account"
                        ? "border-[#ff6b57]/50 bg-[#ff6b57]/10"
                        : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
                    }`}
                  >
                    <span className="block text-[13px] font-medium text-white">
                      Signed-in Sushi accounts
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-slate-400">
                      The link only works for someone signed in to this Sushi instance.
                    </span>
                  </button>
                </div>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => onStart({ write, access })}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#ff6b57] px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-[#ff8578] disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                Start sharing
              </button>
            </div>
          )}

          {/* ---- currently sharing ---------------------------------------------- */}
          {activeShare && (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5">
                <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-200">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                  </span>
                  Live for {formatShareAge(activeShare.createdAt, now)}
                  {activeShare.write ? " · teammates can type" : " · read-only for teammates"}
                </div>
                <p className="mt-1 text-[12px] text-emerald-100/70">
                  {idleHours
                    ? `The shell stays up for ${idleHours}h after the last person leaves.`
                    : "The shell stays up after the last person leaves."}
                </p>
              </div>

              {/* Join link */}
              <div className="space-y-1.5">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <Link2 className="h-3 w-3" />
                  Share this link
                </span>
                <div className="flex items-stretch gap-2">
                  <input
                    readOnly
                    value={joinUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono-code text-[12px] text-slate-200 outline-none focus:border-[#ff6b57]/50"
                  />
                  <button
                    type="button"
                    disabled={!joinUrl}
                    onClick={() => void copy("link", joinUrl)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
                  >
                    {copied === "link" ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied === "link" ? "Copied" : "Copy"}
                  </button>
                  {joinUrl && <a
                    href={joinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                    title="Open the join page in a new tab"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>}
                </div>
                {!joinUrl && <p className="text-xs text-rose-300">The gateway address is invalid; no link was created.</p>}
              </div>

              {/* Passcode */}
              {activeShare.requiresPasscode ? (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Share code
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                      <span className="font-mono-code text-lg font-semibold tracking-[0.4em] text-white">
                        {passcode || "••••••"}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={!passcode}
                      onClick={() => void copy("code", passcode || "")}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
                    >
                      {copied === "code" ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {copied === "code" ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={onRotate}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                      title="Invalidate the current code and mint a new one"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      New code
                    </button>
                  </div>
                </div>
              ) : (
                <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-400">
                  Only people signed in to this Sushi instance can open the link.
                </p>
              )}

              {/* Participants */}
              <div className="space-y-1.5">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <Users className="h-3 w-3" />
                  In this shell ({participants.length})
                </span>
                {participants.length === 0 ? (
                  <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-400">
                    Nobody is attached right now — the shell is still running and waiting.
                  </p>
                ) : (
                  <ul className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/10">
                    {participants.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]"
                      >
                        <span className="flex items-center gap-2 truncate">
                          <span
                            className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${
                              p.role === "owner" ? "bg-[#ff6b57]" : "bg-sky-400"
                            }`}
                          />
                          <span className="truncate text-slate-200">{p.name}</span>
                          {p.role === "owner" && (
                            <span className="shrink-0 rounded border border-[#ff6b57]/30 bg-[#ff6b57]/10 px-1 text-[10px] uppercase tracking-wide text-[#ff9587]">
                              host
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[11px] text-slate-500">
                          {p.canWrite ? "can type" : "watching"} ·{" "}
                          {formatShareAge(p.joinedAt, now)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => onStop()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Stop sharing
              </button>
              <p className="text-[12px] leading-relaxed text-slate-500">
                Stopping disconnects everyone and kills the link. Your own terminal keeps running.
              </p>
            </div>
          )}

          {/* ---- other shares on this server ------------------------------------ */}
          {shares && otherShares.length > 0 && (
            <div className="space-y-1.5 border-t border-white/8 pt-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Other shared sessions here
              </span>
              <ul className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/10">
                {otherShares.map((s) => (
                  <li key={s.shareId} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 space-y-0.5">
                      <span className="block truncate text-[13px] text-slate-200">{s.label}</span>
                      <span className="block text-[11px] text-slate-500">
                        {s.participants.length} attached · {formatShareAge(s.createdAt, now)} ·{" "}
                        {s.requiresPasscode ? "code" : "account"}
                        {s.write ? " · can type" : " · read-only"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <a
                        href={buildShareJoinUrl(s.shareId, gatewaySettings.gatewayUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/10"
                      >
                        Rejoin
                      </a>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void Promise.resolve(onStop(s.shareId)).then(refreshShares)}
                        className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
                      >
                        Stop
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {requiresGateway && (
            <p className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] leading-relaxed text-slate-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This Sushi is running serverless, so it cannot host a shared shell itself. Attach a
              gateway (VPS, Railway or Render) and share from a terminal that connects through it.
            </p>
          )}

          {listError && <p className="text-[12px] text-slate-500">{listError}</p>}
        </div>
      </div>
    </div>
  );
}
