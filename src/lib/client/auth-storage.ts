const SESSION_TOKEN_KEY = "sushi_session_token_v1";
const SIGNED_PASSKEYS_KEY = "sushi_signed_passkey_certs_v1";

export interface StoredClientPasskeyCert {
  id: string;
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
