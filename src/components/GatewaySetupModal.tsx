"use client";

import React, { useState, useEffect } from "react";
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
} from "lucide-react";
import type { SystemCapabilities } from "@/types/connection";
import {
  type GatewaySettings,
  getAuthHeaders,
  resolveGatewayHttpBase,
} from "@/lib/client/gateway";
import { copyTextToClipboard } from "@/lib/client/clipboard";

interface GatewaySetupModalProps {
  isOpen: boolean;
  localCapabilities: SystemCapabilities | null;
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

const GATEWAY_ONLY_SNIPPET = `# Run lightweight WebSocket SSH/RDP bridge on VPS for a Vercel frontend
docker compose up -d guacd
SUSHI_GATEWAY_TOKEN="your-secret-token" ALLOWED_ORIGIN="https://your-app.vercel.app" npm run gateway`;

const RAILWAY_SNIPPET = `# Railway: native PTY + guacd RDP as a companion for a Vercel UI.
# .railway/railway.ts creates both services (Dockerfile.gateway + guacamole/guacd)
# and wires GUACD_HOST to guacd's private DNS name for you.
npm i -g @railway/cli
railway login && railway init
npm i --no-save railway          # SDK, only needed to evaluate .railway/railway.ts
railway config plan              # preview
railway config apply             # create sushi-gateway + guacd
railway variable set SUSHI_GATEWAY_TOKEN="$(openssl rand -hex 24)" --service sushi-gateway
railway variable set ALLOWED_ORIGIN="https://your-app.vercel.app" --service sushi-gateway
# sushi-gateway → Settings → Networking → Generate Domain → paste that URL below`;

const RAILWAY_DASHBOARD_SNIPPET = `# Railway without the CLI: New Project → GitHub Repo → this repository.
# 1. sushi-gateway: Settings → Build Configuration → Dockerfile Path
#      = Dockerfile.gateway   (the root Dockerfile builds the whole app instead)
# 2. + New → Docker Image → guacamole/guacd:1.5.5   (name it "guacd")
# 3. sushi-gateway → Variables: GUACD_HOST = guacd's RAILWAY_PRIVATE_DOMAIN,
#      SUSHI_GATEWAY_TOKEN = openssl rand -hex 24, ALLOWED_ORIGIN = your Vercel URL
# 4. Settings → Networking → Generate Domain → paste it below`;

const RENDER_SNIPPET = `# Render: native PTY gateway as a companion for a Vercel UI.
# Dashboard → New + → Blueprint → this repository: render.yaml builds
# Dockerfile.gateway and generates SUSHI_GATEWAY_TOKEN for you.
# Then set ALLOWED_ORIGIN = https://your-app.vercel.app and copy both that token
# and the service URL (https://sushi-gateway.onrender.com) into Sushi below.
# A free Render instance sleeps when idle and cannot answer a WebSocket handshake
# while asleep — use a paid plan, or keep the "awake" toggle below switched on.`;

/**
 * Places the WebSocket PTY gateway can run. Each one produces the same
 * `wss://` URL that unlocks native PTY shells for a Vercel-hosted Sushi; they
 * differ only in who keeps the process alive (and whether guacd joins it).
 */
const DEPLOY_TARGETS = [
  {
    id: "vps",
    label: "VPS / Docker",
    blurb:
      "Full Sushi + guacd on one Linux box: interactive PTY, team-shared shells and live RDP. Pick this when you already have a server.",
    blocks: [
      { id: "compose", title: "Full self-host (Docker Compose + guacd RDP)", code: DOCKER_COMPOSE_SNIPPET },
      { id: "gw", title: "Companion gateway only (pair with the Vercel UI)", code: GATEWAY_ONLY_SNIPPET },
    ],
  },
  {
    id: "railway",
    label: "Railway",
    blurb:
      "Push this repo and .railway/railway.ts deploys sushi-gateway + guacd on Railway's private network — native PTY and guacd RDP with no server to maintain.",
    blocks: [
      { id: "railway-cli", title: "Railway CLI (two services from .railway/railway.ts)", code: RAILWAY_SNIPPET },
      { id: "railway-dash", title: "Railway dashboard (no CLI)", code: RAILWAY_DASHBOARD_SNIPPET },
    ],
  },
  {
    id: "render",
    label: "Render",
    blurb:
      "New + → Blueprint reads render.yaml and creates the sushi-gateway web service from Dockerfile.gateway. PTY over WebSocket; RDP uses the browser's IronRDP WASM client because Render services cannot address a guacd sidecar.",
    blocks: [{ id: "render", title: "Render Blueprint (render.yaml)", code: RENDER_SNIPPET }],
  },
] as const;

type DeployTargetId = (typeof DEPLOY_TARGETS)[number]["id"];

export function GatewaySetupModal({
  isOpen,
  localCapabilities,
  gatewaySettings,
  onClose,
  onSaveSettings,
}: GatewaySetupModalProps) {
  const [gatewayUrl, setGatewayUrl] = useState(gatewaySettings.gatewayUrl);
  const [gatewayToken, setGatewayToken] = useState(gatewaySettings.gatewayToken);
  const [probing, setProbing] = useState(false);
  const [probeStatus, setProbeStatus] = useState<{
    ok: boolean;
    message: string;
    caps?: SystemCapabilities;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deployTarget, setDeployTarget] = useState<DeployTargetId>("vps");
  const [keepAwake, setKeepAwake] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setGatewayUrl(gatewaySettings.gatewayUrl);
    setGatewayToken(gatewaySettings.gatewayToken);
    setProbeStatus(null);
  }, [isOpen, gatewaySettings]);

  /**
   * Managed hosts (Render's free instance plan, an idle Railway service) put the
   * gateway to sleep when nothing talks to it, and a sleeping gateway cannot
   * accept a WebSocket upgrade — the first shell then waits for a cold start or
   * fails outright. While this is on, this tab pings the gateway every 4 minutes
   * so it stays warm. It cannot rescue a session that was already dropped: pick
   * an always-on plan (or a VPS) for shells that must survive the night.
   */
  useEffect(() => {
    if (!isOpen || !keepAwake) return;
    const trimmed = gatewayUrl.trim();
    if (!trimmed) return;
    const httpBase = resolveGatewayHttpBase(trimmed);
    const ping = () => {
      void fetch(`${httpBase}/health`, {
        headers: getAuthHeaders({ gatewayUrl: trimmed, gatewayToken }),
        cache: "no-store",
      }).catch(() => {
        // a failed keepalive ping is not worth interrupting the user for
      });
    };
    ping();
    const timer = window.setInterval(ping, 240000);
    return () => window.clearInterval(timer);
  }, [isOpen, keepAwake, gatewayUrl, gatewayToken]);

  if (!isOpen) return null;

  const copyText = (id: string, value: string) => {
    void copyTextToClipboard(value);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
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

    setProbing(true);
    setProbeStatus(null);
    try {
      const httpBase = resolveGatewayHttpBase(trimmed);
      const res = await fetch(`${httpBase}/api/system/capabilities`, {
        headers: getAuthHeaders({ gatewayUrl: trimmed, gatewayToken }),
      });
      if (!res.ok) {
        throw new Error(`Gateway returned HTTP ${res.status}`);
      }
      const caps = (await res.json()) as SystemCapabilities;
      setProbeStatus({
        ok: true,
        message: `Connected to ${caps.mode.toUpperCase()} Gateway • WS SSH: ${
          caps.websocketSsh ? "Ready" : "Off"
        } • RDP guacd: ${caps.rdpGuacd ? "Ready" : "Not running"}`,
        caps,
      });
      return caps;
    } catch (err) {
      setProbeStatus({
        ok: false,
        message:
          err instanceof Error
            ? `Unable to reach gateway: ${err.message}`
            : "Gateway connection failed.",
      });
      return null;
    } finally {
      setProbing(false);
    }
  };

  const handleSave = async () => {
    const trimmed = gatewayUrl.trim();
    let remoteCaps: SystemCapabilities | null = null;
    if (trimmed) {
      remoteCaps = await probeGateway();
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

  return (
    <div className="modal-safe-area fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Radio className="h-4 w-4 text-[#ff6b57]" />
            <h2 className="text-base font-semibold text-white">
              Hybrid VPS &amp; Vercel Deployment Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close gateway settings"
            className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
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
                  {localCapabilities === null ? (
                    <span className="text-slate-400">Detecting…</span>
                  ) : localCapabilities.websocketSsh ? (
                    <span className="text-emerald-400">Active on this host</span>
                  ) : localCapabilities.serverlessSshExec ? (
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
                    {localCapabilities?.rdpGuacd
                      ? "Active (guacd)"
                      : "Active (IronRDP WebAssembly)"}
                  </span>
                </li>
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
                below when you also want persistent WebSocket PTY shells (full-screen{" "}
                <code className="text-slate-300">vim</code>/<code className="text-slate-300">tmux</code>{" "}
                with resize) and team-shared terminals. Any host that keeps one process alive
                works: a <strong className="text-slate-200">VPS</strong>,{" "}
                <strong className="text-slate-200">Railway</strong> (gateway + guacd, private
                network) or <strong className="text-slate-200">Render</strong> (gateway; RDP then
                runs in-browser through IronRDP WASM).
              </p>
            </div>
          </div>

          {/* Remote gateway URL input */}
          <div className="space-y-3 rounded-xl border border-white/10 bg-[#131722] p-4">
            <div className="text-xs font-semibold text-white">
              Remote WebSocket Gateway (optional — only when Sushi runs serverless)
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] text-slate-400">
                  Gateway URL (leave blank to use same-origin server)
                </label>
                <input
                  type="text"
                  value={gatewayUrl}
                  onChange={(e) => setGatewayUrl(e.target.value)}
                  placeholder="https://sushi-gw.yourdomain.com or https://sushi-gateway.up.railway.app"
                  className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none focus:border-white/25"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-slate-400">
                  Gateway Token (SUSHI_GATEWAY_TOKEN)
                </label>
                <input
                  type="password"
                  value={gatewayToken}
                  onChange={(e) => setGatewayToken(e.target.value)}
                  placeholder="Optional token"
                  className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none focus:border-white/25"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
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
                  onClick={() => {
                    setGatewayUrl("");
                    setGatewayToken("");
                    setProbeStatus(null);
                  }}
                  className="text-xs text-slate-400 hover:text-white"
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
                  Keep this gateway awake while this tab is open
                </span>
                Pings <code className="text-slate-300">/health</code> every 4 minutes so a Render
                free instance or an idle Railway service does not sleep between commands. It cannot
                restore a session a sleep already dropped — for shells that must stay up, use an
                always-on plan or a VPS.
              </span>
            </label>

            {probeStatus && (
              <div
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                  probeStatus.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-200"
                }`}
              >
                {probeStatus.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                )}
                <span>{probeStatus.message}</span>
              </div>
            )}
          </div>

          {/* Where the WebSocket PTY gateway runs */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-200">
                Run the WebSocket PTY gateway on…
              </span>
              <div className="flex flex-wrap gap-1 rounded-xl border border-white/10 bg-[#0b0e14] p-1">
                {DEPLOY_TARGETS.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    onClick={() => setDeployTarget(target.id)}
                    aria-pressed={deployTarget === target.id}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      deployTarget === target.id
                        ? "bg-[#ff6b57] text-white"
                        : "text-slate-400 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    {target.label}
                  </button>
                ))}
              </div>
            </div>

            {DEPLOY_TARGETS.filter((target) => target.id === deployTarget).map((target) => (
              <div key={target.id} className="space-y-3">
                <p className="text-xs leading-relaxed text-slate-400">{target.blurb}</p>
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
              Whichever target you pick, the result is the same: one{" "}
              <code className="text-slate-400">wss://</code> URL that turns{" "}
              <span className="text-slate-400">Serverless Stream Active</span> into{" "}
              <span className="text-emerald-400">Active on this host</span> — full-screen{" "}
              <code className="text-slate-400">vim</code>/<code className="text-slate-400">tmux</code>,
              terminal resize and team-shared shells. Set{" "}
              <code className="text-slate-400">ALLOWED_ORIGIN</code> to this app's exact origin and{" "}
              <code className="text-slate-400">SUSHI_GATEWAY_TOKEN</code> to a fresh secret, then
              paste both below.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-white/8 bg-[#0b0e14] px-4 py-3 sm:px-6 sm:py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e]"
          >
            Save Gateway Settings
          </button>
        </div>
      </div>
    </div>
  );
}
