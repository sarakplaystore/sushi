import type { EncryptedVaultEnvelope } from "./crypto-vault";
import { saveLocalEnvelope } from "./crypto-vault";
import { getAuthHeaders, type GatewaySettings } from "./gateway";

const SYNC_METADATA_KEY = "sushi_vault_sync_v1";

export interface RemoteVault {
  envelope: EncryptedVaultEnvelope | null;
  revision: string | null;
}

interface LocalSyncMetadata {
  revision: string;
  iv: string;
}

export function getLocalSyncMetadata(): LocalSyncMetadata | null {
  try {
    const raw = localStorage.getItem(SYNC_METADATA_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LocalSyncMetadata>;
    return typeof value.revision === "string" && typeof value.iv === "string"
      ? { revision: value.revision, iv: value.iv }
      : null;
  } catch {
    return null;
  }
}

/** Save ciphertext before its revision, so a partial cache update is detected. */
export function cacheSyncedVault(envelope: EncryptedVaultEnvelope, revision: string): boolean {
  try {
    saveLocalEnvelope(envelope);
    localStorage.setItem(SYNC_METADATA_KEY, JSON.stringify({ revision, iv: envelope.iv }));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalSyncMetadata(): void {
  try { localStorage.removeItem(SYNC_METADATA_KEY); } catch { /* no cache */ }
}

export function sameVaultEnvelope(a: EncryptedVaultEnvelope, b: EncryptedVaultEnvelope): boolean {
  return a.version === b.version && a.mode === b.mode && a.keySource === b.keySource &&
    a.salt === b.salt && a.iv === b.iv && a.ciphertext === b.ciphertext;
}

async function jsonResponse(res: Response): Promise<Record<string, unknown>> {
  try { return await res.json() as Record<string, unknown>; } catch { return {}; }
}

export async function fetchRemoteVault(settings: GatewaySettings): Promise<RemoteVault> {
  let res: Response;
  try {
    res = await fetch("/api/vault", { headers: getAuthHeaders(settings), cache: "no-store" });
  } catch {
    throw new Error("Could not reach vault storage. No local or shared data was changed.");
  }
  const data = await jsonResponse(res);
  if (res.status === 401) throw new Error("Your session expired or the account changed. Sign out and sign in again to sync.");
  if (!res.ok || !data.ok || !data.enabled) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not read the shared vault. No data was changed.");
  }
  if (data.envelope === null && data.revision === null) return { envelope: null, revision: null };
  if (!data.envelope || typeof data.envelope !== "object" || typeof data.revision !== "string" || !data.revision) {
    throw new Error("The shared vault response is invalid. No data was changed.");
  }
  return { envelope: data.envelope as EncryptedVaultEnvelope, revision: data.revision };
}

export async function verifyAccountPassword(settings: GatewaySettings, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/auth/verify-password", {
      method: "POST",
      headers: getAuthHeaders(settings),
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new Error("Could not verify the account password. No vault changes were made.");
  }
  const data = await jsonResponse(res);
  if (res.status === 401 && typeof data.error === "string" && data.error.startsWith("Authentication required")) {
    throw new Error("Your session expired or the account changed. Sign out and sign in again to sync.");
  }
  if (!res.ok || !data.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Could not verify the account password.");
  }
}

export async function saveRemoteVault(
  settings: GatewaySettings,
  envelope: EncryptedVaultEnvelope,
  baseRevision: string | null
): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/vault", {
      method: "POST",
      headers: getAuthHeaders(settings),
      body: JSON.stringify({ envelope, baseRevision }),
    });
  } catch {
    // The server might have committed before the connection failed. Never
    // retry blindly; a fresh GET and revision comparison are required.
    throw new Error("Vault save could not be confirmed. Reload the latest vault before trying again; your edits were not marked as saved.");
  }
  const data = await jsonResponse(res);
  if (res.status === 401) throw new Error("Your session expired or the account changed. Sign out and sign in again to sync.");
  if (!res.ok || !data.ok || typeof data.revision !== "string") {
    const message = typeof data.error === "string" ? data.error : "Could not save the encrypted vault.";
    if (res.status >= 500 || (res.ok && !data.revision)) {
      throw new Error(`${message} The save could not be confirmed; reload the latest vault before trying again.`);
    }
    throw new Error(message);
  }
  return data.revision;
}
