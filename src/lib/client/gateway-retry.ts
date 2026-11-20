/**
 * Reaching a remote WebSocket gateway that may be asleep.
 *
 * A gateway on a plan that suspends idle services — Render's free instance
 * sleeps after ~15 minutes, an unscaled Railway service can be cold — cannot
 * complete a WebSocket handshake until it has booted, which takes tens of
 * seconds. Sushi used to attempt the handshake exactly once and, on any failure,
 * quietly downgrade the whole session to the serverless shell: one grey line in
 * the scrollback and no full-screen `vim`/`htop`, no resize, no team sharing, for
 * a gateway that was merely still starting up.
 *
 * So: wake it over HTTP first (an ordinary request boots the instance), then
 * retry the handshake a few times with a visible countdown, and only give up on a
 * failure that retrying cannot fix.
 */

import { GATEWAY_PROBE_TIMEOUT_MS, fetchGatewayCapabilities } from "./gateway";
import type { GatewaySettings } from "./gateway";

/** Handshake attempts before Sushi offers the serverless shell instead. */
export const GATEWAY_WS_ATTEMPTS = 3;

/** Wait before attempt 2, then 3. Short, because the warm-up already paid the boot. */
export const GATEWAY_WS_RETRY_DELAYS_MS: readonly number[] = [2000, 5000];

/**
 * How long the warm-up will keep asking. Generous on purpose: its whole job is to
 * sit through a cold boot, and a warm-up that gives up early is the same as none.
 * Exceeding it is not an error — the handshake retries cover a slower boot.
 */
export const GATEWAY_WAKE_TIMEOUT_MS = 30000;

/** How often the warm-up re-asks while it waits for a cold instance to listen. */
export const GATEWAY_WAKE_POLL_MS = 2000;

/**
 * Hard cap on asks, independent of the time window. A sleeping instance answers
 * *instantly* (a refused connection, or a 502 from the platform's proxy), so the
 * poll interval alone would not stop a tight loop from hammering the endpoint
 * hundreds of times a second while it waits out the window.
 */
export const GATEWAY_WAKE_MAX_PROBES = 40;

/**
 * Why a gateway handshake did not produce a PTY. The split matters: `unreachable`
 * is the only kind retrying can fix.
 */
export type GatewayFailureKind =
  /** Never reached the gateway process (asleep, cold-booting, DNS, TLS, refused). */
  | "unreachable"
  /** The gateway answered and rejected us (close 1008): wrong or missing token. */
  | "refused"
  /**
   * The gateway answered and then reported a problem — usually that *the SSH host*
   * is unreachable or the credentials are wrong. Retrying the gateway cannot help;
   * the failure belongs to the target machine and is shown as-is.
   */
  | "reported";

export interface GatewayHandshakeFailure {
  kind: GatewayFailureKind;
  /** WebSocket close code, when the socket got as far as closing with one. */
  code?: number;
  /** The gateway's own error text, when it managed to send one. */
  message?: string;
  /**
   * The gateway being dialled, for messages that need to name it. Kept separate
   * from `message`, which is whatever the gateway said — the two are not
   * interchangeable, and conflating them produces sentences like "the gateway at
   * Connection lost before handshake".
   */
  url?: string;
}

export type GatewayRetryDecision =
  | { action: "retry"; delayMs: number; attempt: number; of: number }
  | { action: "fail"; reason: string }
  | { action: "fallback"; reason: string };

/**
 * Classifies a failed handshake the way `ws.onclose` sees it.
 *
 * `gotServerMessage` is the discriminator: a gateway that sent *anything* (even a
 * `pong`) is awake and reachable, so whatever went wrong next is not a cold start.
 */
export function classifyGatewayClose(input: {
  code: number;
  gotServerMessage: boolean;
  serverError?: string | null;
}): GatewayFailureKind {
  // 1008 is what Sushi's own gateway sends for a rejected token, and it always
  // sends an error frame first — so a bare 1008 with nothing received means the
  // socket was closed by something in front of the app (a proxy, a cold router).
  if (input.code === 1008 && input.gotServerMessage) return "refused";
  if (input.gotServerMessage && input.serverError) return "reported";
  return "unreachable";
}

/**
 * Decides what to do about a failed handshake.
 *
 * `attempt` is 1-based: the attempt that has just failed. Retrying is only ever
 * offered for `unreachable`, and only while attempts remain.
 */
export function decideGatewayRetry(input: {
  failure: GatewayHandshakeFailure;
  attempt: number;
  attempts?: number;
  delaysMs?: readonly number[];
}): GatewayRetryDecision {
  const attempts = input.attempts ?? GATEWAY_WS_ATTEMPTS;
  const delays = input.delaysMs ?? GATEWAY_WS_RETRY_DELAYS_MS;

  if (input.failure.kind === "refused") {
    return {
      action: "fail",
      reason:
        input.failure.message ||
        "The gateway rejected this session. Check that SUSHI_GATEWAY_TOKEN matches the value in Sushi → Gateway settings.",
    };
  }

  if (input.failure.kind === "reported") {
    // The gateway is fine; it told us the SSH side failed. Show that verbatim —
    // re-running the handshake would only produce the same answer.
    return {
      action: "fail",
      reason: input.failure.message || "The gateway could not open the SSH session.",
    };
  }

  const delayMs = delays[input.attempt - 1];
  if (input.attempt >= attempts || delayMs === undefined) {
    return {
      action: "fallback",
      reason: `The gateway${
        input.failure.url ? ` at ${input.failure.url}` : ""
      } never answered ${attempts} handshake attempts. If it is on a plan that sleeps when idle it may still be starting up — retry in a moment, or use an always-on plan.`,
    };
  }

  return {
    action: "retry",
    delayMs,
    attempt: input.attempt + 1,
    of: attempts,
  };
}

