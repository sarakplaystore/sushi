import { canStreamExecStdin } from "./exec-stdin";
import { type GatewaySettings, getAuthHeaders } from "./gateway";

export const SERVERLESS_RDP_WS_ORIGIN = "wss://sushi-rdp-http.internal";

interface ServerlessRdpSessionConfig {
  streamUrl: string;
  inputUrl: string;
  headers: Record<string, string>;
  ignoreCert: boolean;
  forceSplitStream?: boolean;
  preferDuplex?: boolean;
}

const pendingConfigs = new Map<string, ServerlessRdpSessionConfig>();

function randomSessionId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let out = "rdpsess_";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function encodeLengthPrefixedFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.byteLength, false);
  out.set(payload, 4);
  return out;
}

class ClientFrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    if (this.buffer.byteLength === 0) {
      this.buffer = new Uint8Array(chunk);
    } else {
      const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.byteLength);
      this.buffer = merged;
    }

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= 4) {
      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + offset,
        4
      );
      const len = view.getUint32(0, false);
      if (len > 16 * 1024 * 1024) {
        throw new Error(`Invalid RDP frame length: ${len}`);
      }
      if (this.buffer.byteLength - offset < 4 + len) {
        break;
      }
      frames.push(this.buffer.slice(offset + 4, offset + 4 + len));
      offset += 4 + len;
    }

    if (offset > 0) {
      this.buffer =
        offset === this.buffer.byteLength
          ? new Uint8Array(0)
          : this.buffer.slice(offset);
    }
    return frames;
  }
}

function makeCloseEvent(code: number, reason: string): Event {
  if (typeof CloseEvent === "function") {
    return new CloseEvent("close", {
      code,
      reason,
      wasClean: code === 1000,
    });
  }
  const ev = new Event("close") as Event & {
    code: number;
    reason: string;
    wasClean: boolean;
  };
  ev.code = code;
  ev.reason = reason;
  ev.wasClean = code === 1000;
  return ev;
}

async function normalizeOutboundPayload(
  data: string | ArrayBufferLike | Blob | ArrayBufferView
): Promise<Uint8Array> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (
    data instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)
  ) {
    return new Uint8Array(data.slice(0));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error("Unsupported WebSocket frame type for RDP transport");
}

