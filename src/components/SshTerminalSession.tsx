"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  RotateCw,
  FolderKanban,
  Monitor,
  Search,
  Sparkles,
  Trash2,
  ShieldCheck,
  Radio,
  Minus,
  Plus,
  X,
  Palette,
  Loader2,
  Ban,
  Keyboard,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  Cpu,
  Languages,
  Infinity,
  Square,
} from "lucide-react";
import type {
  CommandSnippet,
  ConnectionCredentials,
  HostProfile,
  SshSystemInfo,
} from "@/types/connection";
import {
  type GatewaySettings,
  buildWebSocketUrl,
  getAuthHeaders,
} from "@/lib/client/gateway";
import {
  type ExecStdinChannel,
  canStreamExecStdin,
  createExecRequestBody,
  supportsStreamingRequestBody,
} from "@/lib/client/exec-stdin";
import { getStoredSessionToken } from "@/lib/client/auth-storage";
import { randomUUID } from "@/lib/client/web-crypto";
import {
  CONFIRM_PROMPT_RE,
  MENU_KEY,
  PASSWORD_PROMPT_RE,
  SUDO_NEEDS_PASSWORD_RE,
  SUDO_WRONG_PASSWORD_RE,
  detectFullscreenMenu,
  detectInteractiveProgram,
  menuButtonKeys,
  menuSelectKeys,
  parseElevationCommand,
  splitTerminalInput,
  type FullscreenMenu,
} from "@/lib/client/terminal-commands";
import {
  createKeyBatcher,
  sendKeyChannelInput,
  type ExecKeyChannel,
} from "@/lib/client/exec-keys";
import {
  formatOsLabel,
  formatSystemDetails,
  formatSystemLine,
  formatTerminalSystemLine,
  loadSshSystemInfo,
} from "@/lib/client/sysinfo";
import {
  groupSnippetsByCategory,
  isSnippetCategoryForHost,
  mergeOsCommandSnippets,
  osSnippetCategoryFor,
} from "@/lib/client/os-commands";
import {
  SSH_RETRY_DELAY_SECONDS,
  cleanSshFailureMessage,
  connectFailureFromExec,
  describeSshConnectFailure,
  tickRetryCountdown,
  type SshConnectFailure,
} from "@/lib/client/ssh-retry";
import { SshConnectErrorCard } from "@/components/SshConnectErrorCard";
import { fetchRunStatus, stopHostBackgroundProcesses } from "@/lib/client/run-status";
import type { ResumableRun } from "@/lib/client/session-resume";
import { TranslatePanel } from "@/components/TranslatePanel";

