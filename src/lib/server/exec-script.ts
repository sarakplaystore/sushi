import { randomBytes } from "node:crypto";
import { shellQuote } from "./ssh-client";

/**
 * Builds the remote script for one Serverless SSH command (`/api/ssh/exec`).
 *
 * Every command is wrapped so the shell prints an OSC marker with the exit code and
 * working directory when it finishes:  "\n" ESC "]777;SUSHI_META;<exit>;<pwd>" BEL
 *
 * With `elevate` the whole wrapper runs through sudo, which is how Sushi emulates
 * `sudo su` / `sudo <command>` on hosts where a live PTY is unavailable (Vercel):
 * the working directory, environment and marker are evaluated inside the root shell.
 */
export interface ExecElevation {
  /** User to run as (default "root"). */
  user?: string;
  /** sudo password. When set, sudo reads it from stdin after it prompts. */
  password?: string;
}

export interface ExecScriptOptions {
  command: string;
  cwd?: string;
  elevate?: ExecElevation | null;
  /**
   * Path of a keystroke FIFO on the remote host (see `createKeyChannelPath`).
   *
   * When set, the command runs inside `script(1)` — a real terminal on the remote
   * side — and anything written into the FIFO arrives as key presses. That is what
   * lets a whiptail/debconf screen (`Configuring lightdm`) be answered from the
   * browser even when the deployment cannot stream keystrokes into the running
   * request: each key press is just a tiny second exec that writes to the FIFO, so
   * it never depends on the browser, HTTP/2 or a sticky server instance.
   */
  keyChannel?: string | null;
  /** Text piped into the command's stdin (routed through the FIFO when there is one). */
  pipedInput?: string | null;
  /**
   * No-timeout run: the wrapper ignores SIGHUP (so closing the SSH channel — an
   * internet blip — does not kill the command), the session is also written to a
   * log file in /tmp, and the keystroke FIFO stays open for a day. Prompts such as
   * `Confirm to continue? [y/n]` can then be answered long after the request that
   * started the command is gone, via `/api/ssh/exec/keys`.
   */
  noTimeout?: boolean | null;
  /**
   * Pre-made log path for a no-timeout key-channel run (the route announces it in
   * its `ready` event before the script is built, so it creates the path itself).
   */
  runLogPath?: string | null;
}

export interface ExecScript {
  script: string;
  /** Password to type into sudo's prompt, or null when none is needed. */
  feedPassword: string | null;
  /** Never echo the typed password back into the terminal stream. */
  ptyModes: { ECHO: 0 } | null;
  /** Keystroke FIFO used by this run (null when no key channel was requested). */
  keyChannel: string | null;
  /** Output log of a no-timeout key-channel run (null otherwise). */
  runLog: string | null;
}

/** Pagers would block forever on a command that has no keystrokes available. */
export const PAGER_ENV_LINE =
  "export PAGER=cat GIT_PAGER=cat MANPAGER=cat SYSTEMD_PAGER=cat LESS=-FRX 2>/dev/null";

/**
 * Prefix of the per-command keystroke FIFO. Lives in `/tmp`, is owned by the SSH
 * login user with mode 600 (so no other local user can type into a root shell) and
 * is removed when the command finishes.
 */
export const KEY_CHANNEL_PREFIX = "/tmp/.sushi-keys-";

/**
 * Inline shell picker: resolves to bash when the host has it, otherwise /bin/sh.
 *
 * `/bin/sh` is dash on Debian/Ubuntu and cannot parse bash syntax such as process
 * substitution — `bash <(curl -Ls …)` dies with `Syntax error: "(" unexpected`.
 * A command typed into Sushi has to run under the same kind of shell an interactive
 * login would give, so every wrapper below runs it through bash when bash exists and
 * only falls back to /bin/sh on minimal systems (BusyBox/Alpine) without bash.
 *
 * The expression is POSIX-only, so it is safe at the top of a script even when the
 * SSH login shell itself is dash, and inline inside `sudo -- <shell> -c …` (sudo
 * starts a fresh shell, so the FIFO runner cannot rely on a variable set outside).
 */
