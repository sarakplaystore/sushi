"use client";

import type { SshConnectFailure } from "@/lib/client/ssh-retry";
import {
  formatRetryCountdown,
  retryCountdownFraction,
} from "@/lib/client/ssh-retry";

interface SshConnectErrorCardProps {
  failure: SshConnectFailure;
  /** Seconds until the automatic retry, or null when none is scheduled. */
  retryIn: number | null;
  onReconnect: () => void;
  /** Stops the automatic retry but keeps the card (and the Reconnect button). */
  onCancelRetry: () => void;
}

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4.5" />
      <path d="M12 16.2v.01" />
    </svg>
  );
}

function ReconnectIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

/**
 * What a failed SSH connection shows instead of a shell.
 *
 * The card carries exactly the sentence the server produced (host, port, cause and
 * what to check), then offers to reconnect now or wait for the automatic retry.
 * Nothing else is on screen — no banner, no prompt and no echoed command.
 */
export function SshConnectErrorCard({
  failure,
  retryIn,
  onReconnect,
  onCancelRetry,
}: SshConnectErrorCardProps) {
  return (
    <div
      data-testid="ssh-connect-error"
      className="absolute inset-0 z-20 flex items-center justify-center overflow-auto bg-[#090b10] p-4 sm:p-6"
    >
      <div className="w-full max-w-xl rounded-2xl border border-rose-500/30 bg-[#141924] p-5 shadow-2xl">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 rounded-lg border border-rose-500/25 bg-rose-500/10 p-1.5 text-rose-300">
            <AlertIcon />
          </span>
          <p
            data-testid="ssh-connect-error-message"
            role="alert"
            className="min-w-0 select-text break-words font-mono-code text-[13px] leading-relaxed text-slate-100"
          >
            {failure.message}
          </p>
        </div>

        {retryIn !== null && (
          <div className="mt-4">
            <div className="h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[#ff6b57] transition-[width] duration-1000 ease-linear"
                style={{ width: `${Math.round(retryCountdownFraction(retryIn) * 100)}%` }}
              />
            </div>
            <p
              data-testid="ssh-retry-countdown"
              className="mt-2 text-[11px] text-slate-400"
            >
              {formatRetryCountdown(retryIn)}
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="ssh-reconnect"
            onClick={onReconnect}
            className="flex items-center gap-1.5 rounded-lg border border-[#ff6b57]/40 bg-[#ff6b57]/15 px-3 py-1.5 text-xs font-semibold text-[#ffb3a8] transition hover:bg-[#ff6b57]/25"
          >
            <ReconnectIcon />
            Reconnect
          </button>

          {retryIn !== null ? (
            <button
              type="button"
              data-testid="ssh-retry-cancel"
              onClick={onCancelRetry}
              className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/10"
            >
              Stop retrying
            </button>
          ) : (
            <span data-testid="ssh-retry-off" className="text-[11px] text-slate-500">
              Automatic retry is off — fix the cause on the server, then reconnect.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
