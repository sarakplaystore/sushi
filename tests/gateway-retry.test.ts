import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  GATEWAY_WAKE_MAX_PROBES,
  GATEWAY_WAKE_POLL_MS,
  GATEWAY_WAKE_TIMEOUT_MS,
  GATEWAY_WS_ATTEMPTS,
  GATEWAY_WS_RETRY_DELAYS_MS,
  classifyGatewayClose,
  countdownSecondsLeft,
  decideGatewayRetry,
  isAwakeProbe,
  probeHttpStatus,
  realClock,
  wakeGateway,
} from "../src/lib/client/gateway-retry";

/**
 * A gateway on a plan that suspends idle services cannot complete a WebSocket
 * handshake until it has booted. These tests cover the policy that replaced "try
 * once, then silently downgrade the session to the serverless shell": wake it over
 * HTTP, retry the handshake with a visible countdown, and only give up on a
 * failure that retrying cannot fix.
 */

console.log("==> Testing gateway wake-up and WebSocket retry policy...");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// ---- classifying a failed handshake -----------------------------------------
// A gateway that sent anything at all is awake, so the failure is not a cold start.
assert.equal(
  classifyGatewayClose({ code: 1006, gotServerMessage: false }),
  "unreachable",
  "closed with nothing received = never reached the process"
);
assert.equal(
  classifyGatewayClose({ code: 1008, gotServerMessage: false }),
  "unreachable",
  "a bare 1008 with no frame came from something in front of the app, not from it"
);
assert.equal(
  classifyGatewayClose({
    code: 1008,
    gotServerMessage: true,
    serverError: "Gateway token rejected",
  }),
  "refused",
  "1008 after an error frame is the gateway rejecting the token"
);
assert.equal(
  classifyGatewayClose({
    code: 1006,
    gotServerMessage: true,
    serverError: "Could not reach 10.0.0.5:22",
  }),
  "reported",
  "the gateway answered and then reported the SSH host failing"
);
assert.equal(
  classifyGatewayClose({ code: 1000, gotServerMessage: true }),
  "unreachable",
  "a clean close with no error text still has nothing retrying would fix, but it is not a refusal"
);

// ---- deciding what to do about it -------------------------------------------
// Cold start: retried, with the documented backoff, then downgraded.
const first = decideGatewayRetry({
  failure: { kind: "unreachable", code: 1006 },
  attempt: 1,
});
assert.equal(first.action, "retry", "attempt 1 of an unreachable gateway is retried");
assert.deepEqual(
  first,
  { action: "retry", delayMs: GATEWAY_WS_RETRY_DELAYS_MS[0], attempt: 2, of: GATEWAY_WS_ATTEMPTS },
  "the retry names the next attempt and how many there are"
);

const second = decideGatewayRetry({
  failure: { kind: "unreachable", code: 1006 },
  attempt: 2,
});
assert.equal(second.action, "retry", "attempt 2 is retried too");
assert.equal(
  second.action === "retry" && second.delayMs,
  GATEWAY_WS_RETRY_DELAYS_MS[1],
  "the second wait is longer than the first"
);
assert.ok(
  GATEWAY_WS_RETRY_DELAYS_MS[1] > GATEWAY_WS_RETRY_DELAYS_MS[0],
  "backoff grows, giving a cold instance time to finish booting"
);

const exhausted = decideGatewayRetry({
  failure: { kind: "unreachable", code: 1006, url: "https://gw.onrender.com" },
  attempt: GATEWAY_WS_ATTEMPTS,
});
assert.equal(
  exhausted.action,
  "fallback",
  "only once every attempt is spent does the session downgrade to serverless"
);
assert.ok(
  exhausted.action === "fallback" && exhausted.reason.includes("sleeps when idle"),
  "the downgrade says why, and that an always-on plan is the fix"
);
assert.ok(
  exhausted.action === "fallback" &&
    exhausted.reason.includes("The gateway at https://gw.onrender.com never answered 3"),
  "and names the gateway it could not reach"
);

