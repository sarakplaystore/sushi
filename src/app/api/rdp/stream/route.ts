import type tls from "node:tls";
import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import {
  buildRDCleanPathError,
  buildRDCleanPathResponse,
  encodeRdpStreamFrame,
  isValidRdpSessionId,
  mapErrorToRDCleanPathDetails,
  parseRDCleanPathRequest,
  performRDCleanPathHandshake,
  RdpFrameDecoder,
  registerRdpHttpTunnel,
} from "@/lib/server/rdcleanpath";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401, headers: cors }
    );
  }

  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  const isJsonSplitMode = contentType.includes("application/json");
  const url = new URL(req.url);
  const queryIgnoreCert = url.searchParams.get("ignoreCert");

  if (isJsonSplitMode) {
    let body: {
      sessionId?: string;
      firstFrame?: string;
      ignoreCert?: boolean;
    };
    try {
      body = (await req.json()) as {
        sessionId?: string;
        firstFrame?: string;
        ignoreCert?: boolean;
      };
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400, headers: cors }
      );
    }

    if (!isValidRdpSessionId(body.sessionId) || typeof body.firstFrame !== "string") {
      return NextResponse.json(
        { error: "Missing valid sessionId or firstFrame." },
        { status: 400, headers: cors }
      );
    }

    const sessionId = body.sessionId;
    const firstFrameBuf = Buffer.from(body.firstFrame, "base64");
    const ignoreCert =
      typeof body.ignoreCert === "boolean"
        ? body.ignoreCert
        : queryIgnoreCert !== "0";

    let activeTls: tls.TLSSocket | null = null;
    let tunnelReg: { dispose: () => void } | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const cleanup = (controller?: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      closed = true;
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      tunnelReg?.dispose();
      tunnelReg = null;
      if (activeTls && !activeTls.destroyed) {
        activeTls.destroy();
      }
      if (controller) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const earlyFrames: Buffer[] = [];
        tunnelReg = registerRdpHttpTunnel({
          sessionId,
          username: auth.username || "admin",
          writeFrames: (frames) => {
            for (const f of frames) {
              if (activeTls && !activeTls.destroyed) {
                activeTls.write(f);
              } else {
                earlyFrames.push(f);
              }
            }
          },
          close: () => cleanup(controller),
        });

        req.signal.addEventListener("abort", () => cleanup(controller), { once: true });

        // Flush HTTP 200 response headers immediately on Vercel Serverless / Edge proxies
        // before TCP + TLS negotiation to the target RDP host even finishes.
        try {
          controller.enqueue(new Uint8Array(encodeRdpStreamFrame(Buffer.alloc(0))));
        } catch {
          cleanup(controller);
          return;
        }

        try {
          const parsedReq = parseRDCleanPathRequest(firstFrameBuf);
          const hs = await performRDCleanPathHandshake(
            parsedReq.destination,
            parsedReq.x224ConnectionRequest,
            { ignoreCert }
          );
          if (closed) {
            hs.tlsSocket?.destroy();
            return;
          }

          const responsePdu = buildRDCleanPathResponse({
            serverAddr: hs.serverAddr,
            x224Response: hs.x224Response,
            certChain: hs.certChain,
          });
          controller.enqueue(new Uint8Array(encodeRdpStreamFrame(responsePdu)));

          if (!hs.tlsSocket) {
            cleanup(controller);
            return;
          }

          activeTls = hs.tlsSocket;
          activeTls.on("data", (chunk: Buffer) => {
            if (closed) return;
            try {
              controller.enqueue(new Uint8Array(encodeRdpStreamFrame(chunk)));
            } catch {
              cleanup(controller);
            }
          });
          activeTls.on("end", () => cleanup(controller));
          activeTls.on("close", () => cleanup(controller));
          activeTls.on("error", () => cleanup(controller));

          while (earlyFrames.length > 0) {
            const queued = earlyFrames.shift()!;
            if (!activeTls.destroyed) {
              activeTls.write(queued);
            }
          }

          keepAliveTimer = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(new Uint8Array(encodeRdpStreamFrame(Buffer.alloc(0))));
            } catch {
              cleanup(controller);
            }
          }, 20_000);
        } catch (err) {
          if (!closed) {
            try {
              const errPdu = buildRDCleanPathError(mapErrorToRDCleanPathDetails(err));
              controller.enqueue(new Uint8Array(encodeRdpStreamFrame(errPdu)));
            } catch {
              // ignore
            }
          }
          cleanup(controller);
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // Full-duplex streaming mode (`fetch(..., { body: ReadableStream, duplex: "half" })`).
  if (!req.body) {
    return NextResponse.json(
      { error: "Missing streaming request body." },
      { status: 400, headers: cors }
    );
  }

  const ignoreCert = queryIgnoreCert !== "0";
  const reqReader = req.body.getReader();

  let activeTls: tls.TLSSocket | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const cleanup = (controller?: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (activeTls && !activeTls.destroyed) {
      activeTls.destroy();
    }
    void reqReader.cancel().catch(() => {});
    if (controller) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      req.signal.addEventListener("abort", () => cleanup(controller), { once: true });

      keepAliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(encodeRdpStreamFrame(Buffer.alloc(0))));
        } catch {
          cleanup(controller);
        }
      }, 20_000);

      void (async () => {
        const decoder = new RdpFrameDecoder();
        let handshakeDone = false;

        try {
          while (!closed) {
            const { value, done } = await reqReader.read();
            if (done) {
              cleanup(controller);
              return;
            }
            if (!value || value.byteLength === 0) continue;

            const frames = decoder.push(value);
            for (const frame of frames) {
              if (frame.length === 0) continue;

              if (!handshakeDone) {
                handshakeDone = true;
                const parsedReq = parseRDCleanPathRequest(frame);
                const hs = await performRDCleanPathHandshake(
                  parsedReq.destination,
                  parsedReq.x224ConnectionRequest,
                  { ignoreCert }
                );
                if (closed) {
                  hs.tlsSocket?.destroy();
                  return;
                }

                const responsePdu = buildRDCleanPathResponse({
                  serverAddr: hs.serverAddr,
                  x224Response: hs.x224Response,
                  certChain: hs.certChain,
                });
                controller.enqueue(new Uint8Array(encodeRdpStreamFrame(responsePdu)));

                if (!hs.tlsSocket) {
                  cleanup(controller);
                  return;
                }

                activeTls = hs.tlsSocket;
                activeTls.on("data", (chunk: Buffer) => {
                  if (closed) return;
                  try {
                    controller.enqueue(new Uint8Array(encodeRdpStreamFrame(chunk)));
                  } catch {
                    cleanup(controller);
                  }
                });
                activeTls.on("end", () => cleanup(controller));
                activeTls.on("close", () => cleanup(controller));
                activeTls.on("error", () => cleanup(controller));
                continue;
              }

              if (activeTls && !activeTls.destroyed) {
                activeTls.write(frame);
              }
            }
          }
        } catch (err) {
          if (!closed && !handshakeDone) {
            // Error while decoding or before handshake finished
            try {
              const errPdu = buildRDCleanPathError(mapErrorToRDCleanPathDetails(err));
              controller.enqueue(new Uint8Array(encodeRdpStreamFrame(errPdu)));
            } catch {
              // ignore
            }
          } else if (!closed && !activeTls) {
            try {
              const errPdu = buildRDCleanPathError(mapErrorToRDCleanPathDetails(err));
              controller.enqueue(new Uint8Array(encodeRdpStreamFrame(errPdu)));
            } catch {
              // ignore
            }
          }
          cleanup(controller);
        }
      })();
    },
    cancel() {
      cleanup();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
