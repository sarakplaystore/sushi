import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  checkLoginRateLimit,
  clearLoginFailures,
  createSessionToken,
  getEffectiveAuthConfig,
  recordLoginFailure,
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
    const cfg = await getEffectiveAuthConfig();
    if (!cfg.initialized) {
      return NextResponse.json(
        {
          ok: false,
          error: "Admin account is not configured yet.",
        },
        { status: 400, headers: cors }
      );
    }

    const body = (await req.json()) as {
      username?: string;
      password?: string;
    };

    const providedUser = (body?.username || "").trim();
    const providedPass = body?.password ?? "";

    const userHashA = crypto.createHash("sha256").update(providedUser, "utf8").digest();
    const userHashB = crypto.createHash("sha256").update(cfg.username, "utf8").digest();
    const userMatches = crypto.timingSafeEqual(userHashA, userHashB);
    const passMatches = await cfg.verifyPassword(providedPass);

    if (!userMatches || !passMatches) {
      recordLoginFailure(clientIp);
      return NextResponse.json(
        { ok: false, error: "Invalid username or password." },
        { status: 401, headers: cors }
      );
    }

    clearLoginFailures(clientIp);
    const sessionToken = createSessionToken(cfg.username, cfg.authSecret);

    const res = NextResponse.json(
      {
        ok: true,
        username: cfg.username,
        sessionToken,
      },
      { headers: cors }
    );
    attachSessionCookie(res, sessionToken, req);
    return res;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Authentication error.",
      },
      { status: 500, headers: cors }
    );
  }
}
