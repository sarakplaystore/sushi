import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/server/auth";
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
  const res = NextResponse.json(
    { ok: true },
    { headers: getCorsHeaders(req.headers.get("origin")) }
  );
  clearSessionCookie(res);
  return res;
}
