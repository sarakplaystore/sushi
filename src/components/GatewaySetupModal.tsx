"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  X,
  Server,
  Cloud,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  Radio,
  Zap,
  ExternalLink,
} from "lucide-react";
import type { SystemCapabilities } from "@/types/connection";
import {
  type GatewaySettings,
  fetchGatewayCapabilities,
  resolveGatewayHttpBase,
} from "@/lib/client/gateway";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { DEFAULT_GATEWAY_ALLOWED_ORIGIN } from "@/lib/gateway-defaults.mjs";

interface GatewaySetupModalProps {
  isOpen: boolean;
  localCapabilities: SystemCapabilities | null;
  /**
   * Capabilities of the attached gateway, as the workspace last read them. The
   * matrix below is about *this Sushi*, and on Vercel this Sushi can never accept
   * a WebSocket upgrade — so without the gateway's own capabilities the "Native
   * WebSocket PTY" row would keep saying "Serverless Stream Active" even after a
   * gateway was attached and proven to work.
   */
  gatewayCapabilities?: SystemCapabilities | null;
  gatewaySettings: GatewaySettings;
  onClose: () => void;
  onSaveSettings: (
    nextSettings: GatewaySettings,
    remoteCaps: SystemCapabilities | null
  ) => void;
}

const DOCKER_COMPOSE_SNIPPET = `# Self-host full Sushi + guacd (SSH, SFTP & Live RDP) on any Linux VPS
git clone https://github.com/sarakplaystore/sushi.git
cd sushi
cp .env.example .env
docker compose up -d --build`;

const GATEWAY_ONLY_SNIPPET = `# Companion gateway + guacd on a VPS, from a Sushi checkout (Node 22 + Docker).
# For a new file and another frontend, append --origin https://your-app.vercel.app
node scripts/provision-gateway.mjs local
docker compose -f docker-compose.gateway.yml up -d --build
# Put an HTTPS reverse proxy in front of 127.0.0.1:3000.
# Read the token privately from .env.gateway.local and enter it below.`;

const RAILWAY_SNIPPET = `# New, dedicated project; run from a Sushi checkout with Node 22 + Railway CLI 5.47.2+.
npm i -g @railway/cli
railway login && railway init
railway status                     # verify the project and environment
npm i --no-save railway@3.17.0     # SDK for .railway/railway.ts
# --apply manages the entire environment and may delete unlisted resources or
# variables. Review the plan and cancel unintended changes.
env -u _ railway config plan       # preview both services
# For a different initial frontend, append --origin https://your-app.vercel.app
node scripts/provision-gateway.mjs railway --apply
# For an existing gateway, railway link then run the helper WITHOUT --apply.
# --apply with --environment NAME requires Railway CLI 5.64.0+.
# Existing tokens/origins (including sealed values) are preserved. Run on a
# trusted machine; the helper reads unsealed variables locally. Avoid concurrent
# edits: Railway variable writes are not atomic create-if-absent.
# Copy the token privately from sushi-gateway → Variables.
# Settings → Networking → Generate Domain → paste that URL below`;

const RAILWAY_DASHBOARD_SNIPPET = `# Railway without the CLI: New Project → GitHub Repo → this repository.
# 1. sushi-gateway: Settings → Build Configuration → Dockerfile Path
#      = Dockerfile.gateway   (the root Dockerfile builds the whole app instead)
# 2. + New → Docker Image → guacamole/guacd:1.5.5   (name it "guacd")
# 3. Variables: GUACD_HOST = guacd's RAILWAY_PRIVATE_DOMAIN.
#    Generate a token locally with openssl rand -hex 24; paste its output (not
#    the command) as SUSHI_GATEWAY_TOKEN. The dashboard does not auto-generate it.
#    ALLOWED_ORIGIN defaults to ${DEFAULT_GATEWAY_ALLOWED_ORIGIN} if absent;
#    add it to Variables only if your Sushi frontend uses a different origin.
# 4. Settings → Networking → Generate Domain → paste it below`;

