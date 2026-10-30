import { StringDecoder } from "node:string_decoder";
import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { connectSsh, shellQuote } from "@/lib/server/ssh-client";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import { META_REGEX, splitEmittable } from "@/lib/server/exec-stream";
import {
  buildExecScript,
  createSudoAnswerer,
  type ExecElevation,
} from "@/lib/server/exec-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let body: {
    credentials?: ConnectionCredentials;
    command?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    /** Run the command through sudo (used to emulate `sudo su` / `sudo <cmd>`). */
    elevate?: ExecElevation;
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

        const { script, feedPassword, ptyModes } = buildExecScript({
          command,
          cwd,
          elevate: body.elevate,
        });

        await new Promise<void>((resolve) => {
          const ptyOptions = {
            term: "xterm-256color",
            cols,
            rows,
            ...(ptyModes ? { modes: ptyModes } : {}),
          };

          session!.client.exec(
            script,
            { pty: ptyOptions },
            (err, ch) => {
              if (err) {
                sendEvent({ type: "error", message: err.message });
                resolve();
                return;
              }

              let carry = "";
              let parsedMeta = false;
              // Keeps multi-byte UTF-8 characters intact across SSH packets
              const utf8 = new StringDecoder("utf8");

              const sudoAnswerer = createSudoAnswerer();
              let finished = false;

              let passwordWritten = false;
              const sendPassword = () => {
                if (!feedPassword || passwordWritten || finished) return;
                passwordWritten = true;
                try {
                  ch.write(`${feedPassword}\n`);
                } catch {
                  // channel already closed
                }
              };

              /** Answers sudo's prompt once, hiding it and the password from the stream. */
              const answerSudo = (text: string): string => {
                if (!feedPassword) return text;
                const answer = sudoAnswerer.answer(text);
                if (answer.sendPassword) sendPassword();
                if (answer.gaveUp) {
                  // sudo asked again → wrong password; fail fast instead of hanging
                  finished = true;
                  try {
                    ch.close();
                  } catch {
                    // already closed
                  }
                }
                return answer.text;
              };

              // Some sudo builds phrase the prompt differently: if nothing matched and
              // the command has not finished, answer once anyway (echo is disabled).
              const passwordFallback = feedPassword
                ? setTimeout(sendPassword, 3500)
                : null;

              const flushText = (text: string) => {
                if (!text) return;
                sendEvent({
                  type: "data",
                  data: Buffer.from(text, "utf8").toString("base64"),
                });
              };

              ch.on("data", (chunk: Buffer) => {
                carry += utf8.write(chunk);
                const match = META_REGEX.exec(carry);
                if (match) {
                  const before = carry.slice(0, match.index);
                  const after = carry.slice(match.index + match[0].length);
                  flushText(answerSudo(before));
                  parsedMeta = true;
                  sendEvent({
                    type: "meta",
                    exitCode: Number(match[1] || 0),
                    cwd: match[2] || cwd || "~",
                  });
                  carry = after;
                } else {
                  // Emit everything except a tail that may be a split META marker
                  const [emitPart, held] = splitEmittable(carry);
                  carry = held;
                  flushText(answerSudo(emitPart));
                }
              });

              ch.stderr.on("data", (chunk: Buffer) => {
                sendEvent({
                  type: "data",
                  data: chunk.toString("base64"),
                });
              });

              ch.on("close", (code: number | null) => {
                finished = true;
                if (passwordFallback) clearTimeout(passwordFallback);
                carry += utf8.end();
                if (carry) {
                  const match = META_REGEX.exec(carry);
                  if (match) {
                    flushText(answerSudo(carry.slice(0, match.index)));
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
