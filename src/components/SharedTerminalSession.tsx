"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Keyboard,
  Link2,
  Loader2,
  LogOut,
  RotateCw,
  Terminal,
  Users,
} from "lucide-react";
import { buildWebSocketUrl, getAuthHeaders } from "@/lib/client/gateway";
import { isShareId } from "@/lib/share-gateway";
import { getStoredSessionToken } from "@/lib/client/auth-storage";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { DEFAULT_TERMINAL_FONT_SIZE, TerminalFontSizeControl } from "@/components/TerminalFontSizeControl";
import {
  type SharedParticipantView,
  type SharedSessionView,
  buildShareJoinUrl,
  fetchShareAccountTicket,
  formatShareAge,
  gatewayFromShareSearch,
  loadShareDisplayName,
  recallSharePasscode,
  rememberSharePasscode,
  saveShareDisplayName,
  sortParticipants,
} from "@/lib/client/shared-ssh";

/**
 * The other half of team sharing: the page a teammate opens.
 *
 * Nothing here knows any SSH credential. It attaches to a shell that is already
 * authenticated on the host, replays the scrollback it missed, and from then on is
 * just another keyboard on that one PTY — which is exactly what "continue working in
 * the same session" means.
 */

type Phase = "gate" | "connecting" | "live" | "lost" | "ended" | "error";

