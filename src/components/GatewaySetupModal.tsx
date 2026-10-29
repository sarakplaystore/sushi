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

  useEffect(() => {
    if (!isOpen) return;
    setGatewayUrl(gatewaySettings.gatewayUrl);
    setGatewayToken(gatewaySettings.gatewayToken);
    setProbeStatus(null);
  }, [isOpen, gatewaySettings]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Radio className="h-4 w-4 text-[#ff6b57]" />
            <h2 className="text-base font-semibold text-white">
              Hybrid VPS &amp; Vercel Deployment Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
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
                  <span
                    className={
                      localCapabilities?.websocketSsh
                        ? "text-emerald-400"
                        : "text-amber-300"
                    }
                  >
                    {localCapabilities?.websocketSsh
                      ? "Active on this host"
                      : "Requires VPS / Gateway"}
                  </span>
                </li>
                <li>
                  • Live RDP (guacd):{" "}
                  <span
                    className={
                      localCapabilities?.rdpGuacd
                        ? "text-emerald-400"
                        : "text-amber-300"
                    }
                  >
                    {localCapabilities?.rdpGuacd
                      ? "Active on this host"
                      : "Start guacd or attach VPS Gateway"}
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
                streaming SSH commands, and RDP X.224/TLS probes run natively on Node
                serverless functions. Attach a{" "}
                <strong className="text-slate-200">VPS Gateway URL</strong> below to unlock
                persistent WebSocket PTY shells and 60fps HTML5 RDP streaming.
              </p>
            </div>
          </div>

          {/* Remote VPS Gateway URL input */}
          <div className="space-y-3 rounded-xl border border-white/10 bg-[#131722] p-4">
            <div className="text-xs font-semibold text-white">
              Remote VPS WebSocket Gateway (Optional when self-hosted on VPS)
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
                  placeholder="https://sushi-gw.yourdomain.com"
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

          {/* VPS Self-Host Quickstart Commands */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                1. Full Self-Host on VPS (Docker Compose + guacd RDP)
              </span>
              <button
                type="button"
                onClick={() => copyText("compose", DOCKER_COMPOSE_SNIPPET)}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"
              >
                {copiedId === "compose" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedId === "compose" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="font-mono-code overflow-x-auto rounded-xl border border-white/8 bg-[#090b10] p-3.5 text-[11px] leading-relaxed text-slate-300">
              {DOCKER_COMPOSE_SNIPPET}
            </pre>

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs font-semibold text-slate-200">
                2. Companion VPS Gateway Only (Pair with Vercel UI)
              </span>
              <button
                type="button"
                onClick={() => copyText("gw", GATEWAY_ONLY_SNIPPET)}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"
              >
                {copiedId === "gw" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedId === "gw" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="font-mono-code overflow-x-auto rounded-xl border border-white/8 bg-[#090b10] p-3.5 text-[11px] leading-relaxed text-slate-300">
              {GATEWAY_ONLY_SNIPPET}
            </pre>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-white/8 bg-[#0b0e14] px-6 py-4">
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
