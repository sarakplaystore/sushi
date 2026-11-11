import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { runSshCommand } from "@/lib/server/ssh-pool";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import {
  buildRunStatusScript,
  isKeyChannelPath,
  isRunLogPath,
  parseRunStatusOutput,
  tailPreview,
} from "@/lib/server/exec-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two `test`/`tail` calls on the pooled connection: nothing here is long.
export const maxDuration = 30;

/**
 * "Is my command still running?" — used by the resume prompt and by a reopened tab.
 *
 * A long command in the serverless shell keeps running on the host (No timeout), and
 * its keystroke FIFO plus `/tmp/.sushi-run-*.log` survive the tab that started it.
 * This route answers, in one round trip, whether the FIFO still exists (so the
 * command is alive) and returns the tail of the log so the browser can redraw what it
 * missed. Read-only: no command is started or stopped here.
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
    /** Keystroke FIFO of the run (`/tmp/.sushi-keys-…`). */
    keyChannel?: string;
    /** Output log of the run (`/tmp/.sushi-run-….log`). */
    runLog?: string;
    /** Bytes of log tail to return (default 48 KiB, max 256 KiB). */
    tailBytes?: number;
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

  const keyChannel = (body.keyChannel || "").trim();
  const runLog = (body.runLog || "").trim();
  // Both paths are checked against the exact shapes the exec route hands out: a
  // client can never point this route at an arbitrary file on the host.
  if (!keyChannel && !runLog) {
    return NextResponse.json(
      { ok: false, error: "A run needs a key channel or a run log." },
      { status: 400, headers: cors }
    );
  }
  if (keyChannel && !isKeyChannelPath(keyChannel)) {
    return NextResponse.json(
      { ok: false, error: "Invalid key channel." },
      { status: 400, headers: cors }
    );
  }
  if (runLog && !isRunLogPath(runLog)) {
    return NextResponse.json(
      { ok: false, error: "Invalid run log." },
      { status: 400, headers: cors }
    );
  }

  const tailBytes = Number(body.tailBytes);
  try {
    const { output } = await runSshCommand(creds, {
      script: buildRunStatusScript({
        keyChannel,
        runLog,
        tailBytes: Number.isFinite(tailBytes) && tailBytes > 0 ? tailBytes : undefined,
      }),
      timeoutMs: 12000,
      maxWaitMs: 10000,
    });

    const status = parseRunStatusOutput(output);
    return NextResponse.json(
      {
        ok: true,
        // `running` is what the UI switches on: FIFO present ⇒ the wrapper (and the
        // command) is still alive on the host.
        running: status.alive,
        logExists: status.exists,
        logBytes: status.logBytes,
        /** Plain-text tail of the log (control sequences stripped). */
        output: status.output,
        preview: tailPreview(status.output),
        keyChannel: keyChannel || undefined,
        runLog: runLog || undefined,
      },
      { headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Could not check the run on the host.",
      },
      { status: 502, headers: cors }
    );
  }
}