interface SshTerminalSessionProps {
  profile: HostProfile;
  isActive: boolean;
  initialPath?: string;
  wsAvailable: boolean;
  gatewaySettings: GatewaySettings;
  snippets: CommandSnippet[];
  onOpenCompanionSftp: (cwd?: string) => void;
  onOpenRdp: () => void;
  onOpenGatewayModal: () => void;
  /**
   * The session really connected (used for the "Recently connected" history and to
   * offer a command that is still running on this host).
   */
  onConnected?: () => void;
  /**
   * A command started, changed state, or ended. `null` means "this tab has no run
   * any more" (a new command replaced it, or the session was reset). The workspace
   * stores it so the run survives a reload / a closed tab.
   */
  onRunChange?: (run: ResumableRun | null) => void;
  /**
   * Called after stopping all background SSH processes on this host so any
   * persisted resumable runs for this host are also cleared in the workspace.
   */
  onStopHostRuns?: () => void;
  /**
   * A run to take over: the command line is replayed in the terminal and, when the
   * command is still alive on the host, its output log is redrawn and keystrokes are
   * delivered to the run that is already going.
   */
  resumeRun?: ResumableRun | null;
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

/** Result of an elevation (sudo) probe. */
type ElevationProbe = {
  ok: boolean;
  needsPassword: boolean;
  message: string;
  /** Set when the probe could not even connect: the session is gone. */
  connectError?: string;
};

/** While a sudo password is being typed, keystrokes are captured here instead. */
type SecretPrompt =
  | { action: "enter-root" }
  | { action: "run"; command: string; elevateUser: string };

export function SshTerminalSession({
  profile,
  isActive,
  initialPath,
  wsAvailable,
  gatewaySettings,
  snippets,
  onOpenCompanionSftp,
  onOpenRdp,
  onOpenGatewayModal,
  onConnected,
  onRunChange,
  onStopHostRuns,
  resumeRun,
}: SshTerminalSessionProps) {
  const [stoppingBg, setStoppingBg] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const searchAddonRef = useRef<import("@xterm/addon-search").SearchAddon | null>(
    null
  );
  const wsRef = useRef<WebSocket | null>(null);
  const abortExecRef = useRef<AbortController | null>(null);
  /** Live stdin channel of the running serverless command (null when idle). */
  const stdinRef = useRef<ExecStdinChannel | null>(null);
  /**
   * Keystroke FIFO of the running command. Used when this browser/deployment cannot
   * stream keystrokes into the running request (Firefox, HTTP/1.1, buffering proxy):
   * each key press is then one tiny request that writes into the remote FIFO.
   */
  const keyChannelRef = useRef<ExecKeyChannel | null>(null);
  /** Coalesces fast key presses into one key-channel round trip. */
  const keyBatcherRef = useRef<ReturnType<typeof createKeyBatcher> | null>(null);
  /** Serialises key deliveries so they reach the remote FIFO in the order typed. */
  const keySendChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Signature of the box on screen, so an unchanged redraw does not re-render. */
  const menuSignatureRef = useRef<string>("");
  /** The "arrow keys need a real menu" hint is only printed once per command. */
  const menuHintShownRef = useRef(false);
  /** Set when streamed request bodies are not usable here (buffering proxy). */
  const streamingBlockedRef = useRef(false);
  /** Set once a streamed exec actually produced output (stdin confirmed working). */
  const streamingConfirmedRef = useRef(false);
  const [streamingStdinBlocked, setStreamingStdinBlocked] = useState(false);

  const [transportMode, setTransportMode] = useState<"ws" | "serverless">(
    wsAvailable ? "ws" : "serverless"
  );
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("connecting");
  const [fingerprint, setFingerprint] = useState<string | undefined>();
  /**
   * Distro + version and hosting platform of the remote machine, e.g.
   * "Ubuntu 24.04.1 LTS · Oracle Cloud". Read once per connection.
   */
  const [systemInfo, setSystemInfo] = useState<SshSystemInfo | null>(null);
  /** One in-flight probe per session, shared by the header and the banner. */
  const sysinfoPromiseRef = useRef<Promise<SshSystemInfo | null> | null>(null);
  const [currentCwd, setCurrentCwd] = useState<string>(
    initialPath || profile.initialPath || "~"
  );
  // Default terminal text size when a session opens (the −/+ buttons adjust 11–20).
  const [fontSize, setFontSize] = useState(14);
  const [themeKey, setThemeKey] = useState<string>("obsidian");
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSnippets, setShowSnippets] = useState(false);
  /** Filters the snippet popover by title, command or category. */
  const [snippetFilter, setSnippetFilter] = useState("");
  const [showThemes, setShowThemes] = useState(false);
  /** xterm currently has a text selection (enables the Translate button). */
  const [hasSelection, setHasSelection] = useState(false);
  /** Selected text open in the translate panel (null = panel closed). */
  const [translateSource, setTranslateSource] = useState<string | null>(null);
  /**
   * No-timeout mode for serverless commands (enabled by default so commands
   * stay running across disconnects, reloads, and device switches): prompts wait
   * forever, output is logged to /tmp, and keystrokes reach the FIFO.
   */
  const [noTimeout, setNoTimeout] = useState<boolean>(() => {
    try {
      return localStorage.getItem("sushi.noTimeout") !== "0";
    } catch {
      return true;
    }
  });
  const noTimeoutRef = useRef(true);
  noTimeoutRef.current = noTimeout;
  const userCancelledExecRef = useRef(false);
  /** A no-timeout command still running on the host after our request died. */
  const [detachedRun, setDetachedRun] = useState<(ExecKeyChannel & { runLog?: string }) | null>(
    null
  );
  /**
   * The run this tab is tracking: the command that started in it, or the one it
   * reattached to. Reported to the workspace (and from there to localStorage), so a
   * reload or a closed tab can offer "go back to the still-running command".
   */
  const [currentRun, setCurrentRun] = useState<ResumableRun | null>(null);
  const currentRunRef = useRef<ResumableRun | null>(null);
  /** True while the tab is showing the log of a run it did not start. */
  const [reattached, setReattached] = useState(false);
  /** The resumed command is being followed; its log tail is redrawn here. */
  const [trackingRun, setTrackingRun] = useState(false);
  const [connectSeq, setConnectSeq] = useState(0);
  /** The failure that ended the session; null while the session is healthy. */
  const [connectFailure, setConnectFailure] = useState<SshConnectFailure | null>(
    null
  );
  /** Seconds until the automatic reconnect; null means none is scheduled. */
  const [retryIn, setRetryIn] = useState<number | null>(null);
  /** A serverless command is currently running (drives the input bar). */
  const [running, setRunning] = useState(false);
  /** The running command printed something that looks like a question. */
  const [livePrompt, setLivePrompt] = useState<
    { kind: "confirm" | "password" | "generic"; canType: boolean } | null
  >(null);
  /** True when keystrokes reach the running command's stdin. */
  const [canTypeWhileRunning, setCanTypeWhileRunning] = useState(false);
  /**
   * A full-screen terminal menu (whiptail / debconf / ncurses) is on screen. It can
   * only be driven with key presses, so Sushi offers the keys next to the terminal.
   */
  const [menu, setMenu] = useState<FullscreenMenu | null>(null);
  /** Transient note under the menu panel ("keys sent", "no key channel", …). */
  const [menuNote, setMenuNote] = useState<string | null>(null);
  /** The running command has a keystroke FIFO, so key presses can reach it. */
  const [keyChannelActive, setKeyChannelActive] = useState(false);
  /** True when keystrokes reach the running command, by either route. */
  const canSendKeys = canTypeWhileRunning || keyChannelActive;
  /** The command behind the current prompt, so it can be re-run with an answer. */
  const pendingCommandRef = useRef<string | null>(null);
  /** Local line buffer used while a command runs with no live stdin channel. */
  const busyInputRef = useRef<string>("");
  /** True while the running command is (probably) waiting for an answer. */
  const awaitingAnswerRef = useRef(false);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);

  // Refs used inside xterm.onData closure for Serverless Streaming Shell mode
  const modeRef = useRef<"ws" | "serverless">(wsAvailable ? "ws" : "serverless");
  /** Mirrors `connectFailure` for the xterm / socket callbacks. */
  const connectFailureRef = useRef<SshConnectFailure | null>(null);
  /** True while the shell is still opening: typing has nowhere to go yet. */
  const connectingRef = useRef(false);
  const cwdRef = useRef<string>(initialPath || profile.initialPath || "~");
  const lineBufferRef = useRef<string>("");
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const execBusyRef = useRef<boolean>(false);
  // Root mode: after `sudo su` / `sudo -i` every command runs through sudo.
  const elevatedUserRef = useRef<string | null>(null);
  const [elevatedUser, setElevatedUserState] = useState<string | null>(null);
  const setElevatedUser = useCallback((user: string | null) => {
    elevatedUserRef.current = user;
    setElevatedUserState(user);
  }, []);
  // Kept in memory only (never persisted) and cleared on exit / reconnect.
  const sudoPasswordRef = useRef<string | null>(null);
  const sudoNoPasswordRef = useRef<boolean>(false);
  const secretPromptRef = useRef<SecretPrompt | null>(null);
  const secretBufferRef = useRef<string>("");

  useEffect(() => {
    cwdRef.current = currentCwd;
  }, [currentCwd]);

  /**
   * Asks the server what the machine actually is: the distro and version
   * (Ubuntu 24.04.1 LTS, Debian 12, Rocky 9.4, …) plus the cloud the VPS runs on
   * (Oracle Cloud, AWS EC2, Hetzner, KVM VPS, …). One short SSH connection, cached
   * for five minutes, shared by the header badge and the session banner.
   */
  const ensureSystemInfo = useCallback(() => {
    if (!sysinfoPromiseRef.current) {
      const credentials: ConnectionCredentials = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMethod: profile.authMethod,
        password: profile.password,
        privateKey: profile.privateKey,
        passphrase: profile.passphrase,
      };
      sysinfoPromiseRef.current = loadSshSystemInfo(credentials, gatewaySettings).then(
        (info) => {
          if (info) setSystemInfo(info);
          return info;
        }
      );
    }
    return sysinfoPromiseRef.current;
  }, [profile, gatewaySettings]);

  useEffect(() => {
    if (status !== "connected") return;
    void ensureSystemInfo();
  }, [status, ensureSystemInfo]);

  /** Keeps the ref (used inside xterm callbacks) and the UI in sync. */
  const setExecBusy = useCallback((value: boolean) => {
    execBusyRef.current = value;
    setRunning(value);
    if (!value) setLivePrompt(null);
  }, []);

  /**
   * Ends the session with exactly one sentence.
   *
   * A failed connection must never leave a shell on screen: the terminal is wiped
   * (so a prompt, a half-typed line or an echoed command cannot survive) and the
   * error card takes over with Reconnect plus an automatic retry. Retryable
   * failures are retried after `SSH_RETRY_DELAY_SECONDS`; credential problems are
   * not, because waiting cannot fix them.
   */
  const failConnect = useCallback(
    (raw: string | null | undefined) => {
      const failure = describeSshConnectFailure(raw, {
        host: profile.host,
        port: profile.port,
      });
      connectFailureRef.current = failure;
      setConnectFailure(failure);
      setRetryIn(failure.retryable ? SSH_RETRY_DELAY_SECONDS : null);
      setStatus("error");
      lineBufferRef.current = "";
      busyInputRef.current = "";
      secretPromptRef.current = null;
      secretBufferRef.current = "";
      setExecBusy(false);
      termRef.current?.reset();
      termRef.current?.blur();
    },
    [profile.host, profile.port, setExecBusy]
  );

  /** Latest `failConnect`, for the transport callbacks installed per connection. */
  const failConnectRef = useRef(failConnect);
  useEffect(() => {
    failConnectRef.current = failConnect;
  }, [failConnect]);

  const writePrompt = useCallback(
    (term: import("@xterm/xterm").Terminal, cwdVal?: string) => {
      // A dead connection has no prompt. Printing one is what used to make a failed
      // session look alive (`ubuntu@host:~$ sudo su` under the timeout message).
      if (connectFailureRef.current) return;
      const displayPath = cwdVal ?? cwdRef.current ?? "~";
      const asRoot = elevatedUserRef.current !== null;
      const user = elevatedUserRef.current ?? profile.username;
      const color = asRoot ? "\x1b[1;31m" : "\x1b[1;32m";
      term.write(
        `\r\n${color}${user}@${profile.host}\x1b[0m:\x1b[1;34m${displayPath}\x1b[0m${asRoot ? "# " : "$ "}`
      );
    },
    [profile.username, profile.host]
  );

  /**
   * Runs one command through the serverless exec API and streams its output.
   *
   * When the browser and the deployment both support it, the request body is a
   * chunked NDJSON stream that stays open and carries keystrokes, so the command's
   * stdin is live (`[Y/n]`, passphrase, sudo and REPL prompts are answerable). If no
   * response starts within a few seconds — the signature of a proxy buffering the
   * request body — the command is retried once as a plain JSON exec, which is the
   * old fire-and-run behaviour.
   *
   * `elevateUser` wraps the command in sudo (root mode / `sudo <cmd>`).
   */
  const execServerless = useCallback(
    async (
      command: string,
      options: {
        elevateUser?: string | null;
        password?: string;
        /** Text piped into the command's stdin when live typing is not possible. */
        stdin?: string;
        stream?: (text: string) => void;
        /** Told whether keystrokes can reach this command's stdin. */
        onInputReady?: (canSendInput: boolean) => void;
      } = {}
    ): Promise<{
      exitCode: number;
      output: string;
      /** The HTTP request itself failed (auth, bad body, gateway…). */
      httpError?: string;
      /** The SSH session never opened, so nothing ran at all. */
      connectError?: string;
    }> => {
      const term = termRef.current;
      const utf8Decoder = new TextDecoder("utf-8");

      const credentials = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMethod: profile.authMethod,
        password: profile.password,
        privateKey: profile.privateKey,
        passphrase: profile.passphrase,
      };

      /**
       * `keyChannel` is only asked for when keystrokes cannot travel up the request
       * body: the command then runs inside `script(1)` with a keystroke FIFO, so
       * whiptail / debconf / ncurses menus stay answerable from any browser.
       */
      const buildPayload = (withKeyChannel: boolean) => ({
        credentials,
        command,
        cwd: cwdRef.current,
        cols: term?.cols || 100,
        rows: term?.rows || 30,
        ...(withKeyChannel ? { keyChannel: true } : {}),
        ...(noTimeoutRef.current ? { noTimeout: true } : {}),
        ...(options.stdin ? { stdin: options.stdin } : {}),
        ...(options.elevateUser
          ? {
              elevate: {
                user: options.elevateUser,
                password: options.password,
              },
            }
          : {}),
      });

      type AttemptResult = {
        exitCode: number;
        output: string;
        httpError?: string;
        connectError?: string;
        retryWithoutStreaming?: boolean;
      };

      const attempt = async (allowStreaming: boolean): Promise<AttemptResult> => {
        const controller = new AbortController();
        abortExecRef.current = controller;
        let output = "";
        let exitCode = 0;
        let gotReady = false;
        let settled = false;
        let connectError: string | undefined;
        let runLogPath = "";
        let keyPath = "";
        let gotMeta = false;

        const streaming = allowStreaming && canStreamExecStdin();
        // No-timeout always asks for the keystroke FIFO: if the request dies, keys
        // must still be able to reach the command on the host.
        const payload = buildPayload(!streaming || noTimeoutRef.current);
        const channel = streaming ? createExecRequestBody(payload) : null;
        const headers = getAuthHeaders(gatewaySettings);
        if (channel) headers["Content-Type"] = "application/x-ndjson";
        const requestInit: RequestInit & { duplex?: "half" } = {
          method: "POST",
          headers,
          signal: controller.signal,
          body: channel ? channel.body : JSON.stringify(payload),
          ...(channel ? { duplex: "half" as const } : {}),
        };
        if (channel) stdinRef.current = channel.channel;
        options.onInputReady?.(Boolean(channel));

        // The route answers with stream headers as soon as it has read the first body
        // line, so "no response within a few seconds" means the request body is being
        // buffered somewhere and live typing can never work here. Fall back quickly
        // instead of leaving the terminal waiting.
        const startWatchdog = channel
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              controller.abort();
            }, 4000)
          : null;

        try {
          const res = await fetch("/api/ssh/exec", requestInit);
          if (startWatchdog) clearTimeout(startWatchdog);

          if (!res.ok || !res.body) {
            const errJson = await res.json().catch(() => ({}));
            const errorCode = String((errJson as { code?: string }).code || "");
            return {
              exitCode: 1,
              output: "",
              httpError: String(
                (errJson as { error?: string }).error || `HTTP ${res.status}`
              ),
              retryWithoutStreaming:
                Boolean(channel) && errorCode === "streamed_body_timeout",
            };
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
              let evt: Record<string, unknown>;
              try {
                evt = JSON.parse(line) as Record<string, unknown>;
              } catch {
                continue;
              }
              if (evt.type === "ready") {
                gotReady = true;
                setStatus("connected");
                if (channel) streamingConfirmedRef.current = true;
                if (typeof evt.keyChannel === "string" && evt.keyChannel) {
                  keyPath = evt.keyChannel;
                  keyChannelRef.current = { path: evt.keyChannel, credentials };
                  setKeyChannelActive(true);
                  // Kept in the tab's run, so the command can be reached again after
                  // a reload or a closed tab (this is what makes resume work).
                  updateRunRef.current({ keyChannel: evt.keyChannel });
                }
                if (typeof evt.runLog === "string" && evt.runLog) {
                  runLogPath = evt.runLog;
                  updateRunRef.current({ runLog: evt.runLog });
                }
                if (typeof evt.fingerprint === "string") setFingerprint(evt.fingerprint);
              } else if (evt.type === "data" && typeof evt.data === "string") {
                const text = utf8Decoder.decode(decodeBase64Bytes(evt.data), {
                  stream: true,
                });
                output += text;
                options.stream?.(text);
              } else if (evt.type === "meta") {
                gotMeta = true;
                exitCode = Number(evt.exitCode ?? 0);
                // The command ended inside this tab (with or without noTimeout): mark finished.
                updateRunRef.current({ running: false, exitCode });
                if (typeof evt.cwd === "string" && evt.cwd) {
                  cwdRef.current = evt.cwd;
                  setCurrentCwd(evt.cwd);
                }
              } else if (evt.type === "error") {
                const message = String(evt.message || "SSH error");
                output += `\n${message}`;
                if (!gotReady) {
                  // The session never opened: the caller shows this as the
                  // one-sentence failure card (and retries it), so it is not
                  // printed into the terminal and no prompt is drawn after it.
                  connectError = message;
                  setStatus("error");
                } else {
                  options.stream?.(`\r\n\x1b[31m${message}\x1b[0m`);
                }
              }
            }
          }
          if (!gotMeta && noTimeoutRef.current && keyPath) {
            // The request ended without an exit marker: in no-timeout mode the
            // command is (by design) still running on the host.
            options.stream?.(
              `\r\n\x1b[90m↳ command continues running on the host${runLogPath ? ` (log: ${runLogPath})` : ""} — keys still reach it via ${keyPath}.\x1b[0m\r\n`
            );
            setDetachedRun({ path: keyPath, credentials, runLog: runLogPath || undefined });
            updateRunRef.current({
              running: true,
              detached: true,
              keyChannel: keyPath,
              ...(runLogPath ? { runLog: runLogPath } : {}),
            });
          }
        } catch (err) {
          // Any failure before the stream produced output means the streamed body was
          // not usable: the watchdog fired, or the browser refused it outright
          // (Chrome over HTTP/1.1: ERR_H2_OR_QUIC_REQUIRED; Firefox/Safari: a platform
          // error like "ReadableStream uploading is not supported" that is NOT a
          // page-realm TypeError, so it must not be identified by `instanceof`).
          // A user cancel is the one thing that must not be retried.
          const aborted = settled || (err as Error)?.name === "AbortError";
          if (channel && !gotReady && (settled || !aborted)) {
            return { exitCode: 1, output: "", retryWithoutStreaming: true };
          }
          if ((err as Error)?.name === "AbortError") {
            exitCode = 130;
            if (userCancelledExecRef.current) {
              userCancelledExecRef.current = false;
              options.stream?.("^C");
              updateRunRef.current({ running: false, exitCode: 130 });
            } else if (noTimeoutRef.current && gotReady && keyPath) {
              // Tab closed or unmounted: leave the detached run marked running so
              // reloading or switching devices can reattach to it.
              updateRunRef.current({
                running: true,
                detached: true,
                keyChannel: keyPath,
                ...(runLogPath ? { runLog: runLogPath } : {}),
              });
            }
          } else {
            const message =
              err instanceof Error ? err.message : "SSH stream interrupted.";
            output += `\n${message}`;
            exitCode = 1;
            options.stream?.(`\r\n\x1b[31m${message}\x1b[0m`);
            // Internet dropped mid-run: the no-timeout command is still alive on the
            // host — offer its key channel + output log so it can be answered later.
            if (noTimeoutRef.current && gotReady && keyPath) {
              setDetachedRun({ path: keyPath, credentials, runLog: runLogPath || undefined });
              updateRunRef.current({
                running: true,
                detached: true,
                keyChannel: keyPath,
                ...(runLogPath ? { runLog: runLogPath } : {}),
              });
            }
          }
        } finally {
          if (startWatchdog) clearTimeout(startWatchdog);
          abortExecRef.current = null;
          stdinRef.current = null;
          keyChannelRef.current = null;
          keyBatcherRef.current?.dispose();
          keyBatcherRef.current = null;
          setKeyChannelActive(false);
          channel?.channel.close();
        }

        return { exitCode, output, connectError };
      };

      const wantsStreaming = !streamingBlockedRef.current && canStreamExecStdin();
      const first = await attempt(wantsStreaming);

      if (first.retryWithoutStreaming) {
        // Remember it for the rest of the session: this deployment (or the network
        // in front of it) does not pass request bodies through while streaming.
        streamingBlockedRef.current = true;
        setStreamingStdinBlocked(true);
        termRef.current?.writeln(
          "\x1b[90m↳ Live typing can't stream into a running command on this connection (that\r\n" +
            "  needs HTTP/2 and a Chromium browser), so Sushi gives each command a keystroke\r\n" +
            "  channel on the host instead: prompts and full-screen menus (whiptail, debconf,\r\n" +
            "  tasksel) still answer to your keys, just with a little delay per key.\x1b[0m"
        );
        options.onInputReady?.(false);
        return attempt(false);
      }

      return first;
    },
    [gatewaySettings, profile]
  );

  /** Checks (quietly) whether sudo works right now, and whether it needs a password. */
  const probeElevation = useCallback(
    async (user: string, password?: string): Promise<ElevationProbe> => {
      const probe = await execServerless("true", { elevateUser: user, password });
      if (probe.exitCode === 0) {
        return { ok: true, needsPassword: false, message: "" };
      }
      // Nothing ran at all: the host is unreachable or the session ended. Reporting
      // that as "sudo is not installed" would send the user after the wrong problem.
      const lost = connectFailureFromExec(probe);
      if (lost) {
        return {
          ok: false,
          needsPassword: false,
          message: cleanSshFailureMessage(lost),
          connectError: lost,
        };
      }
      const text = probe.output || probe.httpError || "";
      if (SUDO_WRONG_PASSWORD_RE.test(text)) {
        return { ok: false, needsPassword: true, message: "Incorrect sudo password." };
      }
      if (SUDO_NEEDS_PASSWORD_RE.test(text)) {
        return { ok: false, needsPassword: true, message: "" };
      }
      const firstLine =
        text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || probe.httpError || "";
      if (/command not found|not found/i.test(firstLine)) {
        return {
          ok: false,
          needsPassword: false,
          message: "sudo is not installed on this server — log in as root instead.",
        };
      }
      return {
        ok: false,
        needsPassword: false,
        message: firstLine || "sudo did not grant root access on this server.",
      };
    },
    [execServerless]
  );

  /** Ctrl+C: a real SIGINT when stdin works, otherwise cancel the request. */
  const stopRunningCommand = useCallback(() => {
    const stdin = stdinRef.current;
    if (stdin?.canSendInput && stdin.sendSignal("INT")) return;
    userCancelledExecRef.current = true;
    // In no-timeout mode the server never kills the remote command on abort, so
    // deliver the Ctrl+C through the keystroke FIFO explicitly.
    if (noTimeoutRef.current && keyChannelRef.current) {
      void sendKeyChannelInput(keyChannelRef.current, "\x03", gatewaySettings);
    }
    abortExecRef.current?.abort();
  }, [gatewaySettings]);
  const stopRunningCommandRef = useRef(stopRunningCommand);
  useEffect(() => {
    stopRunningCommandRef.current = stopRunningCommand;
  }, [stopRunningCommand]);

  /** Sends keys to a no-timeout command that outlived its request (after a drop). */
  const sendDetachedKeys = useCallback(
    (keys: string) => {
      if (!detachedRun) return;
      void sendKeyChannelInput(detachedRun, keys, gatewaySettings).then((result) => {
        if (result === "missing") setDetachedRun(null); // it finished on the host
      });
    },
    [detachedRun, gatewaySettings]
  );

  /**
   * Publishes the tab's run to the workspace (localStorage-backed), so the command
   * can be found again after a reload or a closed tab. `null` clears it.
   */
  const publishRun = useCallback(
    (run: ResumableRun | null) => {
      currentRunRef.current = run;
      setCurrentRun(run);
      onRunChange?.(run);
    },
    [onRunChange]
  );

  /**
   * Remembers a command that just started. Only serverless commands can outlive the
   * tab (they are the ones with a keystroke FIFO and a /tmp log); a WebSocket PTY
   * lives exactly as long as its socket, so it is not offered as resumable.
   */
  const beginRun = useCallback(
    (command: string, transport: "ws" | "serverless") => {
      if (transport !== "serverless") {
        publishRun(null);
        return;
      }
      publishRun({
        id: `run-${randomUUID()}`,
        profile: {
          ...profile,
          // The stored snapshot never carries credentials (see session-resume).
          password: undefined,
          privateKey: undefined,
          passphrase: undefined,
        },
        command,
        cwd: cwdRef.current,
        detached: noTimeoutRef.current,
        running: true,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    [profile, publishRun]
  );

  /** `updateRun` is called from the transport callbacks installed per connection. */
  const updateRunRef = useRef<(patch: Partial<ResumableRun>) => void>(() => {});
  /** Same for the connection callbacks (they are installed once per session). */
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);
  /** A run handed over by the workspace, consumed once the session connects (or live while idle). */
  const resumeRunRef = useRef<ResumableRun | null>(resumeRun ?? null);
  const lastAttachedRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    resumeRunRef.current = resumeRun ?? null;
  }, [resumeRun]);

  /** Fills in the FIFO / log paths and the final state of the tracked run. */
  const updateRun = useCallback(
    (patch: Partial<ResumableRun>) => {
      const run = currentRunRef.current;
      if (!run) return;
      const next: ResumableRun = {
        ...run,
        ...patch,
        profile: run.profile,
        id: run.id,
        updatedAt: Date.now(),
      };
      // Nothing actually changed: do not rewrite localStorage on every poll.
      const changed =
        next.running !== run.running ||
        next.exitCode !== run.exitCode ||
        next.keyChannel !== run.keyChannel ||
        next.runLog !== run.runLog ||
        next.command !== run.command;
      currentRunRef.current = next;
      setCurrentRun(next);
      if (changed) onRunChange?.(next);
    },
    [onRunChange]
  );
  useEffect(() => {
    updateRunRef.current = updateRun;
  }, [updateRun]);

  /**
   * "Go back to that session": shows the command line again, redraws what the log
   * captured while the tab was gone, and points the keystroke channel at the FIFO of
   * the command that is still running — so typing reaches it instead of starting a
   * second copy.
   */
  const attachToRun = useCallback(
    async (term: import("@xterm/xterm").Terminal, run: ResumableRun) => {
      const credentials: ConnectionCredentials = {
        host: run.profile.host,
        port: run.profile.port,
        username: run.profile.username,
        authMethod: run.profile.authMethod,
        password: profile.password,
        privateKey: profile.privateKey,
        passphrase: profile.passphrase,
      };
      const label = `${run.profile.username}@${run.profile.host}`;
      setReattached(true);
      setTrackingRun(run.running);
      currentRunRef.current = run;
      setCurrentRun(run);
      onRunChange?.(run);

      term.writeln(
        `\x1b[90m↳ resuming \x1b[0m\x1b[1m${run.command}\x1b[0m\x1b[90m on ${label} — started ${new Date(run.startedAt).toLocaleString()}\x1b[0m`
      );

      if (run.keyChannel && run.running) {
        keyChannelRef.current = { path: run.keyChannel, credentials };
        setKeyChannelActive(true);
      }

      const status = run.keyChannel || run.runLog
        ? await fetchRunStatus(
            { credentials, keyChannel: run.keyChannel, runLog: run.runLog },
            gatewaySettings
          )
        : null;

      if (status?.ok) {
        if (status.output) {
          term.writeln("\x1b[90m── output so far (from the run log on the host) ──\x1b[0m");
          term.write(status.output.replace(/\r?\n/g, "\r\n"));
        }
        if (status.running) {
          term.writeln(
            "\x1b[33m● still running on the host\x1b[0m" +
              (run.runLog ? ` \x1b[90m(log: ${run.runLog})\x1b[0m` : "") +
              "\x1b[90m — keys you type are sent to it.\x1b[0m"
          );
          updateRun({ running: true });
        } else {
          term.writeln(
            "\x1b[90m● that command has finished on the host; the full log is still there" +
              (run.runLog ? ` at ${run.runLog}` : "") +
              ".\x1b[0m"
          );
          setTrackingRun(false);
          updateRun({ running: false });
          if (run.keyChannel) {
            keyChannelRef.current = null;
            setKeyChannelActive(false);
          }
          writePrompt(term);
        }
      } else {
        term.writeln(
          `\x1b[33m● could not read the run log${status?.error ? `: ${status.error}` : ""}. The command may have finished or the host is unreachable.\x1b[0m`
        );
        setTrackingRun(false);
        if (run.keyChannel) {
          keyChannelRef.current = null;
          setKeyChannelActive(false);
        }
        writePrompt(term);
      }
    },
    [gatewaySettings, onRunChange, profile, updateRun, writePrompt]
  );

  /**
   * Polls a reattached run: prints what the log gained and notices when the command
   * ends, so the terminal goes back to a normal prompt by itself.
   */
  useEffect(() => {
    if (!reattached || !currentRun || modeRef.current !== "serverless") return;
    let stopped = false;
    let printed = 0;
    let misses = 0;
    const credentials: ConnectionCredentials = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod,
      password: profile.password,
      privateKey: profile.privateKey,
      passphrase: profile.passphrase,
    };

    const tick = async () => {
      const run = currentRunRef.current;
      if (stopped || !run || !run.keyChannel) return;
      const status = await fetchRunStatus(
        { credentials, keyChannel: run.keyChannel, runLog: run.runLog },
        gatewaySettings,
        { timeoutMs: 12000 }
      );
      if (stopped) return;
      if (!status.ok) {
        // A single failed poll is not an ending; three in a row is.
        misses += 1;
        if (misses >= 3) {
          setTrackingRun(false);
          setReattached(false);
          return;
        }
        return;
      }
      misses = 0;
      if (status.output.length > printed) {
        const fresh = status.output.slice(printed);
        printed = status.output.length;
        termRef.current?.write(fresh.replace(/\r?\n/g, "\r\n"));
      }
      if (!status.running) {
        setTrackingRun(false);
        setReattached(false);
        keyChannelRef.current = null;
        setKeyChannelActive(false);
        updateRun({ running: false });
        termRef.current?.writeln("\r\n\x1b[90m● the command finished on the host.\x1b[0m");
        const t = termRef.current;
        if (t) writePrompt(t);
        return;
      }
    };

    const timer = setInterval(() => void tick(), 4000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [gatewaySettings, profile, reattached, updateRun, writePrompt]);

  /** Stops following a reattached run without touching the command on the host. */
  const stopTrackingRun = useCallback(() => {
    setTrackingRun(false);
    setReattached(false);
  }, []);

  /**
   * Writes raw bytes into the running command's keystroke FIFO.
   *
   * This is the path that makes an old-Ubuntu `Configuring lightdm` screen usable on
   * Vercel: the keys travel over their own tiny request, so nothing depends on the
   * browser streaming its request body.
   */
  const flushChannelKeys = useCallback(
    async (keys: string): Promise<boolean> => {
      const channel = keyChannelRef.current;
      if (!channel || !keys) return false;
      // Key presses are queued: two round trips started at the same time could
      // otherwise reach the FIFO out of order (an arrow before the Enter it follows).
      const previous = keySendChainRef.current;
      let release: () => void = () => {};
      keySendChainRef.current = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const result = await sendKeyChannelInput(channel, keys, gatewaySettings).finally(
        release
      );
      if (result === "missing") {
        // The command finished, or this host cannot host a key channel (no
        // `script`/`mkfifo`). Drop it so typing falls back to the replay path.
        keyChannelRef.current = null;
        keyBatcherRef.current?.dispose();
        keyBatcherRef.current = null;
        setKeyChannelActive(false);
        updateRunRef.current({ running: false });
        setMenuNote(
          "This host has no key channel for the running command — typing an answer and pressing Enter works instead."
        );
      } else if (result === "failed") {
        setMenuNote("The key press could not be delivered. Check the connection and try again.");
      } else {
        setMenuNote(null);
      }
      return result === "delivered";
    },
    [gatewaySettings]
  );

  /** Queues keystrokes typed in the terminal (coalesced into one round trip). */
  const queueChannelKeys = useCallback(
    (keys: string) => {
      if (!keys) return;
      if (!keyBatcherRef.current) {
        keyBatcherRef.current = createKeyBatcher((batch) => {
          void flushChannelKeys(batch);
        });
      }
      keyBatcherRef.current.push(keys);
      // A menu or a prompt must react at once; ordinary typing is worth batching.
      if (/[\r\n\x1b]/.test(keys)) keyBatcherRef.current.flushNow();
    },
    [flushChannelKeys]
  );

  /**
   * Sends key presses to the running command: through the live stdin channel when
   * the browser has one, otherwise through the remote keystroke FIFO.
   */
  const deliverKeys = useCallback(
    (keys: string) => {
      if (!keys) return;
      const stdin = stdinRef.current;
      if (stdin?.canSendInput) {
        stdin.sendInput(keys);
        setMenuNote(null);
        return;
      }
      if (keyChannelRef.current) {
        void flushChannelKeys(keys);
        return;
      }
      setMenuNote(
        "This screen only takes key presses and this host has no key channel. Press Ctrl+C and run the command again from a terminal that supports it."
      );
    },
    [flushChannelKeys]
  );

  // xterm's onData handler is installed once per connection, so it reads the key
  // helpers through refs (settings can change without re-registering the terminal).
  const queueChannelKeysRef = useRef(queueChannelKeys);
  useEffect(() => {
    queueChannelKeysRef.current = queueChannelKeys;
  }, [queueChannelKeys]);

  const askSudoPassword = useCallback(
    (term: import("@xterm/xterm").Terminal, prompt: SecretPrompt) => {
      secretPromptRef.current = prompt;
      secretBufferRef.current = "";
      term.write(
        `\r\n\x1b[33m[sudo] password for ${profile.username}: \x1b[0m`
      );
    },
    [profile.username]
  );

  /** Switches the session into root mode (what `sudo su` would do in a live PTY). */
  const enterRootMode = useCallback(
    async (
      term: import("@xterm/xterm").Terminal,
      password?: string
    ): Promise<"done" | "prompting"> => {
      if (profile.username.trim() === "root") {
        setElevatedUser("root");
        term.writeln("\r\n\x1b[90mAlready connected as root.\x1b[0m");
        return "done";
      }

      const known = password ?? sudoPasswordRef.current ?? undefined;
      if (!known && sudoNoPasswordRef.current) {
        setElevatedUser("root");
        return "done";
      }

      term.writeln("\r\n\x1b[90mChecking sudo…\x1b[0m");
      const probe = await probeElevation("root", known);
      if (probe.connectError) {
        failConnectRef.current(probe.connectError);
        return "done";
      }
      if (probe.ok) {
        if (known) sudoPasswordRef.current = known;
        else sudoNoPasswordRef.current = true;
        setElevatedUser("root");
        term.writeln(
          "\x1b[90m→ root shell — commands run with sudo, type \x1b[0mexit\x1b[90m to leave.\x1b[0m"
        );
        return "done";
      }
      if (probe.needsPassword) {
        if (known) {
          sudoPasswordRef.current = null;
          term.writeln("\r\n\x1b[31mIncorrect sudo password.\x1b[0m");
        }
        askSudoPassword(term, { action: "enter-root" });
        return "prompting";
      }
      term.writeln(
        `\r\n\x1b[31mCould not switch to root: ${probe.message}\x1b[0m`
      );
      return "done";
    },
    [askSudoPassword, probeElevation, profile.username, setElevatedUser]
  );

  const runServerlessCommand = useCallback(
    async (rawCmd: string, options: { password?: string; stdin?: string } = {}) => {
      const term = termRef.current;
      if (!term) return;

      const trimmed = rawCmd.trim();
      if (trimmed === "clear") {
        term.clear();
        writePrompt(term);
        return;
      }
      if (!trimmed) {
        writePrompt(term);
        return;
      }

      // Interactive shell builtins: sudo su / sudo -i / exit / su
      const intent = parseElevationCommand(trimmed);
      if (intent?.kind === "leave-root") {
        if (elevatedUserRef.current) {
          setElevatedUser(null);
          sudoPasswordRef.current = null;
          term.writeln(
            `\r\n\x1b[90m→ left the root shell (back to ${profile.username})\x1b[0m`
          );
          writePrompt(term);
        } else {
          term.writeln("\r\n\x1b[33mSession closed.\x1b[0m");
          setStatus("disconnected");
        }
        return;
      }
      if (intent?.kind === "enter-root") {
        setExecBusy(true);
        let result: "done" | "prompting" = "done";
        try {
          result = await enterRootMode(term, options.password);
        } finally {
          setExecBusy(false);
        }
        if (result === "done") writePrompt(term);
        return;
      }
      if (intent?.kind === "su-needs-root-password") {
        term.writeln(
          "\r\n\x1b[33m`su` needs the root account's own password, which this Vercel terminal can't prompt for.\r\nUse `sudo su` instead — Sushi asks for YOUR sudo password.\x1b[0m"
        );
        writePrompt(term);
        return;
      }

      const loggedInAsRoot = profile.username.trim() === "root";
      let commandToRun = rawCmd;
      let elevateUser: string | null = null;
      if (elevatedUserRef.current && !loggedInAsRoot) {
        elevateUser = elevatedUserRef.current;
      }
      if (intent?.kind === "sudo") {
        commandToRun = intent.command;
        elevateUser = loggedInAsRoot ? null : intent.asUser;
      }

      const interactive = detectInteractiveProgram(commandToRun);
      if (interactive) {
        const stdinWorks =
          streamingConfirmedRef.current && !streamingBlockedRef.current;
        if (!stdinWorks) {
          term.writeln(
            `\x1b[33m"${interactive}" needs a live terminal, and this session can only run one command at a time — it would sit there waiting for keystrokes.`
          );
          term.writeln(
            "\x1b[90mPiping into a shell is fine, though: `curl -fsSL … | sh` runs the piped script, and its [y/n] prompts are still answerable here.\x1b[0m"
          );
          term.writeln(
            "Use these here: cat / tail -n 100 / sed -i / top -bn1, or open a self-hosted Sushi (VPS / Docker) or a VPS gateway for vim, nano, less, tmux…\x1b[0m"
          );
          writePrompt(term);
          return;
        }
        // Keystrokes reach this command's stdin, so a full-screen program really
        // runs. It is not a perfect PTY (no window resizing), hence the heads-up.
        term.writeln(
          `\x1b[90m↳ ${interactive}: keystrokes are forwarded to it; press Ctrl+C to leave. (Resizing isn't supported in serverless mode.)\x1b[0m`
        );
      }

      // Elevation needs credentials first: remember NOPASSWD, otherwise ask once.
      const password = options.password ?? sudoPasswordRef.current ?? undefined;
      /** The command never ran because the session itself failed. */
      let sessionLost = false;
      setExecBusy(true);
      try {
        if (elevateUser && !password && !sudoNoPasswordRef.current) {
          const probe = await probeElevation(elevateUser, undefined);
          if (probe.ok) {
            sudoNoPasswordRef.current = true;
          } else if (probe.needsPassword) {
            askSudoPassword(term, { action: "run", command: rawCmd, elevateUser });
            return;
          } else if (probe.connectError) {
            failConnectRef.current(probe.connectError);
            return;
          } else {
            term.writeln(`\r\n\x1b[31m${probe.message}\x1b[0m`);
            writePrompt(term);
            return;
          }
        }

        let promptHintShown = false;
        let outputTail = "";
        let canType = false;
        menuHintShownRef.current = false;
        menuSignatureRef.current = "";
        setMenu(null);
        setMenuNote(null);
        pendingCommandRef.current = rawCmd;
        // Track this as the tab's run: it can outlive the tab in no-timeout mode, and
        // the workspace stores it so a reload can offer "go back".
        beginRun(rawCmd, modeRef.current);
        const result = await execServerless(commandToRun, {
          elevateUser,
          password,
          stdin: options.stdin,
          onInputReady: (value) => {
            canType = value;
            setCanTypeWhileRunning(value);
          },
          stream: (text) => {
            term.write(text);
            outputTail = (outputTail + text).slice(-8000);

            // A full-screen box (whiptail / debconf / ncurses — `Configuring
            // lightdm`) cannot be answered with a typed line: it wants key presses.
            // Show the actual entries and keys right above the terminal.
            const detected = detectFullscreenMenu(outputTail);
            if (detected) {
              const signature = [
                detected.title,
                detected.kind,
                detected.items.map((i) => `${i.selected ? "*" : " "}${i.label}`).join("|"),
                detected.buttons.join("|"),
              ].join("~");
              if (signature !== menuSignatureRef.current) {
                menuSignatureRef.current = signature;
                setMenu(detected);
                setMenuNote(null);
              }
            }

            // Surface a question with buttons, so nothing ever leaves the user
            // staring at a prompt they cannot answer.
            const kind = PASSWORD_PROMPT_RE.test(outputTail.slice(-200))
              ? "password"
              : CONFIRM_PROMPT_RE.test(outputTail.slice(-200))
                ? "confirm"
                : null;
            if (kind) {
              setLivePrompt({ kind, canType });
              awaitingAnswerRef.current = true;
              setAwaitingAnswer(true);
            }

            if (promptHintShown) return;
            if (!kind) return;
            promptHintShown = true;
            if (canType || keyChannelRef.current) return; // the answer bar is live
            term.write(
              "\r\n\x1b[33m↳ Waiting for your answer — type it here and press Enter " +
                "(e.g. y or n), or click Yes / No above. Sushi re-runs the command with " +
                "your answer. Ctrl+C cancels it.\x1b[0m\r\n"
            );
          },
        });

        // Nothing ran at all: the connection failed (dead host, firewall, expired
        // session). Show the one-sentence card instead of a prompt that can never
        // execute anything.
        const lost = connectFailureFromExec(result);
        if (lost) {
          sessionLost = true;
          failConnectRef.current(lost);
          return;
        }

        // A normal (with-timeout) command that returned is over. In no-timeout mode
        // the lack of a META marker means it is still running on the host instead.
        if (!noTimeoutRef.current) {
          updateRun({ running: false, exitCode: result.exitCode });
        }

        // sudo accepted / rejected the password we used
        if (elevateUser && options.password) {
          if (SUDO_WRONG_PASSWORD_RE.test(result.output)) {
            sudoPasswordRef.current = null;
            sudoNoPasswordRef.current = false;
            term.writeln("\r\n\x1b[31mIncorrect sudo password.\x1b[0m");
            askSudoPassword(term, { action: "run", command: rawCmd, elevateUser });
            return;
          }
          if (result.exitCode === 0) sudoPasswordRef.current = options.password;
        }
      } finally {
        awaitingAnswerRef.current = false;
        setAwaitingAnswer(false);
        busyInputRef.current = "";
        menuSignatureRef.current = "";
        setMenu(null);
        setExecBusy(false);
        // When a password prompt was started, the prompt itself is the cursor.
        // A lost session keeps the error card instead of a prompt.
        if (!secretPromptRef.current && !sessionLost) writePrompt(term);
      }
    },
    [askSudoPassword, beginRun, enterRootMode, execServerless, profile.username, probeElevation, updateRun, writePrompt]
  );

  /**
   * Enter while a command is running without a live stdin channel.
   *
   * The stuck command cannot be typed into, so Sushi cancels it and re-runs it with
   * the typed line piped into stdin — the same result `printf 'y\\n' | apt install …`
   * has. A line typed when no question is pending simply replaces the command, so the
   * terminal is never wedged.
   */
  const submitWhileBusy = useCallback(
    (line: string) => {
      const term = termRef.current;
      const answer = line.replace(/\s+$/, "");
      const command = pendingCommandRef.current;
      const awaiting = awaitingAnswerRef.current;

      if (!awaiting && !answer) return;

      // Stop the running exec first: its stdin is out of reach.
      abortExecRef.current?.abort();
      awaitingAnswerRef.current = false;
      setAwaitingAnswer(false);
      setLivePrompt(null);

      // The aborted command redraws the prompt in its own cleanup, so start the new
      // output on a fresh line a moment later instead of gluing it to that prompt.
      const rerun = (fn: () => void) => {
        setTimeout(() => {
          term?.write("\r\n");
          fn();
        }, 120);
      };

      if (awaiting && command) {
        term?.writeln(
          `\x1b[90m↳ answering "${answer || "Enter"}" and re-running the command…\x1b[0m`
        );
        rerun(() => void runServerlessCommand(command, { stdin: `${answer}\r` }));
        return;
      }

      const next = answer.trim();
      if (next) {
        term?.writeln(`\x1b[90m↳ stopping the running command…\x1b[0m`);
        rerun(() => void runServerlessCommand(next));
      }
    },
    [runServerlessCommand]
  );

  const submitWhileBusyRef = useRef(submitWhileBusy);
  useEffect(() => {
    submitWhileBusyRef.current = submitWhileBusy;
  }, [submitWhileBusy]);

  const runServerlessCommandRef = useRef(runServerlessCommand);
  useEffect(() => {
    runServerlessCommandRef.current = runServerlessCommand;
  }, [runServerlessCommand]);

  /**
   * Live cross-device attach: if another device starts a detached command on this
   * host while this session is already connected and idle, attach to its run log
   * and FIFO automatically so both devices see and control the same live command.
   */
  useEffect(() => {
    if (!resumeRun || !resumeRun.running) return;
    if (lastAttachedRunIdRef.current === resumeRun.id) return;
    if (currentRunRef.current?.id === resumeRun.id) return;
    const term = termRef.current;
    if (!term || connectingRef.current || execBusyRef.current || reattached) return;
    if (modeRef.current !== "serverless") return;
    lastAttachedRunIdRef.current = resumeRun.id;
    resumeRunRef.current = null;
    term.write("\r\n");
    void attachToRun(term, resumeRun);
  }, [attachToRun, reattached, resumeRun, running]);


  // Initialize xterm and transport session
  useEffect(() => {
    let disposed = false;
    // Capability state is per connection: a new session re-probes the deployment.
    streamingBlockedRef.current = false;
    streamingConfirmedRef.current = false;
    setStreamingStdinBlocked(false);
    let resizeObserver: ResizeObserver | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    async function initSession() {
      if (!containerRef.current) return;
      // Every session starts clean: the previous failure (and its countdown) is
      // gone before a byte of the new connection is attempted.
      connectFailureRef.current = null;
      connectingRef.current = false;
      setConnectFailure(null);
      setRetryIn(null);

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
      // Drives the "Translate" toolbar button while text is selected.
      term.onSelectionChange(() => setHasSelection(term.hasSelection()));
      try {
        fitAddon.fit();
      } catch {
        // ignore hidden container fit
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      setElevatedUser(null);
      setHasSelection(false);
      setTranslateSource(null);
      sudoPasswordRef.current = null;
      sudoNoPasswordRef.current = false;
      secretPromptRef.current = null;
      secretBufferRef.current = "";

      const shouldUseWs = Boolean(wsAvailable || gatewaySettings.gatewayUrl.trim());
      modeRef.current = shouldUseWs ? "ws" : "serverless";
      setTransportMode(modeRef.current);
      setStatus("connecting");

      // Handle user keystrokes across both WS and Serverless modes
      term.onData((data) => {
        // A failed connection is not a shell: keys are dropped, so nothing gets
        // echoed under the error message (`ubuntu@host:~$ sudo su`). While the shell
        // is still opening there is nothing to type into either.
        if (connectFailureRef.current || connectingRef.current) return;
        if (modeRef.current === "ws") {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data }));
          }
          return;
        }

        // A sudo password is being typed: capture it, never echo it
        if (secretPromptRef.current) {
          for (const ch of data) {
            if (ch === "\r" || ch === "\n") {
              const prompt = secretPromptRef.current;
              const password = secretBufferRef.current;
              secretPromptRef.current = null;
              secretBufferRef.current = "";
              term.write("\r\n");
              if (!prompt) break;
              if (!password) {
                term.writeln("\x1b[33m(cancelled)\x1b[0m");
                writePrompt(term);
                break;
              }
              if (prompt.action === "enter-root") {
                void runServerlessCommandRef.current("sudo su", { password });
              } else {
                void runServerlessCommandRef.current(prompt.command, { password });
              }
            } else if (ch === "\x7f" || ch === "\b") {
              if (secretBufferRef.current.length > 0) {
                secretBufferRef.current = secretBufferRef.current.slice(0, -1);
                term.write("\b \b");
              }
            } else if (ch === "\x03") {
              secretPromptRef.current = null;
              secretBufferRef.current = "";
              term.write("^C");
              writePrompt(term);
            } else if (ch >= " ") {
              secretBufferRef.current += ch;
              term.write("*");
            }
          }
          return;
        }

        // A command is running: keystrokes belong to it, exactly like a real PTY.
        // This is what makes `apt install` → `[Y/n]`, passphrase prompts and
        // `ssh-keygen` questions answerable on Vercel.
        if (execBusyRef.current) {
          const stdin = stdinRef.current;
          if (data === "\x03") {
            busyInputRef.current = "";
            stopRunningCommandRef.current();
            return;
          }
          if (stdin?.canSendInput) {
            // No local echo here — the remote PTY echoes what we type.
            stdin.sendInput(data);
            return;
          }

          // No live channel (Firefox, HTTP/1.1, a buffering proxy), but the command
          // does have a keystroke FIFO: forward the bytes verbatim, so arrows, Tab,
          // Space and Enter drive whiptail / debconf / ncurses screens instead of
          // landing in the shell as literal "[B" text.
          if (keyChannelRef.current) {
            queueChannelKeysRef.current(data);
            return;
          }

          // Neither. Escape sequences are not text: dropping them keeps an arrow key
          // from being executed as a command ("[B[B: not found") while a full-screen
          // menu is up.
          const parsed = splitTerminalInput(data);
          if (parsed.sequences.length > 0 && !menuHintShownRef.current) {
            menuHintShownRef.current = true;
            setMenuNote(
              "That screen needs key presses, and this host has no key channel for it — press Ctrl+C and re-run the command."
            );
          }
          const typed = parsed.text;

          // Let the user type a line anyway: Enter replays the stuck command with
          // that line piped into its stdin, so typing `y` really does answer
          // `[Y/n]`; anything else replaces the command.
          for (let i = 0; i < typed.length; i += 1) {
            const ch = typed[i];
            if (ch === "\r" || ch === "\n") {
              const line = busyInputRef.current;
              busyInputRef.current = "";
              term.write("\r\n");
              submitWhileBusyRef.current(line);
            } else if (ch === "\x7f" || ch === "\b") {
              if (busyInputRef.current.length > 0) {
                busyInputRef.current = busyInputRef.current.slice(0, -1);
                term.write("\b \b");
              }
            } else if (ch === "\x15") {
              const len = busyInputRef.current.length;
              if (len > 0) {
                term.write("\b \b".repeat(len));
                busyInputRef.current = "";
              }
            } else if (ch >= " ") {
              busyInputRef.current += ch;
              term.write(ch);
            }
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
              void runServerlessCommandRef.current(cmd);
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
        void (async () => {
          // The first command is both the reachability check and the working
          // directory read: the SSH handshake really has to happen before anything
          // is drawn. A host that cannot be reached then shows one sentence and a
          // Reconnect card — never a banner plus a prompt that can execute nothing.
          setStatus("connecting");
          connectingRef.current = true;
          // Only mention the wait when there actually is one: a fast handshake goes
          // straight to the banner. A failed one is replaced by the error card.
          const progress = setTimeout(() => {
            if (disposed || !connectingRef.current || connectFailureRef.current) return;
            term.writeln(
              `\x1b[90mConnecting to ${profile.username}@${profile.host}:${profile.port}…\x1b[0m`
            );
          }, 600);
          // The machine-info probe starts with the shell probe instead of after it.
          // Both ride on the same SSH connection, so naming the distro adds nothing
          // to the wait, and the prompt no longer sits behind a separate handshake.
          const sysinfo = ensureSystemInfo();
          const probe = await execServerless("pwd");
          clearTimeout(progress);
          if (disposed || connectFailureRef.current) return;

          const lost = connectFailureFromExec(probe);
          if (lost) {
            connectingRef.current = false;
            failConnectRef.current(lost);
            return;
          }

          term.writeln(
            `\x1b[38;2;255;107;87m● Sushi Serverless SSH Stream\x1b[0m \x1b[90m(${profile.username}@${profile.host}:${profile.port})\x1b[0m`
          );
          const reportedCwd = (probe.output || "")
            .trim()
            .split(/\r?\n/)
            .pop()
            ?.trim();
          if (reportedCwd && reportedCwd.startsWith("/")) {
            cwdRef.current = reportedCwd;
            setCurrentCwd(reportedCwd);
          }

          // Name the machine under the banner. It is already in flight (and usually
          // finished); a slow or restricted host must not hold the prompt up.
          const info = await Promise.race([
            sysinfo,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 700)),
          ]);
          if (disposed || connectFailureRef.current) return;
          const line = formatTerminalSystemLine(info);
          if (line) term.writeln(`\x1b[90m\u21b3 ${line}\x1b[0m`);
          // Only now can anything be typed: a prompt exists from here on.
          connectingRef.current = false;
          onConnectedRef.current?.();
          if (resumeRunRef.current) {
            // "Go back": show the command again and take over the run if the host is
            // still executing it. The prompt is written once the attach finishes.
            const run = resumeRunRef.current;
            lastAttachedRunIdRef.current = run.id;
            resumeRunRef.current = null;
            await attachToRun(term, run);
          } else {
            writePrompt(term);
          }
          term.focus();
        })();
      };

      if (shouldUseWs) {
        const wsUrl = buildWebSocketUrl("/ws/ssh", gatewaySettings);
        term.writeln(
          `\x1b[90mConnecting via WebSocket PTY to ${profile.username}@${profile.host}:${profile.port}...\x1b[0m`
        );

        let openedReady = false;
        let fellBack = false;
        let gotServerMessage = false;
        let lastServerError = "";
        const usingRemoteGateway = Boolean(gatewaySettings.gatewayUrl.trim());
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
            if (msg.type !== "pong") gotServerMessage = true;
            if (msg.type === "ready") {
              openedReady = true;
              setStatus("connected");
              if (msg.fingerprint) setFingerprint(msg.fingerprint);
              onConnectedRef.current?.();
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
              lastServerError = String(msg.message || "");
              // A remote gateway that refuses our tokens closes with 1008 next;
              // onclose falls back to serverless SSH instead of showing a dead end.
              if (!(usingRemoteGateway && !openedReady)) {
                if (!openedReady) {
                  // The PTY never opened: one sentence and the retry card, exactly
                  // like the serverless transport.
                  failConnectRef.current(lastServerError);
                } else {
                  setStatus("error");
                  term.writeln(`\r\n\x1b[31mSSH Error: ${msg.message}\x1b[0m`);
                }
              }
            } else if (msg.type === "exit") {
              setStatus("disconnected");
              term.writeln("\r\n\x1b[33mRemote SSH session ended.\x1b[0m");
            }
          } catch {
            // ignore
          }
        };

        ws.onerror = () => {
          if (!openedReady && !disposed && !fellBack) {
            fellBack = true;
            ws.close();
            switchToServerlessShell(
              usingRemoteGateway
                ? "Could not reach the VPS gateway WebSocket — falling back to Serverless HTTP Streaming SSH."
                : "WebSocket endpoint unavailable on this host — falling back to Serverless HTTP Streaming SSH."
            );
          }
        };

        ws.onclose = (event) => {
          if (disposed) return;
          if (openedReady) {
            setStatus("disconnected");
            return;
          }
          if (fellBack) return;
          if (usingRemoteGateway && (event.code === 1008 || !gotServerMessage)) {
            // Gateway rejected the session (e.g. missing / wrong SUSHI_GATEWAY_TOKEN)
            fellBack = true;
            switchToServerlessShell(
              `VPS gateway refused the session${
                lastServerError ? `: ${lastServerError}` : ""
              } — falling back to Serverless HTTP Streaming SSH.`
            );
            return;
          }
          if (usingRemoteGateway && lastServerError) {
            failConnectRef.current(lastServerError);
            return;
          }
          if (!gotServerMessage) {
            fellBack = true;
            switchToServerlessShell(
              "WebSocket closed before the SSH session started — falling back to Serverless HTTP Streaming SSH."
            );
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

  /**
   * Automatic retry: a failure that looks like a network problem is tried again
   * after `SSH_RETRY_DELAY_SECONDS`. Reconnecting starts a whole new session, so it
   * also clears the card, the terminal and any half-typed line.
   */
  useEffect(() => {
    if (retryIn === null) return;
    if (retryIn <= 0) {
      setRetryIn(null);
      setConnectSeq((n) => n + 1);
      return;
    }
    const timer = setTimeout(() => {
      setRetryIn((value) => (value === null ? null : tickRetryCountdown(value)));
    }, 1000);
    return () => clearTimeout(timer);
  }, [retryIn]);

  /** Reconnect button: retry now and push the countdown back. */
  const reconnectNow = useCallback(() => {
    setRetryIn(null);
    setConnectSeq((n) => n + 1);
  }, []);

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

  /**
   * Snippets grouped by category (Diagnostics, Containers, OS · Ubuntu, …). The
   * connected host's own OS family is flagged so the right "which Ubuntu is
   * this?" command is one click away.
   */
  // Vaults saved before the OS commands existed still get them: they are merged
  // in for display only, so nothing is written back to an unchanged vault.
  const allSnippetGroups = useMemo(
    () => groupSnippetsByCategory(mergeOsCommandSnippets(snippets)),
    [snippets]
  );
  const snippetGroups = useMemo(() => {
    const query = snippetFilter.trim().toLowerCase();
    if (!query) return allSnippetGroups;
    return allSnippetGroups
      .map((group) => ({
        category: group.category,
        snippets: group.snippets.filter((item) =>
          `${item.title} ${item.command} ${item.description || ""} ${group.category}`
            .toLowerCase()
            .includes(query)
        ),
      }))
      .filter((group) => group.snippets.length > 0);
  }, [allSnippetGroups, snippetFilter]);
  const snippetCount = allSnippetGroups.reduce((total, group) => total + group.snippets.length, 0);
  const hostOsCategory = osSnippetCategoryFor(systemInfo);

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

  const handleStopBackgroundProcesses = async () => {
    if (stoppingBg) return;
    setStoppingBg(true);
    try {
      // Cancel any active command in this tab first.
      if (execBusyRef.current) {
        userCancelledExecRef.current = true;
        try {
          stdinRef.current?.sendSignal("INT");
          stdinRef.current?.sendInput("\x03");
          stdinRef.current?.close();
        } catch {
          // ignore
        }
        abortExecRef.current?.abort();
      }
      if (keyChannelRef.current) {
        void sendKeyChannelInput(keyChannelRef.current, "\x03", gatewaySettings);
      } else if (detachedRun) {
        void sendKeyChannelInput(detachedRun, "\x03", gatewaySettings);
      }

      const result = await stopHostBackgroundProcesses(
        {
          host: profile.host,
          port: profile.port,
          username: profile.username,
          authMethod: profile.authMethod,
          password: profile.password,
          privateKey: profile.privateKey,
          passphrase: profile.passphrase,
        },
        gatewaySettings
      );

      setDetachedRun(null);
      currentRunRef.current = null;
      setCurrentRun(null);
      setReattached(false);
      setTrackingRun(false);
      onRunChange?.(null);
      onStopHostRuns?.();

      const term = termRef.current;
      if (term) {
        if (!result.ok) {
          term.write(
            `\r\n\x1b[31m✗ Failed to stop background SSH processes: ${result.error || "connection error"}\x1b[0m\r\n`
          );
        } else if (result.stoppedCount > 0 || result.cleanedChannels > 0) {
          const namesSuffix =
            result.processes.length > 0
              ? ` (${result.processes.join(", ")})`
              : "";
          term.write(
            `\r\n\x1b[32m✓ Stopped ${result.stoppedCount} background SSH process${result.stoppedCount === 1 ? "" : "es"}${namesSuffix}.\x1b[0m`
          );
          if (modeRef.current === "serverless" && !execBusyRef.current) {
            writePrompt(term);
          } else {
            term.write("\r\n");
          }
        } else {
          term.write(
            `\r\n\x1b[90m• No background SSH processes were running on ${profile.host}.\x1b[0m`
          );
          if (modeRef.current === "serverless" && !execBusyRef.current) {
            writePrompt(term);
          } else {
            term.write("\r\n");
          }
        }
        term.focus();
      }
    } finally {
      setStoppingBg(false);
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
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2.5">
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

          <span className="font-mono-code max-w-full truncate text-xs text-slate-400">
            {profile.username}@{profile.host}:{profile.port}
          </span>

          {(formatOsLabel(systemInfo) || systemInfo?.provider) && (
            <span
              title={formatSystemDetails(systemInfo).join("\n")}
              className="inline-flex max-w-[260px] items-center gap-1 truncate rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-200"
            >
              <Cpu className="h-3 w-3 shrink-0 text-violet-300" />
              <span className="truncate">{formatSystemLine(systemInfo)}</span>
            </span>
          )}

          {elevatedUser && transportMode === "serverless" && (
            <span
              title="Commands run with sudo until you type exit"
              className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-200"
            >
              <ShieldCheck className="h-3 w-3" />
              ROOT (sudo)
            </span>
          )}

          {transportMode === "serverless" &&
            (() => {
              const liveInput = !streamingStdinBlocked && canStreamExecStdin();
              return (
                <span
                  title={
                    liveInput
                      ? "Keystrokes are forwarded to the running command, so prompts like [Y/n] and whiptail menus can be answered."
                      : "Keystrokes can't stream into the running command here (that needs HTTP/2 + a Chromium browser), so every command gets a keystroke channel on the host instead — prompts, whiptail/debconf menus and arrow keys still reach it."
                  }
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                    liveInput
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                  }`}
                >
                  <Radio className="h-3 w-3" />
                  {liveInput ? "Live input" : "Key channel input"}
                </span>
              );
            })()}

          {fingerprint && (
            <span
              title={fingerprint}
              className="font-mono-code hidden max-w-[210px] items-center gap-1 truncate rounded-md border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-400 lg:inline-flex"
            >
              <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-400" />
              {fingerprint}
            </span>
          )}

          {detachedRun && (
            <span
              title={`This no-timeout command is still running on the host. Output log: ${detachedRun.runLog || "n/a"} (read it via SFTP or \`cat ${detachedRun.runLog}\`). Keystrokes are delivered to ${detachedRun.path}.`}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200"
            >
              <Infinity className="h-3 w-3 shrink-0" />
              <span className="hidden lg:inline">still running on host</span>
              <button
                type="button"
                onClick={() => sendDetachedKeys("y\r")}
                className="rounded border border-amber-400/40 px-1 font-semibold hover:bg-amber-500/20"
                title="Answer y + Enter"
              >
                y⏎
              </button>
              <button
                type="button"
                onClick={() => sendDetachedKeys("\r")}
                className="rounded border border-amber-400/40 px-1 font-semibold hover:bg-amber-500/20"
                title="Press Enter"
              >
                ⏎
              </button>
              <button
                type="button"
                onClick={() => sendDetachedKeys("\x03")}
                className="rounded border border-rose-400/40 px-1 font-semibold text-rose-200 hover:bg-rose-500/20"
                title="Send Ctrl+C to the detached command"
              >
                ^C
              </button>
              <button
                type="button"
                onClick={() => setDetachedRun(null)}
                className="text-amber-200/70 hover:text-white"
                title="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
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

        <div className="relative flex w-full max-w-full flex-wrap items-center gap-1.5 xl:w-auto">
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

          {/* Open the same host as an RDP desktop */}
          <button
            type="button"
            onClick={onOpenRdp}
            className="flex items-center gap-1.5 rounded-lg border border-[#ff6b57]/35 bg-[#ff6b57]/10 px-2.5 py-1 text-xs font-medium text-[#ff9587] transition hover:bg-[#ff6b57]/20"
            title="Open this host as an RDP desktop (port 3389)"
          >
            <Monitor className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Open RDP</span>
          </button>

          {/* Snippets Popover */}
          <div className="xl:relative">
            <button
              type="button"
              onClick={() => {
                setShowSnippets((v) => {
                  if (!v) setSnippetFilter("");
                  return !v;
                });
                setShowThemes(false);
              }}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10"
              aria-label="Open snippets"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">Snippets</span>
            </button>
            {showSnippets && (
              <div className="absolute top-full right-0 z-30 mt-2 max-h-[calc(100dvh-9rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-white/12 bg-[#141924] p-2 shadow-2xl xl:top-9 xl:mt-0">
                <div className="flex items-baseline justify-between gap-2 px-2 py-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Run Quick Command
                  </span>
                  {hostOsCategory && (
                    <span
                      className="truncate text-[10px] font-medium text-violet-300"
                      title="Snippets matching the connected host's OS are flagged below"
                    >
                      this host: {hostOsCategory.replace(/^OS · /, "")}
                    </span>
                  )}
                </div>
                {snippetCount > 6 && (
                  <input
                    type="text"
                    value={snippetFilter}
                    onChange={(event) => setSnippetFilter(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setSnippetFilter("");
                      }
                    }}
                    placeholder="Filter snippets (ubuntu, kernel, dnf …)"
                    aria-label="Filter snippets"
                    className="mb-1 w-full rounded-lg border border-white/10 bg-[#090b10] px-2.5 py-1.5 text-[11px] text-white placeholder-slate-500 outline-none focus:border-[#ff6b57]"
                  />
                )}
                {!snippetGroups.length && (
                  <div className="px-2.5 py-2 text-xs text-slate-400">
                    {snippetCount
                      ? "No snippet matches that filter."
                      : "No snippets yet — import a Termix database or add your own."}
                  </div>
                )}
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {snippetGroups.map((group) => {
                    const isHostOs = isSnippetCategoryForHost(group.category, systemInfo);
                    return (
                      <div key={group.category} className="space-y-0.5">
                        <div className="flex items-center gap-1.5 px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          <span className="truncate">{group.category}</span>
                          {isHostOs && (
                            <span className="shrink-0 rounded-full bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-violet-200">
                              this host
                            </span>
                          )}
                        </div>
                        {group.snippets.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => executeSnippet(s.command)}
                            title={s.description || s.command}
                            className="w-full rounded-lg px-2.5 py-1.5 text-left transition hover:bg-white/8"
                          >
                            <div className="text-xs font-medium text-white">{s.title}</div>
                            <div className="font-mono-code truncate text-[11px] text-slate-400">
                              {s.command}
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  })}
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

          {/* Translate the current selection */}
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => {
              const selected = termRef.current?.getSelection()?.trim() ?? "";
              if (selected) setTranslateSource(selected);
            }}
            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
            title="Translate selected text"
          >
            <Languages className="h-3.5 w-3.5" />
          </button>

          {/* Theme Picker */}
          <div className="xl:relative">
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
              <div className="absolute top-full right-0 z-30 mt-2 max-h-[calc(100dvh-9rem)] w-44 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-white/12 bg-[#141924] p-1.5 shadow-2xl xl:top-9 xl:mt-0">
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

          {/* No-timeout toggle for serverless commands */}
          <button
            type="button"
            onClick={() => {
              const next = !noTimeout;
              setNoTimeout(next);
              try {
                localStorage.setItem("sushi.noTimeout", next ? "1" : "0");
              } catch {
                // private mode — just keep it for this session
              }
            }}
            className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition ${
              noTimeout
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
            }`}
            title="No timeout (serverless shell): prompts like [y/n] wait forever, and the command keeps running on the host even if the internet drops — output is logged to a /tmp file and keys still reach it"
          >
            <Infinity className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">No timeout</span>
          </button>

          {/* Stop all background SSH processes on this host */}
          <button
            type="button"
            onClick={() => void handleStopBackgroundProcesses()}
            disabled={stoppingBg}
            className="flex items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/12 px-2.5 py-1 text-xs font-medium text-rose-200 transition hover:bg-rose-500/22 disabled:opacity-50"
            title="Stop all background SSH processes and detached commands on this host"
          >
            {stoppingBg ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Square className="h-3 w-3 fill-current" />
            )}
            <span className="hidden sm:inline">Stop Background</span>
            <span className="sm:hidden">Stop BG</span>
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

      {/* Following a command that was started before this tab existed. */}
      {reattached && currentRun && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-100">
          <span className="flex min-w-0 items-center gap-1.5">
            <Infinity className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span className="truncate">
              Resumed run · <span className="font-mono-code">{currentRun.command}</span>
              {currentRun.runLog ? (
                <span className="text-amber-200/70"> · log {currentRun.runLog}</span>
              ) : null}
            </span>
            <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold">
              {trackingRun ? "still running" : "finished"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            {currentRun.runLog && (
              <span className="hidden font-mono-code text-[10px] text-amber-200/70 sm:inline">
                polling every 4s
              </span>
            )}
            <button
              type="button"
              onClick={() => sendDetachedKeys("\x03")}
              className="rounded border border-rose-400/40 bg-rose-500/15 px-2 py-0.5 font-semibold text-rose-100 hover:bg-rose-500/25"
              title="Send Ctrl+C to the command that is still running on the host"
            >
              Stop it
            </button>
            <button
              type="button"
              onClick={stopTrackingRun}
              className="rounded border border-white/20 px-2 py-0.5 font-semibold text-amber-100 hover:bg-white/10"
              title="Stop following the log here. The command keeps running on the host."
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {/*
        Full-screen terminal menu bar (serverless mode).
        whiptail / debconf / ncurses screens (`Configuring lightdm`) only listen to
        their own terminal, so Sushi puts the keys they expect above the terminal —
        and delivers them through the command's keystroke FIFO when the browser
        cannot stream keystrokes into the running request.
      */}
      {transportMode === "serverless" && menu && (
        <div className="space-y-1 border-b border-sky-500/25 bg-sky-500/10 px-4 py-1.5 text-[11px] text-sky-50">
          <div className="flex flex-wrap items-center gap-1.5">
            <Keyboard className="h-3.5 w-3.5 shrink-0 text-sky-300" />
            <span className="min-w-0 max-w-[220px] truncate font-semibold text-sky-100">
              {menu.title || "Terminal menu"}
            </span>
            <span className="hidden text-sky-200/70 sm:inline">— keys go to the screen:</span>
            <span className="flex items-center gap-1">
              {[
                { label: "↑", title: "Arrow up", keys: MENU_KEY.up, Icon: ChevronUp },
                { label: "↓", title: "Arrow down", keys: MENU_KEY.down, Icon: ChevronDown },
                { label: "←", title: "Arrow left", keys: MENU_KEY.left, Icon: ChevronLeft },
                { label: "→", title: "Arrow right", keys: MENU_KEY.right, Icon: ChevronRight },
              ].map(({ label, title, keys, Icon }) => (
                <button
                  key={label}
                  type="button"
                  title={title}
                  onClick={() => deliverKeys(keys)}
                  className="flex items-center gap-0.5 rounded-md border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 font-semibold text-sky-100 transition hover:bg-sky-500/30"
                >
                  <Icon className="h-3 w-3" />
                  <span>{label}</span>
                </button>
              ))}
              <button
                type="button"
                title="Move to the next field / button"
                onClick={() => deliverKeys(MENU_KEY.tab)}
                className="rounded-md border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 font-semibold text-sky-100 transition hover:bg-sky-500/30"
              >
                Tab
              </button>
              <button
                type="button"
                title="Toggle the highlighted entry"
                onClick={() => deliverKeys(MENU_KEY.space)}
                className="rounded-md border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 font-semibold text-sky-100 transition hover:bg-sky-500/30"
              >
                Space
              </button>
              <button
                type="button"
                title="Press the default button"
                onClick={() => deliverKeys(MENU_KEY.enter)}
                className="flex items-center gap-0.5 rounded-md border border-emerald-400/40 bg-emerald-500/20 px-1.5 py-0.5 font-semibold text-emerald-100 transition hover:bg-emerald-500/30"
              >
                <CornerDownLeft className="h-3 w-3" />
                Enter
              </button>
              <button
                type="button"
                title="Escape"
                onClick={() => deliverKeys(MENU_KEY.escape)}
                className="rounded-md border border-white/15 px-1.5 py-0.5 text-sky-100 transition hover:bg-white/10"
              >
                Esc
              </button>
            </span>
            <button
              type="button"
              title="Hide this bar (the menu stays on screen)"
              onClick={() => {
                menuSignatureRef.current = "";
                setMenu(null);
              }}
              className="ml-auto text-sky-200/70 transition hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {menu.items.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sky-200/70">Choices:</span>
              {menu.items.map((item, index) => (
                <button
                  key={`${item.label}-${index}`}
                  type="button"
                  title={`Select ${item.label}`}
                  onClick={() => deliverKeys(menuSelectKeys(menu, index))}
                  className={
                    item.selected
                      ? "rounded-md border border-emerald-400/50 bg-emerald-500/20 px-1.5 py-0.5 font-semibold text-emerald-100 transition hover:bg-emerald-500/30"
                      : "rounded-md border border-white/15 px-1.5 py-0.5 text-sky-50 transition hover:bg-white/10"
                  }
                >
                  {item.selected ? "(*)" : "( )"} {item.label}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sky-200/70">Buttons:</span>
            {menu.buttons.map((button) => (
              <button
                key={button}
                type="button"
                title={`Press <${button}>`}
                onClick={() => deliverKeys(menuButtonKeys(menu, button))}
                className={
                  menu.buttons.indexOf(button) === 0
                    ? "rounded-md border border-emerald-400/50 bg-emerald-500/20 px-1.5 py-0.5 font-semibold text-emerald-100 transition hover:bg-emerald-500/30"
                    : "rounded-md border border-white/15 px-1.5 py-0.5 text-sky-50 transition hover:bg-white/10"
                }
              >
                &lt;{button}&gt;
              </button>
            ))}
            {!canSendKeys && (
              <span className="text-amber-200/90">
                No key channel for this command — restart it to use these keys.
              </span>
            )}
            {menuNote && <span className="text-amber-200/90">{menuNote}</span>}
          </div>
        </div>
      )}

      {/* Running command / answerable prompt bar (serverless mode) */}
      {transportMode === "serverless" && running && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-100">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />
          <span className="min-w-0 flex-1 truncate">
            {livePrompt
              ? livePrompt.kind === "password"
                ? "This command is asking for a password — type it below."
                : livePrompt.kind === "confirm"
                  ? canSendKeys
                    ? "Waiting for an answer — type it, or pick one:"
                    : "Waiting for an answer — type it and press Enter, or pick one:"
                  : "Waiting for input…"
              : "Command running — keystrokes go to it; Ctrl+C interrupts."}
          </span>

          {livePrompt && (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  canSendKeys
                    ? deliverKeys(livePrompt.kind === "confirm" ? "y\r" : "\r")
                    : submitWhileBusy(livePrompt.kind === "confirm" ? "y" : "")
                }
                className="rounded-md border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-200 transition hover:bg-emerald-500/30"
                title={livePrompt.kind === "confirm" ? "Answer yes" : "Press Enter"}
              >
                {livePrompt.kind === "confirm" ? "Yes (y)" : "Enter"}
              </button>
              {livePrompt.kind === "confirm" && (
                <button
                  type="button"
                  onClick={() => (canSendKeys ? deliverKeys("n\r") : submitWhileBusy("n"))}
                  className="rounded-md border border-white/15 px-2 py-0.5 text-amber-100 transition hover:bg-white/10"
                  title="Answer no"
                >
                  No (n)
                </button>
              )}
            </span>
          )}

          <button
            type="button"
            onClick={stopRunningCommand}
            className="flex shrink-0 items-center gap-1 rounded-md border border-rose-400/40 bg-rose-500/15 px-2 py-0.5 font-medium text-rose-200 transition hover:bg-rose-500/30"
            title={canSendKeys ? "Send Ctrl+C to the command" : "Cancel the running command"}
          >
            <Ban className="h-3 w-3" /> Stop
          </button>
        </div>
      )}

      {transportMode === "serverless" &&
        (running || awaitingAnswer) &&
        livePrompt &&
        !canSendKeys && (
          <div className="flex flex-wrap items-center gap-2 border-b border-sky-500/20 bg-[#101621] px-4 py-1.5 text-[11px] text-sky-100/90">
            <span className="min-w-0 flex-1">
              Type your answer in the terminal and press{" "}
              <span className="font-semibold">Enter</span> — Sushi stops the stuck command
              and re-runs it with what you typed (so <span className="font-mono-code">y</span>{" "}
              answers <span className="font-mono-code">[Y/n]</span>). You can also just type
              a different command. Next time, avoid the question with{" "}
              <span className="font-mono-code">
                {livePrompt.kind === "confirm" ? "apt install -y …" : "ssh-keygen -N '' …"}
              </span>
              .
            </span>
          </div>
        )}

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

      {/* Translate panel for the current selection */}
      {translateSource !== null && (
        <div className="border-b border-white/8 bg-[#131823] px-4 py-2">
          <TranslatePanel text={translateSource} onClose={() => setTranslateSource(null)} />
        </div>
      )}

      {/* Terminal Canvas */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
        {connectFailure && (
          <SshConnectErrorCard
            failure={connectFailure}
            retryIn={retryIn}
            onReconnect={reconnectNow}
            onCancelRetry={() => setRetryIn(null)}
          />
        )}
      </div>
    </div>
  );
}
