import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";
import { verifyAdminSession } from "@/lib/server/auth";
import { isServerVaultEnabled, parseVaultEnvelope, readStoredVault, saveStoredVault } from "@/lib/server/vault-store";
import { getStateStoreKind } from "@/lib/server/state-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req.headers.get("origin")) });
}

export async function GET(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  try {
    const auth = await verifyAdminSession(req.headers);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
    if (!isServerVaultEnabled()) {
      return NextResponse.json({ ok: true, enabled: false, envelope: null, revision: null }, { headers: cors });
    }
    const current = await readStoredVault();
    return NextResponse.json({
      ok: true,
      enabled: true,
      envelope: current?.envelope ?? null,
      revision: current?.revision ?? null,
    }, { headers: cors });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Could not read the encrypted vault.",
    }, { status: 503, headers: cors });
  }
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  try {
    const auth = await verifyAdminSession(req.headers);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
    if (!isServerVaultEnabled()) {
      return NextResponse.json({ ok: false, enabled: false, error: "Persistent vault storage is not enabled." }, { status: 400, headers: cors });
    }
    let body: { envelope?: unknown; baseRevision?: unknown };
    try {
      body = await req.json() as typeof body;
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid vault request." }, { status: 400, headers: cors });
    }
    const envelope = parseVaultEnvelope(body?.envelope);
    if (!envelope || (body.baseRevision !== undefined && body.baseRevision !== null && typeof body.baseRevision !== "string")) {
      return NextResponse.json({ ok: false, error: "Invalid encrypted vault envelope or revision." }, { status: 400, headers: cors });
    }
    // Vercel limits request bodies; Firestore's atomic transaction limit also
    // requires a bounded snapshot, even on a self-hosted deployment.
    const maxBytes = process.env.VERCEL === "1" || getStateStoreKind() === "firestore"
      ? 4 * 1024 * 1024 : 32 * 1024 * 1024;
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxBytes) {
      return NextResponse.json({ ok: false, error: "The encrypted vault is too large for this deployment to synchronize." }, { status: 413, headers: cors });
    }
    const current = await readStoredVault();
    // Old clients did not send a revision. Let them create a first vault, but
    // never let them overwrite an existing one without an explicit base.
    if (current && body.baseRevision === undefined) {
      return NextResponse.json({ ok: false, error: "Refresh Sushi before saving: a vault revision is required." }, { status: 428, headers: cors });
    }
    if ((body.baseRevision ?? null) !== (current?.revision ?? null)) {
      return NextResponse.json({ ok: false, conflict: true, error: "The vault changed on another device. Reload the latest vault before saving." }, { status: 409, headers: cors });
    }
    const result = await saveStoredVault(current, envelope);
    if (!result.ok) {
      return NextResponse.json({ ok: false, conflict: true, error: "The vault changed on another device. Reload the latest vault before saving." }, { status: 409, headers: cors });
    }
    return NextResponse.json({ ok: true, enabled: true, revision: result.revision }, { headers: cors });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Failed to persist encrypted vault.",
    }, { status: 503, headers: cors });
  }
}
