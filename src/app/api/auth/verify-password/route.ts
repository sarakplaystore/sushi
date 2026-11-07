import { NextRequest, NextResponse } from "next/server";
import { checkLoginRateLimit, clearLoginFailures, getEffectiveAuthConfig, recordLoginFailure, verifyAdminSession } from "@/lib/server/auth";
import { getCorsHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req.headers.get("origin")) });
}

// Used after a passkey/session login before choosing the account password as a
// vault key. A typo must not create a vault no other device can unlock.
export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  try {
    const auth = await verifyAdminSession(req.headers);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
    const limit = checkLoginRateLimit(ip);
    if (!limit.allowed) return NextResponse.json({ ok: false, error: `Too many attempts. Try again in ${limit.retryAfterSec}s.` }, { status: 429, headers: cors });
    const body = await req.json() as { password?: unknown };
    const cfg = await getEffectiveAuthConfig(req.headers);
    if (typeof body?.password !== "string" || !body.password || !(await cfg.verifyPassword(body.password))) {
      recordLoginFailure(ip);
      return NextResponse.json({ ok: false, error: "Account password is incorrect." }, { status: 401, headers: cors });
    }
    clearLoginFailures(ip);
    return NextResponse.json({ ok: true }, { headers: cors });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not verify the account password. No vault changes were made." }, { status: 503, headers: cors });
  }
}
