import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, verifyGatewayTokenFromHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getVaultFilePath(): string {
  const dir = process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");
  return path.join(dir, "vault.enc.json");
}

function isServerVaultEnabled(): boolean {
  return process.env.VERCEL !== "1" && process.env.SUSHI_SERVER_VAULT !== "false";
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function GET(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = verifyGatewayTokenFromHeaders(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  if (!isServerVaultEnabled()) {
    return NextResponse.json(
      { ok: true, enabled: false, envelope: null },
      { headers: cors }
    );
  }

  try {
    const raw = await fs.readFile(getVaultFilePath(), "utf8");
    const envelope = JSON.parse(raw);
    return NextResponse.json(
      { ok: true, enabled: true, envelope },
      { headers: cors }
    );
  } catch {
    return NextResponse.json(
      { ok: true, enabled: true, envelope: null },
      { headers: cors }
    );
  }
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = verifyGatewayTokenFromHeaders(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  if (!isServerVaultEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        enabled: false,
        error: "Server-side file vault is disabled on stateless serverless deployments.",
      },
      { status: 400, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as { envelope?: Record<string, unknown> };
    if (!body?.envelope || typeof body.envelope.ciphertext !== "string") {
      return NextResponse.json(
        { ok: false, error: "Invalid encrypted vault envelope." },
        { status: 400, headers: cors }
      );
    }

    const filePath = getVaultFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          ...body.envelope,
          updatedAt: Date.now(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );

    return NextResponse.json({ ok: true, enabled: true }, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to persist encrypted vault.",
      },
      { status: 500, headers: cors }
    );
  }
}
