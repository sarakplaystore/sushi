"use client";

import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { AuthStatusResponse, AuthStorageProblem, SharedStorageProvider } from "@/types/auth";

interface StorageSetupGuideProps {
  problem: AuthStorageProblem | null;
  error: string | null;
  onRefreshStatus: () => Promise<AuthStatusResponse | null>;
}

type ProviderGuide = {
  name: string;
  hint: string;
  description: string;
  link: string;
  linkLabel: string;
  create: string;
  connect: string;
  settings: string[];
  note: string;
};

const guides: Record<SharedStorageProvider, ProviderGuide> = {
  turso: {
    name: "Turso",
    hint: "Recommended",
    description: "A hosted SQLite-compatible database, available through the Vercel Marketplace.",
    link: "https://vercel.com/marketplace/tursocloud/database",
    linkLabel: "Open Turso on Vercel",
    create: "Choose Install, then create a database or select an existing Vercel-managed resource. Review the provider's plan and pricing before confirming.",
    connect: "In the resource's Projects tab, connect it to this Sushi project and select Production (or the environment you use). Leave the custom variable prefix blank.",
    settings: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
    note: "Using an existing Turso database outside Vercel? Add its URL and token under Project → Settings → Environment Variables using these names. SUSHI_TURSO_DATABASE_URL and SUSHI_TURSO_AUTH_TOKEN also work as a pair.",
  },
  redis: {
    name: "Redis REST",
    hint: "Upstash / KV",
    description: "Use an Upstash-compatible Redis REST database, including Vercel's Upstash integration.",
    link: "https://vercel.com/marketplace/upstash/upstash-kv",
    linkLabel: "Open Upstash on Vercel",
    create: "Install Upstash for Redis, then create a database or connect an existing resource. Review the provider's plan and pricing before confirming.",
    connect: "Connect the resource to this Sushi project and select Production (or the environment you use). Leave the custom variable prefix blank.",
    settings: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    note: "For an existing Redis REST database, add its URL and token in Project → Settings → Environment Variables. Sushi also accepts the complete UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN or SUSHI_REDIS_REST_URL + SUSHI_REDIS_REST_TOKEN pair. A Redis TCP URL alone will not work.",
  },
  firestore: {
    name: "Firestore",
    hint: "Google Cloud",
    description: "Use a Google Cloud Firestore database with server-side IAM credentials.",
    link: "https://console.cloud.google.com/firestore",
    linkLabel: "Open Google Cloud",
    create: "Create or choose a Firestore database in Native mode. Enable the Firestore API and grant the server identity permission to read and write documents.",
    connect: "In this Vercel project's Settings → Environment Variables, select Production (or the environment you use). Set the backend to firestore and add the project ID and a service-account JSON secret.",
    settings: ["SUSHI_STORAGE_BACKEND=firestore", "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_CREDENTIALS_JSON"],
    note: "Alternatively, use Google Application Default Credentials instead of the JSON secret. SUSHI_FIRESTORE_DATABASE_ID is optional for a named database. See the full Firestore guide below.",
  },
};

const providerOrder: SharedStorageProvider[] = ["turso", "redis", "firestore"];

function StepNumber({ children }: { children: React.ReactNode }) {
  return <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#1a202b] text-xs font-semibold text-slate-300">{children}</span>;
}

