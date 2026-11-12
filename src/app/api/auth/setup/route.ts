import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import {
  attachAdminProfileCookie,
  attachSessionCookie,
  bootstrapAdminAccount,
  createSessionToken,
  getEffectiveAuthConfig,
} from "@/lib/server/auth";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));

  try {
    const body = (await req.json()) as {
      username?: string;
      password?: string;
      adminProfileCert?: string;
    };

    const cfg = await getEffectiveAuthConfig(
      req.headers,
      body?.adminProfileCert
    );

    if (cfg.initialized) {
      return NextResponse.json(
        { ok: false, error: "Admin account is already initialized." },
        { status: 409, headers: cors }
      );
    }

    if (!body?.username || !body?.password) {
      return NextResponse.json(
        { ok: false, error: "Username and password are required." },
        { status: 400, headers: cors }
      );
    }

    const created = await bootstrapAdminAccount(body.username, body.password);

    const sessionToken = createSessionToken(
      created.username,
      created.authSecret,
      created.sessionVersion
    );

    const res = NextResponse.json(
      {
        ok: true,
        username: created.username,
        sessionToken,
        adminProfileCert: created.adminProfileCert,
        persistedOnDisk: created.persistedOnDisk,
      },
      { headers: cors }
    );

    attachSessionCookie(res, sessionToken, req);
    attachAdminProfileCookie(res, created.adminProfileCert, req);
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initialize admin account.";
    const status = /already initialized/i.test(message) ? 409
      : /storage|firestore|turso|persistent account data/i.test(message) ? 503 : 400;
    return NextResponse.json({ ok: false, error: message }, { status, headers: cors });
  }
}
