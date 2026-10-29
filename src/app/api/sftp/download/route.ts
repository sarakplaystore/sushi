import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { sftpReadBuffer } from "@/lib/server/ssh-client";
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
    if (!body?.credentials || !body?.path) {
      return NextResponse.json(
        { ok: false, error: "Missing credentials or remote file path." },
        { status: 400, headers: cors }
      );
    }

    const { buffer } = await sftpReadBuffer(
      body.credentials,
      body.path,
      50 * 1024 * 1024
    );

    const filename = path.posix.basename(body.path) || "download.bin";
    const safeFilename = filename.replace(/["\\\r\n]/g, "_");

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buffer.length),
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to download file.",
      },
      { status: 422, headers: cors }
    );
  }
}