const SHELL_PICK_CMD =
  "command -v bash 2>/dev/null || { [ -x /bin/bash ] && echo /bin/bash || echo /bin/sh; }";

/** `$(…)` form of the shell picker, for assignments and env prefixes. */
export const SHELL_PICK = `$(${SHELL_PICK_CMD})`;

/** Random path for a new keystroke FIFO. Hex only, so it is safe to embed in a shell. */
export function createKeyChannelPath(): string {
  return `${KEY_CHANNEL_PREFIX}${randomBytes(9).toString("hex")}`;
}

/** Rejects anything that is not a path produced by `createKeyChannelPath`. */
export function isKeyChannelPath(value: string): boolean {
  return /^\/tmp\/\.sushi-keys-[0-9a-f]{8,32}$/.test(value);
}

/**
 * Prefix of the per-command output log used by no-timeout runs (see
 * `ExecScriptOptions.noTimeout`). Lives in `/tmp` next to the keystroke FIFO and is
 * deliberately kept after the command ends, so the output can still be read when
 * the connection that started the command dropped in the middle of it.
 */
export const RUN_LOG_PREFIX = "/tmp/.sushi-run-";

/** Random path for a new no-timeout run log. Hex only, safe to embed in a shell. */
export function createRunLogPath(): string {
  return `${RUN_LOG_PREFIX}${randomBytes(9).toString("hex")}.log`;
}

/** Rejects anything that is not a path produced by `createRunLogPath`. */
export function isRunLogPath(value: string): boolean {
  return /^\/tmp\/\.sushi-run-[0-9a-f]{8,32}\.log$/.test(value);
}

/**
 * Script for one key press: writes the exact bytes into the running command's FIFO.
 *
 * It runs as the SSH login user (the FIFO's owner), never through sudo, so it works
 * on hosts where the command itself is elevated. Reports which of the three things
 * happened, because the UI needs to know whether keys actually arrived.
 */
export function buildKeyDeliveryScript(path: string, keys: string): string {
  const quotedPath = shellQuote(path);
  return [
    `if [ -p ${quotedPath} ]; then`,
    `  if printf %s ${shellQuote(keys)} > ${quotedPath} 2>/dev/null; then echo SUSHI_KEYS_OK; else echo SUSHI_KEYS_FAIL; fi`,
    "else",
    "  echo SUSHI_KEYS_MISSING",
    "fi",
  ].join("\n");
}

/** Parses `buildKeyDeliveryScript` output. */
export function parseKeyDeliveryResult(
  output: string
): "delivered" | "failed" | "missing" {
  if (output.includes("SUSHI_KEYS_OK")) return "delivered";
  if (output.includes("SUSHI_KEYS_MISSING")) return "missing";
  return "failed";
}

