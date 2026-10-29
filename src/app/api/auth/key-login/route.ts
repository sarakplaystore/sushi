import { NextRequest, NextResponse } from "next/server";
import {
  attachAdminProfileCookie,
  attachSessionCookie,
  checkLoginRateLimit,
  clearLoginFailures,
  createSessionToken,
  extractAdminCertFromHeaders,
  getEffectiveAuthConfig,
  mergeAuthorizedKeys,
  recordLoginFailure,
  verifySignedAuthorizedKeyCertificates,
} from "@/lib/server/auth";
import { verifyPrivateKeyAgainstWhitelist } from "@/lib/server/ssh-key-utils";
import { getCorsHeaders } from "@/lib/server/security";

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
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";

  const rateCheck = checkLoginRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many failed sign-in attempts. Try again in ${rateCheck.retryAfterSec}s.`,
      },
      { status: 429, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as {
      privateKey?: string;
      passphrase?: string;
      adminProfileCert?: string;
      signedKeyCertificates?: string[];
    };

    const cfg = await getEffectiveAuthConfig(req.headers, body?.adminProfileCert);
    if (!cfg.initialized) {
      return NextResponse.json(
        {
          ok: false,
          error: "Admin account is not initialized yet.",
        },
        { status: 400, headers: cors }
      );
    }

    const certKeys = verifySignedAuthorizedKeyCertificates(
      body?.signedKeyCertificates,
      cfg.username,
      cfg.authSecret
    );
    const allWhitelisted = mergeAuthorizedKeys(cfg.authorizedKeys, certKeys);

    const verification = verifyPrivateKeyAgainstWhitelist(
      body?.privateKey || "",
      body?.passphrase,
      allWhitelisted
    );

    if (!verification.ok) {
      recordLoginFailure(clientIp);
      return NextResponse.json(
        { ok: false, error: verification.error },
        { status: 401, headers: cors }
      );
    }

    clearLoginFailures(clientIp);
    const sessionToken = createSessionToken(cfg.username, cfg.authSecret);

    const res = NextResponse.json(
      {
        ok: true,
        username: cfg.username,
        matchedFingerprint: verification.matchedKey.fingerprint,
        matchedLabel: verification.matchedKey.label,
        sessionToken,
      },
      { headers: cors }
    );
    attachSessionCookie(res, sessionToken, req);

    const activeAdminCert = extractAdminCertFromHeaders(
      req.headers,
      body?.adminProfileCert
    );
    if (activeAdminCert) {
      attachAdminProfileCookie(res, activeAdminCert, req);
    }
    return res;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Private key authentication failed.",
      },
      { status: 500, headers: cors }
    );
  }
}
