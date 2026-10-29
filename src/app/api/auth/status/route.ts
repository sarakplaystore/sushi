import { NextRequest, NextResponse } from "next/server";
import {
  getEffectiveAuthConfig,
  mergePasskeySummaries,
  verifyIncomingAuth,
  verifySignedPasskeyCertificates,
} from "@/lib/server/auth";
import { getCorsHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

async function buildStatusResponse(req: NextRequest, signedCertificates?: string[]) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const isVercel = process.env.VERCEL === "1";
  const isGateway = process.env.GATEWAY_ONLY === "true";
  const mode = isVercel ? "vercel" : isGateway ? "gateway" : "vps";

  const cfg = await getEffectiveAuthConfig();
  const authCheck = await verifyIncomingAuth(req.headers);

  const certKeys = cfg.initialized
    ? verifySignedPasskeyCertificates(signedCertificates, cfg.username, cfg.authSecret)
    : [];
  const merged = mergePasskeySummaries(cfg.serverPasskeys, certKeys);

  return NextResponse.json(
    {
      ok: true,
      authenticated: authCheck.ok,
      initialized: cfg.initialized,
      canBootstrapOnDisk: cfg.canBootstrapOnDisk,
      envConfigured: cfg.envConfigured,
      mode,
      username: authCheck.ok ? cfg.username : undefined,
      passkeyCount: merged.length,
    },
    { headers: cors }
  );
}

export async function GET(req: NextRequest) {
  return buildStatusResponse(req);
}

export async function POST(req: NextRequest) {
  let certs: string[] | undefined;
  try {
    const body = (await req.json()) as { signedCertificates?: string[] };
    certs = body?.signedCertificates;
  } catch {
    // ignore empty body
  }
  return buildStatusResponse(req, certs);
}
