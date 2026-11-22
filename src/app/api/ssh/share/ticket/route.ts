import { NextRequest, NextResponse } from "next/server";
import { isShareId, normalizeShareGateway } from "@/lib/share-gateway";
import { getEffectiveAuthConfig, verifyAdminSession } from "@/lib/server/auth";
import { issueShareTicket, shareTicketPublicKey } from "@/lib/server/share-ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };

async function signingSecret(req: NextRequest): Promise<string | null> {
  // Gateway keys authorize protocol access, not the frontend's account. This
  // same-origin guard explicitly requires a real admin session, not that key.
  const auth = await verifyAdminSession(req.headers);
  if (!auth.ok) return null;
  const cfg = await getEffectiveAuthConfig(req.headers);
  return cfg.initialized ? cfg.authSecret : null;
}

/** Public verifier registered by the authenticated host when sharing. */
export async function GET(req: NextRequest) {
  const secret = await signingSecret(req);
  if (!secret) return NextResponse.json({ ok: false, error: "Sign in to this Sushi account first." }, { status: 401, headers });
  return NextResponse.json({ ok: true, publicKey: shareTicketPublicKey(secret) }, { headers });
}

/** A bearer ticket usable only for this share on its pinned gateway, for 60 seconds. */
export async function POST(req: NextRequest) {
  const secret = await signingSecret(req);
  if (!secret) return NextResponse.json({ ok: false, error: "Sign in to this Sushi account first." }, { status: 401, headers });
  try {
    const body = await req.json() as { shareId?: unknown; gateway?: unknown };
    const shareId = typeof body.shareId === "string" ? body.shareId : "";
    const gateway = typeof body.gateway === "string" ? normalizeShareGateway(body.gateway) : "";
    if (!isShareId(shareId) || !gateway) throw new Error("Invalid share or gateway.");
    return NextResponse.json({ ok: true, ticket: issueShareTicket(secret, shareId, gateway) }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: "A valid share ID and gateway address are required." }, { status: 400, headers });
  }
}