const RENDER_SNIPPET = `# Render: Dashboard → New + → Blueprint → this repository.
# render.yaml builds Dockerfile.gateway and generates a persistent 256-bit base64
# SUSHI_GATEWAY_TOKEN if absent. An existing value is kept, even if blank; if
# blank, set a strong token explicitly. Copy it privately from Environment.
# If ALLOWED_ORIGIN is absent, the gateway defaults to ${DEFAULT_GATEWAY_ALLOWED_ORIGIN};
# add an Environment variable to override it for another frontend. Existing values stay.
# Copy the public service URL and matching token into Sushi below.
# A free Render instance may sleep; the panel's keep-awake pings are not a guarantee.`;

/**
 * Places the WebSocket PTY gateway can run. Each one produces the same
 * `wss://` URL that unlocks native PTY shells for a Vercel-hosted Sushi; they
 * differ only in who keeps the process alive (and whether guacd joins it).
 */
const DEPLOY_TARGETS = [
  {
    id: "vps",
    label: "VPS / Docker",
    /** How the target is named inside sentences. */
    short: "a VPS",
    blurb:
      "Full Sushi + guacd on one Linux box: interactive PTY, team-shared shells and live RDP. Pick this when you already have a server.",
    // No console to link to: the commands below are the whole setup.
    link: null,
    blocks: [
      { id: "compose", title: "Full self-host (Docker Compose + guacd RDP)", code: DOCKER_COMPOSE_SNIPPET },
      { id: "gw", title: "Companion gateway only (pair with the Vercel UI)", code: GATEWAY_ONLY_SNIPPET },
    ],
  },
  {
    id: "railway",
    label: "Railway",
    short: "Railway",
    blurb:
      "Apply .railway/railway.ts to deploy sushi-gateway + guacd on Railway's private network — native PTY and guacd RDP with no server to maintain.",
    link: {
      label: "railway.com/new",
      href: "https://railway.com/new",
      title: "Open Railway and create the project that .railway/railway.ts describes",
    },
    blocks: [
      { id: "railway-cli", title: "Railway CLI (two services from .railway/railway.ts)", code: RAILWAY_SNIPPET },
      { id: "railway-dash", title: "Railway dashboard (no CLI)", code: RAILWAY_DASHBOARD_SNIPPET },
    ],
  },
  {
    id: "render",
    label: "Render",
    short: "Render",
    blurb:
      "New + → Blueprint reads render.yaml and creates the sushi-gateway web service from Dockerfile.gateway. The blueprint supplies SSH PTY; without a separately configured guacd, RDP uses the browser's IronRDP WASM client.",
    link: {
      label: "render.com/deploy",
      href: "https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi",
      title: "Open Render's Blueprint flow for this repository (reads render.yaml)",
    },
    blocks: [{ id: "render", title: "Render Blueprint (render.yaml)", code: RENDER_SNIPPET }],
  },
] as const;

type DeployTargetId = (typeof DEPLOY_TARGETS)[number]["id"];

type PostDeployGuide = {
  dashboard: { label: string; href: string } | null;
  service: React.ReactNode;
  address: React.ReactNode;
  settings: React.ReactNode;
  example: string;
};

/** What to do with an already-deployed gateway, not how to create another one. */
const POST_DEPLOY_GUIDES: Record<DeployTargetId, PostDeployGuide> = {
  railway: {
    dashboard: { label: "Open Railway dashboard", href: "https://railway.com/dashboard" },
    service: <>Open your project and the right environment, then select the <strong>sushi-gateway</strong> service (or whatever you named it), not guacd. Wait for its deployment to be active.</>,
    address: <>Open <strong>Settings → Networking → Public Networking</strong>. Copy the public domain, or choose <strong>Generate Domain</strong> if there isn’t one. If asked for a target port, choose the gateway’s <code>PORT</code> (the Dockerfile defaults to 3000).</>,
    settings: <>Under the gateway service’s <strong>Variables</strong>, find <code>SUSHI_GATEWAY_TOKEN</code>. The setup command adds missing values; it keeps existing ones. If your origin differs from the default or an existing override, set <code>ALLOWED_ORIGIN</code> to the Sushi origin shown below. Deploy changes and wait for the service to be active.</>,
    example: "https://your-gateway.up.railway.app",
  },
  render: {
    dashboard: { label: "Open Render dashboard", href: "https://dashboard.render.com" },
    service: <>Open your <strong>sushi-gateway</strong> web service (or whatever you named it) in the Render dashboard and wait for its deployment to be live.</>,
    address: <>Copy the public <strong>onrender.com</strong> URL shown at the top of the service page, or use your public custom domain.</>,
    settings: <>Open <strong>Environment</strong> and find <code>SUSHI_GATEWAY_TOKEN</code> (generated for a new Sushi Blueprint deployment). If your origin differs from the default or an existing override, add or update <code>ALLOWED_ORIGIN</code> to the Sushi origin shown below; save and deploy any changes.</>,
    example: "https://your-gateway.onrender.com",
  },
  vps: {
    dashboard: null,
    service: <>Run the Sushi gateway on your server and put an HTTPS reverse proxy in front of it.</>,
    address: <>Use the public HTTPS address of that proxy. It must forward WebSocket requests to the gateway’s listening port.</>,
    settings: <>Find <code>SUSHI_GATEWAY_TOKEN</code> in the gateway’s environment or private <code>.env.gateway.local</code>. Check <code>ALLOWED_ORIGIN</code> matches the Sushi origin shown below and restart the gateway if settings changed.</>,
    example: "https://gateway.example.com",
  },
};

