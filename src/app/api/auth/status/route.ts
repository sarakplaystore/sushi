import { NextRequest, NextResponse } from "next/server";
import {
  getEffectiveAuthConfig,
  mergeAuthorizedKeys,
  mergePasskeySummaries,
  verifyIncomingAuth,
  verifySignedAuthorizedKeyCertificates,
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

async function buildStatusResponse(
  req: NextRequest,
  signedCertificates?: string[],
  signedKeyCertificates?: string[],
  adminProfileCert?: string
) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const isVercel = process.env.VERCEL === "1";
  const isGateway = process.env.GATEWAY_ONLY === "true";
  const mode = isVercel ? "vercel" : isGateway ? "gateway" : "vps";

  const cfg = await getEffectiveAuthConfig(req.headers, adminProfileCert);
  const authCheck = await verifyIncomingAuth(req.headers);

  const certPasskeys = cfg.initialized
    ? verifySignedPasskeyCertificates(
        signedCertificates,
        cfg.username,
        cfg.authSecret
      )
    : [];
  const mergedPasskeys = mergePasskeySummaries(cfg.serverPasskeys, certPasskeys);

  const certAuthKeys = cfg.initialized
    ? verifySignedAuthorizedKeyCertificates(
        signedKeyCertificates,
        cfg.username,
        cfg.authSecret
      )
    : [];
  const mergedAuthKeys = mergeAuthorizedKeys(cfg.authorizedKeys, certAuthKeys);

  return NextResponse.json(
    {
      ok: true,
      authenticated: authCheck.ok,
      initialized: cfg.initialized,
      canBootstrapOnDisk: cfg.canBootstrapOnDisk,
      canBootstrapInteractive: cfg.canBootstrapInteractive,
      envConfigured: cfg.envConfigured,
      mode,
      username: authCheck.ok ? authCheck.username || cfg.username : undefined,
      passkeyCount: mergedPasskeys.length,
      authorizedKeyCount: mergedAuthKeys.length,
    },
    { headers: cors }
  );
}

export async function GET(req: NextRequest) {
  return buildStatusResponse(req);
}

export async function POST(req: NextRequest) {
  let certs: string[] | undefined;
  let keyCerts: string[] | undefined;
  let adminProfileCert: string | undefined;
  try {
    const body = (await req.json()) as {
      signedCertificates?: string[];
      signedKeyCertificates?: string[];
      adminProfileCert?: string;
    };
    certs = body?.signedCertificates;
    keyCerts = body?.signedKeyCertificates;
    adminProfileCert = body?.adminProfileCert;
  } catch {
    // ignore empty body
  }
  return buildStatusResponse(req, certs, keyCerts, adminProfileCert);
}
