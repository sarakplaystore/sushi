import { NextRequest, NextResponse } from "next/server";
import type { AuthorizedKeyRecord } from "@/types/auth";
import {
  attachAdminProfileCookie,
  attachSessionCookie,
  bootstrapAdminAccount,
  createSessionToken,
  getEffectiveAuthConfig,
  issueSignedAuthorizedKeyCertificate,
} from "@/lib/server/auth";
import {
  generateEd25519KeyPair,
  parseAuthorizedKeysBlock,
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

  try {
    const body = (await req.json()) as {
      username?: string;
      password?: string;
      initialPublicKeys?: string;
      generateMasterKey?: boolean;
      adminProfileCert?: string;
    };

    const current = await getEffectiveAuthConfig(
      req.headers,
      body?.adminProfileCert
    );
    if (current.initialized) {
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

    const initialAuthorizedKeys: AuthorizedKeyRecord[] = [];
    if (body.initialPublicKeys?.trim()) {
      const parsed = parseAuthorizedKeysBlock(body.initialPublicKeys);
      if (parsed.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Could not parse the provided SSH public key(s). Expected format like 'ssh-ed25519 AAAAC3...'.",
          },
          { status: 400, headers: cors }
        );
      }
      initialAuthorizedKeys.push(...parsed);
    }

    let generatedPrivateKey: string | undefined;
    let generatedKeyRecord: AuthorizedKeyRecord | undefined;

    if (body.generateMasterKey) {
      const kp = generateEd25519KeyPair(`${body.username.trim()}@sushi`);
      generatedPrivateKey = kp.privateKey;
      generatedKeyRecord = kp.record;
      initialAuthorizedKeys.push(kp.record);
    }

    const created = await bootstrapAdminAccount(
      body.username,
      body.password,
      initialAuthorizedKeys
    );
    const sessionToken = createSessionToken(created.username, created.authSecret);

    const signedKeyCertificates = initialAuthorizedKeys.map((rec) => ({
      fingerprint: rec.fingerprint,
      cert: issueSignedAuthorizedKeyCertificate(
        rec,
        created.username,
        created.authSecret
      ),
    }));

    const res = NextResponse.json(
      {
        ok: true,
        username: created.username,
        sessionToken,
        adminProfileCert: created.adminProfileCert,
        persistedOnDisk: created.persistedOnDisk,
        generatedPrivateKey,
        generatedKeyFingerprint: generatedKeyRecord?.fingerprint,
        signedKeyCertificates,
      },
      { headers: cors }
    );
    attachSessionCookie(res, sessionToken, req);
    attachAdminProfileCookie(res, created.adminProfileCert, req);
    return res;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to initialize admin account.",
      },
      { status: 400, headers: cors }
    );
  }
}
