"use client";

import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Rocket } from "lucide-react";

/**
 * Keeps an open tab honest about which build it is running.
 *
 * After a deployment, a tab that was loaded earlier keeps executing the previous
 * JavaScript bundle — that is how a fixed bug can look unfixed (and how an old
 * "press Ctrl+C and add -y" hint survived a release). This banner compares the build
 * id compiled into this page with the one the server is serving now, and offers a
 * reload as soon as they differ.
 */
export default function BuildUpdateBanner() {
  const [staleBuildId, setStaleBuildId] = useState<string | null>(null);

  const check = useCallback(async () => {
    const current = process.env.NEXT_PUBLIC_SUSHI_BUILD_ID;
    if (!current) return;
    try {
      const res = await fetch("/api/system/version", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { buildId?: string };
      if (data.buildId && data.buildId !== current) {
        setStaleBuildId(data.buildId);
      }
    } catch {
      // offline / transient — try again later
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [check]);

  if (!staleBuildId) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-sky-400/40 bg-[#0e1725] px-4 py-2.5 text-xs text-sky-100 shadow-2xl">
      <Rocket className="h-4 w-4 shrink-0 text-sky-300" />
      <span>
        A newer version of Sushi was deployed. This tab is still running the old one —
        reload to pick up the fixes.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="flex shrink-0 items-center gap-1 rounded-md border border-sky-400/40 bg-sky-500/20 px-2 py-1 font-semibold text-sky-100 transition hover:bg-sky-500/30"
      >
        <RefreshCw className="h-3 w-3" /> Reload
      </button>
    </div>
  );
}
