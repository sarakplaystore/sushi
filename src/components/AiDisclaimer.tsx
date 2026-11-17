"use client";

import React, { useEffect, useState } from "react";
import { AlertTriangle, X, ExternalLink } from "lucide-react";

const DISMISS_KEY = "sushi_ai_disclaimer_dismissed_v1";

interface AiDisclaimerProps {
  /** `"card"` on the sign-in screen, `"banner"` inside the workspace. */
  variant?: "card" | "banner";
  /** Remember "Got it" per browser (only for the banner). */
  dismissible?: boolean;
  className?: string;
}

function useDismissed(): [boolean, () => void, boolean] {
  const [dismissed, setDismissed] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // storage blocked — show the notice
    }
    setChecked(true);
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore storage errors
    }
  };

  return [dismissed, dismiss, checked];
}

/**
 * The one place Sushi states what it is, in the product itself: AI-assisted,
 * experimental, no warranty, and it can run commands / control desktops on your
 * servers. Shown on the sign-in screen and once on the launchpad; links to the
 * repository's DISCLAIMER.md and PRIVACY.md.
 *
 * Deliberately short — the full terms live in those two files.
 */
export function AiDisclaimer({
  variant = "banner",
  dismissible = true,
  className = "",
}: AiDisclaimerProps) {
  const [dismissed, dismiss, checked] = useDismissed();

  // Never flash the banner at a returning user before localStorage was read.
  if (variant === "banner" && (!checked || (dismissible && dismissed))) return null;

  const links = (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <a
        href="https://github.com/sarakplaystore/sushi/blob/main/DISCLAIMER.md"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-amber-200 underline decoration-amber-300/40 underline-offset-2 hover:text-amber-100"
      >
        Disclaimer &amp; terms
      </a>
      <span aria-hidden="true" className="text-amber-300/40">
        ·
      </span>
      <a
        href="https://github.com/sarakplaystore/sushi/blob/main/PRIVACY.md"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-amber-200 underline decoration-amber-300/40 underline-offset-2 hover:text-amber-100"
      >
        Privacy
      </a>
      <ExternalLink className="h-2.5 w-2.5 text-amber-300/50" />
    </span>
  );

  const body = (
    <>
      <span className="font-semibold text-amber-200">AI-assisted, experimental software.</span>{" "}
      Sushi is a self-hosted remote-access tool provided <strong>as is, without warranty</strong>.
      It can run commands and control desktops on your servers, and it has{" "}
      <strong>one admin account with full access to every saved host</strong> — limit other
      people on the target machine, not by sharing your admin password. You are responsible for
      your deployment, its data, and the systems you connect to.
    </>
  );

  if (variant === "card") {
    return (
      <div
        role="note"
        className={`flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-3 text-[11px] leading-relaxed text-amber-100/90 ${className}`}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <span className="space-y-1">
          <span className="block">{body}</span>
          <span className="block">{links}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      role="note"
      className={`flex items-start justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-100/90 ${className}`}
    >
      <span className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="space-y-0.5">
          <span className="block">{body}</span>
          <span className="block">{links}</span>
        </span>
      </span>
      {dismissible && (
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded p-1 text-amber-300/70 transition hover:bg-white/10 hover:text-amber-100"
          aria-label="Dismiss the disclaimer notice"
          title="Hide this notice on this browser (it stays in Settings → About)"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
