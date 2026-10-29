"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  RotateCw,
  FolderKanban,
  Search,
  Sparkles,
  Trash2,
  ShieldCheck,
  Radio,
  Minus,
  Plus,
  X,
  Palette,
} from "lucide-react";
import type {
  CommandSnippet,
  HostProfile,
} from "@/types/connection";
import {
  type GatewaySettings,
  buildWebSocketUrl,
  getAuthHeaders,
} from "@/lib/client/gateway";
import { getStoredSessionToken } from "@/lib/client/auth-storage";

interface SshTerminalSessionProps {
  profile: HostProfile;
  isActive: boolean;
  initialPath?: string;
  wsAvailable: boolean;
  gatewaySettings: GatewaySettings;
  snippets: CommandSnippet[];
  onOpenCompanionSftp: (cwd?: string) => void;
  onOpenGatewayModal: () => void;
}

const TERMINAL_THEMES: Record<
  string,
  {
    label: string;
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  }
> = {
  obsidian: {
    label: "Sushi Obsidian",
    background: "#090b10",
    foreground: "#e2e8f0",
    cursor: "#ff6b57",
    selectionBackground: "rgba(255, 107, 87, 0.28)",
  },
  tokyo: {
    label: "Tokyo Night",
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#7aa2f7",
    selectionBackground: "rgba(122, 162, 247, 0.28)",
  },
  catppuccin: {
    label: "Catppuccin",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    selectionBackground: "rgba(203, 166, 247, 0.28)",
  },
  emerald: {
    label: "Phosphor",
    background: "#06100c",
    foreground: "#6ee7b7",
    cursor: "#34d399",
    selectionBackground: "rgba(52, 211, 153, 0.25)",
  },
};

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function SshTerminalSession({
  profile,
  isActive,
  initialPath,
  wsAvailable,
  gatewaySettings,
  snippets,
  onOpenCompanionSftp,
  onOpenGatewayModal,
}: SshTerminalSessionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const searchAddonRef = useRef<import("@xterm/addon-search").SearchAddon | null>(
    null
  );
  const wsRef = useRef<WebSocket | null>(null);
  const abortExecRef = useRef<AbortController | null>(null);

  const [transportMode, setTransportMode] = useState<"ws" | "serverless">(
    wsAvailable ? "ws" : "serverless"
  );
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("connecting");
  const [fingerprint, setFingerprint] = useState<string | undefined>();
  const [currentCwd, setCurrentCwd] = useState<string>(
    initialPath || profile.initialPath || "~"
  );
  const [fontSize, setFontSize] = useState(13);
  const [themeKey, setThemeKey] = useState<string>("obsidian");
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSnippets, setShowSnippets] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [connectSeq, setConnectSeq] = useState(0);

  // Refs used inside xterm.onData closure for Serverless Streaming Shell mode
  const modeRef = useRef<"ws" | "serverless">(wsAvailable ? "ws" : "serverless");
  const cwdRef = useRef<string>(initialPath || profile.initialPath || "~");
  const lineBufferRef = useRef<string>("");
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const execBusyRef = useRef<boolean>(false);

  useEffect(() => {
    cwdRef.current = currentCwd;
  }, [currentCwd]);

  const writePrompt = useCallback(
    (term: import("@xterm/xterm").Terminal, cwdVal?: string) => {
      const displayPath = cwdVal ?? cwdRef.current ?? "~";
      term.write(
        `\r\n\x1b[1;32m${profile.username}@${profile.host}\x1b[0m:\x1b[1;34m${displayPath}\x1b[0m$ `
      );
    },
    [profile.username, profile.host]
  );

  const runServerlessCommand = useCallback(
    async (rawCmd: string) => {
      const term = termRef.current;
      if (!term) return;

      const trimmed = rawCmd.trim();
      if (trimmed === "clear") {
        term.clear();
        writePrompt(term);
        return;
      }
      if (trimmed === "exit" || trimmed === "logout") {
        term.writeln("\r\n\x1b[33mSession closed.\x1b[0m");
        setStatus("disconnected");
        return;
      }

      execBusyRef.current = true;
      const controller = new AbortController();
      abortExecRef.current = controller;
      const utf8Decoder = new TextDecoder("utf-8");

      try {
        const res = await fetch("/api/ssh/exec", {
          method: "POST",
          headers: getAuthHeaders(gatewaySettings),
          signal: controller.signal,
          body: JSON.stringify({
            credentials: {
              host: profile.host,
              port: profile.port,
              username: profile.username,
              authMethod: profile.authMethod,
              password: profile.password,
              privateKey: profile.privateKey,
              passphrase: profile.passphrase,
            },
            command: rawCmd,
            cwd: cwdRef.current,
            cols: term.cols || 100,
            rows: term.rows || 30,
          }),
        });

        if (!res.ok || !res.body) {
          const errJson = await res.json().catch(() => ({}));
          term.writeln(
            `\r\n\x1b[31mError: ${errJson.error || `HTTP ${res.status}`}\x1b[0m`
          );
          setStatus("error");
          writePrompt(term);
          return;
        }

        const reader = res.body.getReader();
        const lineDec = new TextDecoder();
        let ndjsonBuf = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          ndjsonBuf += lineDec.decode(value, { stream: true });
          const lines = ndjsonBuf.split("\n");
          ndjsonBuf = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === "ready") {
                setStatus("connected");
                if (evt.fingerprint) setFingerprint(evt.fingerprint);
              } else if (evt.type === "data" && typeof evt.data === "string") {
                const decoded = utf8Decoder.decode(decodeBase64Bytes(evt.data), {
                  stream: true,
                });
                term.write(decoded);
              } else if (evt.type === "meta") {
                if (typeof evt.cwd === "string" && evt.cwd) {
                  cwdRef.current = evt.cwd;
                  setCurrentCwd(evt.cwd);
                }
              } else if (evt.type === "error") {
                term.writeln(`\r\n\x1b[31m${evt.message}\x1b[0m`);
              }
            } catch {
              // ignore malformed chunk
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          term.write("^C");
        } else {
          term.writeln(
            `\r\n\x1b[31m${
              err instanceof Error ? err.message : "SSH stream interrupted."
            }\x1b[0m`
          );
        }
      } finally {
        execBusyRef.current = false;
        abortExecRef.current = null;
        writePrompt(term);
      }
    },
    [gatewaySettings, profile, writePrompt]
  );

  // Initialize xterm and transport session
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    async function initSession() {
      if (!containerRef.current) return;

      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
          import("@xterm/addon-search"),
        ]);

      if (disposed || !containerRef.current) return;

      const activeTheme = TERMINAL_THEMES[themeKey] || TERMINAL_THEMES.obsidian;
      const term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily:
          '"JetBrains Mono", "Fira Code", "SFMono-Regular", Menlo, Consolas, monospace',
        lineHeight: 1.24,
        scrollback: 5000,
        allowProposedApi: true,
        theme: {
          background: activeTheme.background,
          foreground: activeTheme.foreground,
          cursor: activeTheme.cursor,
          selectionBackground: activeTheme.selectionBackground,
          black: "#1e293b",
          red: "#f87171",
          green: "#34d399",
          yellow: "#fbbf24",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#38bdf8",
          white: "#f1f5f9",
        },
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.loadAddon(searchAddon);

      containerRef.current.innerHTML = "";
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch {
        // ignore hidden container fit
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      const shouldUseWs = Boolean(wsAvailable || gatewaySettings.gatewayUrl.trim());
      modeRef.current = shouldUseWs ? "ws" : "serverless";
      setTransportMode(modeRef.current);
      setStatus("connecting");

      // Handle user keystrokes across both WS and Serverless modes
      term.onData((data) => {
        if (modeRef.current === "ws") {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data }));
          }
          return;
        }

        // Serverless Streaming Shell interactive line editor
        if (execBusyRef.current) {
          if (data === "\x03") {
            // Ctrl+C cancels active streaming command
            abortExecRef.current?.abort();
          }
          return;
        }

        for (let i = 0; i < data.length; i++) {
          const ch = data[i];

          // Handle ANSI escape sequences (Up/Down history)
          if (ch === "\x1b" && data.slice(i, i + 3) === "\x1b[A") {
            i += 2;
            const hist = historyRef.current;
            if (hist.length > 0) {
              const nextIdx =
                historyIdxRef.current === -1
                  ? hist.length - 1
                  : Math.max(0, historyIdxRef.current - 1);
              historyIdxRef.current = nextIdx;
              const prevLen = lineBufferRef.current.length;
              if (prevLen > 0) {
                term.write("\b \b".repeat(prevLen));
              }
              lineBufferRef.current = hist[nextIdx];
              term.write(lineBufferRef.current);
            }
            continue;
          }
          if (ch === "\x1b" && data.slice(i, i + 3) === "\x1b[B") {
            i += 2;
            const hist = historyRef.current;
            if (historyIdxRef.current !== -1) {
              const prevLen = lineBufferRef.current.length;
              if (prevLen > 0) {
                term.write("\b \b".repeat(prevLen));
              }
              if (historyIdxRef.current < hist.length - 1) {
                historyIdxRef.current += 1;
                lineBufferRef.current = hist[historyIdxRef.current];
                term.write(lineBufferRef.current);
              } else {
                historyIdxRef.current = -1;
                lineBufferRef.current = "";
              }
            }
            continue;
          }
          if (ch === "\x1b") {
            // Skip other escape sequences in line-buffered mode
            while (i + 1 < data.length && !/[A-Za-z~]/.test(data[i + 1])) {
              i++;
            }
            i++;
            continue;
          }

          if (ch === "\r" || ch === "\n") {
            term.write("\r\n");
            const cmd = lineBufferRef.current;
            lineBufferRef.current = "";
            historyIdxRef.current = -1;
            if (cmd.trim()) {
              historyRef.current.push(cmd);
              void runServerlessCommand(cmd);
            } else {
              writePrompt(term);
            }
          } else if (ch === "\x7f" || ch === "\b") {
            if (lineBufferRef.current.length > 0) {
              lineBufferRef.current = lineBufferRef.current.slice(0, -1);
              term.write("\b \b");
            }
          } else if (ch === "\x03") {
            lineBufferRef.current = "";
            term.write("^C");
            writePrompt(term);
          } else if (ch === "\x15") {
            // Ctrl+U clear line
            const len = lineBufferRef.current.length;
            if (len > 0) {
              term.write("\b \b".repeat(len));
              lineBufferRef.current = "";
            }
          } else if (ch === "\x0c") {
            // Ctrl+L clear screen
            term.clear();
            writePrompt(term);
            term.write(lineBufferRef.current);
          } else if (ch >= " ") {
            lineBufferRef.current += ch;
            term.write(ch);
          }
        }
      });

      const switchToServerlessShell = (notice?: string) => {
        modeRef.current = "serverless";
        setTransportMode("serverless");
        if (notice) {
          term.writeln(`\x1b[90m${notice}\x1b[0m`);
        }
        term.writeln(
          `\x1b[38;2;255;107;87m● Sushi Serverless SSH Stream\x1b[0m \x1b[90m(${profile.username}@${profile.host}:${profile.port})\x1b[0m`
        );
        // Perform initial handshake & working directory resolution
        void runServerlessCommand("pwd && uname -sr 2>/dev/null || true");
      };

      if (shouldUseWs) {
        const wsUrl = buildWebSocketUrl("/ws/ssh", gatewaySettings);
        term.writeln(
          `\x1b[90mConnecting via WebSocket PTY to ${profile.username}@${profile.host}:${profile.port}...\x1b[0m`
        );

        let openedReady = false;
        const utf8Decoder = new TextDecoder("utf-8");
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "auth",
              sessionToken: getStoredSessionToken() || undefined,
              gatewayToken: gatewaySettings.gatewayToken || undefined,
              cols: term.cols || 100,
              rows: term.rows || 30,
              credentials: {
                host: profile.host,
                port: profile.port,
                username: profile.username,
                authMethod: profile.authMethod,
                password: profile.password,
                privateKey: profile.privateKey,
                passphrase: profile.passphrase,
              },
            })
          );

          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 20000);
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "ready") {
              openedReady = true;
              setStatus("connected");
              if (msg.fingerprint) setFingerprint(msg.fingerprint);
              term.focus();
              if (initialPath && initialPath !== "~") {
                ws.send(
                  JSON.stringify({
                    type: "input",
                    data: `cd ${JSON.stringify(initialPath)}\r`,
                  })
                );
              }
            } else if (msg.type === "data" && typeof msg.data === "string") {
              const text = utf8Decoder.decode(decodeBase64Bytes(msg.data), {
                stream: true,
              });
              term.write(text);
            } else if (msg.type === "error") {
              setStatus("error");
              term.writeln(`\r\n\x1b[31mSSH Error: ${msg.message}\x1b[0m`);
            } else if (msg.type === "exit") {
              setStatus("disconnected");
              term.writeln("\r\n\x1b[33mRemote SSH session ended.\x1b[0m");
            }
          } catch {
            // ignore
          }
        };

        ws.onerror = () => {
          if (!openedReady && !disposed) {
            ws.close();
            switchToServerlessShell(
              "WebSocket endpoint unavailable on this host — falling back to Serverless HTTP Streaming SSH."
            );
          }
        };

        ws.onclose = () => {
          if (openedReady && !disposed) {
            setStatus("disconnected");
          }
        };
      } else {
        switchToServerlessShell();
      }

      resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current || containerRef.current.clientWidth === 0) return;
        try {
          fitAddon.fit();
          if (
            modeRef.current === "ws" &&
            wsRef.current &&
            wsRef.current.readyState === WebSocket.OPEN
          ) {
            wsRef.current.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              })
            );
          }
        } catch {
          // ignore
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    void initSession();

    return () => {
      disposed = true;
      if (pingInterval) clearInterval(pingInterval);
      resizeObserver?.disconnect();
      abortExecRef.current?.abort();
      wsRef.current?.close();
      termRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectSeq]);

  // Update theme & font size dynamically without dropping SSH session!
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const activeTheme = TERMINAL_THEMES[themeKey] || TERMINAL_THEMES.obsidian;
    term.options.fontSize = fontSize;
    term.options.theme = {
      ...term.options.theme,
      background: activeTheme.background,
      foreground: activeTheme.foreground,
      cursor: activeTheme.cursor,
      selectionBackground: activeTheme.selectionBackground,
    };
    try {
      fitAddonRef.current?.fit();
    } catch {
      // ignore
    }
  }, [fontSize, themeKey]);

  // Re-fit when tab becomes active
  useEffect(() => {
    if (!isActive) return;
    const t = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        termRef.current?.focus();
      } catch {
        // ignore
      }
    }, 40);
    return () => clearTimeout(t);
  }, [isActive]);

  const executeSnippet = (cmd: string) => {
    setShowSnippets(false);
    const term = termRef.current;
    if (!term) return;

    if (modeRef.current === "ws") {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data: cmd + "\r" }));
        term.focus();
      }
    } else if (!execBusyRef.current) {
      term.write(cmd + "\r\n");
      historyRef.current.push(cmd);
      void runServerlessCommand(cmd);
    }
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{
        backgroundColor:
          (TERMINAL_THEMES[themeKey] || TERMINAL_THEMES.obsidian).background,
      }}
    >
      {/* Session Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 bg-[#0f131b] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              status === "connected"
                ? "bg-emerald-500/15 text-emerald-300"
                : status === "connecting"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-rose-500/15 text-rose-300"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status === "connected"
                  ? "bg-emerald-400"
                  : status === "connecting"
                    ? "animate-pulse bg-amber-400"
                    : "bg-rose-400"
              }`}
            />
            {status === "connected"
              ? transportMode === "ws"
                ? "WebSocket PTY"
                : "Serverless Stream"
              : status}
          </span>

          <span className="font-mono-code text-xs text-slate-400">
            {profile.username}@{profile.host}:{profile.port}
          </span>

          {fingerprint && (
            <span
              title={fingerprint}
              className="font-mono-code hidden max-w-[210px] items-center gap-1 truncate rounded-md border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-400 lg:inline-flex"
            >
              <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-400" />
              {fingerprint}
            </span>
          )}

          {transportMode === "serverless" && (
            <button
              type="button"
              onClick={onOpenGatewayModal}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition hover:bg-amber-500/20"
            >
              <Radio className="h-3 w-3" />
              Attach VPS Gateway for full PTY
            </button>
          )}
        </div>

        <div className="relative flex items-center gap-1.5">
          {/* Open Companion SFTP */}
          <button
            type="button"
            onClick={() => onOpenCompanionSftp(currentCwd !== "~" ? currentCwd : undefined)}
            className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-300 transition hover:bg-sky-500/20"
            title="Open SFTP File Manager for this host"
          >
            <FolderKanban className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Open SFTP</span>
          </button>

          {/* Snippets Popover */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowSnippets((v) => !v);
                setShowThemes(false);
              }}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">Snippets</span>
            </button>
            {showSnippets && (
              <div className="absolute right-0 top-9 z-30 w-72 rounded-xl border border-white/12 bg-[#141924] p-2 shadow-2xl">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Run Quick Command
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {snippets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => executeSnippet(s.command)}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left transition hover:bg-white/8"
                    >
                      <div className="text-xs font-medium text-white">{s.title}</div>
                      <div className="font-mono-code truncate text-[11px] text-slate-400">
                        {s.command}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Search Toggle */}
          <button
            type="button"
            onClick={() => setShowSearch((v) => !v)}
            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
            title="Search terminal scrollback"
          >
            <Search className="h-3.5 w-3.5" />
          </button>

          {/* Theme Picker */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowThemes((v) => !v);
                setShowSnippets(false);
              }}
              className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
              title="Terminal theme"
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
            {showThemes && (
              <div className="absolute right-0 top-9 z-30 w-44 rounded-xl border border-white/12 bg-[#141924] p-1.5 shadow-2xl">
                {Object.entries(TERMINAL_THEMES).map(([k, t]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setThemeKey(k);
                      setShowThemes(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition ${
                      themeKey === k
                        ? "bg-white/10 text-white"
                        : "text-slate-300 hover:bg-white/5"
                    }`}
                  >
                    <span
                      className="h-3 w-3 rounded-full border border-white/20"
                      style={{ backgroundColor: t.background }}
                    />
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Font size */}
          <div className="hidden items-center rounded-lg border border-white/10 bg-white/5 md:flex">
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.max(11, s - 1))}
              className="p-1.5 text-slate-300 hover:text-white"
              title="Decrease font size"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="font-mono-code px-1 text-[11px] text-slate-300">
              {fontSize}
            </span>
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.min(20, s + 1))}
              className="p-1.5 text-slate-300 hover:text-white"
              title="Increase font size"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          {/* Clear */}
          <button
            type="button"
            onClick={() => termRef.current?.clear()}
            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
            title="Clear terminal"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>

          {/* Reconnect */}
          <button
            type="button"
            onClick={() => setConnectSeq((n) => n + 1)}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10"
            title="Reconnect SSH session"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Reconnect</span>
          </button>
        </div>
      </div>

      {/* Optional Search Bar */}
      {showSearch && (
        <div className="flex items-center gap-2 border-b border-white/8 bg-[#131823] px-4 py-1.5">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) {
                searchAddonRef.current?.findNext(e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchQuery) {
                searchAddonRef.current?.findNext(searchQuery);
              }
              if (e.key === "Escape") {
                setShowSearch(false);
              }
            }}
            placeholder="Find in terminal scrollback (Enter for next)..."
            autoFocus
            className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none"
          />
          <button
            type="button"
            onClick={() => setShowSearch(false)}
            className="text-slate-400 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Terminal Canvas */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
