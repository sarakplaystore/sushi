import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import {
  deliverRdpHttpInput,
  isValidRdpSessionId,
} from "@/lib/server/rdcleanpath";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  let body: {
    sessionId?: unknown;
    seq?: unknown;
    frames?: unknown;
  };
  try {
    body = (await req.json()) as {
      sessionId?: unknown;
      seq?: unknown;
      frames?: unknown;
    };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400, headers: cors }
    );
  }

  if (
    !isValidRdpSessionId(body.sessionId) ||
    typeof body.seq !== "number" ||
    !Number.isInteger(body.seq) ||
    body.seq < 0 ||
    !Array.isArray(body.frames) ||
    body.frames.length === 0 ||
    body.frames.length > 256 ||
    !body.frames.every((f) => typeof f === "string")
  ) {
    return NextResponse.json(
      { error: "Invalid sessionId, seq, or frames payload." },
      { status: 400, headers: cors }
    );
  }

  try {
    const result = await deliverRdpHttpInput({
      sessionId: body.sessionId,
      username: auth.username || "admin",
      seq: body.seq,
      framesBase64: body.frames as string[],
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Failed to deliver RDP input." },
        { status: 410, headers: cors }
      );
    }
    return NextResponse.json({ ok: true, mode: result.mode }, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "RDP input delivery failed." },
      { status: 500, headers: cors }
    );
  }
}