export class SushiServerlessRdpWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  readyState: number = SushiServerlessRdpWebSocket.CONNECTING;

  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: Event) => unknown) | null = null;

  private readonly sessionId: string;
  private readonly cfg: ServerlessRdpSessionConfig;
  private readonly abortController = new AbortController();

  private started = false;
  private mode: "duplex" | "split" | null = null;
  private duplexController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private preModeQueue: Uint8Array[] = [];
  private sendChain: Promise<void> = Promise.resolve();

  // Split-stream batching state
  private splitReady = false;
  private splitBatch: string[] = [];
  private splitFlushing = false;
  private splitSeq = 0;

  constructor(url: string) {
    super();
    this.url = url;
    const parsed = new URL(url);
    const id = parsed.pathname.replace(/^\/+/, "");
    const found = pendingConfigs.get(id);
    pendingConfigs.delete(id);
    if (!found) {
      throw new Error("Missing serverless RDP transport configuration");
    }
    this.sessionId = id;
    this.cfg = found;

    this.addEventListener("open", (e) => this.onopen?.(e));
    this.addEventListener("message", (e) => this.onmessage?.(e as MessageEvent));
    this.addEventListener("error", (e) => this.onerror?.(e));
    this.addEventListener("close", (e) => this.onclose?.(e));

    queueMicrotask(() => {
      if (this.readyState !== SushiServerlessRdpWebSocket.CONNECTING) return;
      this.readyState = SushiServerlessRdpWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== SushiServerlessRdpWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sendChain = this.sendChain
      .then(async () => {
        if (this.readyState !== SushiServerlessRdpWebSocket.OPEN) return;
        const bytes = await normalizeOutboundPayload(data);
        if (this.readyState !== SushiServerlessRdpWebSocket.OPEN) return;
        this.dispatchOutboundBytes(bytes);
      })
      .catch(() => {
        this.failAndClose(1006, "Failed to serialize outbound RDP frame");
      });
  }

  private dispatchOutboundBytes(bytes: Uint8Array): void {
    if (!this.started) {
      this.started = true;
      void this.startTransport(bytes);
      return;
    }

    if (this.mode === null) {
      this.preModeQueue.push(bytes);
      return;
    }

    if (this.mode === "duplex") {
      try {
        this.duplexController?.enqueue(encodeLengthPrefixedFrame(bytes));
      } catch {
        this.failAndClose(1006, "RDP stream closed");
      }
      return;
    }

    this.enqueueSplitFrame(bytes);
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === SushiServerlessRdpWebSocket.CLOSING ||
      this.readyState === SushiServerlessRdpWebSocket.CLOSED
    ) {
      return;
    }
    this.readyState = SushiServerlessRdpWebSocket.CLOSING;
    try {
      this.duplexController?.close();
    } catch {
      // ignore
    }
    this.duplexController = null;
    this.abortController.abort();
    this.readyState = SushiServerlessRdpWebSocket.CLOSED;
    this.dispatchEvent(makeCloseEvent(code, reason));
  }

  private async startTransport(firstFrame: Uint8Array): Promise<void> {
    // Vercel Serverless / AWS Lambda buffers incoming HTTP request bodies until END_STREAM,
    // which hangs open-ended `duplex: "half"` request streams in Chromium. Default straight
    // to Split-Stream (`POST /api/rdp/stream` JSON + `POST /api/rdp/input` JSON), which starts
    // immediately on Vercel, Cloudflare, Safari, Firefox, and Chromium alike.
    const tryDuplex =
      Boolean(this.cfg.preferDuplex) &&
      !this.cfg.forceSplitStream &&
      canStreamExecStdin();

    if (tryDuplex) {
      try {
        await this.startDuplexStream(firstFrame);
        return;
      } catch {
        if (this.readyState !== SushiServerlessRdpWebSocket.OPEN) return;
        this.duplexController = null;
      }
    }

    await this.startSplitStream(firstFrame);
  }

  private async startDuplexStream(firstFrame: Uint8Array): Promise<void> {
    const ctrlBox: { current: ReadableStreamDefaultController<Uint8Array> | null } = {
      current: null,
    };
    const reqBody = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrlBox.current = controller;
        controller.enqueue(encodeLengthPrefixedFrame(firstFrame));
      },
    });

    const duplexAbort = new AbortController();
    const onSessionAbort = () => duplexAbort.abort();
    this.abortController.signal.addEventListener("abort", onSessionAbort, { once: true });
    let timedOut = false;
    const startWatchdog = setTimeout(() => {
      timedOut = true;
      duplexAbort.abort();
    }, 2500);

    const streamUrlWithQuery = this.appendIgnoreCert(this.cfg.streamUrl);
    const reqInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        ...this.cfg.headers,
        "Content-Type": "application/octet-stream",
      },
      body: reqBody,
      duplex: "half",
      signal: duplexAbort.signal,
      cache: "no-store",
    };

    let res: Response;
    try {
      res = await fetch(streamUrlWithQuery, reqInit);
    } catch (err) {
      clearTimeout(startWatchdog);
      this.abortController.signal.removeEventListener("abort", onSessionAbort);
      try {
        ctrlBox.current?.close();
      } catch {
        // ignore
      }
      if (timedOut) {
        throw new Error("Duplex request body buffered by server proxy");
      }
      throw err;
    }
    clearTimeout(startWatchdog);
    if (!res.ok || !res.body) {
      this.abortController.signal.removeEventListener("abort", onSessionAbort);
      try {
        ctrlBox.current?.close();
      } catch {
        // ignore
      }
      if (res.status === 401 || res.status === 403) {
        this.failAndClose(1008, `HTTP ${res.status}`);
        return;
      }
      throw new Error(`Duplex stream HTTP ${res.status}`);
    }

    this.duplexController = ctrlBox.current;
    this.mode = "duplex";
    while (this.preModeQueue.length > 0) {
      const queued = this.preModeQueue.shift()!;
      this.duplexController?.enqueue(encodeLengthPrefixedFrame(queued));
    }

    void this.pumpResponseStream(res.body);
  }

  private async startSplitStream(firstFrame: Uint8Array): Promise<void> {
    this.mode = "split";
    try {
      const res = await fetch(this.cfg.streamUrl, {
        method: "POST",
        headers: {
          ...this.cfg.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          firstFrame: bytesToBase64(firstFrame),
          ignoreCert: this.cfg.ignoreCert,
        }),
        signal: this.abortController.signal,
        cache: "no-store",
      });

      if (!res.ok || !res.body) {
        this.failAndClose(
          res.status === 401 ? 1008 : 1006,
          `RDP stream HTTP ${res.status}`
        );
        return;
      }

      this.splitReady = true;
      while (this.preModeQueue.length > 0) {
        this.enqueueSplitFrame(this.preModeQueue.shift()!);
      }
      void this.flushSplitBatch();
      void this.pumpResponseStream(res.body);
    } catch {
      this.failAndClose(1006, "Failed to establish serverless RDP stream");
    }
  }

  private enqueueSplitFrame(frame: Uint8Array): void {
    this.splitBatch.push(bytesToBase64(frame));
    if (this.splitReady && !this.splitFlushing) {
      void this.flushSplitBatch();
    }
  }

  private async flushSplitBatch(): Promise<void> {
    if (this.splitFlushing || !this.splitReady) return;
    this.splitFlushing = true;
    try {
      while (
        this.splitBatch.length > 0 &&
        this.readyState === SushiServerlessRdpWebSocket.OPEN
      ) {
        const frames = this.splitBatch.splice(0, 64);
        const seq = this.splitSeq++;
        const payload = JSON.stringify({
          action: "input",
          sessionId: this.sessionId,
          seq,
          frames,
        });

        let ok = false;
        let lastStatus = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(this.cfg.inputUrl, {
              method: "POST",
              headers: {
                ...this.cfg.headers,
                "Content-Type": "application/json",
              },
              body: payload,
              signal: this.abortController.signal,
              cache: "no-store",
            });
            lastStatus = res.status;
            if (res.ok) {
              ok = true;
              break;
            }
            if (res.status < 500 || attempt === 1) break;
          } catch {
            if (
              attempt === 1 ||
              this.readyState !== SushiServerlessRdpWebSocket.OPEN
            ) {
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 150));
        }

        if (!ok) {
          if (this.readyState === SushiServerlessRdpWebSocket.OPEN) {
            this.failAndClose(
              lastStatus === 401 ? 1008 : 1006,
              lastStatus ? `RDP input HTTP ${lastStatus}` : "RDP input stream interrupted"
            );
          }
          return;
        }
      }
    } finally {
      this.splitFlushing = false;
    }
  }

  private async pumpResponseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new ClientFrameDecoder();
    try {
      while (this.readyState === SushiServerlessRdpWebSocket.OPEN) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        const frames = decoder.push(value);
        for (const frame of frames) {
          if (frame.byteLength === 0) {
            // Heartbeat keepalive frame
            continue;
          }
          const copy = new Uint8Array(frame.byteLength);
          copy.set(frame);
          const msgData =
            this.binaryType === "blob"
              ? new Blob([copy])
              : copy.buffer;
          this.dispatchEvent(new MessageEvent("message", { data: msgData }));
        }
      }
      if (this.readyState === SushiServerlessRdpWebSocket.OPEN) {
        try {
          this.duplexController?.close();
        } catch {
          // ignore
        }
        this.duplexController = null;
        this.abortController.abort();
        this.readyState = SushiServerlessRdpWebSocket.CLOSED;
        this.dispatchEvent(makeCloseEvent(1000, "Stream ended"));
      }
    } catch {
      if (this.readyState === SushiServerlessRdpWebSocket.OPEN) {
        this.failAndClose(1006, "RDP stream read error");
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private appendIgnoreCert(baseUrl: string): string {
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}ignoreCert=${this.cfg.ignoreCert ? "1" : "0"}`;
  }

  private failAndClose(code: number, reason: string): void {
    if (this.readyState === SushiServerlessRdpWebSocket.CLOSED) return;
    try {
      this.duplexController?.close();
    } catch {
      // ignore
    }
    this.duplexController = null;
    this.abortController.abort();
    this.readyState = SushiServerlessRdpWebSocket.CLOSED;
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(makeCloseEvent(code, reason));
  }
}

export function installServerlessRdpWebSocketShim(): void {
  const g = globalThis as Record<string, unknown>;
  const current = g.WebSocket as
    | (typeof WebSocket & { __sushiServerlessRdpShim?: boolean })
    | undefined;
  if (!current || current.__sushiServerlessRdpShim) return;

  const NativeWebSocket = current;

  const ShimmedWebSocket = new Proxy(NativeWebSocket, {
    construct(target, argArray, newTarget) {
      const rawUrl = String(argArray[0] ?? "");
      if (rawUrl.startsWith(`${SERVERLESS_RDP_WS_ORIGIN}/`)) {
        return new SushiServerlessRdpWebSocket(rawUrl);
      }
      return Reflect.construct(target, argArray, newTarget);
    },
  }) as typeof WebSocket & { __sushiServerlessRdpShim?: boolean };

  ShimmedWebSocket.__sushiServerlessRdpShim = true;
  g.WebSocket = ShimmedWebSocket;
}

export function buildServerlessRdpProxyUrl(params: {
  httpBase?: string;
  gatewaySettings: GatewaySettings;
  ignoreCert?: boolean;
  forceSplitStream?: boolean;
  preferDuplex?: boolean;
  inputPath?: string;
}): string {
  installServerlessRdpWebSocketShim();
  const base = (params.httpBase || "").replace(/\/+$/, "");
  const sessionId = randomSessionId();
  pendingConfigs.set(sessionId, {
    streamUrl: `${base}/api/rdp/stream`,
    inputUrl: `${base}${params.inputPath || "/api/rdp/stream"}`,
    headers: getAuthHeaders(params.gatewaySettings),
    ignoreCert: params.ignoreCert !== false,
    forceSplitStream: params.forceSplitStream,
    preferDuplex: params.preferDuplex,
  });
  return `${SERVERLESS_RDP_WS_ORIGIN}/${sessionId}`;
}
