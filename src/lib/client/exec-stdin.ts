/**
 * Streaming request bodies let Sushi turn one `POST /api/ssh/exec` into a real
 * two-way channel: the response streams stdout/stderr while the request body
 * carries keystrokes for the running command (so `[Y/n]`, passphrase and sudo
 * prompts can be answered on Vercel, where there is no long-lived PTY).
 *
 * Chromium supports this with `fetch(..., { duplex: "half" })`. Browsers that do
 * not support it must fall back to the plain JSON body (output only), which is why
 * the capability is detected instead of assumed.
 */

type DuplexRequestInit = RequestInit & { duplex?: "half" };

let cachedSupport: boolean | null = null;

/**
 * Chromium only allows streaming request bodies over HTTP/2 (or HTTP/3): over
 * HTTP/1.1 it aborts the request with ERR_H2_OR_QUIC_REQUIRED. Vercel serves HTTPS
 * with h2, so the feature works there; a plain-HTTP/1.1 origin (or an HTTPS proxy
 * that downgrades to 1.1) has to fall back to fire-and-run execs.
 */
export function streamingTransportAvailable(): boolean {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
    return true; // unknown — let the request itself decide (see execServerless fallback)
  }
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | (PerformanceEntry & { nextHopProtocol?: string })
      | undefined;
    const protocol = nav?.nextHopProtocol || "";
    if (!protocol) return true;
    return protocol.startsWith("h2") || protocol.startsWith("h3");
  } catch {
    return true;
  }
}

/** True when keystrokes can actually reach a running command on this page. */
export function canStreamExecStdin(): boolean {
  return supportsStreamingRequestBody() && streamingTransportAvailable();
}

/**
 * True when this browser can send a `ReadableStream` as a fetch request body.
 *
 * The probe rejects an engine for either of two reasons, both of which are checked
 * without any network traffic:
 *
 *  - constructing the Request throws (Chromium < 105: "duplex option is required");
 *  - the engine silently ignores `duplex`, i.e. it has no support for request
 *    streams at all. Firefox does exactly this and then fails at fetch time with
 *    "ReadableStream uploading is not supported"; Safari behaves the same way for
 *    a request body it cannot stream. Requiring `request.duplex === "half"` keeps
 *    those browsers on the plain JSON path instead of surfacing that error.
 */
export function supportsStreamingRequestBody(): boolean {
  if (cachedSupport !== null) return cachedSupport;
  if (typeof window === "undefined" || typeof ReadableStream === "undefined") {
    cachedSupport = false;
    return false;
  }
  let probeBody: ReadableStream<Uint8Array> | null = null;
  try {
    probeBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const init: DuplexRequestInit = {
      method: "POST",
      body: probeBody,
      duplex: "half",
    };
    const request = new Request("http://localhost/", init) as Request & {
      duplex?: string;
    };
    cachedSupport = request.duplex === "half";
  } catch {
    cachedSupport = false;
  } finally {
    // Never leave the probe stream dangling.
    void probeBody?.cancel().catch(() => {});
  }
  return cachedSupport;
}

/** Overrides the cached capability result (tests only). */
export function __setStreamingRequestBodySupport(value: boolean | null): void {
  cachedSupport = value;
}

export interface ExecStdinChannel {
  /** True when keystrokes actually reach the remote command. */
  readonly canSendInput: boolean;
  /** Writes bytes to the command's stdin. Returns false once it is closed. */
  sendInput: (data: string) => boolean;
  /** Delivers SIGINT/SIGTERM to the remote command. */
  sendSignal: (signal: "INT" | "TERM") => boolean;
  /** Ends the request body (the command keeps running until it exits). */
  close: () => void;
}

/**
 * Builds a chunked NDJSON request body: the `start` line first, then every
 * keystroke as its own line. The stream stays open for the command's lifetime.
 */
export function createExecRequestBody(
  startPayload: Record<string, unknown>
): { body: ReadableStream<Uint8Array>; channel: ExecStdinChannel } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(
        encoder.encode(`${JSON.stringify({ type: "start", payload: startPayload })}\n`)
      );
    },
    cancel() {
      closed = true;
    },
  });

  const enqueue = (payload: Record<string, unknown>): boolean => {
    if (closed || !controller) return false;
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  return {
    body,
    channel: {
      canSendInput: true,
      sendInput: (data) => (data ? enqueue({ type: "input", data }) : true),
      sendSignal: (signal) => enqueue({ type: "signal", signal }),
      close: () => {
        if (closed || !controller) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed / cancelled
        }
      },
    },
  };
}
