import {
  decryptVaultEnvelope,
  encryptVaultData,
  type EncryptedVaultEnvelope,
  type VaultPlaintext,
} from "./crypto-vault";
import { replaceLocalVaultSnapshotIfUnchanged } from "./vault-sync";

/** Verify a portable backup before replacing any existing browser data. */
export async function readPortableBackup(text: string, passphrase: string): Promise<VaultPlaintext> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid encrypted backup."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid encrypted backup.");
  const envelope = value as Partial<EncryptedVaultEnvelope>;
  if (envelope.version !== 1 || envelope.mode !== "passphrase" ||
      typeof envelope.iv !== "string" || typeof envelope.salt !== "string" ||
      typeof envelope.ciphertext !== "string") {
    throw new Error("Choose a portable passphrase-encrypted Sushi backup.");
  }
  return decryptVaultEnvelope(envelope as EncryptedVaultEnvelope, passphrase, { requireVaultData: true });
}

/** Call only after the user confirms replacement; the lock rejects stale tabs. */
export async function replaceLocalVaultFromBackup(
  plain: VaultPlaintext,
  expected: string | null
): Promise<void> {
  const replacement = await encryptVaultData(plain, null);
  await replaceLocalVaultSnapshotIfUnchanged(expected, replacement);
}
