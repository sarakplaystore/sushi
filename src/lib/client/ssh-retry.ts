/**
 * How a failed SSH connection is presented in the terminal.
 *
 * The server already turns low-level ssh2 / socket failures into one actionable
 * sentence (`describeSshError`), built from the real host, port and hosting
 * situation. The browser must not wrap that sentence in UI framing: no
 * `SSH Error:` prefix, no `ubuntu@host:~$` prompt and no echo of the command that
 * was typed — a prompt only exists once a shell really opened.
 *
 * These helpers clean a raw failure down to that sentence, decide whether an
 * automatic retry can help, and format the countdown shown in the error card.
 */

/** Seconds Sushi waits before retrying a failed connection on its own. */
export const SSH_RETRY_DELAY_SECONDS = 10;

export interface SshConnectFailure {
  /** The single sentence shown to the user. */
  message: string;
  /** True when retrying in `SSH_RETRY_DELAY_SECONDS` can plausibly work. */
  retryable: boolean;
}

/** Ansicode sequences (`\x1b[31m`, `\x1b[0m`, …) left over from terminal writes. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * A shell prompt plus everything typed after it, e.g.
 * `ubuntu@indo.rakvpn.eu.org:~$ sudo su`. A prompt is never part of an error.
 */
const SHELL_PROMPT_RE = /(?:^|\n)[ \t]*[\w.-]+@[\w.:-]+:[^\s]*[ \t]*[#$][ \t]?[\s\S]*$/;

/**
 * Failures that mean "this network path is wrong right now": a second attempt can
 * succeed once DNS, a firewall rule, a VPN or a cold host recovers.
 */
const RETRYABLE_RE = new RegExp(
  [
    "could not reach",
    "connection (?:timed out|refused|was reset)",
    "timed out",
    "timeout",
    "unreachable",
    "resolve the hostname",
    "dns",
    "socket hang up",
    "reset before ssh",
    "handshake",
    "network",
    "failed to fetch",
    "load failed",
    "econnrefused",
    "etimedout",
    "ehostunreach",
    "enetunreach",
    "enotfound",
    "eai_again",
    "temporar",
    "rate limit",
    "too many",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "http 5\\d\\d",
  ].join("|"),
  "i"
);

/** Failures a retry cannot fix: the credentials or the session are the problem. */
const NON_RETRYABLE_RE =
  /authentication failed|wrong username or password|permission denied|private key|passphrase|session expired|sign in|unauthori[sz]ed|not allowed|invalid|unsupported|is required|disabled/i;

/** Removes ANSI colours, `SSH Error:` framing and stray prompt / echo lines. */
export function cleanSshFailureMessage(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = String(raw).replace(ANSI_RE, "").replace(/\r/g, "\n");
  // Older builds printed `SSH Error: <message>` / `Error: <message>`; the message
  // itself never starts with that.
  text = text.replace(/^[ \t\n]*(?:SSH[ \t]+)?Error:[ \t]*/i, "");
  // A prompt line can only be a leftover from the shell: drop it and what follows.
  text = text.replace(SHELL_PROMPT_RE, "");
  return text.replace(/\s+/g, " ").trim();
}

/** True when waiting and trying again can fix this failure. */
export function isRetryableSshFailure(message: string): boolean {
  const text = cleanSshFailureMessage(message);
  if (!text) return false;
  if (NON_RETRYABLE_RE.test(text)) return false;
  return RETRYABLE_RE.test(text);
}

/**
 * The failure that means "nothing ran because the session itself is gone".
 *
 * The exec route reports it two ways: an `error` event before the SSH session ever
 * opened (`connectError`), or a non-2xx HTTP answer with no output at all
 * (`httpError`). Either way the terminal must show the sentence and a reconnect —
 * not a prompt. A command that merely failed on the host returns output and is not
 * a connection failure.
 */
export function connectFailureFromExec(result: {
  output: string;
  httpError?: string;
  connectError?: string;
}): string | undefined {
  if (result.connectError) return result.connectError;
  if (result.output.trim()) return undefined;
  return result.httpError || undefined;
}

/**
 * Builds the one thing a failed connection shows: the server's sentence, with a
 * generated fallback when the failure arrived without a message.
 */
export function describeSshConnectFailure(
  raw: string | null | undefined,
  options: { host?: string; port?: number; fallback?: string } = {}
): SshConnectFailure {
  const host = options.host?.trim() || "";
  const address = host ? `${host}${options.port ? `:${options.port}` : ""}` : "";
  const message =
    cleanSshFailureMessage(raw) ||
    cleanSshFailureMessage(options.fallback) ||
    (address
      ? `Could not reach ${address} — the SSH connection could not be established.`
      : "The SSH connection could not be established.");
  return { message, retryable: isRetryableSshFailure(message) };
}

/** `Retrying in 7s…` — the card's countdown line. 0 means "right now". */
export function formatRetryCountdown(secondsLeft: number): string {
  const whole = Number.isFinite(secondsLeft) ? Math.ceil(secondsLeft) : 0;
  return whole > 0 ? `Retrying in ${whole}s…` : "Reconnecting now…";
}

/** One tick of the countdown. 0 means the retry is due. */
export function tickRetryCountdown(secondsLeft: number): number {
  const next = Math.ceil(secondsLeft) - 1;
  return next > 0 ? next : 0;
}

/** 1 right after a failure, 0 when the automatic retry fires. */
export function retryCountdownFraction(secondsLeft: number): number {
  if (!Number.isFinite(secondsLeft)) return 0;
  return Math.min(1, Math.max(0, secondsLeft / SSH_RETRY_DELAY_SECONDS));
}