export function buildExecScript({
  command,
  cwd,
  elevate,
  keyChannel,
  pipedInput,
  noTimeout,
  runLogPath,
}: ExecScriptOptions): ExecScript {
  const cdPrefix =
    cwd && cwd !== "~" ? `cd -- ${shellQuote(cwd)} 2>/dev/null || true` : "";

  const lines = [PAGER_ENV_LINE];
  if (cdPrefix) lines.push(cdPrefix);
  lines.push(
    command.trim() ? command : ":",
    "__sushi_ec=$?",
    'printf "\\n\\033]777;SUSHI_META;%s;%s\\007" "$__sushi_ec" "$(pwd)"',
    "exit $__sushi_ec"
  );
  const body = lines.join("\n");

  const password = elevate?.password || "";
  const user = elevate?.user?.trim() || "root";
  const userFlag = user === "root" ? "" : ` -u ${shellQuote(user)}`;
  // `-n` fails fast when a password is needed (the client then asks for one), while
  // `-S` reads the password from the prompt we answer below. The prompt is kept (no
  // `-p ''`) so the password is only sent after sudo is actually waiting for it —
  // that also means NOPASSWD hosts never have their stdin polluted.
  const passwordFlag = password ? " -S" : " -n";
  // `"$__sushi_shell"` is expanded by the outer (login) shell into the bash path
  // picked at the top of the script — never hardcode /bin/sh here, it is dash on
  // Debian/Ubuntu and rejects bashisms like `bash <(curl …)` (see SHELL_PICK).
  const sudoRunner = (inner: string) =>
    `sudo${passwordFlag}${userFlag} -- "$__sushi_shell" -c ${shellQuote(inner)}`;

  const channel = (keyChannel || "").trim();
  // Resolve the shell once; the wrappers re-exec into it so the command runs under
  // bash even when the SSH login shell (or /bin/sh) is plain dash.
  const shellHead = `__sushi_shell=${SHELL_PICK}`;
  // A no-timeout run survives its own SSH channel closing (internet blip): SIGHUP
  // is ignored, so the command keeps running on the host instead of dying with the
  // request that started it.
  const hupTrap = noTimeout ? "trap '' HUP" : "";
  if (!channel) {
    if (!elevate) {
      return {
        script: [shellHead, hupTrap, `exec "$__sushi_shell" -c ${shellQuote(body)}`]
          .filter(Boolean)
          .join("\n"),
        feedPassword: null,
        ptyModes: null,
        keyChannel: null,
        runLog: null,
      };
    }
    return {
      script: [shellHead, hupTrap, sudoRunner(body)].filter(Boolean).join("\n"),
      feedPassword: password || null,
      ptyModes: password ? { ECHO: 0 } : null,
      keyChannel: null,
      runLog: null,
    };
  }

  const quotedChannel = shellQuote(channel);
  // No-timeout runs additionally write the whole session to a log file (kept after
  // the command ends), so the output is still there when the starting request died.
  const runLog = noTimeout ? (runLogPath ?? createRunLogPath()) : null;
  // `script -q -c` gives the command a terminal of its own; its stdin is the FIFO,
  // so a key press written by another exec shows up as a keystroke. The FIFO is
  // opened read-only on purpose: opening it read-write would create it when it is
  // missing (some kernels then refuse a file owned by another user, e.g. the login
  // user's FIFO opened by root through sudo). A detached writer keeps it open so the
  // read never blocks and never reports EOF between key presses.
  // The SUSHI_META marker inside the body carries the real exit code to Sushi.
  // script(1) runs the body with $SHELL -c: pick bash inline (self-contained, this
  // runner may execute inside sudo's fresh shell) so bashisms keep working.
  const scriptFile = runLog ?? "/dev/null";
  const fifoRunner = [
    `if [ -p ${quotedChannel} ] && command -v script >/dev/null 2>&1; then`,
    `exec 9<${quotedChannel}`,
    ...(pipedInput
      ? [`( sleep 1; printf %s ${shellQuote(pipedInput)} > ${quotedChannel} ) 2>/dev/null &`]
      : []),
    // script(1) streams the session live to stdout AND writes it to the typescript
    // file (scriptFile = the run log for no-timeout runs, /dev/null otherwise). If the
    // SSH channel drops, stdout writes fail but script(1) keeps running (verified:
    // it survives write errors), so the command's terminal stays alive, the log keeps
    // the full session, and keys still arrive through the FIFO.
    `SHELL="${SHELL_PICK}" script -q -c ${shellQuote(body)} ${shellQuote(scriptFile)} <&9`,
    "__sushi_script_ec=$?",
    "exec 9<&-",
    "exit $__sushi_script_ec",
    // Fallback when script(1)/the FIFO is missing: still run the body through the
    // picked shell (quoted!) — a raw body would be parsed by the outer shell, which
    // is dash on Debian/Ubuntu and rejects bashisms at parse time, before anything
    // runs. Inline pick because this runner may execute inside sudo's fresh shell.
    "else",
    `"${SHELL_PICK}" -c ${shellQuote(body)}`,
    "fi",
  ].join("\n");

  const runner = elevate ? sudoRunner(fifoRunner) : fifoRunner;

  // The FIFO is created by the SSH login user (mode 600) *before* sudo runs, so the
  // key-delivery exec can open it without elevation, while the elevated command can
  // still read it as root. The writer below holds the read end open; the trap closes
  // both and removes the FIFO however the command ends.
  const script = [
    shellHead,
    // No-timeout runs ignore SIGHUP so they survive their own channel closing.
    ...(noTimeout ? ["trap '' HUP"] : []),
    `__sushi_log=${shellQuote(scriptFile)}`,
    `__sushi_keys=${quotedChannel}`,
    `rm -f "$__sushi_keys" 2>/dev/null`,
    `trap 'kill $__sushi_writer 2>/dev/null; rm -f "$__sushi_keys" 2>/dev/null' EXIT`,
    // Only when both halves exist: a FIFO nobody reads would swallow key presses.
    `if command -v mkfifo >/dev/null 2>&1 && command -v script >/dev/null 2>&1; then`,
    `  (umask 077; mkfifo -m 600 "$__sushi_keys") 2>/dev/null`,
    // No-timeout keeps the FIFO open for a day, so a prompt can be answered long
    // after the request that started the command is gone.
    `  ( sleep ${noTimeout ? 86400 : 3900} > "$__sushi_keys" 2>/dev/null ) &`,
    "  __sushi_writer=$!",
    // Keep the writer out of the job table: bash would otherwise print
    // `Terminated ( sleep 3900 > "$__sushi_keys" … )` into the terminal when the
    // trap kills it. dash has no disown, so guard it.
    '  if command -v disown >/dev/null 2>&1; then disown "$__sushi_writer" 2>/dev/null || true; fi',
    "fi",
    runner,
  ].join("\n");

  return {
    script,
    feedPassword: password || null,
    ptyModes: password ? { ECHO: 0 } : null,
    keyChannel: channel,
    runLog,
  };
}

