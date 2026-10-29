import { NextRequest, NextResponse } from "next/server";
import {
  generateEd25519KeyPair,
  inspectPrivateKey,
} from "@/lib/server/ssh-key-utils";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";

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
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as {
      action?: "inspect" | "generate";
      privateKey?: string;
      passphrase?: string;
      label?: string;
    };

    if (body.action === "generate") {
      const kp = generateEd25519KeyPair(body.label || "sushi-ssh-key");
      return NextResponse.json(
        {
          ok: true,
          privateKey: kp.privateKey,
          publicKeyOpenSSH: kp.publicKey,
          fingerprint: kp.record.fingerprint,
          keyType: kp.record.keyType,
        },
        { headers: cors }
      );
    }

    if (!body.privateKey?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Private key is required." },
        { status: 400, headers: cors }
      );
    }

    const inspected = inspectPrivateKey(
      body.privateKey,
      body.passphrase,
      body.label
    );

    return NextResponse.json(
      {
        ok: true,
        ...inspected,
      },
      { headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to parse SSH private key.",
      },
      { status: 400, headers: cors }
    );
  }
}
