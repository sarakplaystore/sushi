import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { runSshCommand } from "@/lib/server/ssh-pool";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import {
  buildKeyDeliveryScript,
  isKeyChannelPath,
  parseKeyDeliveryResult,
} from "@/lib/server/exec-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One tiny write; a slow SSH handshake is the only thing that can take a while.
export const maxDuration = 30;

/**
 * Delivers key presses to a command that is already running.
 *
 * Terminal menus (whiptail, debconf, ncurses, `less`, `vim`, a REPL) only listen to
 * their own terminal. In serverless mode Sushi runs such a command inside `script(1)`
 * with a keystroke FIFO as its input, so a key press can arrive as its own small
 * request — it does not need a live request stream, HTTP/2, or the same server
 * instance.
 *
 * Each press writes a few bytes into the FIFO, so it rides on the connection the
 * running command already uses (`runSshCommand` shares it instead of handshaking
 * per key). It works for elevated commands too: the FIFO belongs to the login user.
 */
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
    /** FIFO path reported by `/api/ssh/exec` in its `ready` event. */
    path?: string;
    /** Raw terminal bytes (`"\x1b[B"`, `"\r"`, `"\t"`, `"y"` …). */
    keys?: string;
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
  if (!creds?.host || !creds?.username) {
    return NextResponse.json(
      { ok: false, error: "SSH host and username are required." },
      { status: 400, headers: cors }
    );
  }

  const path = (body.path || "").trim();
  if (!isKeyChannelPath(path)) {
    return NextResponse.json(
      { ok: false, error: "Invalid key channel.", result: "missing" },
      { status: 400, headers: cors }
    );
  }

  const keys = typeof body.keys === "string" ? body.keys.slice(0, 512) : "";
  if (!keys) {
    return NextResponse.json(
      { ok: false, error: "No keys to send." },
      { status: 400, headers: cors }
    );
  }

  try {
    // Shared on purpose: the connection running the command carries this too, so a
    // key press is one round trip instead of a whole SSH handshake.
    const { output } = await runSshCommand(creds, {
      script: buildKeyDeliveryScript(path, keys),
      timeoutMs: 12000,
      maxWaitMs: 8000,
    });

    const result = parseKeyDeliveryResult(output);
    return NextResponse.json(
      {
        ok: result === "delivered",
        result,
        ...(result === "missing"
          ? {
              error:
                "The running command has no key channel on this host (it may have already finished).",
            }
          : {}),
      },
      { headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        result: "failed",
        error: err instanceof Error ? err.message : "SSH execution failed.",
      },
      { status: 502, headers: cors }
    );
  }
}