/** Matches sudo's password prompt at the end of the buffered output. */
export const SUDO_PROMPT_RE = /(?:\[sudo\]|password for)[^\r\n]{0,120}:\s*$/i;

/**
 * Splits sudo's password prompt out of the stream so it can be answered and hidden
 * from the user (they already entered the password in Sushi).
 */
export function extractSudoPrompt(buffer: string): {
  before: string;
  prompt: string | null;
} {
  const match = SUDO_PROMPT_RE.exec(buffer);
  if (!match) return { before: buffer, prompt: null };
  return { before: buffer.slice(0, match.index), prompt: match[0] };
}

export interface SudoAnswer {
  /** Output with sudo's prompt removed. */
  text: string;
  /** Write the password to the channel now. */
  sendPassword: boolean;
  /** sudo asked again → the password was wrong; stop the command instead of hanging. */
  gaveUp: boolean;
}

/**
 * Stateful helper for one command: answers sudo's password prompt once and gives up
 * (rather than blocking until the request times out) if sudo rejects the password.
 */
export function createSudoAnswerer() {
  let sent = false;
  return {
    get passwordSent(): boolean {
      return sent;
    },
    answer(text: string): SudoAnswer {
      const { before, prompt } = extractSudoPrompt(text);
      if (!prompt) return { text, sendPassword: false, gaveUp: false };
      if (!sent) {
        sent = true;
        return { text: before, sendPassword: true, gaveUp: false };
      }
      return { text: before, sendPassword: false, gaveUp: true };
    },
  };
}

/**
 * Script behind "is my command still running?" (`/api/ssh/exec/run`).
 *
 * A resumable run is identified by its keystroke FIFO (removed the moment the
 * command ends) and its output log (kept afterwards). One round trip answers both
 * questions: `SUSHI_RUN_ALIVE` / `SUSHI_RUN_DEAD`, plus the log tail so the browser
 * can redraw what it missed while the tab was gone.
 *
 * Read-only and cheap: `test -p` on the FIFO, `tail -c` on the log. Nothing is
 * written, no root, no extra packages.
 */
export interface RunStatusScriptOptions {
  /** Keystroke FIFO reported by the exec route (`/tmp/.sushi-keys-…`). */
  keyChannel?: string | null;
  /** Output log reported by the exec route (`/tmp/.sushi-run-….log`). */
  runLog?: string | null;
  /** How many bytes of the log tail to include (default 48 KiB, max 256 KiB). */
  tailBytes?: number;
}

