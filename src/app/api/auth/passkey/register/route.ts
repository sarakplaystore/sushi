import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { StoredPasskeyRecord } from "@/types/auth";
import {
  createChallengeToken,
  getEffectiveAuthConfig,
  issueSignedPasskeyCertificate,
  resolveWebAuthnRpFromRequest,
  saveServerPasskey,
  verifyChallengeToken,
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
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: 401, headers: cors }
    );
  }

  const cfg = await getEffectiveAuthConfig();
  if (!cfg.initialized) {
    return NextResponse.json(
      { ok: false, error: "Admin account is not initialized." },
      { status: 400, headers: cors }
    );
  }

  try {
    const body = (await req.json()) as {
      step?: "options" | "verify";
      signedCertificates?: string[];
      challengeToken?: string;
      label?: string;
      attestation?: RegistrationResponseJSON;
    };

    const { rpID, origin, rpName } = resolveWebAuthnRpFromRequest(req);

    if (body.step === "options") {
      const certKeys = verifySignedPasskeyCertificates(
        body.signedCertificates,
        cfg.username,
        cfg.authSecret
      );
      const existingIds = new Set<string>();
      const excludeCredentials: Array<{ id: string; transports?: string[] }> = [];

      for (const k of [...cfg.serverPasskeys, ...certKeys]) {
        if (!existingIds.has(k.id)) {
          existingIds.add(k.id);
          excludeCredentials.push({
            id: k.id,
            transports: k.transports,
          });
        }
      }

      const userIdBytes = new Uint8Array(
        crypto.createHash("sha256").update(`sushi-user:${cfg.username}`).digest()
      );

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: userIdBytes,
        userName: cfg.username,
        userDisplayName: `${cfg.username} (Sushi Admin)`,
        attestationType: "none",
        excludeCredentials,
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      const challengeToken = createChallengeToken(
        {
          challenge: options.challenge,
          rpID,
          origin,
          purpose: "register",
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
      if (!body.challengeToken || !body.attestation) {
        return NextResponse.json(
          { ok: false, error: "Missing WebAuthn challengeToken or attestation response." },
          { status: 400, headers: cors }
        );
      }

      const challengeClaims = verifyChallengeToken(
        body.challengeToken,
        "register",
        cfg.authSecret
      );
      if (!challengeClaims) {
        return NextResponse.json(
          { ok: false, error: "Passkey registration challenge expired or invalid." },
          { status: 400, headers: cors }
        );
      }

      const verification = await verifyRegistrationResponse({
        response: body.attestation,
        expectedChallenge: challengeClaims.challenge,
        expectedOrigin: challengeClaims.origin,
        expectedRPID: challengeClaims.rpID,
        requireUserVerification: false,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return NextResponse.json(
          { ok: false, error: "Passkey attestation signature could not be verified." },
          { status: 400, headers: cors }
        );
      }

      const {
        credential,
        credentialDeviceType,
        credentialBackedUp,
      } = verification.registrationInfo;

      const record: StoredPasskeyRecord = {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports || body.attestation.response.transports,
        label: (body.label || "").trim() || "Passkey",
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: Date.now(),
      };

      const persistedOnServer = await saveServerPasskey(record);
      const signedCertificate = issueSignedPasskeyCertificate(
        record,
        cfg.username,
        cfg.authSecret
      );

      return NextResponse.json(
        {
          ok: true,
          persistedOnServer,
          passkey: {
            id: record.id,
            label: record.label,
            deviceType: record.deviceType,
            backedUp: record.backedUp,
            createdAt: record.createdAt,
            source: persistedOnServer ? "server" : "certificate",
          },
          signedCertificate,
        },
        { headers: cors }
      );
    }

    return NextResponse.json(
      { ok: false, error: "Invalid passkey registration step." },
      { status: 400, headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Passkey registration failed.",
      },
      { status: 400, headers: cors }
    );
  }
}
