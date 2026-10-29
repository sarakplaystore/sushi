import { NextRequest, NextResponse } from "next/server";
import { probeRdpServer } from "@/lib/server/rdp-probe";
import { getCorsHeaders, verifyGatewayTokenFromHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
    const body = (await req.json()) as { host?: string; port?: number };
    if (!body?.host) {
      return NextResponse.json(
        { ok: false, error: "RDP host is required." },
        { status: 400, headers: cors }
      );
    }

    const result = await probeRdpServer(body.host, Number(body.port || 3389), 8000);
    return NextResponse.json(result, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reachable: false,
        latencyMs: 0,
        host: "",
        port: 3389,
        supportedProtocols: [],
        nlaRequired: false,
        tlsSupported: false,
        error: err instanceof Error ? err.message : "RDP probe failed.",
      },
      { status: 422, headers: cors }
    );
  }
}
