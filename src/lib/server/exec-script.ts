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
}

export interface ExecScript {
  script: string;
  /** Password to type into sudo's prompt, or null when none is needed. */
  feedPassword: string | null;
  /** Never echo the typed password back into the terminal stream. */
  ptyModes: { ECHO: 0 } | null;
  /** Keystroke FIFO used by this run (null when no key channel was requested). */
  keyChannel: string | null;
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

/** Random path for a new keystroke FIFO. Hex only, so it is safe to embed in a shell. */
export function createKeyChannelPath(): string {
  return `${KEY_CHANNEL_PREFIX}${randomBytes(9).toString("hex")}`;
}

/** Rejects anything that is not a path produced by `createKeyChannelPath`. */
export function isKeyChannelPath(value: string): boolean {
  return /^\/tmp\/\.sushi-keys-[0-9a-f]{8,32}$/.test(value);
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
  const sudoRunner = (inner: string) =>
    `sudo${passwordFlag}${userFlag} -- /bin/sh -c ${shellQuote(inner)}`;

  const channel = (keyChannel || "").trim();
  if (!channel) {
    if (!elevate) {
      return { script: body, feedPassword: null, ptyModes: null, keyChannel: null };
    }
    return {
      script: sudoRunner(body),
      feedPassword: password || null,
      ptyModes: password ? { ECHO: 0 } : null,
      keyChannel: null,
    };
  }

  const quotedChannel = shellQuote(channel);
  // `script -q -c` gives the command a terminal of its own; its stdin is the FIFO,
  // so a key press written by another exec shows up as a keystroke. The FIFO is
  // opened read-only on purpose: opening it read-write would create it when it is
  // missing (some kernels then refuse a file owned by another user, e.g. the login
  // user's FIFO opened by root through sudo). A detached writer keeps it open so the
  // read never blocks and never reports EOF between key presses.
  // The SUSHI_META marker inside the body carries the real exit code to Sushi.
  const fifoRunner = [
    `if [ -p ${quotedChannel} ] && command -v script >/dev/null 2>&1; then`,
    `exec 9<${quotedChannel}`,
    ...(pipedInput
      ? [`( sleep 1; printf %s ${shellQuote(pipedInput)} > ${quotedChannel} ) 2>/dev/null &`]
      : []),
    `SHELL=/bin/sh script -q -c ${shellQuote(body)} /dev/null <&9`,
    "__sushi_script_ec=$?",
    "exec 9<&-",
    "exit $__sushi_script_ec",
    "else",
    body
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "fi",
  ].join("\n");

  const runner = elevate ? sudoRunner(fifoRunner) : fifoRunner;

  // The FIFO is created by the SSH login user (mode 600) *before* sudo runs, so the
  // key-delivery exec can open it without elevation, while the elevated command can
  // still read it as root. The writer below holds the read end open; the trap closes
  // both and removes the FIFO however the command ends.
  const script = [
    `__sushi_keys=${quotedChannel}`,
    `rm -f "$__sushi_keys" 2>/dev/null`,
    `trap 'kill $__sushi_writer 2>/dev/null; rm -f "$__sushi_keys" 2>/dev/null' EXIT`,
    // Only when both halves exist: a FIFO nobody reads would swallow key presses.
    `if command -v mkfifo >/dev/null 2>&1 && command -v script >/dev/null 2>&1; then`,
    `  (umask 077; mkfifo -m 600 "$__sushi_keys") 2>/dev/null`,
    `  ( sleep 3900 > "$__sushi_keys" 2>/dev/null ) &`,
    "  __sushi_writer=$!",
    "fi",
    runner,
  ].join("\n");

  return {
    script,
    feedPassword: password || null,
    ptyModes: password ? { ECHO: 0 } : null,
    keyChannel: channel,
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
