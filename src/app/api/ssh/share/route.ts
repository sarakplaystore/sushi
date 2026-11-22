import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";
import { verifyAdminSession, verifyGatewayTokenHeaders } from "@/lib/server/auth";
import {
  listSharedSessions,
  getSharedSession,
  rotateSharedPasscode,
  sharedSessionLimits,
  stopSharedSession,
  type SharedSessionSummary,
} from "@/lib/server/shared-ssh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET|DELETE|PATCH /api/ssh/share` — the management side of team sharing.
 *
 * Sharing needs a live process to hold the SSH channel open between browsers, so
 * these endpoints only ever see shares on a VPS / Docker / gateway install. On
 * serverless (Vercel) the registry is always empty and the response says so, which is
 * what the UI uses to show "attach a VPS gateway to share a terminal" instead of an
 * empty list that looks broken.
 */

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

function sharingAvailable(): boolean {
  return Boolean((globalThis as Record<string, unknown>).__SUSHI_WS_ACTIVE__);
}

// Share management is protocol-level access, not account/vault management.
// An attached gateway key can manage its own shares; otherwise require the
// same-origin admin guard (not a cookie accepted across arbitrary origins).
async function authorizeManagement(req: NextRequest) {
  if (verifyGatewayTokenHeaders(req.headers)) return { ok: true, error: undefined };
  return verifyAdminSession(req.headers);
}

export async function GET(req: NextRequest) {
  const cors = { ...getCorsHeaders(req.headers.get("origin")), "Cache-Control": "private, no-store" };
  const auth = await authorizeManagement(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  const shares: SharedSessionSummary[] = sharingAvailable() ? listSharedSessions() : [];
  return NextResponse.json(
    {
      ok: true,
      shares,
      limits: sharedSessionLimits(),
      requiresGateway: !sharingAvailable(),
    },
    { headers: cors }
  );
}

export async function DELETE(req: NextRequest) {
  const cors = { ...getCorsHeaders(req.headers.get("origin")), "Cache-Control": "private, no-store" };
  const auth = await authorizeManagement(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  const id = (req.nextUrl.searchParams.get("id") || "").trim();
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Pass the share id to stop (?id=…)." },
      { status: 400, headers: cors }
    );
  }

  const result = stopSharedSession(id, "The share was stopped from the Sushi dashboard.");
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 404, headers: cors });
  }
  return NextResponse.json({ ok: true, shares: listSharedSessions() }, { headers: cors });
}

export async function PATCH(req: NextRequest) {
  const cors = { ...getCorsHeaders(req.headers.get("origin")), "Cache-Control": "private, no-store" };
  const auth = await authorizeManagement(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let body: { id?: unknown; passcode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400, headers: cors });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ ok: false, error: "Pass the share id." }, { status: 400, headers: cors });
  }

  // "none" makes the share account-only: the 6-digit code stops working.
  const requested =
    body.passcode === null || body.passcode === "none"
      ? null
      : typeof body.passcode === "string" && /^\d{6}$/.test(body.passcode.trim())
        ? body.passcode.trim()
        : "auto";

  if (requested === null && process.env.GATEWAY_ONLY === "true" &&
      getSharedSession(id) && !getSharedSession(id)?.accountIssuer) {
    return NextResponse.json(
      { ok: false, error: "This share has no frontend account verifier. Start it again from an updated Sushi site." },
      { status: 409, headers: cors }
    );
  }
  const result = rotateSharedPasscode(id, requested);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 404, headers: cors });
  }
  return NextResponse.json(
    { ok: true, passcode: result.passcode, shares: listSharedSessions() },
    { headers: cors }
  );
}
