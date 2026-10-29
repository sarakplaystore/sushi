const SESSION_TOKEN_KEY = "sushi_session_token_v1";
const SIGNED_PASSKEYS_KEY = "sushi_signed_passkey_certs_v1";
const ADMIN_PROFILE_CERT_KEY = "sushi_admin_profile_cert_v1";
const SIGNED_AUTH_KEYS_KEY = "sushi_signed_auth_key_certs_v1";

export interface StoredClientPasskeyCert {
  id: string;
  cert: string;
}

export interface StoredClientAuthorizedKeyCert {
  fingerprint: string;
  cert: string;
}

export function getStoredSessionToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredSessionToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) {
      localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function getStoredAdminProfileCert(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(ADMIN_PROFILE_CERT_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredAdminProfileCert(cert: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (cert) {
      localStorage.setItem(ADMIN_PROFILE_CERT_KEY, cert);
    } else {
      localStorage.removeItem(ADMIN_PROFILE_CERT_KEY);
    }
  } catch {
    // ignore
  }
}

export function getStoredPasskeyCertificates(): StoredClientPasskeyCert[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SIGNED_PASSKEYS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredClientPasskeyCert =>
        Boolean(item && typeof item.id === "string" && typeof item.cert === "string")
    );
  } catch {
    return [];
  }
}

export function addStoredPasskeyCertificate(id: string, cert: string): void {
  if (typeof window === "undefined") return;
  const current = getStoredPasskeyCertificates().filter((c) => c.id !== id);
  current.push({ id, cert });
  localStorage.setItem(SIGNED_PASSKEYS_KEY, JSON.stringify(current));
}

export function removeStoredPasskeyCertificate(id: string): void {
  if (typeof window === "undefined") return;
  const next = getStoredPasskeyCertificates().filter((c) => c.id !== id);
  localStorage.setItem(SIGNED_PASSKEYS_KEY, JSON.stringify(next));
}

export function getStoredAuthorizedKeyCertificates(): StoredClientAuthorizedKeyCert[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SIGNED_AUTH_KEYS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredClientAuthorizedKeyCert =>
        Boolean(
          item &&
            typeof item.fingerprint === "string" &&
            typeof item.cert === "string"
        )
    );
  } catch {
    return [];
  }
}

export function addStoredAuthorizedKeyCertificate(
  fingerprint: string,
  cert: string
): void {
  if (typeof window === "undefined") return;
  const current = getStoredAuthorizedKeyCertificates().filter(
    (c) => c.fingerprint !== fingerprint
  );
  current.push({ fingerprint, cert });
  localStorage.setItem(SIGNED_AUTH_KEYS_KEY, JSON.stringify(current));
}

export function removeStoredAuthorizedKeyCertificate(fingerprint: string): void {
  if (typeof window === "undefined") return;
  const next = getStoredAuthorizedKeyCertificates().filter(
    (c) => c.fingerprint !== fingerprint
  );
  localStorage.setItem(SIGNED_AUTH_KEYS_KEY, JSON.stringify(next));
}