export function StorageSetupGuide({ problem, error, onRefreshStatus }: StorageSetupGuideProps) {
  const [provider, setProvider] = useState<SharedStorageProvider>(() =>
    problem?.backend && problem.backend !== "disk" ? problem.backend : "turso"
  );
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (problem?.backend && problem.backend !== "disk") setProvider(problem.backend);
  }, [problem?.backend]);

  useEffect(() => {
    setCopyState("idle");
  }, [provider]);

  const guide = guides[provider];
  const troubleshooting = Boolean(problem || error || checkFailed);
  const providerLink = troubleshooting && provider !== "firestore" ? "https://vercel.com/dashboard" : guide.link;
  const providerLinkLabel = troubleshooting && provider !== "firestore" ? "Open Vercel dashboard" : guide.linkLabel;
  const statusTitle = problem?.reason === "configuration"
    ? "Storage settings need attention"
    : error || checkFailed
      ? "Account storage could not be checked"
      : checked
        ? "Still no shared storage detected"
        : "No shared storage detected";
  const statusText = error || (checkFailed
    ? "The check did not finish. Try again when Sushi is reachable."
    : checked
      ? "This deployment still has no shared storage. Confirm the project and environment, redeploy, and open the new deployment before checking again."
      : "Connect one database before creating the admin account on Vercel.");

  async function checkConnection() {
    setChecking(true);
    setCheckFailed(false);
    try {
      const status = await onRefreshStatus();
      if (status) setChecked(true);
      else setCheckFailed(true);
    } catch {
      setCheckFailed(true);
    } finally {
      setChecking(false);
    }
  }

  async function copySettings() {
    try {
      await navigator.clipboard.writeText(guide.settings.join("\n"));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <main className="flex h-full w-full overflow-y-auto bg-[#090b10] px-4 py-6 sm:px-6 sm:py-10">
      <div className="m-auto w-full max-w-3xl shrink-0">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/sushi-icon.svg" alt="" width={34} height={34} className="h-9 w-9 rounded-xl" />
          <div>
            <p className="text-sm font-bold tracking-wide text-white">SUSHI</p>
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">Storage setup</p>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#10141d] shadow-2xl shadow-black/30">
          <div className="border-b border-white/[0.07] p-5 sm:p-7">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[#ff6b57]/20 bg-[#ff6b57]/10 text-[#ff8b7c]">
              <Database className="h-5 w-5" aria-hidden="true" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">Connect shared storage</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              Give your Sushi account and encrypted vault a durable home, so you can use them across devices.
              Vercel's temporary filesystem cannot keep this data safely.
            </p>
            <div role="status" aria-live="polite" className="mt-5 flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <div>
                <p className="text-xs font-semibold text-amber-100">{statusTitle}</p>
                <p className="mt-1 text-xs leading-5 text-amber-100/70">{statusText}</p>
                {problem?.reason === "unavailable" && (
                  <p className="mt-1 text-xs leading-5 text-amber-100/70">The connection has not been verified. Check the provider, credentials and existing account data before retrying.</p>
                )}
              </div>
            </div>
            <p className="mt-4 text-xs leading-5 text-slate-400">
              <span className="font-semibold text-slate-200">Already have an account?</span> Reconnect its existing database; a new database will not contain your account or vault. See the recovery note below first.
            </p>
          </div>

          <div className="space-y-6 p-5 sm:p-7">
            <section aria-labelledby="storage-provider-heading">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
                <h2 id="storage-provider-heading" className="text-sm font-semibold text-white">Choose one provider</h2>
                <span className="text-xs text-slate-500">Only one database is needed</span>
              </div>
              <div role="group" aria-label="Storage provider" className="grid grid-cols-3 gap-2">
                {providerOrder.map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={provider === key}
                    onClick={() => { setProvider(key); setCopyState("idle"); }}
                    className={`min-h-[66px] rounded-xl border px-2.5 py-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8b7c] sm:px-4 ${provider === key ? "border-[#ff6b57]/60 bg-[#ff6b57]/10" : "border-white/10 bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]"}`}
                  >
                    <span className="block text-xs font-semibold text-white sm:text-sm">{guides[key].name}</span>
                    <span className={`mt-1 block text-[10px] leading-4 sm:text-[11px] ${provider === key ? "text-[#ffab9f]" : "text-slate-500"}`}>{guides[key].hint}</span>
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="provider-steps-heading" className="rounded-xl border border-white/[0.08] bg-[#0c1018] p-4 sm:p-5">
              <div className="mb-5 border-b border-white/[0.07] pb-4">
                <h2 id="provider-steps-heading" className="text-sm font-semibold text-white">Set up {guide.name}</h2>
                <p className="mt-1 text-xs leading-5 text-slate-400">{guide.description}</p>
              </div>
              <ol className="space-y-5">
                <li className="flex gap-3">
                  <StepNumber>1</StepNumber>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-slate-100">{troubleshooting ? "Check your database" : "Choose your database"}</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-400">{troubleshooting
                      ? "Check the existing database and its provider's status. If this is an existing account, do not replace the database or its namespace."
                      : guide.create}</p>
                    <a href={providerLink} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-[#ff6b57]/30 bg-[#ff6b57]/10 px-3 py-2 text-xs font-semibold text-[#ffae9f] transition hover:bg-[#ff6b57]/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8b7c]">
                      {providerLinkLabel}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    {troubleshooting && provider !== "firestore" && (
                      <p className="mt-2 text-[11px] leading-5 text-slate-500">For a new installation, <a href={guide.link} target="_blank" rel="noopener noreferrer" className="text-[#ff9b8c] underline underline-offset-2 hover:text-[#ffc1b7]">open the {guide.name} Marketplace listing<span className="sr-only"> (opens in a new tab)</span></a>.</p>
                    )}
                  </div>
                </li>
                <li className="flex gap-3">
                  <StepNumber>2</StepNumber>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-slate-100">Connect it to this project</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-400">{guide.connect}</p>
                    <p className="mt-2 text-xs leading-5 text-slate-400">In Project → Settings → Environment Variables, confirm the names for that environment match a supported set below.</p>
                    <div className="mt-3 rounded-lg border border-white/[0.07] bg-white/[0.025] p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Settings Sushi recognizes</p>
                        <button type="button" onClick={() => void copySettings()} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400 transition hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8b7c]">
                          {copyState === "copied" ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                          {copyState === "copied" ? "Copied" : "Copy settings"}
                        </button>
                      </div>
                      <div className="space-y-1">{guide.settings.map((name) => <code key={name} className="block break-all font-mono text-[11px] leading-5 text-slate-200">{name}</code>)}</div>
                      {copyState === "failed" && <p role="status" className="mt-2 text-[11px] text-amber-200">Could not copy. Select the settings above to copy them.</p>}
                    </div>
                    <p className="mt-2 text-[11px] leading-5 text-slate-500">{guide.note}</p>
                    {provider === "firestore" && <a href="https://github.com/sarakplaystore/sushi#google-cloud-firestore" target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#ff9b8c] hover:text-[#ffc1b7]">Full Firestore setup <ArrowUpRight className="h-3 w-3" aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>}
                  </div>
                </li>
                <li className="flex gap-3">
                  <StepNumber>3</StepNumber>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-slate-100">Redeploy, then check</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      In Vercel, open this project's Deployments, select the latest deployment for your environment, and choose Redeploy. Wait until it is Ready, then return here and check the connection.
                    </p>
                    <p className="mt-2 text-[11px] leading-5 text-slate-500">
                      Environment changes do not reach old deployments. If you use a unique deployment URL, open the new deployment URL instead; your production domain normally points to the new production deployment. If you deployed with Vercel's prebuilt output, make a fresh build and deployment instead of reusing it.
                    </p>
                    <a href="https://vercel.com/dashboard" target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#ff9b8c] hover:text-[#ffc1b7] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8b7c]">
                      Open Vercel dashboard <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </div>
                </li>
              </ol>
            </section>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="flex items-start gap-2 text-xs leading-5 text-slate-400">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400/80" aria-hidden="true" />
                  Keep database tokens private in Vercel, not in this screen or chat.
                </p>
                <p className="pl-6 text-[11px] leading-5 text-slate-500">The check reads account status; it does not verify or migrate your vault.</p>
              </div>
              <button type="button" onClick={() => void checkConnection()} disabled={checking} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#ff6b57] px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/15 transition hover:bg-[#ff7d6b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8b7c] disabled:cursor-wait disabled:opacity-60">
                {checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                {checking ? "Checking connection…" : "Check connection"}
              </button>
            </div>

            <details className="group rounded-xl border border-white/[0.08] bg-white/[0.025] px-4 py-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold text-slate-300 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8b7c]">
                Protect an existing account or vault <ChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="mt-3 space-y-2 text-xs leading-5 text-slate-400">
                <p>Back up the original database and make a verified portable vault backup before switching storage. Keep the original browser's data. Changing providers does not copy existing data automatically.</p>
                <p>Keep the existing <code>SUSHI_AUTH_SECRET</code> if set. If it is not set, preserve account and gateway environment settings and the Vercel project identity, which can determine the signing secret. Preserve the original namespace (<code>SUSHI_STORAGE_PREFIX</code>, or its default project/environment namespace) and do not rotate secrets while recovering.</p>
                <p>For an older browser-local account, open the original browser first after connecting; follow the migration guide before creating an account.</p>
                <p>If Sushi unexpectedly asks you to create an account, stop and reconnect the original database and namespace rather than creating a replacement.</p>
                <a href="https://github.com/sarakplaystore/sushi#one-account-and-saved-connections-on-multiple-devices" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-[#ff9b8c] hover:text-[#ffc1b7]">Read the account and vault guide <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
              </div>
            </details>
          </div>
        </div>
      </div>
    </main>
  );
}