function targetFromGatewayUrl(url: string): DeployTargetId | null {
  if (!url.trim()) return null;
  try {
    const host = new URL(resolveGatewayHttpBase(url)).hostname.toLowerCase();
    if (host.endsWith(".up.railway.app")) return "railway";
    if (host.endsWith(".onrender.com")) return "render";
  } catch {
    // Custom domains and incomplete input do not identify a provider.
  }
  return null;
}

/** One external link, rendered with the "leaves Sushi" affordances. */
interface ExternalDocLink {
  label: string;
  href: string;
  /** What the link is for, shown as the tooltip. */
  title: string;
}

/**
 * Where each gateway target keeps `SUSHI_GATEWAY_TOKEN` — the value that has to
 * be copied into the field above. Every host stores it somewhere different
 * (Railway's Variables tab, the value Render generated from `render.yaml`, a
 * VPS `.env`), which is the part people actually get stuck on, so the token
 * field links straight there instead of only naming the variable.
 *
 * Single source of truth on purpose: `tests/gateway-deploy.test.ts` reads these
 * URLs and checks them against the README and `.env.example`, so a link cannot
 * drift into a 404 in one place while the docs still point somewhere else.
 */
export const GATEWAY_TOKEN_LINKS: Record<
  DeployTargetId,
  { where: string; links: ExternalDocLink[] }
> = {
  vps: {
    where: "the gateway's private .env.gateway.local or service environment",
    links: [
      {
        label: ".env.example",
        href: "https://github.com/sarakplaystore/sushi/blob/main/.env.example",
        title: "SUSHI_GATEWAY_TOKEN as documented in the repository's .env.example",
      },
    ],
  },
  railway: {
    where: "sushi-gateway → Variables",
    links: [
      {
        label: "Railway dashboard",
        href: "https://railway.com/dashboard",
        title: "Open Railway: your project's sushi-gateway service → Variables tab",
      },
      {
        label: "Variables docs",
        href: "https://docs.railway.com/variables",
        title: "How Railway service variables work, and how to add or seal one",
      },
    ],
  },
  render: {
    where: "sushi-gateway → Environment",
    links: [
      {
        label: "Render dashboard",
        href: "https://dashboard.render.com",
        title: "Open Render: your sushi-gateway service → Environment tab",
      },
      {
        label: "Environment docs",
        href: "https://render.com/docs/configure-environment-variables",
        title:
          "Where Render shows the SUSHI_GATEWAY_TOKEN that render.yaml generated, and how to change it",
      },
    ],
  },
};

