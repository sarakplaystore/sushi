import { StringDecoder } from "node:string_decoder";
import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { connectSsh, shellQuote } from "@/lib/server/ssh-client";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import { META_REGEX, splitEmittable } from "@/lib/server/exec-stream";
import { pumpExecInput, readExecStart } from "@/lib/server/exec-input";
import {
  buildExecScript,
  createSudoAnswerer,
  type ExecElevation,
} from "@/lib/server/exec-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long installs (`apt install docker`, `npm ci`, builds) are common in a terminal,
// so give the exec the full window the platform allows instead of cutting it at 60 s.
export const maxDuration = 300;

/** Output that usually means the command is sitting on a question. */
const PROMPT_HINT_RE = /\[[Yy]\/[Nn]\]|\(yes\/no\)|\[[Yy]\/N\]|\[y\/N\]|password[^\n]{0,30}:\s*$/i;

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
    /**
     * Text piped into the command's stdin once the channel is open. Lets the UI
     * re-run something that asked a question ("Do you want to continue? [Y/n]")
     * when the browser cannot stream live keystrokes.
     */
    stdin?: string;
  };

  // Two request shapes: a plain JSON body (fire-and-run) or a streaming NDJSON body
  // that stays open and becomes the command's stdin, so prompts can be answered.
  const isStreamedBody = (req.headers.get("content-type") || "").includes(
    "application/x-ndjson"
  );
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let inputCarry = "";

  if (isStreamedBody) {
    if (!req.body) {
      return NextResponse.json(
        { ok: false, error: "This request has no streamed body." },
        { status: 400, headers: cors }
      );
    }
    inputReader = req.body.getReader();
    try {
      const { start, carry, timedOut } = await readExecStart(inputReader);
      inputCarry = carry;
      if (timedOut) {
        void inputReader.cancel().catch(() => {});
        return NextResponse.json(
          {
            ok: false,
            error:
              "The exec request body did not arrive in time (this deployment may buffer request bodies). Retry with a plain JSON body.",
            code: "streamed_body_timeout",
          },
          { status: 408, headers: cors }
        );
      }
      if (!start) {
        void inputReader.cancel().catch(() => {});
        return NextResponse.json(
          { ok: false, error: "Streamed exec needs a {type:\"start\"} line first." },
          { status: 400, headers: cors }
        );
      }
      body = start;
    } catch {
      void inputReader.cancel().catch(() => {});
      return NextResponse.json(
        { ok: false, error: "Could not read the exec request body." },
        { status: 400, headers: cors }
      );
    }
  } else {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON payload." },
        { status: 400, headers: cors }
      );
    }
  }

  const creds = body.credentials;
  const command = body.command ?? "";
  if (!creds?.host || !creds?.username) {
    if (inputReader) void inputReader.cancel().catch(() => {});
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
              let channelClosed = false;

              // Keystrokes from the browser become this command's stdin. With a PTY
              // allocated, SSH_MSG_CHANNEL_DATA is what a real keyboard would do, so
              // `[Y/n]`, passphrase and sudo prompts all work — and SIGINT lets
              // Ctrl+C interrupt the command instead of killing the connection.
              if (inputReader) {
                const chRef = ch;
                void pumpExecInput(inputReader, inputCarry, {
                  onInput: (data) => {
                    try {
                      chRef.write(data);
                    } catch {
                      // channel already closed
                    }
                  },
                  onSignal: (signal) => {
                    try {
                      chRef.signal(signal);
                    } catch {
                      // fall back to the terminal's own interrupt character
                      try {
                        if (signal === "INT") chRef.write("\x03");
                      } catch {
                        // channel already closed
                      }
                    }
                  },
                  isClosed: () => finished || channelClosed,
                }).catch(() => {
                  // the browser closed the body (navigated away / command finished)
                });
              }

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

              // Piped stdin: written once the PTY is up, so a re-run of an interactive
              // command can answer its question without live keystrokes.
              const pipedInput =
                typeof body.stdin === "string" && body.stdin.length > 0
                  ? body.stdin.slice(0, 4096)
                  : null;
              let pipedWritten = false;
              const writePipedInput = () => {
                if (!pipedInput || pipedWritten || finished) return;
                pipedWritten = true;
                try {
                  ch.write(pipedInput);
                } catch {
                  // channel already gone
                }
              };
              // A question probably showed up: answer it now. Otherwise answer after
              // ~1 s so slow starters (`apt` printing package lists) still get it.
              const maybeAnswerPrompt = (text: string) => {
                if (PROMPT_HINT_RE.test(text)) writePipedInput();
              };
              const pipedFallback = pipedInput ? setTimeout(writePipedInput, 1000) : null;

              // Without live keystrokes, a command that reads stdin would wait forever
              // (a PTY never reports EOF on its own). Close stdin once the piped answer
              // is in, so `read`/`apt` behave like they do in a pipe instead of hanging
              // until the function timeout.
              const stdinCloseTimer =
                inputReader || feedPassword
                  ? null
                  : setTimeout(() => {
                      if (finished) return;
                      writePipedInput();
                      try {
                        // Ctrl-D: in a PTY that means "end of input", so a blocked
                        // `read` returns immediately (channel.close() would kill the
                        // command's output too).
                        ch.write("\x04");
                      } catch {
                        // channel already gone
                      }
                    }, pipedInput ? 1800 : 1200);

              const flushText = (text: string) => {
                if (!text) return;
                sendEvent({
                  type: "data",
                  data: Buffer.from(text, "utf8").toString("base64"),
                });
              };

              ch.on("data", (chunk: Buffer) => {
                if (pipedInput) maybeAnswerPrompt(chunk.toString("utf8"));
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
                channelClosed = true;
                if (inputReader) void inputReader.cancel().catch(() => {});
                if (passwordFallback) clearTimeout(passwordFallback);
                if (pipedFallback) clearTimeout(pipedFallback);
                if (stdinCloseTimer) clearTimeout(stdinCloseTimer);
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
