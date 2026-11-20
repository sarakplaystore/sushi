"use client";

import React, { useState } from "react";
import {
  Database,
  CheckCircle2,
  XCircle,
  Copy,
  Loader2,
  RefreshCw,
  Info,
} from "lucide-react";
import type { StorageBackendSetup, StorageSetupStatus } from "@/types/auth";

interface StorageSetupGuideProps {
  storageSetup?: StorageSetupStatus | null;
  onRefreshStatus: () => void;
}

/** Copy-paste setup block shown when the user clicks "Copy instructions". */
const COPY_BLOCKS: Record<StorageBackendSetup["key"], string> = {
  turso: `# Option 1 — one-click: add the Turso Marketplace integration in Vercel.
# Option 2 — set these environment variables (Vercel → Settings → Environment Variables):
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-database-token
# Then save and click "Check again" below.`,
  redis: `# Any Redis database with an Upstash-compatible REST API (e.g. Upstash).
# Set these environment variables (Vercel → Settings → Environment Variables):
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-redis-token
# Then save and click "Check again" below.`,
  firestore: `# Google Cloud Firestore (Native mode) with server-side IAM credentials.
# Set these environment variables (Vercel → Settings → Environment Variables):
SUSHI_STORAGE_BACKEND=firestore
SUSHI_FIRESTORE_PROJECT_ID=your-gcp-project-id
# Then save and click "Check again" below.`,
};

/** Canonical env vars shown when the server has not reported anything. */
const EXAMPLE_VARS: Record<StorageBackendSetup["key"], string[]> = {
  turso: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
  redis: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  firestore: ["SUSHI_STORAGE_BACKEND=firestore", "SUSHI_FIRESTORE_PROJECT_ID"],
};

function EnvVarRow({ name, state }: { name: string; state: "set" | "missing" }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
        state === "set"
          ? "border-emerald-500/25 bg-emerald-500/10"
          : "border-amber-500/30 bg-amber-500/10"
      }`}
    >
      <code className="truncate font-mono text-[11px] text-slate-200">{name}</code>
      {state === "set" ? (
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5" /> Set
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-amber-200">
          <XCircle className="h-3.5 w-3.5" /> Add
        </span>
      )}
    </div>
  );
}

function BackendCard({
  backend,
  recommended,
}: {
  backend: StorageBackendSetup;
  recommended: boolean;
}) {
  const vars =
    backend.present.length > 0 || backend.missing.length > 0
      ? [
          ...backend.present.map((name) => ({ name, state: "set" as const })),
          ...backend.missing.map((name) => ({ name, state: "missing" as const })),
        ]
      : EXAMPLE_VARS[backend.key].map((name) => ({ name, state: "missing" as const }));

  return (
    <div
      className={`rounded-xl border p-4 ${
        backend.configured
          ? "border-emerald-500/30 bg-emerald-500/5"
          : recommended
            ? "border-[#ff6b57]/40 bg-[#ff6b57]/5"
            : "border-white/10 bg-white/5"
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-slate-400" />
          <h3 className="text-xs font-semibold text-white">{backend.name}</h3>
        </div>
        {backend.configured ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> Connected
          </span>
        ) : recommended ? (
          <span className="rounded-full bg-[#ff6b57]/15 px-2 py-0.5 text-[10px] font-medium text-[#ff8b7a]">
            Recommended
          </span>
        ) : null}
      </div>
      <p className="mb-3 text-[11px] leading-snug text-slate-400">
        {backend.description}
      </p>
      <div className="space-y-2">{vars.map((v) => (
        <EnvVarRow key={v.name} name={v.name} state={v.state} />
      ))}</div>
    </div>
  );
}

export function StorageSetupGuide({
  storageSetup,
  onRefreshStatus,
}: StorageSetupGuideProps) {
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const backend = storageSetup?.backend ?? "none";
  const backends = storageSetup?.backends ?? [];
  const recommended = storageSetup?.recommended ?? "turso";

  const handleCopy = async (key: StorageBackendSetup["key"]) => {
    const block = COPY_BLOCKS[key];
    try {
      await navigator.clipboard.writeText(block);
    } catch {
      // Fallback for non-secure contexts: select a hidden textarea copy.
      const area = document.createElement("textarea");
      area.value = block;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore
      }
      document.body.removeChild(area);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleCheckAgain = () => {
    setChecking(true);
    void onRefreshStatus();
    window.setTimeout(() => setChecking(false), 1500);
  };

  const detectedLabel =
    backend === "turso" || backend === "redis" || backend === "firestore"
      ? backends.find((b) => b.key === backend)?.name ?? backend
      : backend === "disk"
        ? "Local disk"
        : null;

  return (
    <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
      <div className="w-full max-w-lg space-y-5 rounded-2xl border border-amber-500/30 bg-[#0f131b] p-6 shadow-2xl sm:p-7">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
            <Database className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">
              Connect shared storage
            </h1>
            <p className="text-xs text-slate-400">
              Sushi needs one durable database so every device shares the same
              admin account — otherwise each device creates its own.
            </p>
          </div>
        </div>

        {storageSetup?.error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{storageSetup.error}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Info className="h-4 w-4 shrink-0 text-slate-400" />
            {detectedLabel ? (
              <span>
                Detected on this deployment:{" "}
                <span className="font-semibold text-white">{detectedLabel}</span>
              </span>
            ) : (
              <span>No shared storage detected on this deployment.</span>
            )}
          </div>
        </div>

        <div className="space-y-3">
          {backends.map((b) => (
            <BackendCard
              key={b.key}
              backend={b}
              recommended={b.key === recommended}
            />
          ))}
        </div>

        <div className="space-y-2.5">
          <button
            type="button"
            onClick={() => void handleCopy(recommended)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/5 py-2.5 text-xs font-semibold text-white transition hover:bg-white/10"
          >
            {copied ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied ? "Instructions copied" : "Copy setup instructions"}
          </button>
          <button
            type="button"
            onClick={handleCheckAgain}
            disabled={checking}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#ff6b57] py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/20 transition hover:bg-[#ff7f6e] disabled:opacity-50"
          >
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Check again
          </button>
        </div>

        <p className="text-[11px] leading-snug text-slate-500">
          Advanced: set{" "}
          <code className="rounded bg-white/10 px-1 font-mono text-slate-400">
            SUSHI_ALLOW_STATELESS_SETUP=true
          </code>{" "}
          to create a single-browser account without shared storage. The account
          then has no cross-device sync until storage is connected.
        </p>
      </div>
    </div>
  );
}
