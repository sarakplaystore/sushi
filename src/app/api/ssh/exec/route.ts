import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { connectSsh, shellQuote } from "@/lib/server/ssh-client";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

const META_REGEX = /\r?\n?\x1b\]777;SUSHI_META;(-?\d+);([^\x07]*)\x07/;

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let body: {
    credentials?: ConnectionCredentials;
    command?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400, headers: cors }
    );
  }

  const creds = body.credentials;
  const command = body.command ?? "";
  if (!creds?.host || !creds?.username) {
    return NextResponse.json(
      { ok: false, error: "SSH host and username are required." },
      { status: 400, headers: cors }
    );
  }

  const cols = Math.max(40, Math.min(300, Number(body.cols || 100)));
  const rows = Math.max(10, Math.min(120, Number(body.rows || 30)));
  const cwd = body.cwd?.trim() || "";

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const sendEvent = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload) + "\n"));
        } catch {
          closed = true;
        }
      };

      let session: Awaited<ReturnType<typeof connectSsh>> | null = null;

      const onAbort = () => {
        closed = true;
        session?.client.destroy();
      };
      req.signal.addEventListener("abort", onAbort, { once: true });

      try {
        session = await connectSsh(creds, 14000);
        sendEvent({
          type: "ready",
          fingerprint: session.fingerprint,
          banner: session.serverBanner,
        });

        const cdPrefix =
          cwd && cwd !== "~" ? `cd -- ${shellQuote(cwd)} 2>/dev/null || true\n` : "";

        const wrappedScript = [
          cdPrefix + (command.trim() ? command : ":"),
          "__sushi_ec=$?",
          'printf "\\n\\033]777;SUSHI_META;%s;%s\\007" "$__sushi_ec" "$(pwd)"',
          "exit $__sushi_ec",
        ].join("\n");

        await new Promise<void>((resolve) => {
          session!.client.exec(
            wrappedScript,
            { pty: { term: "xterm-256color", cols, rows } },
            (err, ch) => {
              if (err) {
                sendEvent({ type: "error", message: err.message });
                resolve();
                return;
              }

              let carry = "";
              let parsedMeta = false;

              const flushText = (text: string) => {
                if (!text) return;
                sendEvent({
                  type: "data",
                  data: Buffer.from(text, "utf8").toString("base64"),
                });
              };

              ch.on("data", (chunk: Buffer) => {
                carry += chunk.toString("utf8");
                const match = META_REGEX.exec(carry);
                if (match) {
                  const before = carry.slice(0, match.index);
                  const after = carry.slice(match.index + match[0].length);
                  flushText(before);
                  parsedMeta = true;
                  sendEvent({
                    type: "meta",
                    exitCode: Number(match[1] || 0),
                    cwd: match[2] || cwd || "~",
                  });
                  carry = after;
                } else {
                  // Hold last 96 chars in case OSC marker splits across packets
                  if (carry.length > 96) {
                    const emitPart = carry.slice(0, carry.length - 96);
                    carry = carry.slice(carry.length - 96);
                    flushText(emitPart);
                  }
                }
              });

              ch.stderr.on("data", (chunk: Buffer) => {
                sendEvent({
                  type: "data",
                  data: chunk.toString("base64"),
                });
              });

              ch.on("close", (code: number | null) => {
                if (carry) {
                  const match = META_REGEX.exec(carry);
                  if (match) {
                    flushText(carry.slice(0, match.index));
                    parsedMeta = true;
                    sendEvent({
                      type: "meta",
                      exitCode: Number(match[1] ?? code ?? 0),
                      cwd: match[2] || cwd || "~",
                    });
                  } else {
                    flushText(carry);
                  }
                  carry = "";
                }
                if (!parsedMeta) {
                  sendEvent({
                    type: "meta",
                    exitCode: code ?? 0,
                    cwd: cwd || "~",
                  });
                }
                resolve();
              });
            }
          );
        });
      } catch (err) {
        sendEvent({
          type: "error",
          message: err instanceof Error ? err.message : "SSH execution failed.",
        });
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        session?.client.end();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // ignore
          }
        }
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