export function GatewaySetupModal({
  isOpen,
  localCapabilities,
  gatewayCapabilities,
  gatewaySettings,
  onClose,
  onSaveSettings,
}: GatewaySetupModalProps) {
  const [gatewayUrl, setGatewayUrl] = useState(gatewaySettings.gatewayUrl);
  const [gatewayToken, setGatewayToken] = useState(gatewaySettings.gatewayToken);
  const [probing, setProbing] = useState(false);
  const [hasProbedGateway, setHasProbedGateway] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [probeStatus, setProbeStatus] = useState<{
    ok: boolean;
    message: string;
    caps?: SystemCapabilities;
    warning?: boolean;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deployTarget, setDeployTarget] = useState<DeployTargetId>("railway");
  const [appOrigin, setAppOrigin] = useState("");
  const [originCopyState, setOriginCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [keepAwake, setKeepAwake] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setGatewayUrl(gatewaySettings.gatewayUrl);
    setGatewayToken(gatewaySettings.gatewayToken);
    setProbeStatus(null);
    setHasProbedGateway(false);
    setAppOrigin(window.location.origin === "null" ? "" : window.location.origin);
    setOriginCopyState("idle");
    const detectedTarget = targetFromGatewayUrl(gatewaySettings.gatewayUrl);
    if (detectedTarget) setDeployTarget(detectedTarget);
  }, [isOpen, gatewaySettings]);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      const isVisible = (element: HTMLElement) =>
        element.isConnected && element.getClientRects().length > 0 &&
        window.getComputedStyle(element).visibility === "visible";
      if (previousFocus instanceof HTMLElement && previousFocus !== document.body && isVisible(previousFocus)) {
        previousFocus.focus();
        return;
      }
      // The Settings menu that opened the dialog may have unmounted. Return to
      // its visible trigger (or to mobile navigation) rather than leaving focus lost.
      const fallback = Array.from(document.querySelectorAll<HTMLElement>(
        'button[aria-controls="workspace-settings"], button[aria-label="Open navigation"]'
      )).find(isVisible);
      fallback?.focus();
    };
  }, [isOpen]);

  /**
   * Managed hosts (Render's free instance plan, an idle Railway service) put the
   * gateway to sleep when nothing talks to it, and a sleeping gateway cannot
   * accept a WebSocket upgrade — the first shell then waits for a cold start or
   * fails outright. While this panel is open, it attempts a ping every 4 minutes.
   * Browsers and hosts may still suspend it, and it cannot rescue a dropped session.
   */
  useEffect(() => {
    if (!isOpen || !keepAwake) return;
    const trimmed = gatewayUrl.trim();
    if (!trimmed) return;
    const httpBase = resolveGatewayHttpBase(trimmed);
    const ping = () => {
      void fetch(`${httpBase}/health`, {
        credentials: "omit",
        cache: "no-store",
      }).catch(() => {
        // a failed keepalive ping is not worth interrupting the user for
      });
    };
    ping();
    const timer = window.setInterval(ping, 240000);
    return () => window.clearInterval(timer);
  }, [isOpen, keepAwake, gatewayUrl]);

  if (!isOpen) return null;

  /** The selected target, and where it keeps `SUSHI_GATEWAY_TOKEN`. */
  const activeTarget =
    DEPLOY_TARGETS.find((target) => target.id === deployTarget) ?? DEPLOY_TARGETS[0];
  const activeTokenLocation = GATEWAY_TOKEN_LINKS[activeTarget.id];
  const activeTokenLinks = activeTokenLocation.links;
  const postDeployGuide = POST_DEPLOY_GUIDES[activeTarget.id];

  /** Never revive an old saved response after a newer probe or field edit. */
  const matchesSavedSettings =
    gatewayUrl.trim() === gatewaySettings.gatewayUrl.trim() &&
    gatewayToken.trim() === gatewaySettings.gatewayToken.trim();
  const gatewayAttached = Boolean(gatewayUrl.trim());
  const attachedCaps = !gatewayAttached
    ? null
    : probeStatus
      ? probeStatus.ok ? probeStatus.caps ?? null : null
      : !hasProbedGateway && matchesSavedSettings ? gatewayCapabilities ?? null : null;
  /** Only show the host, never credentials or a path. */
  const gatewayLabel = (() => {
    const raw = gatewayUrl.trim();
    if (!raw) return "";
    try {
      return new URL(resolveGatewayHttpBase(raw)).host;
    } catch {
      return raw.replace(/^https?:\/\//, "").split("/")[0];
    }
  })();

  const copyText = (id: string, value: string) => {
    void copyTextToClipboard(value);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const copyAppOrigin = async () => {
    if (!appOrigin) return;
    setOriginCopyState(await copyTextToClipboard(appOrigin) ? "copied" : "failed");
  };

  const probeGateway = async (): Promise<SystemCapabilities | null> => {
    const trimmed = gatewayUrl.trim();
    if (!trimmed) {
      setProbeStatus({
        ok: true,
        message: "Using built-in same-origin server endpoints.",
        caps: localCapabilities || undefined,
      });
      return null;
    }

    setHasProbedGateway(true);
    setProbing(true);
    setProbeStatus(null);
    // Shared with the workspace's boot probe, so both honour the same timeout: a
    // gateway that is asleep must never leave this spinner running forever.
    const result = await fetchGatewayCapabilities({
      gatewayUrl: trimmed,
      gatewayToken,
    });
    setProbing(false);

    if (!result.ok || !result.caps) {
      setProbeStatus({
        ok: false,
        message: result.timedOut
          ? result.error || "Gateway did not answer in time. Wake it and retry."
          : `Unable to reach gateway: ${result.error}`,
      });
      return null;
    }

    const caps = result.caps;
    const missingToken = Boolean(caps.requiresGatewayToken && !gatewayToken.trim());
    setProbeStatus({
      ok: true,
      warning: !caps.websocketSsh || missingToken,
      message: `HTTP endpoint reached (${caps.mode.toUpperCase()}) • PTY advertised: ${
        caps.websocketSsh ? "Yes" : "No"
      }. ${missingToken ? "This gateway reports that a token is required. " : ""}Open an SSH session after saving to verify WebSocket and token.`,
      caps,
    });
    return caps;
  };

  const handleSave = async () => {
    const trimmed = gatewayUrl.trim();
    let remoteCaps: SystemCapabilities | null = null;
    if (trimmed) {
      // A successful test already describes these unedited fields; avoid making
      // the user wait for a second cold-start-prone request when saving.
      remoteCaps = probeStatus?.ok && probeStatus.caps ? probeStatus.caps : await probeGateway();
    }
    onSaveSettings(
      {
        gatewayUrl: trimmed,
        gatewayToken: gatewayToken.trim(),
      },
      remoteCaps
    );
    onClose();
  };

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!probing) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'
    )).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (active === dialog || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  return (
    <div className="modal-safe-area fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-modal-title"
        aria-busy={probing}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Radio className="h-4 w-4 text-[#ff6b57]" />
            <h2 id="gateway-modal-title" className="text-base font-semibold text-white">
              PTY Gateway Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={probing}
            aria-label="Close gateway settings"
            className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <section aria-labelledby="gateway-guide-title" className="space-y-4 rounded-xl border border-sky-400/20 bg-sky-400/5 p-4">
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-300">After deploying</p>
              <h3 id="gateway-guide-title" className="text-sm font-semibold text-white">Find your PTY gateway</h3>
              <p className="text-xs leading-relaxed text-slate-300">
                Interactive PTY connections go through a running Sushi gateway service. Use that
                service’s public address—not your database URL or the SSH server you want to connect to.
              </p>
            </div>

            <div role="group" aria-label="Where did you deploy the gateway?" className="flex flex-wrap gap-1.5">
              {DEPLOY_TARGETS.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => setDeployTarget(target.id)}
                  aria-pressed={deployTarget === target.id}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-sky-300 ${
                    deployTarget === target.id
                      ? "border-sky-400/50 bg-sky-400/15 text-sky-100"
                      : "border-white/10 bg-[#0b0e14] text-slate-300 hover:bg-white/5"
                  }`}
                >
                  {target.label}
                </button>
              ))}
            </div>

            <ol className="space-y-3 text-xs leading-relaxed text-slate-300">
              {[
                { title: "Find the gateway service", content: postDeployGuide.service },
                { title: "Copy its public address", content: postDeployGuide.address },
                { title: "Check its gateway settings", content: postDeployGuide.settings },
              ].map((step, index) => (
                <li key={step.title} className="flex min-w-0 gap-2.5">
                  <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-sky-400/20 bg-[#101b28] text-[11px] font-semibold text-sky-200">{index + 1}</span>
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-semibold text-slate-100">{step.title}</p>
                    <p>{step.content}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="space-y-2 rounded-lg border border-white/10 bg-[#0b0e14] p-3 text-[11px] leading-relaxed text-slate-300">
              <p>
                <strong className="text-slate-100">Example only:</strong>{" "}
                <code className="break-all text-sky-200">{postDeployGuide.example}</code>
              </p>
              <p>
                Paste the public <code>https://</code> base URL, without <code>/ws/ssh</code> or
                a health-check path. Sushi adds the WebSocket path automatically. Do not use a
                private service address or a guacd address.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span>Your Sushi origin for <code>ALLOWED_ORIGIN</code>:</span>
                <code className="break-all text-sky-200">{appOrigin || "Open Sushi in a browser"}</code>
                <button
                  type="button"
                  disabled={!appOrigin}
                  onClick={() => void copyAppOrigin()}
                  className="inline-flex items-center gap-1 rounded-md border border-white/12 bg-white/5 px-2 py-1 text-sky-200 hover:bg-white/10 disabled:opacity-50"
                >
                  <Copy className="h-3 w-3" /> Copy Sushi origin
                </button>
                <span role="status" aria-live="polite" className="text-slate-400">
                  {originCopyState === "copied" ? "Copied" : originCopyState === "failed" ? "Could not copy; select the origin above." : ""}
                </span>
              </div>
              <p>
                Up-to-date companion gateways default to <code className="break-all text-slate-200">{DEFAULT_GATEWAY_ALLOWED_ORIGIN}</code> only
                when <code>ALLOWED_ORIGIN</code> is absent. Existing overrides are kept; older
                gateways may need the variable set explicitly. If this page uses another origin,
                set it to the origin shown above.
              </p>
              <p>
                Use the existing <code>SUSHI_GATEWAY_TOKEN</code>. If it is sealed or hidden, use
                your saved copy. If you no longer have it, generate a strong new token, set and
                deploy it on the gateway, then update all gateway clients. Sushi saves the token
                in this browser’s local storage—never share it in chat or commit it to Git.
              </p>
            </div>

            {postDeployGuide.dashboard && (
              <a
                href={postDeployGuide.dashboard.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-sky-300 underline decoration-sky-500/40 underline-offset-2 hover:text-sky-200"
              >
                {postDeployGuide.dashboard.label} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </section>

          {/* Remote gateway URL input */}
          <div className="space-y-3 rounded-xl border border-white/10 bg-[#131722] p-4">
            <div className="text-xs font-semibold text-white">
              Remote WebSocket Gateway (optional)
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label htmlFor="gateway-url" className="mb-1 block text-[11px] text-slate-400">
                  Gateway URL (leave blank to use same-origin server)
                </label>
                <input
                  id="gateway-url"
                  type="text"
                  value={gatewayUrl}
                  disabled={probing}
                  onChange={(e) => { setGatewayUrl(e.target.value); setProbeStatus(null); }}
                  placeholder={postDeployGuide.example}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none focus:border-white/25 disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="gateway-token" className="mb-1 block text-[11px] text-slate-400">
                  Gateway Token (
                  <code className="font-mono-code text-slate-300">SUSHI_GATEWAY_TOKEN</code>)
                </label>
                <input
                  id="gateway-token"
                  type="password"
                  value={gatewayToken}
                  disabled={probing}
                  onChange={(e) => { setGatewayToken(e.target.value); setProbeStatus(null); }}
                  placeholder="Matching gateway token"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none focus:border-white/25 disabled:opacity-60"
                />
              </div>
            </div>

            {/* Where the token you just pasted comes from, per gateway target. */}
            <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[11px] leading-relaxed text-slate-500">
              <span>
                Copy it from {activeTokenLocation.where}
                {activeTokenLinks.length > 0 ? " —" : "."}
              </span>
              {activeTokenLinks.map((doc) => (
                <a
                  key={doc.href}
                  href={doc.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={doc.title}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-sky-300 transition hover:border-sky-400/40 hover:bg-sky-500/10 hover:text-sky-200"
                >
                  {doc.label}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ))}
            </p>

            <p className="text-[11px] leading-relaxed text-slate-400">
              Paste the public address and matching token above, then test and save. The test checks
              the HTTP capabilities endpoint only; it does not verify the token or WebSocket. Open
              a real SSH session afterwards to confirm both. Only use a gateway you trust with your
              connection credentials.
            </p>
            <p className="text-[11px] leading-relaxed text-slate-500">
              If the test fails, check that the service is live, its public domain points to the
              gateway port, and <code>ALLOWED_ORIGIN</code> matches this Sushi origin. Deploy any
              settings changes. If the service is asleep, open its public URL in another tab, wait
              for it to respond, then retry. Settings can still be saved if the test fails, but the
              gateway has not been verified.
            </p>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={probeGateway}
                disabled={probing}
                className="flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10"
              >
                {probing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Test Gateway Endpoint
              </button>
              {gatewayUrl && (
                <button
                  type="button"
                  disabled={probing}
                  onClick={() => {
                    setGatewayUrl("");
                    setGatewayToken("");
                    setProbeStatus(null);
                  }}
                  className="text-xs text-slate-400 hover:text-white disabled:opacity-50"
                >
                  Reset to Same-Origin
                </button>
              )}
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/8 bg-[#0b0e14] px-3 py-2.5">
              <input
                type="checkbox"
                checked={keepAwake}
                onChange={(e) => setKeepAwake(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#ff6b57]"
              />
              <span className="text-[11px] leading-relaxed text-slate-400">
                <span className="flex items-center gap-1.5 font-medium text-slate-200">
                  <Zap className="h-3 w-3 text-amber-300" />
                  Keep this gateway awake while this panel is open
                </span>
                Attempts to ping <code className="text-slate-300">/health</code> every 4 minutes.
                Browsers or hosts may still suspend it, and a dropped session cannot be restored.
                For long-running shells, use an always-on plan or a VPS.
              </span>
            </label>

            {probeStatus && (
              <div
                role="status"
                aria-live="polite"
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                  !probeStatus.ok
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                    : probeStatus.warning
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                }`}
              >
                {!probeStatus.ok || probeStatus.warning ? (
                  <AlertCircle className={`h-4 w-4 shrink-0 ${probeStatus.warning ? "text-amber-400" : "text-rose-400"}`} />
                ) : (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                )}
                <span>{probeStatus.message}</span>
              </div>
            )}
          </div>

          {/* Current Runtime Matrix */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/8 bg-[#141923] p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <Cloud className="h-4 w-4 text-sky-400" />
                Current App Host:{" "}
                <span className="uppercase text-sky-300">
                  {localCapabilities?.mode || "Detecting"}
                </span>
              </div>
              <ul className="mt-2 space-y-1 text-xs text-slate-400">
                <li>
                  • Serverless SFTP Manager:{" "}
                  <span className="text-emerald-400">Active</span>
                </li>
                <li>
                  • Serverless SSH Stream:{" "}
                  <span className="text-emerald-400">Active</span>
                </li>
                <li>
                  • Native WebSocket PTY:{" "}
                  {attachedCaps?.websocketSsh ? (
                    <span className="text-emerald-400">
                      Gateway advertises PTY
                      {gatewayLabel ? ` (${gatewayLabel})` : ""}
                      {attachedCaps.sharedSsh ? " · sharing advertised" : ""}
                    </span>
                  ) : localCapabilities === null && !gatewayAttached ? (
                    <span className="text-slate-400">Detecting…</span>
                  ) : gatewayAttached ? (
                    <span className="text-amber-300">
                      {attachedCaps
                        ? "Gateway reached, but it reports no WebSocket PTY"
                        : "Gateway not verified yet"}
                      <span className="text-slate-500">
                        {" "}
                        — run <em>Test Gateway Endpoint</em> above
                      </span>
                    </span>
                  ) : localCapabilities?.websocketSsh ? (
                    <span className="text-emerald-400">Active on this host</span>
                  ) : localCapabilities?.serverlessSshExec ? (
                    <span className="text-sky-300">
                      Serverless Stream Active
                      <span className="text-slate-500">
                        {" "}
                        (Native PTY optional via Gateway)
                      </span>
                    </span>
                  ) : (
                    <span className="text-amber-300">
                      Needs a gateway (VPS, Railway or Render)
                    </span>
                  )}
                </li>
                <li>
                  • Live HTML5 RDP:{" "}
                  <span className="text-emerald-400">
                    {(attachedCaps?.rdpGuacd ?? localCapabilities?.rdpGuacd)
                      ? "Active (guacd)"
                      : "Active (IronRDP WebAssembly)"}
                  </span>
                </li>
                {gatewayAttached && (
                  <li className="border-t border-white/8 pt-1.5">
                    • Attached gateway:{" "}
                    {attachedCaps ? (
                      <span className="text-emerald-400">
                        {attachedCaps.mode.toUpperCase()} · HTTP endpoint responded · Node{" "}
                        {attachedCaps.nodeVersion}
                        {attachedCaps.requiresGatewayToken ? " · token required" : ""}
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        {probing
                          ? "Checking endpoint…"
                          : probeStatus && !probeStatus.ok
                            ? "Last endpoint check failed"
                            : matchesSavedSettings ? "Saved URL not verified" : "Entered URL not checked yet"}
                      </span>
                    )}
                  </li>
                )}
              </ul>
            </div>

            <div className="rounded-xl border border-white/8 bg-[#141923] p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <Server className="h-4 w-4 text-emerald-400" />
                How Hybrid Mode Works
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                On <strong className="text-slate-200">Vercel</strong>, SFTP file management,
                streaming SSH commands, and live HTML5 RDP desktops run natively on Node
                serverless functions — no VPS needed for SSH, SFTP, or RDP. Vercel cannot accept a
                WebSocket upgrade, so attach a <strong className="text-slate-200">gateway URL</strong>{" "}
                above when you also want persistent WebSocket PTY shells (full-screen{" "}
                <code className="text-slate-300">vim</code>/<code className="text-slate-300">tmux</code>{" "}
                with resize) and team-shared terminals. Any host that keeps one process alive
                works: a <strong className="text-slate-200">VPS</strong>,{" "}
                <strong className="text-slate-200">Railway</strong> (gateway + guacd, private
                network) or <strong className="text-slate-200">Render</strong> (gateway; RDP uses
                IronRDP WASM unless guacd is separately configured).
              </p>
            </div>
          </div>

          {/* Deployment recipes are secondary for people who already deployed. */}
          <details className="rounded-xl border border-white/8 bg-[#131722] p-4">
            <summary className="cursor-pointer text-xs font-semibold text-slate-200">
              Need to deploy a gateway? ({activeTarget.label})
            </summary>
            <div className="mt-3 space-y-3">
            {DEPLOY_TARGETS.filter((target) => target.id === deployTarget).map((target) => (
              <div key={target.id} className="space-y-3">
                <p className="text-xs leading-relaxed text-slate-400">
                  {target.blurb}
                  {target.link && (
                    <>
                      {" "}
                      <a
                        href={target.link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={target.link.title}
                        className="inline-flex items-center gap-1 font-medium text-sky-300 underline decoration-sky-500/40 underline-offset-2 transition hover:text-sky-200"
                      >
                        {target.link.label}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </>
                  )}
                </p>
                {target.blocks.map((block) => (
                  <div key={block.id} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-slate-300">{block.title}</span>
                      <button
                        type="button"
                        onClick={() => copyText(block.id, block.code)}
                        className="flex shrink-0 items-center gap-1 text-xs text-slate-400 hover:text-white"
                      >
                        {copiedId === block.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copiedId === block.id ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="font-mono-code overflow-x-auto rounded-xl border border-white/8 bg-[#090b10] p-3.5 text-[11px] leading-relaxed text-slate-300">
                      {block.code}
                    </pre>
                  </div>
                ))}
              </div>
            ))}

              <p className="text-[11px] leading-relaxed text-slate-500">
                Check the gateway’s <code className="text-slate-400">ALLOWED_ORIGIN</code> matches
                this Sushi origin, then enter its public URL and matching{" "}
                <code className="text-slate-400">SUSHI_GATEWAY_TOKEN</code> above. {activeTokenLinks.length > 0 && (
                  <>
                    On {activeTarget.short} that secret lives in{" "}
                    <a
                      href={activeTokenLinks[0].href}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={activeTokenLinks[0].title}
                      className="inline-flex items-center gap-1 text-sky-400 underline decoration-sky-500/40 underline-offset-2 transition hover:text-sky-300"
                    >
                      {activeTokenLocation.where}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                    .
                  </>
                )}
              </p>
            </div>
          </details>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-white/8 bg-[#0b0e14] px-4 py-3 sm:px-6 sm:py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={probing}
            className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={probing}
            className="rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e] disabled:opacity-50"
          >
            Save Gateway Settings
          </button>
        </div>
      </div>
    </div>
  );
}