/** Output of `buildRunStatusScript`, parsed by `parseRunStatusOutput`. */
export interface RunStatus {
  alive: boolean;
  exists: boolean;
  /** Tail of the run log (empty when there is none). */
  output: string;
  /** `wc -c` size of the log, or -1 when it is gone. */
  logBytes: number;
}

export const RUN_ALIVE_MARKER = "SUSHI_RUN_ALIVE";
export const RUN_DEAD_MARKER = "SUSHI_RUN_DEAD";

export function buildRunStatusScript({
  keyChannel,
  runLog,
  tailBytes = 48 * 1024,
}: RunStatusScriptOptions): string {
  const channel = (keyChannel || "").trim();
  const log = (runLog || "").trim();
  const bytes = Math.max(1024, Math.min(256 * 1024, Math.floor(tailBytes)));
  const lines: string[] = [];

  if (channel && isKeyChannelPath(channel)) {
    // A FIFO that still exists means the wrapper (and its command) is still there.
    lines.push(
      `if [ -p ${shellQuote(channel)} ]; then echo ${RUN_ALIVE_MARKER}; else echo ${RUN_DEAD_MARKER}; fi`
    );
  } else {
    lines.push(`echo ${RUN_DEAD_MARKER}`);
  }

  if (log && isRunLogPath(log)) {
    const quoted = shellQuote(log);
    lines.push(
      `if [ -f ${quoted} ]; then echo "SUSHI_LOG_BYTES=$(wc -c < ${quoted} 2>/dev/null | tr -d ' ')"; echo SUSHI_LOG_START; tail -c ${bytes} ${quoted} 2>/dev/null; echo; echo SUSHI_LOG_END; else echo "SUSHI_LOG_BYTES=-1"; fi`
    );
  } else {
    lines.push(`echo "SUSHI_LOG_BYTES=-1"`);
  }

  return lines.join("\n");
}

/**
 * Parses the `buildRunStatusScript` output.
 *
 * The state marker is always the script's first line, so a log that happens to
 * contain the word "SUSHI_RUN_ALIVE" cannot confuse the answer: only that first line
 * is read for the state, and the log sits between the LOG_START / LOG_END sentinels.
 */
export function parseRunStatusOutput(output: string): RunStatus {
  // The state is the script's very first line (see buildRunStatusScript), so a log
  // that happens to contain the marker word cannot change the answer.
  const firstLine =
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "";
  const alive = firstLine === RUN_ALIVE_MARKER;
  const logBytesLine = output.match(/SUSHI_LOG_BYTES=(-?\d+)/);
  const logBytes = logBytesLine ? Number(logBytesLine[1]) : -1;

  const start = output.indexOf("SUSHI_LOG_START");
  const end = output.lastIndexOf("SUSHI_LOG_END");
  let text = "";
  if (start !== -1 && end > start) {
    text = output
      .slice(start + "SUSHI_LOG_START".length, end)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
  }

  return { alive, exists: logBytes >= 0, output: text, logBytes };
}

/**
 * Strips ANSI/VT control sequences from a PTY transcript.
 *
 * `script(1)` logs everything a terminal receives — colour codes, cursor moves,
 * bracketed-paste toggles, `\r` progress redraws. That is right for xterm, but for
 * the one-line "what did I miss?" preview in a resume prompt it must be plain text.
 */
export function stripTerminalControl(text: string): string {
  return text
    // OSC (window title, hyperlinks, Sushi's own meta marker) incl. BEL/ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI (colours, cursor movement, erase line)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Two-byte escapes (e.g. ESC ( B charset switch, ESC = keypad)
    .replace(/\x1b[@-Z\\-_()][0-9A-Za-z]?/g, "")
    // Other C0 controls that confuse a single-line preview, keeping newlines/tabs
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    // Backspaces already removed; carriage returns become line breaks.
    .replace(/\r\n?/g, "\n");
}

/**
 * Last meaningful lines of a transcript, for the resume preview.
 * Drops blank lines and trims long ones, newest last.
 */
export function tailPreview(text: string, maxLines = 6, maxLineLength = 160): string[] {
  const lines = stripTerminalControl(text)
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").trim())
    .filter(Boolean);
  return lines
    .slice(-maxLines)
    .map((line) =>
      line.length > maxLineLength ? `${line.slice(0, maxLineLength - 1)}…` : line
    );
}

