import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { sftpListDirectory } from "@/lib/server/ssh-client";
import { getCorsHeaders, verifyGatewayTokenFromHeaders } from "@/lib/server/security";

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
  const auth = verifyGatewayTokenFromHeaders(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  try {
    const body = (await req.json()) as {
      credentials?: ConnectionCredentials;
      path?: string;
    };
    if (!body?.credentials) {
      return NextResponse.json(
        { ok: false, error: "Missing SFTP credentials." },
        { status: 400, headers: cors }
      );
    }

    const result = await sftpListDirectory(body.credentials, body.path);
    return NextResponse.json({ ok: true, ...result }, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to list SFTP directory.",
      },
      { status: 422, headers: cors }
    );
  }
}
