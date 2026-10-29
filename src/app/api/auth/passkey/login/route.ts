import { NextRequest, NextResponse } from "next/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type { StoredPasskeyRecord } from "@/types/auth";
import {
  attachSessionCookie,
  createChallengeToken,
  createSessionToken,
  getEffectiveAuthConfig,
  resolveWebAuthnRpFromRequest,
  saveServerPasskey,
  verifyChallengeToken,
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
  const cfg = await getEffectiveAuthConfig();

  if (!cfg.initialized) {
    return NextResponse.json(
      { ok: false, error: "Admin account is not initialized yet." },
      { status: 400, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as {
      step?: "options" | "verify";
      signedCertificates?: string[];
      challengeToken?: string;
      assertion?: AuthenticationResponseJSON;
    };

    const { rpID, origin } = resolveWebAuthnRpFromRequest(req);
    const certKeys = verifySignedPasskeyCertificates(
      body.signedCertificates,
      cfg.username,
      cfg.authSecret
    );

    const keyMap = new Map<string, StoredPasskeyRecord>();
    for (const k of [...certKeys, ...cfg.serverPasskeys]) {
      keyMap.set(k.id, k);
    }

    if (body.step === "options") {
      if (keyMap.size === 0) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "No Passkeys registered yet. Sign in with your username and password first, then add a Passkey in Account & Passkeys.",
          },
          { status: 404, headers: cors }
        );
      }

      const allowCredentials = Array.from(keyMap.values()).map((k) => ({
        id: k.id,
        transports: k.transports,
      }));

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials,
        userVerification: "preferred",
      });

      const challengeToken = createChallengeToken(
        {
          challenge: options.challenge,
          rpID,
          origin,
          purpose: "login",
        },
        cfg.authSecret
      );

      return NextResponse.json(
        {
          ok: true,
          options,
          challengeToken,
        },
        { headers: cors }
      );
    }

    if (body.step === "verify") {
      if (!body.challengeToken || !body.assertion) {
        return NextResponse.json(
          { ok: false, error: "Missing passkey challengeToken or assertion." },
          { status: 400, headers: cors }
        );
      }

      const challengeClaims = verifyChallengeToken(
        body.challengeToken,
        "login",
        cfg.authSecret
      );
      if (!challengeClaims) {
        return NextResponse.json(
          { ok: false, error: "Passkey login challenge expired. Please try again." },
          { status: 400, headers: cors }
        );
      }

      const matchingKey = keyMap.get(body.assertion.id);
      if (!matchingKey) {
        return NextResponse.json(
          { ok: false, error: "Unrecognized Passkey credential for this account." },
          { status: 401, headers: cors }
        );
      }

      const verification = await verifyAuthenticationResponse({
        response: body.assertion,
        expectedChallenge: challengeClaims.challenge,
        expectedOrigin: challengeClaims.origin,
        expectedRPID: challengeClaims.rpID,
        requireUserVerification: false,
        credential: {
          id: matchingKey.id,
          publicKey: new Uint8Array(Buffer.from(matchingKey.publicKey, "base64url")),
          counter: matchingKey.counter,
          transports: matchingKey.transports,
        },
      });

      if (!verification.verified) {
        return NextResponse.json(
          { ok: false, error: "Passkey cryptographic signature verification failed." },
          { status: 401, headers: cors }
        );
      }

      // Update counter & lastUsedAt on disk when persistent storage is available
      await saveServerPasskey({
        ...matchingKey,
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: Date.now(),
      });

      const sessionToken = createSessionToken(cfg.username, cfg.authSecret);
      const res = NextResponse.json(
        {
          ok: true,
          username: cfg.username,
          sessionToken,
        },
        { headers: cors }
      );
      attachSessionCookie(res, sessionToken, req);
      return res;
    }

    return NextResponse.json(
      { ok: false, error: "Invalid passkey login step." },
      { status: 400, headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Passkey sign-in failed.",
      },
      { status: 400, headers: cors }
    );
  }
}