/** One tick of a retry countdown. 0 means the retry is due now. */
export function countdownSecondsLeft(delayMs: number, elapsedMs: number): number {
  return Math.max(0, Math.ceil((delayMs - elapsedMs) / 1000));
}

/**
 * Reads an HTTP status out of a probe error (`"Gateway returned HTTP 502"`).
 * Exported so the wake-up loop can tell "the app answered" from "the platform's
 * proxy answered on its behalf because the app is still booting".
 */
export function probeHttpStatus(error?: string | null): number | null {
  const match = /HTTP (\d{3})/.exec(error || "");
  return match ? Number(match[1]) : null;
}

/**
 * True when a probe result proves the gateway *process* is up and listening.
 *
 * Any 1xx–4xx answer does — a 404 or a 401 still came from the app itself. A 5xx
 * does not: on Render and Railway that is the platform's proxy answering while
 * the instance is still cold-booting, which is precisely the state worth waiting
 * out rather than reporting as a failure.
 */
export function isAwakeProbe(probe: { ok: boolean; error?: string | null }): boolean {
  if (probe.ok) return true;
  const status = probeHttpStatus(probe.error);
  return status !== null && status < 500;
}

/** The wall clock the warm-up waits against. Injected so tests can fast-forward it. */
export interface WakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: WakeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface WakeOptions {
  /** Poll interval between asks. 0 means "ask exactly once". */
  pollMs?: number;
  /** Injectable wall clock, so tests can fast-forward the window. */
  clock?: WakeClock;
  /** Hard cap on requests, independent of the window. */
  maxProbes?: number;
  /**
   * Called after every ask that did not find the gateway awake. A cold boot takes
   * tens of seconds, and without this the user stares at "Waking the gateway…"
   * wondering whether anything is happening at all.
   */
  onProbe?: (info: { probe: number; waitedMs: number; error?: string }) => void;
}

/**
 * Wakes a possibly-sleeping gateway, waiting out its cold boot.
 *
 * A single request is not enough: an instance that is asleep refuses or 502s
 * *immediately*, so one probe would return "still asleep" in milliseconds and
 * leave the handshake to fail against a machine that is now busy booting. So this
 * keeps asking for up to `timeoutMs` and returns as soon as the process answers.
 *
 * Never throws, and never treats "gave up waiting" as a hard error — the handshake
 * retries behind it cover a boot that takes longer than the window.
 */
export async function wakeGateway(
  settings: GatewaySettings,
  timeoutMs = GATEWAY_WAKE_TIMEOUT_MS,
  options: WakeOptions = {}
): Promise<{ awake: boolean; timedOut: boolean; probes: number; error?: string }> {
  const pollMs = options.pollMs ?? GATEWAY_WAKE_POLL_MS;
  const clock = options.clock ?? realClock;
  const maxProbes = options.maxProbes ?? GATEWAY_WAKE_MAX_PROBES;

  if (!settings.gatewayUrl.trim()) return { awake: false, timedOut: false, probes: 0 };

  const startedAt = clock.now();
  const deadline = startedAt + timeoutMs;
  let lastError = "";
  let lastTimedOut = false;
  let probes = 0;

  for (;;) {
    // Checked before asking, so `maxProbes` means "at most this many requests".
    const remaining = deadline - clock.now();
    if (remaining <= 0 || probes >= maxProbes) break;
    probes += 1;
    // Each individual probe is bounded well inside the window so a hung request
    // cannot eat the whole warm-up and leave no time to re-ask.
    const probe = await fetchGatewayCapabilities(settings, Math.min(remaining, GATEWAY_PROBE_TIMEOUT_MS));
    lastError = probe.error || lastError;
    lastTimedOut = Boolean(probe.timedOut);

    if (isAwakeProbe(probe)) return { awake: true, timedOut: false, probes };

    options.onProbe?.({ probe: probes, waitedMs: clock.now() - startedAt, error: probe.error });

    // Don't sleep after the final ask — nothing will follow it.
    if (probes >= maxProbes) break;
    const wait = Math.min(pollMs, deadline - clock.now());
    if (wait <= 0) break;
    await clock.sleep(wait);
  }

  return {
    awake: false,
    timedOut: lastTimedOut || probes > 1 || !lastError,
    probes,
    error: lastError
      ? `${lastError} (asked ${probes} time${probes === 1 ? "" : "s"} over ${Math.round(timeoutMs / 1000)} s)`
      : `no answer within ${Math.round(timeoutMs / 1000)} s`,
  };
}
