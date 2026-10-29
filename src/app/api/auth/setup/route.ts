import { NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  bootstrapDiskAdminAccount,
  createSessionToken,
  getEffectiveAuthConfig,
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

  try {
    const current = await getEffectiveAuthConfig();
    if (current.initialized) {
      return NextResponse.json(
        { ok: false, error: "Admin account is already initialized." },
        { status: 409, headers: cors }
      );
    }

    const body = (await req.json()) as {
      username?: string;
      password?: string;
    };

    if (!body?.username || !body?.password) {
      return NextResponse.json(
        { ok: false, error: "Username and password are required." },
        { status: 400, headers: cors }
      );
    }

    const created = await bootstrapDiskAdminAccount(body.username, body.password);
    const sessionToken = createSessionToken(created.username, created.authSecret);

    const res = NextResponse.json(
      {
        ok: true,
        username: created.username,
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
        error: err instanceof Error ? err.message : "Failed to initialize admin account.",
      },
      { status: 400, headers: cors }
    );
  }
}