// `message` is whatever the gateway said, not where it lives. Interpolating it as
// the URL produced "The gateway at Connection lost before handshake never
// answered…", so the two fields are kept apart and this pins that down.
const exhaustedWithNoise = decideGatewayRetry({
  failure: {
    kind: "unreachable",
    code: 1006,
    message: "Connection lost before handshake",
    url: "https://gw.onrender.com",
  },
  attempt: GATEWAY_WS_ATTEMPTS,
});
assert.ok(
  exhaustedWithNoise.action === "fallback" &&
    !exhaustedWithNoise.reason.includes("Connection lost before handshake"),
  "the server's error text is never mistaken for the gateway's address"
);
assert.ok(
  exhaustedWithNoise.action === "fallback" &&
    exhaustedWithNoise.reason.includes("The gateway at https://gw.onrender.com"),
  "the address still makes it into the sentence"
);

// No URL known (should not happen for a remote gateway, but must not print "at undefined").
const exhaustedNoUrl = decideGatewayRetry({
  failure: { kind: "unreachable", code: 1006 },
  attempt: GATEWAY_WS_ATTEMPTS,
});
assert.ok(
  exhaustedNoUrl.action === "fallback" &&
    exhaustedNoUrl.reason.startsWith("The gateway never answered"),
  "with no URL it says \"The gateway\", not \"The gateway at undefined\""
);

// A rejected token must never be retried: it would loop and never succeed. The
// messages below are the exact ones `src/lib/server/auth.ts` sends, so what the
// user sees is the gateway's own explanation, passed through untouched.
const WRONG_TOKEN =
  "Gateway token rejected: it doesn't match this gateway's SUSHI_GATEWAY_TOKEN. Copy the exact value from the gateway's .env into Sushi → Gateway settings.";
const MISSING_TOKEN =
  "This Sushi gateway requires its access token: enter the gateway's SUSHI_GATEWAY_TOKEN in Sushi → Gateway settings.";

const refused = decideGatewayRetry({
  failure: { kind: "refused", code: 1008, message: WRONG_TOKEN },
  attempt: 1,
});
assert.equal(refused.action, "fail", "a refused token fails instead of retrying");
assert.equal(
  refused.action === "fail" && refused.reason,
  WRONG_TOKEN,
  "the gateway's own explanation reaches the user verbatim, and names SUSHI_GATEWAY_TOKEN"
);

const missing = decideGatewayRetry({
  failure: { kind: "refused", code: 1008, message: MISSING_TOKEN },
  attempt: 1,
});
assert.equal(missing.action, "fail", "a missing token is not retried either");
assert.equal(
  missing.action === "fail" && missing.reason,
  MISSING_TOKEN,
  "and says to enter the token rather than blaming the network"
);

const silentRefusal = decideGatewayRetry({
  failure: { kind: "refused", code: 1008 },
  attempt: 1,
});
assert.equal(silentRefusal.action, "fail", "a refusal with no server text still fails");
assert.ok(
  silentRefusal.action === "fail" &&
    silentRefusal.reason.includes("SUSHI_GATEWAY_TOKEN") &&
    silentRefusal.reason.includes("Gateway settings"),
  "and Sushi supplies its own actionable sentence"
);

// The gateway being fine while the SSH host is down is not a gateway problem.
const reported = decideGatewayRetry({
  failure: {
    kind: "reported",
    code: 1006,
    message: "Could not reach 203.0.113.7:22 (connection timed out)",
  },
  attempt: 1,
});
assert.equal(reported.action, "fail", "an SSH-side failure is reported, not retried");
assert.ok(
  reported.action === "fail" && reported.reason.includes("203.0.113.7"),
  "the SSH failure is passed through verbatim instead of being blurred into a gateway error"
);

