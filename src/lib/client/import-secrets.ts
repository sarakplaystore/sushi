/** Explicitly marked ciphertext or external secret references are not passwords. */
export function isUnavailableSecret(value: unknown): boolean {
  return typeof value === "string" && /^(?:enc:|encrypted:|vault:\/\/|keychain:\/\/)/i.test(value.trimStart());
}

/** JSON booleans and common CSV representations of explicit encryption flags. */
export function isEncryptionFlag(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && /^(?:true|yes|1)$/i.test(value.trim()));
}
