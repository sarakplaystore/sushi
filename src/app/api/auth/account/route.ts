import { NextRequest, NextResponse } from "next/server";
import {
  addWhitelistedKey,
  attachAdminProfileCookie,
  attachSessionCookie,
  createSessionToken,
  getEffectiveAuthConfig,
  mergeAuthorizedKeys,
  mergePasskeySummaries,
  removeServerPasskey,
  removeWhitelistedKey,
  updateAdminCredentials,
  verifyIncomingAuth,
  verifySignedAuthorizedKeyCertificates,
  verifySignedPasskeyCertificates,
} from "@/lib/server/auth";
import {
  generateEd25519KeyPair,
  parseAuthorizedPublicKey,
} from "@/lib/server/ssh-key-utils";
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
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  let body: {
    action?: "list" | "add_authorized_key" | "generate_authorized_keypair";
    signedCertificates?: string[];
    signedKeyCertificates?: string[];
    adminProfileCert?: string;
    publicKey?: string;
    label?: string;
    passphrase?: string;
  } = {};

  try {
    body = await req.json();
  } catch {
    // empty body defaults to list
  }

  const cfg = await getEffectiveAuthConfig(req.headers, body.adminProfileCert);

  // Action: Add whitelisted public key
  if (body.action === "add_authorized_key") {
    try {
      if (!body.publicKey?.trim()) {
        return NextResponse.json(
          { ok: false, error: "SSH/PEM public key is required." },
          { status: 400, headers: cors }
        );
      }
      const record = parseAuthorizedPublicKey(
        body.publicKey,
        body.label,
        body.passphrase
      );
      const saved = await addWhitelistedKey(cfg, record);
      const res = NextResponse.json(
        {
          ok: true,
          record,
          signedKeyCert: saved.signedKeyCert,
          adminProfileCert: saved.adminProfileCert,
        },
        { headers: cors }
      );
      if (saved.adminProfileCert) {
        attachAdminProfileCookie(res, saved.adminProfileCert, req);
      }
      return res;
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to whitelist SSH key.",
        },
        { status: 400, headers: cors }
      );
    }
  }

  // Action: Generate fresh Ed25519 login keypair & whitelist its public key
  if (body.action === "generate_authorized_keypair") {
    try {
      const kp = generateEd25519KeyPair(
        body.label?.trim() || `${cfg.username}@sushi`
      );
      const saved = await addWhitelistedKey(cfg, kp.record);
      const res = NextResponse.json(
        {
          ok: true,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          record: kp.record,
          signedKeyCert: saved.signedKeyCert,
          adminProfileCert: saved.adminProfileCert,
        },
        { headers: cors }
      );
      if (saved.adminProfileCert) {
        attachAdminProfileCookie(res, saved.adminProfileCert, req);
      }
      return res;
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to generate SSH keypair.",
        },
        { status: 400, headers: cors }
      );
    }
  }

  // Default: List account info, Passkeys, and Whitelisted Public Keys
  const certPasskeys = verifySignedPasskeyCertificates(
    body.signedCertificates,
    cfg.username,
    cfg.authSecret
  );
  const summaries = mergePasskeySummaries(cfg.serverPasskeys, certPasskeys);

  const rawPasskeyMap = new Map<string, unknown>();
  for (const k of [...certPasskeys, ...cfg.serverPasskeys]) {
    rawPasskeyMap.set(k.id, k);
  }

  const certAuthKeys = verifySignedAuthorizedKeyCertificates(
    body.signedKeyCertificates,
    cfg.username,
    cfg.authSecret
  );
  const authorizedKeys = mergeAuthorizedKeys(cfg.authorizedKeys, certAuthKeys);
  const authorizedKeysEnvBlock = authorizedKeys
    .map((k) => k.publicKeyOpenSSH)
    .join("\n");

  return NextResponse.json(
    {
      ok: true,
      username: cfg.username || auth.username || "admin",
      envConfigured: cfg.envConfigured,
      canEditCredentials: !cfg.envConfigured,
      canEditCredentialsOnDisk: cfg.canBootstrapOnDisk && !cfg.envConfigured,
      passkeys: summaries,
      passkeysEnvJson: JSON.stringify(Array.from(rawPasskeyMap.values())),
      authorizedKeys,
      authorizedKeysEnvBlock,
    },
    { headers: cors }
  );
}

export async function PUT(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyIncomingAuth(req.headers);
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

    const cfg = await getEffectiveAuthConfig(req.headers, body.adminProfileCert);
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

    const targetUser = (body.newUsername || cfg.username).trim();
    const updated = await updateAdminCredentials(
      cfg,
      targetUser,
      body.newPassword
    );

    const sessionToken = createSessionToken(targetUser, cfg.authSecret);

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
  const auth = await verifyIncomingAuth(req.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as {
      credentialId?: string;
      authorizedKeyFingerprint?: string;
      adminProfileCert?: string;
    };

    if (body?.authorizedKeyFingerprint) {
      const cfg = await getEffectiveAuthConfig(
        req.headers,
        body.adminProfileCert
      );
      const removed = await removeWhitelistedKey(
        cfg,
        body.authorizedKeyFingerprint
      );
      const res = NextResponse.json(
        {
          ok: true,
          removedOnDisk: removed.removedOnDisk,
          adminProfileCert: removed.adminProfileCert,
        },
        { headers: cors }
      );
      if (removed.adminProfileCert) {
        attachAdminProfileCookie(res, removed.adminProfileCert, req);
      }
      return res;
    }

    if (!body?.credentialId) {
      return NextResponse.json(
        { ok: false, error: "Missing credentialId or authorizedKeyFingerprint." },
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
        error: err instanceof Error ? err.message : "Failed to revoke key.",
      },
      { status: 400, headers: cors }
    );
  }
}