// ---- the countdown ----------------------------------------------------------
assert.equal(countdownSecondsLeft(5000, 0), 5, "a 5 s wait starts at 5");
assert.equal(countdownSecondsLeft(5000, 4200), 1, "it counts down");
assert.equal(countdownSecondsLeft(5000, 5000), 0, "0 means the retry is due");
assert.equal(countdownSecondsLeft(5000, 99999), 0, "it never goes negative");

async function main(): Promise<void> {
  // ---- waking a gateway over HTTP ---------------------------------------------
async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const CAPS = JSON.stringify({
  mode: "gateway",
  websocketSsh: true,
  sshTransport: "websocket",
  serverlessSshExec: false,
  serverlessSftp: false,
  rdpGuacd: false,
  rdpProbe: false,
  serverVault: false,
  requiresGatewayToken: true,
  nodeVersion: "v22.0.0",
});

// A virtual clock, so these tests exercise the real poll/await loop — including
// how many asks fit in the window — without anyone waiting through it.
function fakeClock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    elapsed: () => t - 1_000_000,
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
    },
  };
}

// Reading a probe answer: only the app's own replies prove it is awake.
assert.equal(probeHttpStatus("Gateway returned HTTP 502"), 502, "the status is read out of the probe error");
assert.equal(probeHttpStatus("fetch failed"), null, "a network failure has no status");
assert.equal(isAwakeProbe({ ok: true }), true, "capabilities answered = awake");
assert.equal(isAwakeProbe({ ok: false, error: "Gateway returned HTTP 404" }), true, "a 404 came from the app, so it is awake");
assert.equal(isAwakeProbe({ ok: false, error: "Gateway returned HTTP 401" }), true, "an auth rejection still means the process is up");
assert.equal(
  isAwakeProbe({ ok: false, error: "Gateway returned HTTP 502" }),
  false,
  "a 502 is the platform's proxy answering while the instance boots — not awake"
);
assert.equal(isAwakeProbe({ ok: false, error: "fetch failed" }), false, "refused = not awake");

// An awake gateway answers on the first ask.
await withServer(
  (req, res) => {
    if (req.url === "/api/system/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(CAPS);
      return;
    }
    res.writeHead(404).end();
  },
  async (baseUrl) => {
    const { waits, clock } = fakeClock();
    const woke = await wakeGateway({ gatewayUrl: baseUrl, gatewayToken: "tok" }, 20000, { pollMs: 2000, clock: clock });
    assert.equal(woke.awake, true, "a gateway that answers capabilities is awake");
    assert.equal(woke.timedOut, false, "and did not time out");
    assert.equal(woke.probes, 1, "one ask was enough");
    assert.deepEqual(waits, [], "so it never slept");
  }
);

// A gateway that answers but not with capabilities (a full Sushi instance whose
// Next.js app 404s the route, or an auth rejection): still awake.
await withServer(
  (_req, res) => res.writeHead(404, { "Content-Type": "application/json" }).end("{}"),
  async (baseUrl) => {
    const { clock } = fakeClock();
    const woke = await wakeGateway({ gatewayUrl: baseUrl, gatewayToken: "" }, 20000, { pollMs: 2000, clock });
    assert.equal(woke.awake, true, "any 4xx answer means the process is up, so it counts as awake");
    assert.equal(woke.probes, 1, "and stops asking immediately");
  }
);

// THE COLD BOOT: 502s from the proxy while the instance starts, then answers.
// This is the exact Render-free sequence the old single-shot warm-up gave up on
// in milliseconds.
await withServer(
  (() => {
    let hits = 0;
    return (_req, res) => {
      hits += 1;
      if (hits < 4) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(CAPS);
    };
  })(),
  async (baseUrl) => {
    const { waits, clock } = fakeClock();
    const seen: number[] = [];
    const woke = await wakeGateway({ gatewayUrl: baseUrl, gatewayToken: "tok" }, 20000, {
      pollMs: 2000,
      clock,
      onProbe: (info) => seen.push(info.probe),
    });
    assert.equal(woke.awake, true, "it waits out the 502s and reports the gateway awake once it boots");
    assert.equal(woke.probes, 4, "having asked once per poll interval");
    assert.deepEqual(waits, [2000, 2000, 2000], "sleeping the poll interval between asks");
    assert.deepEqual(
      seen,
      [1, 2, 3],
      "it reports progress after every unsuccessful ask, but not after the one that worked"
    );
  }
);

