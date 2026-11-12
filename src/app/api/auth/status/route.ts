import { NextRequest, NextResponse } from "next/server";
import {
  getEffectiveAuthConfig,
  mergePasskeySummaries,
  verifyAdminSession,
  verifySignedPasskeyCertificates,
} from "@/lib/server/auth";
import { getCorsHeaders } from "@/lib/server/security";
import { getStateStoreKind } from "@/lib/server/state-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

async function buildStatusResponse(
  req: NextRequest,
  signedCertificates?: string[],
  adminProfileCert?: string
) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const isVercel = process.env.VERCEL === "1";
  const isGateway = process.env.GATEWAY_ONLY === "true";
  const mode = isVercel ? "vercel" : isGateway ? "gateway" : "vps";

  const cfg = await getEffectiveAuthConfig(req.headers, adminProfileCert);
  const authCheck = await verifyAdminSession(req.headers);

  const certPasskeys = cfg.initialized
    ? verifySignedPasskeyCertificates(
        signedCertificates,
        cfg.username,
        cfg.authSecret
      )
    : [];
  const mergedPasskeys = mergePasskeySummaries(cfg.serverPasskeys, certPasskeys);

  return NextResponse.json(
    {
      ok: true,
      authenticated: authCheck.ok,
      initialized: cfg.initialized,
      canBootstrapOnDisk: cfg.canBootstrapOnDisk,
      canBootstrapInteractive: cfg.canBootstrapInteractive,
      envConfigured: cfg.envConfigured,
      mode,
      storage: getStateStoreKind(),
      username: authCheck.ok ? authCheck.username || cfg.username : undefined,
      passkeyCount: mergedPasskeys.length,
    },
    { headers: cors }
  );
}

export async function GET(req: NextRequest) {
  try {
    return await buildStatusResponse(req);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Account storage is unavailable." }, {
      status: 503, headers: getCorsHeaders(req.headers.get("origin")),
    });
  }
}

export async function POST(req: NextRequest) {
  let certs: string[] | undefined;
  let adminProfileCert: string | undefined;
  try {
    const body = (await req.json()) as {
      signedCertificates?: string[];
      adminProfileCert?: string;
    };
    certs = body?.signedCertificates;
    adminProfileCert = body?.adminProfileCert;
  } catch {
    // ignore empty body
  }
  try {
    return await buildStatusResponse(req, certs, adminProfileCert);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Account storage is unavailable." }, {
      status: 503, headers: getCorsHeaders(req.headers.get("origin")),
    });
  }
}
