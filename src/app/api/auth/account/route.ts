import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import {
  attachAdminProfileCookie,
  attachSessionCookie,
  createSessionToken,
  getEffectiveAuthConfig,
  mergePasskeySummaries,
  removeServerPasskey,
  updateAdminCredentials,
  verifyAdminSession,
  verifySignedPasskeyCertificates,
} from "@/lib/server/auth";
import { isServerVaultEnabled, readStoredVault } from "@/lib/server/vault-store";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyAdminSession(req.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  let signedCerts: string[] = [];
  let adminProfileCert: string | undefined;

  try {
    const body = await req.json();
    if (Array.isArray(body?.signedCertificates)) {
      signedCerts = body.signedCertificates;
    }
    if (typeof body?.adminProfileCert === "string") {
      adminProfileCert = body.adminProfileCert;
    }
  } catch {
    // ignore
  }

  try {
    const cfg = await getEffectiveAuthConfig(req.headers, adminProfileCert);

    const certKeys = verifySignedPasskeyCertificates(
      signedCerts,
      cfg.username,
      cfg.authSecret
    );
    const passkeys = mergePasskeySummaries(cfg.serverPasskeys, certKeys);

    // Exportable JSON array for SUSHI_PASSKEYS_JSON
    const exportMap = new Map<string, unknown>();
    for (const k of [...certKeys, ...cfg.serverPasskeys]) {
      exportMap.set(k.id, k);
    }

    return NextResponse.json(
      {
        ok: true,
        username: cfg.username,
        canBootstrapOnDisk: cfg.canBootstrapOnDisk,
        canEditCredentials: !cfg.envConfigured,
        envConfigured: cfg.envConfigured,
        passkeys,
        passkeysEnvJson: JSON.stringify(Array.from(exportMap.values())),
      },
      { headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Account operation failed.",
      },
      { status: 400, headers: cors }
    );
  }
}

export async function PUT(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyAdminSession(req.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as {
      currentPassword?: string;
      newUsername?: string;
      newPassword?: string;
      adminProfileCert?: string;
    };

    const cfg = await getEffectiveAuthConfig(
      req.headers,
      body?.adminProfileCert
    );

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

    if (
      !body?.currentPassword ||
      !(await cfg.verifyPassword(body.currentPassword))
    ) {
      return NextResponse.json(
        { ok: false, error: "Current password is incorrect." },
        { status: 401, headers: cors }
      );
    }

    // A password-bound vault must first be safely re-encrypted with the old
    // password as an independent passphrase. Guard its exact revision during
    // the account update, so a concurrent device cannot undo that preparation.
    let vaultGuard: { raw: string | null } | undefined;
    if (body.newPassword && isServerVaultEnabled()) {
      const vault = await readStoredVault();
      if (vault?.envelope.keySource === "account") {
        return NextResponse.json({ ok: false, error: "Unlock the shared vault in the latest Sushi app before changing the account password." }, { status: 409, headers: cors });
      }
      vaultGuard = { raw: vault?.raw ?? null };
    }
    const targetUser = (body.newUsername || cfg.username).trim();
    const updated = await updateAdminCredentials(
      cfg,
      targetUser,
      body.newPassword,
      body.currentPassword,
      vaultGuard
    );

    const sessionToken = createSessionToken(targetUser, cfg.authSecret, updated.sessionVersion);

    const res = NextResponse.json(
      {
        ok: true,
        username: targetUser,
        sessionToken,
        adminProfileCert: updated.adminProfileCert,
      },
      { headers: cors }
    );
    attachSessionCookie(res, sessionToken, req);
    if (updated.adminProfileCert) {
      attachAdminProfileCookie(res, updated.adminProfileCert, req);
    }
    return res;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error ? err.message : "Failed to update credentials.",
      },
      { status: 400, headers: cors }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyAdminSession(req.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as {
      credentialId?: string;
    };

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