// Still cold when the window runs out: not an error, and reported as a timeout.
await withServer(
  (_req, res) => res.writeHead(502).end("Bad Gateway"),
  async (baseUrl) => {
    const { waits, clock, elapsed } = fakeClock();
    const woke = await wakeGateway({ gatewayUrl: baseUrl, gatewayToken: "" }, 6000, { pollMs: 2000, clock: clock });
    assert.equal(woke.awake, false, "never booted inside the window");
    assert.equal(woke.timedOut, true, "and is reported as a timeout, not a plain failure");
    // 6 s window / 2 s poll: asks at 0 s, 2 s and 4 s, then the window is spent.
    assert.equal(woke.probes, 3, "it kept asking for the whole window");
    assert.ok(woke.error && /HTTP 502/.test(woke.error), "the reason names what answered");
    assert.ok(woke.error && /asked 3 times/.test(woke.error), "and how hard Sushi tried");
    assert.equal(waits.reduce((a, b) => a + b, 0) <= 6000, true, "without sleeping past the window");
    assert.equal(elapsed() <= 6000, true, "and stopping when the window closed, not before");
  }
);

// A server that accepts the socket and then says nothing: a hung request must not
// eat the whole window, leaving no time to re-ask. Capped at 2 asks because each
// one really waits out the 8 s per-probe abort — the point is that it re-asks at
// all, not how many times.
await withServer(
  (_req, _res) => {
    /* never respond */
  },
  async (baseUrl) => {
    const { waits, clock } = fakeClock();
    const woke = await wakeGateway({ gatewayUrl: baseUrl, gatewayToken: "" }, 60_000, { pollMs: 2000, clock: clock, maxProbes: 2 });
    assert.equal(woke.awake, false, "a server that never answers is not awake");
    assert.equal(woke.timedOut, true, "and is reported as a timeout");
    assert.equal(woke.probes, 2, "it re-asked instead of spending the window on one hung request");
    assert.equal(waits.length, 1, "sleeping between the two");
    assert.ok(woke.error && /sleeps when idle/.test(woke.error), "the timeout says what to do about it");
  }
);

// Nothing listening at all (refused): not awake.
{
  const { waits, clock } = fakeClock();
  const woke = await wakeGateway({ gatewayUrl: "http://127.0.0.1:1", gatewayToken: "" }, 4000, { pollMs: 1000, clock: clock });
  assert.equal(woke.awake, false, "a refused connection is not awake");
  assert.equal(woke.timedOut, true, "it kept asking until the window closed");
  assert.ok(woke.probes >= 2, "refusals are instant, so several asks fit in the window");
  assert.ok(woke.error, "and carries a reason");
}

// No gateway configured: nothing to wake, and it must not throw or poll.
{
  const { waits, clock } = fakeClock();
  const woke = await wakeGateway({ gatewayUrl: "", gatewayToken: "" }, 500, { pollMs: 100, clock: clock });
  assert.deepEqual(
    woke,
    { awake: false, timedOut: false, probes: 0 },
    "same-origin Sushi has no gateway to warm, so the warm-up is a no-op"
  );
  assert.deepEqual(waits, [], "and never sleeps");
}

assert.ok(GATEWAY_WAKE_TIMEOUT_MS >= 15000, "the warm-up window is long enough to sit through a cold boot");
assert.ok(
  GATEWAY_WAKE_POLL_MS >= 1000 && GATEWAY_WAKE_POLL_MS <= 5000,
  "polls often enough to notice the boot promptly, rarely enough not to hammer it"
);
assert.ok(
  GATEWAY_WAKE_POLL_MS < GATEWAY_WAKE_TIMEOUT_MS,
  "the window fits more than one ask, otherwise polling would be pointless"
);

