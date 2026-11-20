"use client";

import React, { useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";

/** Vercel cannot safely create a single account without persistent server storage. */
export function EnvironmentLoginGuide({ onRefreshStatus }: { onRefreshStatus: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);

  const checkAgain = async () => {
    setChecking(true);
    try { await onRefreshStatus(); } finally { setChecking(false); }
  };

  return (
    <div className="flex h-full w-full overflow-y-auto bg-[#090b10] p-4">
      <div className="m-auto w-full max-w-lg space-y-5 rounded-2xl border border-white/10 bg-[#0f131b] p-6 shadow-2xl sm:p-7">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#ff6b57]/15 text-[#ff8b7a]">
            <KeyRound className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">Configure admin sign-in</h1>
            <p className="text-xs text-slate-400">No database is required.</p>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-slate-300">
          Import a private <code>.env</code> file from a local checkout linked to this
          Vercel project. The deploy helper saves the admin settings securely and
          starts a new production deployment:
        </p>
        <div className="overflow-x-auto rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-slate-200">
          npm run deploy:vercel -- --env-file .env
        </div>
        <p className="text-[11px] leading-relaxed text-slate-400">
          For a fresh install with no vault to recover, use <code className="text-slate-200">npm run deploy:vercel -- --new</code> to
          generate credentials in <code className="text-slate-200">.env.sushi.local</code>. An authenticated Vercel CLI
          and linked project are required. Existing credentials are never overwritten;
          ordinary Git deployments reuse the saved settings. See the{" "}
          <a href="https://github.com/sarakplaystore/sushi#3-deploy-to-vercel--optional-companion-gateway-vps-railway-or-render" target="_blank" rel="noreferrer" className="underline underline-offset-2">setup guide</a>.
        </p>
        <div className="space-y-2 font-mono text-xs">
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-slate-200">SUSHI_AUTH_USERNAME</div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-slate-200">SUSHI_AUTH_PASSWORD <span className="font-sans text-slate-400">(or SUSHI_AUTH_PASSWORD_HASH)</span></div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-slate-200">SUSHI_AUTH_SECRET <span className="font-sans text-slate-400">(recommended; keep it stable)</span></div>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-400">
          Keep the file private and never commit it. Vercel vaults stay in this browser
          and do not sync to other devices; download a portable encrypted backup before
          clearing browser data.
        </p>
        <p className="text-[11px] leading-relaxed text-amber-200">
          Upgrading an existing deployment? Back up its account and vault before
          removing old storage configuration. See the{" "}
          <a href="https://github.com/sarakplaystore/sushi#migrating-from-database-storage" target="_blank" rel="noreferrer" className="underline underline-offset-2">migration guide</a>.
        </p>
        <button type="button" onClick={() => void checkAgain()} disabled={checking} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#ff6b57] py-2.5 text-xs font-semibold text-white transition hover:bg-[#ff7f6e] disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          Check again
        </button>
      </div>
    </div>
  );
}
