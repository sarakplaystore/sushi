/**
 * Client-side storage for session tokens, signed WebAuthn passkey certificates,
 * and interactive stateless admin profile certificates.
 *
 * Security model:
 * - Passkey certificates store ONLY WebAuthn COSE public keys + HMAC-SHA256
 *   signatures signed by the server's secret.
 * - Admin profile certificates store ONLY scrypt password hashes + HMAC-SHA256
 *   signatures — NEVER plaintext passwords or private keys.
 */

const SESSION_TOKEN_KEY = "sushi.auth.sessionToken.v1";
const ADMIN_PROFILE_CERT_KEY = "sushi.auth.adminProfileCert.v1";
const SIGNED_PASSKEYS_KEY = "sushi.auth.passkeyCerts.v1";

export interface StoredClientPasskeyCert {
  id: string;
  cert: string;
}

export function getStoredSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SESSION_TOKEN_KEY);
}

export function setStoredSessionToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  }
}

export function getStoredAdminProfileCert(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ADMIN_PROFILE_CERT_KEY);
}

export function setStoredAdminProfileCert(cert: string | null): void {
  if (typeof window === "undefined") return;
  if (cert) {
    localStorage.setItem(ADMIN_PROFILE_CERT_KEY, cert);
  } else {
    localStorage.removeItem(ADMIN_PROFILE_CERT_KEY);
  }
}

export function getStoredPasskeyCertificates(): StoredClientPasskeyCert[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SIGNED_PASSKEYS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addStoredPasskeyCertificate(id: string, cert: string): void {
  if (typeof window === "undefined") return;
  const existing = getStoredPasskeyCertificates().filter((c) => c.id !== id);
  existing.push({ id, cert });
  localStorage.setItem(SIGNED_PASSKEYS_KEY, JSON.stringify(existing));
}

export function removeStoredPasskeyCertificate(id: string): void {
  if (typeof window === "undefined") return;
  const next = getStoredPasskeyCertificates().filter((c) => c.id !== id);
  localStorage.setItem(SIGNED_PASSKEYS_KEY, JSON.stringify(next));
}
