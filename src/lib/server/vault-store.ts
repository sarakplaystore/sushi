import crypto from "node:crypto";
import type { EncryptedVaultEnvelope } from "@/lib/client/crypto-vault";
import { compareAndSwapStateRecord, hasPersistentStateStore, readStateRecord } from "./state-store";

interface StoredVault {
  raw: string;
  revision: string;
  envelope: EncryptedVaultEnvelope;
}

export function isServerVaultEnabled(): boolean {
  return process.env.SUSHI_SERVER_VAULT !== "false" && hasPersistentStateStore();
}

export function parseVaultEnvelope(input: unknown): EncryptedVaultEnvelope | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  if (data.version !== 1 || (data.mode !== "device" && data.mode !== "passphrase") ||
      typeof data.iv !== "string" || !data.iv ||
      typeof data.ciphertext !== "string" || !data.ciphertext ||
      typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt) ||
      (data.mode === "passphrase" && (typeof data.salt !== "string" || !data.salt)) ||
      (data.keySource !== undefined && data.keySource !== "account" && data.keySource !== "independent" && data.keySource !== "session") ||
      ((data.keySource === "account" || data.keySource === "session") && data.mode !== "passphrase")) {
    return null;
  }
  return {
    version: 1,
    mode: data.mode,
    ...(data.mode === "passphrase" ? { salt: data.salt as string } : {}),
    ...(data.keySource === "account" || data.keySource === "independent" || data.keySource === "session" ? { keySource: data.keySource } : {}),
    iv: data.iv,
    ciphertext: data.ciphertext,
    updatedAt: data.updatedAt,
  };
}

export async function readStoredVault(): Promise<StoredVault | null> {
  const raw = await readStateRecord("vault");
  if (raw === null) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("The stored encrypted vault is corrupt; it has not been replaced.");
  }
  const envelope = parseVaultEnvelope(value);
  if (!envelope) throw new Error("The stored encrypted vault is invalid; it has not been replaced.");
  // Old releases wrote the envelope directly without a revision. A digest of
  // its exact bytes gives those existing files a stable, non-destructive base.
  const revision = typeof value._syncRevision === "string" && value._syncRevision
    ? value._syncRevision
    : `legacy-${crypto.createHash("sha256").update(raw).digest("hex")}`;
  return { raw, revision, envelope };
}

export async function saveStoredVault(
  current: StoredVault | null,
  envelope: EncryptedVaultEnvelope
): Promise<{ ok: boolean; revision: string }> {
  const revision = crypto.randomUUID();
  const raw = JSON.stringify({ ...envelope, _syncRevision: revision }, null, 2);
  const ok = await compareAndSwapStateRecord("vault", current?.raw ?? null, raw);
  return { ok, revision };
}
