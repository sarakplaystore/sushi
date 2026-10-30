"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
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
import {
  type ExecStdinChannel,
  canStreamExecStdin,
  createExecRequestBody,
  supportsStreamingRequestBody,
} from "@/lib/client/exec-stdin";
import { getStoredSessionToken } from "@/lib/client/auth-storage";
import {
  CONFIRM_PROMPT_RE,
  PASSWORD_PROMPT_RE,
  SUDO_NEEDS_PASSWORD_RE,
  SUDO_WRONG_PASSWORD_RE,
  detectInteractiveProgram,
  parseElevationCommand,
} from "@/lib/client/terminal-commands";

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
type ElevationProbe = { ok: boolean; needsPassword: boolean; message: string };

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
}: SshTerminalSessionProps) {
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
  /** A serverless command is currently running (drives the input bar). */
  const [running, setRunning] = useState(false);
  /** The running command printed something that looks like a question. */
  const [livePrompt, setLivePrompt] = useState<
    { kind: "confirm" | "password" | "generic"; canType: boolean } | null
  >(null);
  /** True when keystrokes reach the running command's stdin. */
  const [canTypeWhileRunning, setCanTypeWhileRunning] = useState(false);
  /** The command behind the current prompt, so it can be re-run with an answer. */
  const pendingCommandRef = useRef<string | null>(null);
  /** Local line buffer used while a command runs with no live stdin channel. */
  const busyInputRef = useRef<string>("");
  /** True while the running command is (probably) waiting for an answer. */
  const awaitingAnswerRef = useRef(false);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);

  // Refs used inside xterm.onData closure for Serverless Streaming Shell mode
  const modeRef = useRef<"ws" | "serverless">(wsAvailable ? "ws" : "serverless");
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

  /** Keeps the ref (used inside xterm callbacks) and the UI in sync. */
  const setExecBusy = useCallback((value: boolean) => {
    execBusyRef.current = value;
    setRunning(value);
    if (!value) setLivePrompt(null);
  }, []);

  const writePrompt = useCallback(
    (term: import("@xterm/xterm").Terminal, cwdVal?: string) => {
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
    ): Promise<{ exitCode: number; output: string; httpError?: string }> => {
      const term = termRef.current;
      const utf8Decoder = new TextDecoder("utf-8");

      const payload = {
        credentials: {
          host: profile.host,
          port: profile.port,
          username: profile.username,
          authMethod: profile.authMethod,
          password: profile.password,
          privateKey: profile.privateKey,
          passphrase: profile.passphrase,
        },
        command,
        cwd: cwdRef.current,
        cols: term?.cols || 100,
        rows: term?.rows || 30,
        ...(options.stdin ? { stdin: options.stdin } : {}),
        ...(options.elevateUser
          ? {
              elevate: {
                user: options.elevateUser,
                password: options.password,
              },
            }
          : {}),
      };

      type AttemptResult = {
        exitCode: number;
        output: string;
        httpError?: string;
        retryWithoutStreaming?: boolean;
      };

      const attempt = async (allowStreaming: boolean): Promise<AttemptResult> => {
        const controller = new AbortController();
        abortExecRef.current = controller;
        let output = "";
        let exitCode = 0;
        let gotReady = false;
        let settled = false;

        const streaming = allowStreaming && canStreamExecStdin();
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
                if (typeof evt.fingerprint === "string") setFingerprint(evt.fingerprint);
              } else if (evt.type === "data" && typeof evt.data === "string") {
                const text = utf8Decoder.decode(decodeBase64Bytes(evt.data), {
                  stream: true,
                });
                output += text;
                options.stream?.(text);
              } else if (evt.type === "meta") {
                exitCode = Number(evt.exitCode ?? 0);
                if (typeof evt.cwd === "string" && evt.cwd) {
                  cwdRef.current = evt.cwd;
                  setCurrentCwd(evt.cwd);
                }
              } else if (evt.type === "error") {
                if (!gotReady) setStatus("error");
                const message = String(evt.message || "SSH error");
                output += `\n${message}`;
                options.stream?.(`\r\n\x1b[31m${message}\x1b[0m`);
              }
            }
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
            options.stream?.("^C");
          } else {
            const message =
              err instanceof Error ? err.message : "SSH stream interrupted.";
            output += `\n${message}`;
            exitCode = 1;
            options.stream?.(`\r\n\x1b[31m${message}\x1b[0m`);
          }
        } finally {
          if (startWatchdog) clearTimeout(startWatchdog);
          abortExecRef.current = null;
          stdinRef.current = null;
          channel?.channel.close();
        }

        return { exitCode, output };
      };

      const wantsStreaming = !streamingBlockedRef.current && canStreamExecStdin();
      const first = await attempt(wantsStreaming);

      if (first.retryWithoutStreaming) {
        // Remember it for the rest of the session: this deployment (or the network
        // in front of it) does not pass request bodies through while streaming.
        streamingBlockedRef.current = true;
        setStreamingStdinBlocked(true);
        termRef.current?.writeln(
          "\x1b[90m↳ Live typing isn't available on this connection (it needs HTTP/2 and a\r\n" +
            "  Chromium browser). Everything still works: when a command asks a question,\r\n" +
            "  type the answer and press Enter — Sushi re-runs it with your answer.\x1b[0m"
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

  /** Sends bytes to the running command's stdin (false when unavailable). */
  const sendTerminalInput = useCallback((data: string): boolean => {
    const stdin = stdinRef.current;
    return stdin?.canSendInput ? stdin.sendInput(data) : false;
  }, []);

  /** Ctrl+C: a real SIGINT when stdin works, otherwise cancel the request. */
  const stopRunningCommand = useCallback(() => {
    const stdin = stdinRef.current;
    if (stdin?.canSendInput && stdin.sendSignal("INT")) return;
    abortExecRef.current?.abort();
  }, []);

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
      setExecBusy(true);
      try {
        if (elevateUser && !password && !sudoNoPasswordRef.current) {
          const probe = await probeElevation(elevateUser, undefined);
          if (probe.ok) {
            sudoNoPasswordRef.current = true;
          } else if (probe.needsPassword) {
            askSudoPassword(term, { action: "run", command: rawCmd, elevateUser });
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
        pendingCommandRef.current = rawCmd;
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
            outputTail = (outputTail + text).slice(-200);

            // Surface a question with buttons, so nothing ever leaves the user
            // staring at a prompt they cannot answer.
            const kind = PASSWORD_PROMPT_RE.test(outputTail)
              ? "password"
              : CONFIRM_PROMPT_RE.test(outputTail)
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
            if (canType) return; // the answer bar is live; no scary warning needed
            term.write(
              "\r\n\x1b[33m↳ Waiting for your answer — type it here and press Enter " +
                "(e.g. y or n), or click Yes / No above. Sushi re-runs the command with " +
                "your answer. Ctrl+C cancels it.\x1b[0m\r\n"
            );
          },
        });

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
        setExecBusy(false);
        // When a password prompt was started, the prompt itself is the cursor
        if (!secretPromptRef.current) writePrompt(term);
      }
    },
    [askSudoPassword, enterRootMode, execServerless, profile.username, probeElevation, writePrompt]
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

      setElevatedUser(null);
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
                void runServerlessCommand("sudo su", { password });
              } else {
                void runServerlessCommand(prompt.command, { password });
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
            if (stdin?.canSendInput) {
              // Real SIGINT so the remote command cleans up after itself.
              stdin.sendSignal("INT");
            } else {
              busyInputRef.current = "";
              abortExecRef.current?.abort();
            }
            return;
          }
          if (stdin?.canSendInput) {
            // No local echo here — the remote PTY echoes what we type.
            stdin.sendInput(data);
            return;
          }

          // No live channel (HTTP/1.1, Safari, …): let the user type a line anyway.
          // Enter replays the stuck command with that line piped into its stdin, so
          // typing `y` really does answer `[Y/n]`; anything else replaces the command.
          for (let i = 0; i < data.length; i += 1) {
            const ch = data[i];
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
                setStatus("error");
                term.writeln(`\r\n\x1b[31mSSH Error: ${msg.message}\x1b[0m`);
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
            setStatus("error");
            term.writeln(`\r\n\x1b[31mSSH Error: ${lastServerError}\x1b[0m`);
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
                      ? "Keystrokes are forwarded to the running command, so prompts like [Y/n] can be answered."
                      : "Keystrokes can't reach a running command here (needs HTTP/2 + a Chromium browser). Sushi offers a one-click retry that answers the prompt, e.g. `apt install -y`."
                  }
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                    liveInput
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                  }`}
                >
                  <Radio className="h-3 w-3" />
                  {liveInput ? "Live input" : "No live input"}
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

      {/* Running command / answerable prompt bar (serverless mode) */}
      {transportMode === "serverless" && running && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-100">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />
          <span className="min-w-0 flex-1 truncate">
            {livePrompt
              ? livePrompt.kind === "password"
                ? "This command is asking for a password — type it below."
                : livePrompt.kind === "confirm"
                  ? canTypeWhileRunning
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
                  canTypeWhileRunning
                    ? void sendTerminalInput(livePrompt.kind === "confirm" ? "y\r" : "\r")
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
                  onClick={() =>
                    canTypeWhileRunning
                      ? void sendTerminalInput("n\r")
                      : submitWhileBusy("n")
                  }
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
            title={canTypeWhileRunning ? "Send Ctrl+C to the command" : "Cancel the running command"}
          >
            <Ban className="h-3 w-3" /> Stop
          </button>
        </div>
      )}

      {transportMode === "serverless" &&
        (running || awaitingAnswer) &&
        livePrompt &&
        !canTypeWhileRunning && (
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

      {/* Terminal Canvas */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
