"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Monitor,
  Maximize2,
  Camera,
  Clipboard,
  RotateCw,
  Download,
  Keyboard as KeyboardIcon,
  Radio,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ShieldCheck,
  Shrink,
  X,
} from "lucide-react";
import type { HostProfile, RdpProbeResult } from "@/types/connection";
import {
  type GatewaySettings,
  buildWebSocketUrl,
  getAuthHeaders,
} from "@/lib/client/gateway";
import { downloadRdpFile } from "@/lib/client/rdp-file";

interface RdpDesktopSessionProps {
  profile: HostProfile;
  isActive: boolean;
  guacdAvailable: boolean;
  gatewaySettings: GatewaySettings;
  onOpenGatewayModal: () => void;
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// X11 keysyms used by Guacamole protocol
const KEYSYMS = {
  CTRL_L: 0xffe3,
  ALT_L: 0xffe9,
  SHIFT_L: 0xffe1,
  DELETE: 0xffff,
  SUPER_L: 0xffeb,
  TAB: 0xff09,
  ESCAPE: 0xff1b,
  F4: 0xffc1,
};

export function RdpDesktopSession({
  profile,
  isActive,
  guacdAvailable,
  gatewaySettings,
  onOpenGatewayModal,
}: RdpDesktopSessionProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const displayHostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<import("guacamole-common-js").Client | null>(null);
  const keyboardFocusedRef = useRef<boolean>(false);

  const shouldAttemptStreamDefault = Boolean(
    guacdAvailable || gatewaySettings.gatewayUrl.trim()
  );

  const [streamEnabled, setStreamEnabled] = useState<boolean>(
    shouldAttemptStreamDefault
  );
  const [connState, setConnState] = useState<
    "idle" | "connecting" | "connected" | "error" | "closed"
  >(shouldAttemptStreamDefault ? "connecting" : "idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scaleToFit, setScaleToFit] = useState(true);
  const [remoteSize, setRemoteSize] = useState<{ w: number; h: number }>({
    w: profile.rdpWidth || 1280,
    h: profile.rdpHeight || 720,
  });
  const [connectSeq, setConnectSeq] = useState(0);

  const [showSpecialKeys, setShowSpecialKeys] = useState(false);
  const [showClipboard, setShowClipboard] = useState(false);
  const [clipboardText, setClipboardText] = useState("");

  // Live RDP X.224 / TLS / NLA Probe state
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<RdpProbeResult | null>(null);

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      const res = await fetch("/api/rdp/probe", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          host: profile.host,
          port: profile.port || 3389,
        }),
      });
      const data = (await res.json()) as RdpProbeResult;
      setProbeResult(data);
    } catch (err) {
      setProbeResult({
        ok: false,
        reachable: false,
        latencyMs: 0,
        host: profile.host,
        port: profile.port || 3389,
        supportedProtocols: [],
        nlaRequired: false,
        tlsSupported: false,
        error: err instanceof Error ? err.message : "Probe request failed.",
      });
    } finally {
      setProbing(false);
    }
  }, [gatewaySettings, profile.host, profile.port]);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  useEffect(() => {
    if (guacdAvailable || gatewaySettings.gatewayUrl.trim()) {
      setStreamEnabled(true);
    }
  }, [guacdAvailable, gatewaySettings.gatewayUrl]);

  const recalcScale = useCallback(() => {
    const client = clientRef.current;
    const stage = stageRef.current;
    if (!client || !stage) return;
    const display = client.getDisplay();
    const dw = display.getWidth();
    const dh = display.getHeight();
    if (!dw || !dh) return;

    if (!scaleToFit) {
      display.scale(1);
      return;
    }

    const availW = Math.max(200, stage.clientWidth - 16);
    const availH = Math.max(200, stage.clientHeight - 16);
    const scale = Math.min(availW / dw, availH / dh, 1.5);
    display.scale(scale);
  }, [scaleToFit]);

  // Connect Guacamole HTML5 RDP Client
  useEffect(() => {
    if (!streamEnabled) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let guacKeyboard: import("guacamole-common-js").Keyboard | null = null;

    async function startGuacSession() {
      if (!displayHostRef.current) return;
      setConnState("connecting");
      setErrorMessage(null);

      const GuacamoleMod = await import("guacamole-common-js");
      const Guacamole = GuacamoleMod.default || GuacamoleMod;
      if (disposed || !displayHostRef.current) return;

      const wsUrl = buildWebSocketUrl("/ws/rdp", gatewaySettings);
      const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
      const client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      const displayEl = display.getElement();
      displayHostRef.current.innerHTML = "";
      displayHostRef.current.appendChild(displayEl);

      display.onresize = (w: number, h: number) => {
        setRemoteSize({ w, h });
        recalcScale();
      };

      tunnel.onerror = (status) => {
        if (disposed) return;
        setConnState("error");
        setErrorMessage(
          status.message ||
            `RDP stream error (code ${status.code}). Ensure guacd is running on the VPS gateway.`
        );
      };

      client.onerror = (status) => {
        if (disposed) return;
        setConnState("error");
        setErrorMessage(
          status.message || `Remote desktop error (code ${status.code}).`
        );
      };

      client.onstatechange = (state: number) => {
        if (disposed) return;
        // Guacamole.Client states: 0 IDLE, 1 CONNECTING, 2 WAITING, 3 CONNECTED, 4 DISCONNECTING, 5 DISCONNECTED
        if (state === 3) {
          setConnState("connected");
          recalcScale();
        } else if (state === 1 || state === 2) {
          setConnState("connecting");
        } else if (state === 5) {
          setConnState((prev) => (prev === "error" ? "error" : "closed"));
        }
      };

      // Receive remote clipboard updates
      client.onclipboard = (stream, mimetype) => {
        if (mimetype === "text/plain") {
          const reader = new Guacamole.StringReader(stream);
          let buf = "";
          reader.ontext = (chunk) => {
            buf += chunk;
          };
          reader.onend = () => {
            setClipboardText(buf);
          };
        }
      };

      // Mouse binding with scale awareness
      const mouse = new Guacamole.Mouse(displayEl);
      mouse.onmousedown = (state) => {
        keyboardFocusedRef.current = true;
        client.sendMouseState(state, true);
      };
      mouse.onmouseup = (state) => {
        client.sendMouseState(state, true);
      };
      mouse.onmousemove = (state) => {
        client.sendMouseState(state, true);
      };

      // Keyboard binding (active only when desktop canvas has focus)
      guacKeyboard = new Guacamole.Keyboard(window);
      guacKeyboard.onkeydown = (keysym: number) => {
        if (!keyboardFocusedRef.current || !isActive) return true;
        client.sendKeyEvent(1, keysym);
        return false;
      };
      guacKeyboard.onkeyup = (keysym: number) => {
        if (!keyboardFocusedRef.current || !isActive) return;
        client.sendKeyEvent(0, keysym);
      };

      const payload = toBase64Url(
        JSON.stringify({
          host: profile.host,
          port: profile.port || 3389,
          username: profile.username,
          password: profile.password || "",
          domain: profile.domain || "",
          rdpSecurity: profile.rdpSecurity || "any",
          ignoreCert: profile.ignoreCert !== false,
          width: profile.rdpWidth || 1280,
          height: profile.rdpHeight || 720,
          dpi: 96,
        })
      );

      const queryParts = [`payload=${encodeURIComponent(payload)}`];
      if (gatewaySettings.gatewayToken) {
        queryParts.push(
          `token=${encodeURIComponent(gatewaySettings.gatewayToken)}`
        );
      }

      client.connect(queryParts.join("&"));

      if (stageRef.current) {
        resizeObserver = new ResizeObserver(() => recalcScale());
        resizeObserver.observe(stageRef.current);
      }
    }

    void startGuacSession();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      guacKeyboard?.reset();
      try {
        clientRef.current?.disconnect();
      } catch {
        // ignore
      }
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamEnabled, connectSeq]);

  useEffect(() => {
    recalcScale();
  }, [scaleToFit, recalcScale, isActive]);

  const sendKeyCombo = (keys: number[]) => {
    const client = clientRef.current;
    if (!client) return;
    for (const k of keys) client.sendKeyEvent(1, k);
    for (let i = keys.length - 1; i >= 0; i--) client.sendKeyEvent(0, keys[i]);
    setShowSpecialKeys(false);
  };

  const pushClipboardToRemote = async (text: string) => {
    const client = clientRef.current;
    if (!client) return;
    const GuacamoleMod = await import("guacamole-common-js");
    const Guacamole = GuacamoleMod.default || GuacamoleMod;
    const stream = client.createClipboardStream("text/plain");
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
  };

  const captureScreenshot = () => {
    const client = clientRef.current;
    if (!client) return;
    const canvas = client.getDisplay().flatten();
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `rdp-${profile.host}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const toggleFullscreen = () => {
    if (!stageRef.current) return;
    if (!document.fullscreenElement) {
      void stageRef.current.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  };

  const showDiagnosticsPanel =
    !streamEnabled || connState === "error" || connState === "closed";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#090b10]">
      {/* RDP Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 bg-[#0f131b] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              connState === "connected"
                ? "bg-emerald-500/15 text-emerald-300"
                : connState === "connecting"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-[#ff6b57]/15 text-[#ff8b7b]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connState === "connected"
                  ? "bg-emerald-400"
                  : connState === "connecting"
                    ? "animate-pulse bg-amber-400"
                    : "bg-[#ff6b57]"
              }`}
            />
            {connState === "connected"
              ? `Live RDP (${remoteSize.w}×${remoteSize.h})`
              : connState === "connecting"
                ? "Negotiating RDP..."
                : "RDP Inspector / Launcher"}
          </span>

          <span className="font-mono-code text-xs text-slate-400">
            {profile.domain ? `${profile.domain}\\` : ""}
            {profile.username}@{profile.host}:{profile.port || 3389}
          </span>
        </div>

        <div className="relative flex flex-wrap items-center gap-1.5">
          {connState === "connected" && (
            <>
              {/* Special Keys */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowSpecialKeys((v) => !v);
                    setShowClipboard(false);
                  }}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
                >
                  <KeyboardIcon className="h-3.5 w-3.5 text-[#ff6b57]" />
                  <span>Keys</span>
                </button>
                {showSpecialKeys && (
                  <div className="absolute right-0 top-9 z-30 w-52 space-y-1 rounded-xl border border-white/12 bg-[#141924] p-1.5 shadow-2xl">
                    <button
                      type="button"
                      onClick={() =>
                        sendKeyCombo([
                          KEYSYMS.CTRL_L,
                          KEYSYMS.ALT_L,
                          KEYSYMS.DELETE,
                        ])
                      }
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Ctrl + Alt + Del
                    </button>
                    <button
                      type="button"
                      onClick={() => sendKeyCombo([KEYSYMS.SUPER_L])}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Windows / Super Key
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        sendKeyCombo([
                          KEYSYMS.CTRL_L,
                          KEYSYMS.SHIFT_L,
                          KEYSYMS.ESCAPE,
                        ])
                      }
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Task Manager (Ctrl+Shift+Esc)
                    </button>
                    <button
                      type="button"
                      onClick={() => sendKeyCombo([KEYSYMS.ALT_L, KEYSYMS.TAB])}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Alt + Tab
                    </button>
                    <button
                      type="button"
                      onClick={() => sendKeyCombo([KEYSYMS.ALT_L, KEYSYMS.F4])}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Alt + F4
                    </button>
                  </div>
                )}
              </div>

              {/* Clipboard Sync */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowClipboard((v) => !v);
                    setShowSpecialKeys(false);
                  }}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
                >
                  <Clipboard className="h-3.5 w-3.5 text-sky-400" />
                  <span className="hidden sm:inline">Clipboard</span>
                </button>
                {showClipboard && (
                  <div className="absolute right-0 top-9 z-30 w-80 space-y-2 rounded-xl border border-white/12 bg-[#141924] p-3 shadow-2xl">
                    <div className="flex items-center justify-between text-xs font-medium text-white">
                      <span>Remote Clipboard Sync</span>
                      <button
                        type="button"
                        onClick={() => setShowClipboard(false)}
                        className="text-slate-400 hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <textarea
                      rows={4}
                      value={clipboardText}
                      onChange={(e) => setClipboardText(e.target.value)}
                      placeholder="Paste text here to send to remote RDP clipboard..."
                      className="font-mono-code w-full rounded-lg border border-white/10 bg-[#090b10] p-2 text-xs text-white outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void pushClipboardToRemote(clipboardText);
                        setShowClipboard(false);
                      }}
                      className="w-full rounded-lg bg-sky-500 py-1.5 text-xs font-semibold text-slate-950"
                    >
                      Send to Remote Clipboard
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setScaleToFit((v) => !v)}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
                title={scaleToFit ? "Switch to 1:1 native pixels" : "Scale to fit window"}
              >
                <Shrink className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={captureScreenshot}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
                title="Capture PNG screenshot"
              >
                <Camera className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
                title="Toggle Fullscreen"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => downloadRdpFile(profile)}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
            title="Download native .rdp connection file"
          >
            <Download className="h-3.5 w-3.5 text-[#ff6b57]" />
            <span className="hidden sm:inline">.rdp File</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setStreamEnabled(true);
              setConnectSeq((s) => s + 1);
              void runProbe();
            }}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {streamEnabled ? "Reconnect" : "Try Live Stream"}
            </span>
          </button>
        </div>
      </div>

      {/* Main Viewport */}
      <div
        ref={stageRef}
        onMouseEnter={() => {
          keyboardFocusedRef.current = true;
        }}
        onMouseLeave={() => {
          keyboardFocusedRef.current = false;
        }}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#07090d]"
      >
        {/* Guacamole HTML5 Canvas Container */}
        <div
          ref={displayHostRef}
          className={`flex items-center justify-center ${
            showDiagnosticsPanel ? "hidden" : "block"
          }`}
        />

        {connState === "connecting" && streamEnabled && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#090b10]/90 backdrop-blur-xs">
            <Loader2 className="mb-3 h-8 w-8 animate-spin text-[#ff6b57]" />
            <div className="text-sm font-medium text-white">
              Connecting HTML5 RDP Desktop to {profile.host}:{profile.port || 3389}...
            </div>
            <div className="mt-1 text-xs text-slate-400">
              Negotiating X.224 / {profile.rdpSecurity?.toUpperCase() || "ANY"} via guacd
            </div>
          </div>
        )}

        {/* Diagnostics & Hybrid Launcher View (when guacd isn't active or stream errored) */}
        {showDiagnosticsPanel && (
          <div className="mx-auto w-full max-w-2xl space-y-5 p-6">
            <div className="rounded-2xl border border-white/10 bg-[#111621] p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#ff6b57]/15 text-[#ff6b57]">
                    <Monitor className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-white">
                      {profile.name}
                    </h3>
                    <p className="font-mono-code text-xs text-slate-400">
                      rdp://{profile.username}@{profile.host}:{profile.port || 3389}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void runProbe()}
                  disabled={probing}
                  className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10"
                >
                  {probing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                  Re-probe X.224
                </button>
              </div>

              {errorMessage && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Live RDP Handshake Probe Results */}
              <div className="mt-5 rounded-xl border border-white/8 bg-[#0b0e15] p-4">
                <div className="mb-2.5 flex items-center justify-between text-xs font-medium text-slate-300">
                  <span>Live MS-RDPBCGR X.224 &amp; TLS Server Handshake</span>
                  {probeResult && (
                    <span className="font-mono-code text-slate-400">
                      {probeResult.latencyMs} ms
                    </span>
                  )}
                </div>

                {probing && !probeResult ? (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#ff6b57]" />
                    Probing TCP &amp; X.224 negotiation on {profile.host}:
                    {profile.port || 3389}...
                  </div>
                ) : probeResult ? (
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center gap-2">
                      {probeResult.reachable ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-rose-400" />
                      )}
                      <span
                        className={
                          probeResult.reachable
                            ? "font-medium text-emerald-300"
                            : "font-medium text-rose-300"
                        }
                      >
                        {probeResult.reachable
                          ? `Online • ${probeResult.negotiatedProtocol || "RDP Confirmed"}`
                          : probeResult.error || "Host unreachable on RDP port"}
                      </span>
                    </div>

                    {probeResult.supportedProtocols.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {probeResult.supportedProtocols.map((p) => (
                          <span
                            key={p}
                            className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300"
                          >
                            {p}
                          </span>
                        ))}
                        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300">
                          NLA Required: {probeResult.nlaRequired ? "Yes" : "Optional"}
                        </span>
                      </div>
                    )}

                    {probeResult.certificate?.subjectCN && (
                      <div className="font-mono-code mt-2 rounded-lg border border-white/6 bg-white/[0.02] p-2.5 text-[11px] text-slate-300">
                        <div>Certificate CN: {probeResult.certificate.subjectCN}</div>
                        {probeResult.certificate.fingerprint256 && (
                          <div className="truncate text-slate-400">
                            SHA-256: {probeResult.certificate.fingerprint256}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              {/* Launch Actions */}
              <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => downloadRdpFile(profile)}
                  className="flex items-center justify-center gap-2 rounded-xl bg-[#ff6b57] px-4 py-3 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/20 transition hover:bg-[#ff7f6e]"
                >
                  <Download className="h-4 w-4" />
                  Launch Native .rdp Client
                </button>

                <button
                  type="button"
                  onClick={onOpenGatewayModal}
                  className="flex items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/6 px-4 py-3 text-xs font-semibold text-white transition hover:bg-white/12"
                >
                  <Radio className="h-4 w-4 text-emerald-400" />
                  Configure VPS Gateway (guacd)
                </button>
              </div>

              <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
                Live browser RDP streaming uses Apache Guacamole&apos;s{" "}
                <code className="font-mono-code text-slate-300">guacd</code> daemon
                included in <code className="font-mono-code text-slate-300">docker-compose.yml</code>.
                Self-host on a VPS with <code className="font-mono-code text-slate-300">docker compose up -d</code>{" "}
                or attach your VPS Gateway URL to stream full desktop sessions directly inside
                this tab.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
