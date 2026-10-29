import { NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  createSessionToken,
  getEffectiveAuthConfig,
  mergePasskeySummaries,
  removeServerPasskey,
  updateDiskCredentials,
  verifyIncomingAuth,
  verifySignedPasskeyCertificates,
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
  const auth = await verifyIncomingAuth(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let signedCertificates: string[] | undefined;
  try {
    const body = (await req.json()) as { signedCertificates?: string[] };
    signedCertificates = body?.signedCertificates;
  } catch {
    // ignore
  }

  const cfg = await getEffectiveAuthConfig();
  const certKeys = verifySignedPasskeyCertificates(
    signedCertificates,
    cfg.username,
    cfg.authSecret
  );
  const summaries = mergePasskeySummaries(cfg.serverPasskeys, certKeys);

  // Merge raw records so users on Vercel can optionally copy SUSHI_PASSKEYS_JSON
  const rawMap = new Map<string, unknown>();
  for (const k of [...certKeys, ...cfg.serverPasskeys]) {
    rawMap.set(k.id, k);
  }

  return NextResponse.json(
    {
      ok: true,
      username: cfg.username,
      envConfigured: cfg.envConfigured,
      canEditCredentialsOnDisk: cfg.canBootstrapOnDisk && !cfg.envConfigured,
      passkeys: summaries,
      passkeysEnvJson: JSON.stringify(Array.from(rawMap.values())),
    },
    { headers: cors }
  );
}

export async function PUT(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyIncomingAuth(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  try {
    const cfg = await getEffectiveAuthConfig();
    if (cfg.envConfigured) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Username/password are controlled by SUSHI_AUTH_USERNAME / SUSHI_AUTH_PASSWORD environment variables.",
        },
        { status: 400, headers: cors }
      );
    }

    const body = (await req.json()) as {
      currentPassword?: string;
      newUsername?: string;
      newPassword?: string;
    };

    if (!body?.currentPassword || !(await cfg.verifyPassword(body.currentPassword))) {
      return NextResponse.json(
        { ok: false, error: "Current password is incorrect." },
        { status: 401, headers: cors }
      );
    }

    const targetUser = (body.newUsername || cfg.username).trim();
    await updateDiskCredentials(targetUser, body.newPassword);

    const updatedCfg = await getEffectiveAuthConfig();
    const sessionToken = createSessionToken(
      updatedCfg.username,
      updatedCfg.authSecret
    );

    const res = NextResponse.json(
      {
        ok: true,
        username: updatedCfg.username,
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
        error: err instanceof Error ? err.message : "Failed to update credentials.",
      },
      { status: 400, headers: cors }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyIncomingAuth(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  try {
    const body = (await req.json()) as { credentialId?: string };
    if (!body?.credentialId) {
      return NextResponse.json(
        { ok: false, error: "Missing credentialId." },
        { status: 400, headers: cors }
      );
    }
    const removedFromServer = await removeServerPasskey(body.credentialId);
    return NextResponse.json(
      { ok: true, removedFromServer },
      { headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to revoke passkey.",
      },
      { status: 400, headers: cors }
    );
  }
}
