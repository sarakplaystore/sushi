import crypto from "node:crypto";
import { isShareId, normalizeShareGateway } from "@/lib/share-gateway";

/**
 * A frontend can prove a signed-in account to a separate gateway without sending
 * the account session or the all-powerful gateway token to a share guest. Each
 * share pins the public key supplied by its authenticated publisher. Tickets are
 * short-lived and bound to one share and the gateway address selected by that host.
 */
const PRIVATE_KEY_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const TICKET_LIFETIME_SECONDS = 60;

function signingKey(secret: string): crypto.KeyObject {
  const seed = Buffer.from(crypto.hkdfSync(
    "sha256", secret, "sushi-share-ticket-v1", "ed25519-signing-key", 32
  ));
  return crypto.createPrivateKey({
    key: Buffer.concat([PRIVATE_KEY_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export function shareTicketPublicKey(secret: string): string {
  return crypto.createPublicKey(signingKey(secret))
    .export({ type: "spki", format: "der" }).toString("base64url");
}

export interface ShareAccountIssuer {
  publicKey: string;
  audience: string;
}

export function parseShareAccountIssuer(value: unknown): ShareAccountIssuer | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.publicKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(candidate.publicKey) ||
      typeof candidate.audience !== "string") return null;
  try {
    const audience = normalizeShareGateway(candidate.audience);
    if (!audience || audience !== candidate.audience) return null;
    const key = crypto.createPublicKey({ key: Buffer.from(candidate.publicKey, "base64url"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    // Reject alternative/non-canonical encodings of the same key.
    if (key.export({ format: "der", type: "spki" }).toString("base64url") !== candidate.publicKey) return null;
    return { publicKey: candidate.publicKey, audience };
  } catch {
    return null;
  }
}

export function issueShareTicket(secret: string, shareId: string, audience: string, now = Date.now()): string {
  if (!isShareId(shareId) || !audience || normalizeShareGateway(audience) !== audience) {
    throw new Error("A valid share ID and gateway address are required.");
  }
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1, purpose: "share-join", shareId, audience, iat, exp: iat + TICKET_LIFETIME_SECONDS,
  })).toString("base64url");
  return `${payload}.${crypto.sign(null, Buffer.from(payload), signingKey(secret)).toString("base64url")}`;
}

export function verifyShareTicket(
  token: unknown,
  shareId: string,
  issuer: ShareAccountIssuer | null,
  now = Date.now()
): boolean {
  if (!issuer || typeof token !== "string" || token.length > 4096) return false;
  const pieces = token.split(".");
  if (pieces.length !== 2 || !pieces.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const [payload, signature] = pieces;
    const key = crypto.createPublicKey({ key: Buffer.from(issuer.publicKey, "base64url"), format: "der", type: "spki" });
    if (!crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const seconds = Math.floor(now / 1000);
    return claims.v === 1 && claims.purpose === "share-join" && claims.shareId === shareId &&
      claims.audience === issuer.audience && typeof claims.iat === "number" && Number.isInteger(claims.iat) &&
      typeof claims.exp === "number" && Number.isInteger(claims.exp) && claims.iat <= seconds + 30 &&
      claims.iat >= seconds - TICKET_LIFETIME_SECONDS - 30 && claims.exp > seconds &&
      claims.exp > claims.iat && claims.exp <= claims.iat + TICKET_LIFETIME_SECONDS;
  } catch {
    return false;
  }
}