export interface StopBackgroundProcessesResult {
  stoppedCount: number;
  cleanedChannels: number;
  processes: string[];
}

export const STOP_BG_MARKER = "SUSHI_BG_STOPPED";

/**
 * Builds a safe POSIX shell script that stops all background SSH processes on
 * the remote host without touching system boot services (`systemd`, `sshd`,
 * `dockerd`, `nginx`, etc.) or live interactive login prompts:
 *
 * 1. Protects its own PID, `$PPID`, and full ancestor chain up to PID 1.
 * 2. Removes all `/tmp/.sushi-keys-*` FIFOs and stops all Sushi detached /
 *    no-timeout command wrappers (`SUSHI_META`, `/tmp/.sushi-run-*`).
 * 3. Stops background jobs spawned from SSH sessions (`SSH_CONNECTION` /
 *    `SSH_CLIENT` in `/proc/<pid>/environ`, plus POSIX `ps` fallback for
 *    non-root orphaned processes) and recursively terminates their child /
 *    `sudo` descendant trees (`SIGTERM` followed by `SIGKILL`).
 */
export function buildStopBackgroundProcessesScript(): string {
  return [
    "__uid=$(id -u 2>/dev/null || echo -1)",
    '__prot=" $$ $PPID "',
    "__cur=$PPID",
    "__step=0",
    'while [ -n "$__cur" ] && [ "$__cur" -gt 1 ] 2>/dev/null && [ "$__step" -lt 16 ]; do',
    '  __next=$(ps -o ppid= -p "$__cur" 2>/dev/null | tr -d " ")',
    '  if [ -z "$__next" ] || [ "$__next" = "$__cur" ]; then break; fi',
    '  __prot="${__prot}${__next} "',
    "  __cur=$__next",
    "  __step=$((__step + 1))",
    "done",
    "__fifos=0",
    "for __f in /tmp/.sushi-keys-*; do",
    '  if [ -p "$__f" ]; then',
    '    rm -f "$__f" 2>/dev/null && __fifos=$((__fifos + 1))',
    "  fi",
    "done",
    '__targets=""',
    "__add_target() {",
    '  case " $__prot $__targets " in',
    '    *" $1 "*) ;;',
    '    *) __targets="${__targets} $1" ;;',
    "  esac",
    "}",
    "for __p in $(ps -eo pid=,ppid=,args= 2>/dev/null | awk -v self=\"$$\" '$1 != self && $2 != self && (/\\/tmp\\/\\.sushi-keys-|\\/tmp\\/\\.sushi-run-|SUSHI_META/) {print $1}'); do",
    '  [ -n "$__p" ] && __add_target "$__p"',
    "done",
    "if [ -d /proc ]; then",
    "  for __d in /proc/[0-9]*; do",
    "    __p=${__d#/proc/}",
    '    case " $__prot " in *" $__p "*) continue ;; esac',
    '    [ ! -r "$__d/status" ] && continue',
    "    __ppid=$(awk '/^PPid:/ {print $2; exit}' \"$__d/status\" 2>/dev/null)",
    '    [ "$__ppid" = "$$" ] && continue',
    '    if [ "$__uid" != "0" ]; then',
    "      __owner=$(awk '/^Uid:/ {print $2; exit}' \"$__d/status\" 2>/dev/null)",
    '      [ -n "$__owner" ] && [ "$__owner" != "$__uid" ] && continue',
    "    fi",
    "    if tr '\\0' '\\n' < \"$__d/environ\" 2>/dev/null | grep -qE '^(SSH_CONNECTION|SSH_CLIENT|SUSHI_BG)='; then",
    '      __comm=$(cat "$__d/comm" 2>/dev/null)',
    '      case "$__comm" in',
    '        sshd|sshd-session|systemd|"(sd-pam)"|ssh-agent|gpg-agent|dbus-daemon) continue ;;',
    "      esac",
      '      __stat=$(ps -o stat= -p "$__p" 2>/dev/null | tr -d " ")',
      '      case "$__stat" in',
      "        *+*) continue ;;",
      "      esac",
      '      __pcomm=""',
    '      [ -n "$__ppid" ] && [ -r "/proc/$__ppid/comm" ] && __pcomm=$(cat "/proc/$__ppid/comm" 2>/dev/null)',
    '      case "$__pcomm" in',
    "        sshd|sshd-session)",
    '          case "$__comm" in',
    "            bash|sh|dash|zsh|fish|ash|ksh|tcsh|csh|-*)",
    "              if ! tr '\\0' ' ' < \"$__d/cmdline\" 2>/dev/null | grep -qE 'SUSHI_META|/tmp/\\.sushi-'; then",
    "                continue",
    "              fi",
    "              ;;",
    "          esac",
    "          ;;",
    "      esac",
    '      __add_target "$__p"',
    "    fi",
    "  done",
    'elif [ "$__uid" != "0" ] && [ "$__uid" != "-1" ]; then',
    "  for __p in $(ps -u \"$__uid\" -o pid=,ppid=,comm= 2>/dev/null | awk -v self=\"$$\" '$1 != self && $2 == 1 && $3 !~ /^(sshd|systemd|launchd|cfprefsd|UserEventAgent|ssh-agent|gpg-agent)$/ {print $1}'); do",
    '    [ -n "$__p" ] && __add_target "$__p"',
    "  done",
    "fi",
    'if [ -n "$__targets" ]; then',
    "  __ps_tree=$(ps -eo pid=,ppid= 2>/dev/null)",
    "  __added=1",
    "  __iter=0",
    '  while [ "$__added" -eq 1 ] && [ "$__iter" -lt 12 ]; do',
    "    __added=0",
    "    __iter=$((__iter + 1))",
    "    for __child in $(printf '%s\\n' \"$__ps_tree\" | awk -v self=\"$$\" -v t=\" $__targets \" '$1 != self && $2 != self && index(t, \" \" $2 \" \") > 0 {print $1}'); do",
    '      case " $__prot $__targets " in',
    '        *" $__child "*) ;;',
    '        *) __targets="${__targets} $__child"; __added=1 ;;',
    "      esac",
    "    done",
    "  done",
    "fi",
    "__count=0",
    '__names=""',
    "for __p in $__targets; do",
    '  if kill -0 "$__p" 2>/dev/null || sudo -n kill -0 "$__p" 2>/dev/null; then',
    "    __cn=$(ps -o comm= -p \"$__p\" 2>/dev/null | tr -d ' ,;' | head -n 1)",
    '    if [ -n "$__cn" ]; then',
    '      case ",$__names," in',
    '        *,"$__cn",*) ;;',
    '        *) __names=${__names:+$__names,}$__cn ;;',
    "      esac",
    "    fi",
    '    kill -TERM "$__p" 2>/dev/null || sudo -n kill -TERM "$__p" 2>/dev/null || true',
    "    __count=$((__count + 1))",
    "  fi",
    "done",
    'if [ "$__count" -gt 0 ]; then',
    "  sleep 0.25 2>/dev/null || sleep 1",
    "  for __p in $__targets; do",
    '    if kill -0 "$__p" 2>/dev/null || sudo -n kill -0 "$__p" 2>/dev/null; then',
    '      kill -KILL "$__p" 2>/dev/null || sudo -n kill -KILL "$__p" 2>/dev/null || true',
    "    fi",
    "  done",
    "fi",
    `printf '${STOP_BG_MARKER} count=%s fifos=%s names=%s\\n' "$__count" "$__fifos" "$__names"`,
  ].join("\n");
}

export function parseStopBackgroundProcessesOutput(
  output: string
): StopBackgroundProcessesResult {
  const match = output.match(
    new RegExp(`${STOP_BG_MARKER}\\s+count=(\\d+)\\s+fifos=(\\d+)\\s+names=([^\\r\\n]*)`)
  );
  if (!match) {
    return { stoppedCount: 0, cleanedChannels: 0, processes: [] };
  }
  const stoppedCount = Number(match[1]) || 0;
  const cleanedChannels = Number(match[2]) || 0;
  const processes = (match[3] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  return { stoppedCount, cleanedChannels, processes };
}
