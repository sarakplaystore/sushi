import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { testSshConnection } from "@/lib/server/ssh-client";
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

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  try {
    const body = (await req.json()) as { credentials?: ConnectionCredentials };
    if (!body?.credentials) {
      return NextResponse.json(
        { ok: false, error: "Missing SSH credentials." },
        { status: 400, headers: cors }
      );
    }

    const result = await testSshConnection(body.credentials);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
      headers: cors,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : "SSH test failed.",
      },
      { status: 500, headers: cors }
    );
  }
}