// Refusals and 502s come back in milliseconds, so the time window alone would let
// the loop hammer a sleeping endpoint. The cap is what actually bounds it.
await withServer(
  (_req, res) => res.writeHead(502).end("Bad Gateway"),
  async (baseUrl) => {
    const { waits, clock, elapsed } = fakeClock();
    const woke = await wakeGateway(
      { gatewayUrl: baseUrl, gatewayToken: "" },
      600_000, // a 10-minute window
      {
        pollMs: 1, // and effectively no politeness delay
        clock,
        maxProbes: 8,
      }
    );
    assert.equal(woke.awake, false, "still cold");
    assert.equal(woke.probes, 8, "it stopped at the cap instead of looping for the whole window");
    assert.equal(waits.length, 7, "one sleep between each pair of asks, none after the last");
    assert.equal(elapsed(), 7, "so the window was nowhere near exhausted");
  }
);
assert.ok(
  GATEWAY_WAKE_MAX_PROBES * GATEWAY_WAKE_POLL_MS >= GATEWAY_WAKE_TIMEOUT_MS,
  "the cap is high enough that the time window, not the cap, ends a normal warm-up"
);

// pollMs of 0 means "ask once", and must never become a hot loop.
await withServer(
  (_req, res) => res.writeHead(502).end("Bad Gateway"),
  async (baseUrl) => {
    const { waits, clock } = fakeClock();
    const woke = await wakeGateway({ gatewayUrl: baseUrl, gatewayToken: "" }, 60_000, { pollMs: 0, clock: clock });
    assert.equal(woke.probes, 1, "with no poll interval it asks exactly once");
    assert.deepEqual(waits, [], "and never sleeps");
  }
);
assert.equal(typeof realClock.now(), "number", "the production clock is real time");

// ---- the terminal actually uses the policy ----------------------------------
  // The behaviour above is only worth anything if the connect path calls it.
  const terminal = read("src/components/SshTerminalSession.tsx");
  assert.ok(
    terminal.includes("await wakeGateway(gatewaySettings, GATEWAY_WAKE_TIMEOUT_MS"),
    "the terminal warms the gateway before the first handshake"
  );
  assert.ok(
    terminal.includes("onProbe:"),
    "and reports progress while it waits, so a long cold boot never looks like a hang"
  );
  assert.ok(
    terminal.includes("Waking the gateway\u2026"),
    "with a line the user can actually read"
  );
  assert.ok(
    terminal.includes("decideGatewayRetry({ failure, attempt })"),
    "a failed handshake goes through the retry decision"
  );
  assert.ok(
    terminal.includes("classifyGatewayClose("),
    "the close event is classified instead of being guessed at inline"
  );
  assert.ok(
    terminal.includes("url: resolveGatewayHttpBase(gatewaySettings.gatewayUrl)"),
    "the failure carries the gateway's address separately from its error text"
  );
  assert.ok(
    terminal.includes("countdownSecondsLeft("),
    "the retry countdown is shown to the user"
  );
  assert.ok(
    terminal.includes("stopGatewayTimers?.()"),
    "unmounting cancels a pending gateway retry"
  );
  // The old behaviour was one attempt and a silent downgrade on any failure.
  assert.ok(
    !terminal.includes("Could not reach the VPS gateway WebSocket"),
    "the single-attempt downgrade message is gone"
  );
  assert.ok(
    !/usingRemoteGateway && \(event\.code === 1008 \|\| !gotServerMessage\)/.test(terminal),
    "the old inline 1008-or-silence fallback is gone"
  );
  // A same-origin /ws/ssh has nothing to wake and nothing to retry.
  assert.ok(
    terminal.includes("if (!usingRemoteGateway) {"),
    "same-origin Sushi still falls straight back to the serverless shell"
  );
}

void main().then(
  () => console.log("Gateway wake-up and retry policy tests passed."),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
