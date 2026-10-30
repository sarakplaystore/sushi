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
}

export interface ExecScript {
  script: string;
  /** Password to type into sudo's prompt, or null when none is needed. */
  feedPassword: string | null;
  /** Never echo the typed password back into the terminal stream. */
  ptyModes: { ECHO: 0 } | null;
}

/** Pagers would block forever on a command that has no keystrokes available. */
export const PAGER_ENV_LINE =
  "export PAGER=cat GIT_PAGER=cat MANPAGER=cat SYSTEMD_PAGER=cat LESS=-FRX 2>/dev/null";

export function buildExecScript({
  command,
  cwd,
  elevate,
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
  if (!elevate) {
    return { script: body, feedPassword: null, ptyModes: null };
  }

  const user = elevate.user?.trim() || "root";
  const userFlag = user === "root" ? "" : ` -u ${shellQuote(user)}`;
  // `-n` fails fast when a password is needed (the client then asks for one), while
  // `-S` reads the password from the prompt we answer below. The prompt is kept (no
  // `-p ''`) so the password is only sent after sudo is actually waiting for it —
  // that also means NOPASSWD hosts never have their stdin polluted.
  const passwordFlag = password ? " -S" : " -n";
  const script = `sudo${passwordFlag}${userFlag} -- /bin/sh -c ${shellQuote(body)}`;

  return {
    script,
    feedPassword: password || null,
    ptyModes: password ? { ECHO: 0 } : null,
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