const THEME = {
  background: "#090b10",
  foreground: "#e2e8f0",
  cursor: "#ff6b57",
  selectionBackground: "rgba(255, 107, 87, 0.28)",
  black: "#1e293b",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#38bdf8",
  white: "#f1f5f9",
};

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function SharedTerminalSession({ shareId }: { shareId: string }) {
  // Links without a gateway are same-origin; never consult a visitor's unrelated
  // local gateway settings or send their private gateway key to a link destination.
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("gate");
  const [share, setShare] = useState<SharedSessionView | null>(null);
  const [participants, setParticipants] = useState<SharedParticipantView[]>([]);
  const [activity, setActivity] = useState<{ by: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(true);
  const [youId, setYouId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const [needsPasscode, setNeedsPasscode] = useState(false);
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const disposedRef = useRef(false);
  const attemptRef = useRef(0);
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const joinUrl = useMemo(() => {
    if (gatewayUrl === null) return "";
    try { return buildShareJoinUrl(shareId, gatewayUrl); } catch { return ""; }
  }, [shareId, gatewayUrl]);

  useEffect(() => {
    try {
      if (!isShareId(shareId)) throw new Error("Invalid shared-session link.");
      const gateway = gatewayFromShareSearch(window.location.search);
      if (window.location.protocol === "https:" && gateway.startsWith("http:")) {
        throw new Error("This link needs a secure HTTPS/WSS gateway.");
      }
      setGatewayUrl(gateway);
    } catch (error) {
      setErrorCode("BAD_LINK");
      setError(error instanceof Error ? error.message : "Invalid shared-session link.");
      setPhase("error");
    }
  }, [shareId]);

  // ---- terminal ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    disposedRef.current = false;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: fontSizeRef.current,
        fontFamily:
          '"JetBrains Mono", "Fira Code", "SFMono-Regular", Menlo, Consolas, monospace',
        lineHeight: 1.24,
        scrollback: 5000,
        allowProposedApi: true,
        theme: THEME,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch {
        // container not measured yet; the ResizeObserver below will fit it
      }

      term.onData((data) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "input", data }));
      });

      termRef.current = term;
      fitRef.current = fitAddon;
      setTerminalReady(true);
      term.focus();
    })().catch(() => {
      if (!cancelled) {
        setErrorCode("TERMINAL_LOAD_FAILED");
        setError("The terminal could not load. Refresh this page and try again.");
        setPhase("error");
      }
    });

    const observer = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      cancelled = true;
      observer.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      disposedRef.current = true;
      attemptRef.current += 1;
      wsRef.current?.close();
      wsRef.current = null;
      if (activityTimer.current) clearTimeout(activityTimer.current);
    };
  }, []);

  // Changing text size refits the same terminal and updates the shared PTY; it
  // must not open a new SSH connection. The ref also covers async xterm loading.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = fontSize;
    const previousCols = term.cols;
    const previousRows = term.rows;
    try {
      fit.fit();
      const ws = wsRef.current;
      if ((term.cols !== previousCols || term.rows !== previousRows) && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    } catch {
      // A hidden terminal will be fitted once its container is measured.
    }
  }, [fontSize, terminalReady]);

  // Ages in the participant list have to tick.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setName(loadShareDisplayName());
    setPasscode(recallSharePasscode(shareId));
  }, [shareId]);

  // A signed-in Sushi account joins without a code; everybody else needs one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/status", {
          headers: getAuthHeaders({ gatewayUrl: "", gatewayToken: "" }), cache: "no-store",
        });
        const data = (await res.json()) as { authenticated?: boolean };
        if (!cancelled) setSignedIn(Boolean(data.authenticated));
      } catch {
        if (!cancelled) setSignedIn(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- connection -------------------------------------------------------------

  const connect = useCallback(
    async (options?: { passcode?: string; name?: string }) => {
      const displayName = (options?.name ?? name).trim();
      const code = (options?.passcode ?? passcode).trim();
      if (gatewayUrl === null || !terminalReady) return;

      if (!displayName) {
        setError("Add your name so the team can see who is in the shell.");
        setPhase("gate");
        return;
      }

      const attempt = ++attemptRef.current;
      wsRef.current?.close();
      wsRef.current = null;
      setError(null);
      setErrorCode(null);
      setPhase("connecting");
      termRef.current?.reset();

      let ticket: string | undefined;
      if (gatewayUrl && signedIn && !code) {
        try { ticket = await fetchShareAccountTicket(shareId, gatewayUrl); } catch {
          // A passcode can still work if the frontend account service is unavailable.
        }
      }
      if (attempt !== attemptRef.current || disposedRef.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(buildWebSocketUrl("/ws/ssh", { gatewayUrl, gatewayToken: "" }));
      } catch {
        setError("Could not open the gateway address in this share link.");
        setPhase("error");
        return;
      }
      wsRef.current = ws;

      let opened = false;
      let terminalOutcome = false;
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 20_000);

      ws.onopen = () => {
        opened = true;
        ws.send(
          JSON.stringify({
            type: "auth",
            // A link-selected external gateway never receives this site's full
            // session or this browser's saved gateway key.
            sessionToken: gatewayUrl ? undefined : getStoredSessionToken() || undefined,
            cols: termRef.current?.cols || 100,
            rows: termRef.current?.rows || 30,
            share: { join: shareId, passcode: code || undefined, name: displayName, ticket },
          })
        );
      };

      ws.onmessage = (event) => {
        if (disposedRef.current || wsRef.current !== ws) return;
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "ready") {
          // Keep pinging during the live session; many gateway proxies time out
          // otherwise-idle WebSockets after a minute.
          setNeedsPasscode(false);
          setPhase("live");
          setShare((msg.share as SharedSessionView) ?? null);
          setCanWrite(msg.write !== false);
          setYouId(typeof msg.you === "string" ? msg.you : null);
          setParticipants(
            Array.isArray(msg.share?.participants) ? msg.share.participants : []
          );
          if (code) rememberSharePasscode(shareId, code);
          saveShareDisplayName(displayName);
          if (typeof msg.replay === "string" && msg.replay.length > 0) {
            termRef.current?.write(decodeBase64Bytes(msg.replay));
          }
          const term = termRef.current;
          if (term) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          term?.focus();
          return;
        }

        if (msg.type === "data" && typeof msg.data === "string") {
          termRef.current?.write(decodeBase64Bytes(msg.data));
          return;
        }

        if (msg.type === "participants") {
          setParticipants(Array.isArray(msg.participants) ? msg.participants : []);
          return;
        }

        if (msg.type === "activity" && typeof msg.by === "string") {
          setActivity({ by: msg.by, at: Date.now() });
          if (activityTimer.current) clearTimeout(activityTimer.current);
          activityTimer.current = setTimeout(() => setActivity(null), 4000);
          return;
        }

        if (msg.type === "error") {
          terminalOutcome = true;
          clearInterval(ping);
          const codeName = typeof msg.code === "string" ? msg.code : null;
          setErrorCode(codeName);
          setError(String(msg.message || "Could not join the shared session."));
          if (codeName === "PASSCODE_REQUIRED" || codeName === "BAD_PASSCODE") {
            setNeedsPasscode(codeName === "BAD_PASSCODE");
            setPhase("gate");
          } else if (codeName === "SHARE_NOT_FOUND") {
            setPhase("ended");
          } else {
            setPhase("error");
          }
          return;
        }

        if (msg.type === "share-closed") {
          terminalOutcome = true;
          clearInterval(ping);
          setPhase("ended");
          setError(String(msg.reason || "The host stopped sharing this session."));
          return;
        }

        if (msg.type === "exit") {
          terminalOutcome = true;
          clearInterval(ping);
          setPhase("ended");
          setError(String(msg.reason || "The shared shell ended."));
        }
      };

      ws.onerror = () => {
        // onclose carries the user-facing result
      };

      ws.onclose = () => {
        clearInterval(ping);
        if (disposedRef.current || wsRef.current !== ws || terminalOutcome) return;
        if (!opened) {
          setErrorCode(null);
          setPhase("error");
          setError("Could not reach the share's WebSocket gateway. Check its address and allowed origin.");
          return;
        }
        setPhase("lost");
      };
    },
    [gatewayUrl, name, passcode, shareId, signedIn, terminalReady]
  );

  const leave = useCallback(() => {
    attemptRef.current += 1;
    const ws = wsRef.current;
    wsRef.current = null;
    try {
      ws?.close(1000, "Left the shared session");
    } catch {
      // ignore
    }
    setPhase("gate");
    setShare(null);
    setParticipants([]);
    setError(null);
  }, []);

  const copyLink = async () => {
    await copyTextToClipboard(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const sortedParticipants = useMemo(() => sortParticipants(participants), [participants]);
  const readyToJoin = signedIn !== null && gatewayUrl !== null && terminalReady;
  const canJoinNow = Boolean(name.trim()) &&
    ((signedIn === true && !needsPasscode) || /^\d{6}$/.test(passcode.trim())) &&
    !(errorCode === "PASSCODE_REQUIRED" && !signedIn);

  return (
    <div className="flex h-[100dvh] flex-col bg-[#090b10] text-slate-100">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/8 bg-[#0f131b] px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#ff6b57]/15">
            <Users className="h-3.5 w-3.5 text-[#ff6b57]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[13px] font-semibold text-white">
              {share?.label || "Shared SSH session"}
            </h1>
            <p className="truncate text-[11px] text-slate-500">
              {phase === "live"
                ? `${participants.length} in this shell · ${
                    canWrite ? "you can type" : "read-only"
                  }`
                : "Sushi team sharing"}
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <TerminalFontSizeControl size={fontSize} setSize={setFontSize} />
          {phase === "live" && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              live
            </span>
          )}
          {activity && (
            <span className="hidden items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300 sm:inline-flex">
              <Keyboard className="h-3 w-3" />
              {activity.by} is typing
            </span>
          )}
          <button
            type="button"
            disabled={!joinUrl}
            onClick={() => void copyLink()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
            title="Copy the link so someone else can join too"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Link2 className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy link"}</span>
          </button>
          {phase === "live" && (
            <button
              type="button"
              onClick={leave}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10"
              title="Leave — the shell keeps running for everyone else"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Leave</span>
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full px-2 py-2" />

        {/* Join gate */}
        {phase === "gate" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#090b10]/92 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-[#0f131b] p-5 shadow-2xl">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-base font-semibold text-white">
                  <Terminal className="h-4 w-4 text-[#ff6b57]" />
                  Join this shared shell
                </h2>
                <p className="text-[13px] leading-relaxed text-slate-400">
                  You are joining one live SSH session on{" "}
                  <span className="font-mono-code text-slate-300">
                    {share?.label || "the host"}
                  </span>
                  . Everyone sees the same screen and the same running commands.
                </p>
                {gatewayUrl && <p className="break-all text-[12px] leading-relaxed text-slate-500">
                  Gateway: {gatewayUrl}. Verify this address with the host before entering a code.
                </p>}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="share-name" className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Your name
                </label>
                <input
                  id="share-name"
                  value={name}
                  disabled={!readyToJoin}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ana"
                  autoComplete="name"
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#ff6b57]/50"
                />
              </div>

              {errorCode !== "PASSCODE_REQUIRED" && (needsPasscode || (!signedIn && signedIn !== null)) && (
                <div className="space-y-1.5">
                  <label htmlFor="share-code" className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    6-digit share code
                  </label>
                  <input
                    id="share-code"
                    value={passcode}
                    disabled={!readyToJoin}
                    onChange={(e) => setPasscode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    placeholder="000000"
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono-code text-lg tracking-[0.4em] text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#ff6b57]/50"
                  />
                  <p className="text-[12px] text-slate-500">
                    Ask whoever shared the terminal for the code shown in their share panel.
                  </p>
                </div>
              )}

              {error && (
                <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
                  {error}
                </p>
              )}

              <button
                type="button"
                disabled={!readyToJoin || !canJoinNow}
                onClick={() => connect()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#ff6b57] px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-[#ff8578] disabled:opacity-50"
              >
                <Users className="h-4 w-4" />
                Join session
              </button>

              {signedIn === false && (
                <p className="text-[12px] leading-relaxed text-slate-500">
                  Not signed in to this Sushi instance. Use the share code, or{" "}
                  <a href="/" target="_blank" rel="noreferrer" className="text-[#ff9587] underline">sign in</a>{" "}
                  and reload this page for an account-only share.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Connecting / reconnecting */}
        {(phase === "connecting" || phase === "lost") && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#090b10]/80 p-4 backdrop-blur-sm">
            <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl border border-white/10 bg-[#0f131b] p-5 text-center shadow-2xl">
              {phase === "connecting" ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-[#ff6b57]" />
                  <p className="text-[13px] text-slate-300">Attaching to the shared shell…</p>
                </>
              ) : (
                <>
                  <RotateCw className="h-5 w-5 text-amber-300" />
                  <p className="text-[13px] font-medium text-white">Connection dropped</p>
                  <p className="text-[12px] leading-relaxed text-slate-400">
                    The shell is still running on the server. Rejoin to land back in it.
                  </p>
                  <button
                    type="button"
                    onClick={() => connect()}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#ff6b57] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#ff8578]"
                  >
                    <RotateCw className="h-4 w-4" />
                    Rejoin
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Ended / error */}
        {(phase === "ended" || phase === "error") && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#090b10]/92 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm space-y-3 rounded-2xl border border-white/10 bg-[#0f131b] p-5 text-center shadow-2xl">
              <p className="text-[15px] font-semibold text-white">
                {phase === "ended" ? "This shared shell has ended" : "Could not join"}
              </p>
              <p className="text-[13px] leading-relaxed text-slate-400">{error}</p>
              {errorCode === "TERMINAL_LOAD_FAILED" ? (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10"
                >
                  <RotateCw className="h-4 w-4" />
                  Reload page
                </button>
              ) : errorCode !== "BAD_LINK" && (phase !== "ended" || errorCode !== "SHARE_NOT_FOUND") ? (
                <button
                  type="button"
                  onClick={() => connect()}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10"
                >
                  <RotateCw className="h-4 w-4" />
                  Try again
                </button>
              ) : (
                <a
                  href="/"
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/10"
                >
                  Open Sushi
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/8 bg-[#0f131b] px-3 py-2 text-[11px] text-slate-500 sm:px-4">
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-3 w-3" />
          {sortedParticipants.length === 0
            ? "nobody else attached"
            : sortedParticipants
                .map((p) => `${p.name}${p.id === youId ? " (you)" : ""}`)
                .join(", ")}
        </span>
        {share?.createdAt ? (
          <span className="ml-auto">shell alive for {formatShareAge(share.createdAt, now)}</span>
        ) : null}
      </footer>
    </div>
  );
}
