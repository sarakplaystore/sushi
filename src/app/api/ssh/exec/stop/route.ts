import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { runSshCommand } from "@/lib/server/ssh-pool";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import {
  buildStopBackgroundProcessesScript,
  parseStopBackgroundProcessesOutput,
} from "@/lib/server/exec-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

/**
 * Stops all background SSH processes and detached Sushi commands on the target
 * SSH host without touching system boot services (`sshd`, `systemd`, etc.) or
 * active interactive login prompts.
 */
export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  let body: { credentials?: ConnectionCredentials };
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

  try {
    const { output } = await runSshCommand(creds, {
      script: buildStopBackgroundProcessesScript(),
      timeoutMs: 15000,
      maxWaitMs: 12000,
    });
    const parsed = parseStopBackgroundProcessesOutput(output);
    return NextResponse.json(
      {
        ok: true,
        stoppedCount: parsed.stoppedCount,
        cleanedChannels: parsed.cleanedChannels,
        processes: parsed.processes,
      },
      { headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Could not stop background SSH processes on the host.",
      },
      { status: 502, headers: cors }
    );
  }
}
