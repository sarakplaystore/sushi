import type { WhitelistedSshKey } from "@/types/connection";
import type { EncryptedVaultEnvelope } from "./crypto-vault";
import type { TermixImportSummary } from "./termix-porter";
import { isTermixMetadataJson, looksLikeTermixDatabaseFile } from "./termix-sqlite";
import { importSshClientText } from "./ssh-import";
import { decodeImportText, expandImportFiles, type SelectedImportFile } from "./ssh-import-files";
import { randomUUID } from "./web-crypto";

export type PreparedImport =
  | { kind: "preview"; summary: TermixImportSummary; name: string }
  | { kind: "vault"; envelope: EncryptedVaultEnvelope; name: string; warnings: string[] }
  | { kind: "termix-sqlite"; file: SelectedImportFile; metaJson?: string; envText?: string; warnings: string[] };

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;

interface SelectedKey { name: string; key: WhitelistedSshKey }
function privateKeyFile(text: string): string | undefined {
  const value = text.trim();
  return /^(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|PuTTY-User-Key-File-\d+:)/.test(value) ? value : undefined;
}
function keyBasename(path: string): string {
  let value = path.replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop() || "";
  try { value = decodeURIComponent(value); } catch { /* keep literal filename */ }
  return value.toLowerCase();
}
function findSelectedKey(reference: string, selected: SelectedKey[]): WhitelistedSshKey | undefined {
  if (!reference || /^(?!file:\/\/)[a-z][a-z0-9+.-]*:\/\//i.test(reference)) return undefined;
  const base = keyBasename(reference);
  if (!base) return undefined;
  const exact = selected.filter((entry) => keyBasename(entry.name) === base);
  const stem = (name: string) => name.replace(/\.(?:pem|key|ppk)$/i, "");
  const candidates = exact.length ? exact : selected.filter((entry) => stem(keyBasename(entry.name)) === stem(base));
  // Never guess when two different selected keys have the same filename.
  const unique = new Map(candidates.map((entry) => [entry.key.id, entry.key]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function isSqlite(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && new TextDecoder().decode(bytes.subarray(0, 16)) === "SQLite format 3\0";
}
function databaseCandidate(file: SelectedImportFile): boolean {
  if (isSqlite(file.bytes) || /\.(?:sqlite3?|db|encrypted)$/i.test(file.name)) return true;
  // UTF-16 text contains NUL bytes; do not mistake it for an encrypted database.
  const sample = file.bytes.subarray(0, Math.min(512, file.bytes.length));
  let evenZeros = 0, oddZeros = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddZeros++; else evenZeros++; }
  if ((file.bytes[0] === 0xff && file.bytes[1] === 0xfe) || (file.bytes[0] === 0xfe && file.bytes[1] === 0xff) ||
    evenZeros > sample.length / 6 || oddZeros > sample.length / 6) return false;
  return looksLikeTermixDatabaseFile(file.bytes, file.name);
}
function isEnvFile(name: string): boolean {
  return /(?:^|\/)(?:\.env|termix\.env)$/i.test(name);
}
function vaultFromText(text: string): EncryptedVaultEnvelope | null {
  if (!text.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!("ciphertext" in obj) || !("iv" in obj)) return null;
  if (obj.version !== 1 || (obj.mode !== "passphrase" && obj.mode !== "device") ||
    typeof obj.iv !== "string" || typeof obj.ciphertext !== "string" ||
    (obj.mode === "passphrase" && typeof obj.salt !== "string")) {
    throw new Error("This encrypted Sushi backup is incomplete or uses an unsupported version.");
  }
  return obj as unknown as EncryptedVaultEnvelope;
}

/** Prepare a preview without mutating the vault. Everything remains in the browser. */
export function prepareSshImport(inputs: SelectedImportFile[], existingKeys: WhitelistedSshKey[] = []): PreparedImport {
  if (!inputs.length) throw new Error("Choose an SSH client export or backup file first.");
  const expanded = expandImportFiles(inputs);
  const warnings = [...expanded.warnings];
  const databases: SelectedImportFile[] = [];
  const documents: Array<{ file: SelectedImportFile; text: string }> = [];
  const selectedKeys: SelectedKey[] = [];
  const newKeys: WhitelistedSshKey[] = [];
  let metaJson: string | undefined;
  let envText: string | undefined;
  for (const file of expanded.files) {
    if (/(?:^|\/)Manifest\.db$/i.test(file.name) && isSqlite(file.bytes)) {
      throw new Error("This is an Apple device backup manifest, not an SSH client export. Restore the device or extract the SSH app's data and export a supported file from that app.");
    }
    if (databaseCandidate(file)) { databases.push(file); continue; }
    if (isEnvFile(file.name)) {
      if (file.bytes.length > MAX_ENV_BYTES) throw new Error("The Termix .env file exceeds 256 KB.");
      if (envText !== undefined) throw new Error("Select only one Termix .env file at a time.");
      envText = decodeImportText(file.bytes); continue;
    }
    if (file.bytes.length > MAX_TEXT_BYTES) throw new Error(`"${file.name}" exceeds the 10 MB text import limit.`);
    const text = decodeImportText(file.bytes);
    const privateKey = privateKeyFile(text);
    if (privateKey) {
      let key = [...existingKeys, ...newKeys].find((entry) => entry.privateKey.trim() === privateKey);
      if (!key) {
        key = { id: randomUUID(), name: file.name.split(/[\\/]/).pop() || "Imported SSH key", privateKey, createdAt: Date.now() };
        newKeys.push(key);
      }
      selectedKeys.push({ name: file.name, key });
      if (privateKey.startsWith("PuTTY-User-Key-File-")) warnings.push("PuTTY keys are supported only for .ppk v2 RSA. Convert other .ppk keys to OpenSSH with PuTTYgen.");
      continue;
    }
    if (/\.meta$/i.test(file.name) || (file.bytes.length < 8192 && isTermixMetadataJson(text))) {
      if (metaJson !== undefined) throw new Error("Select only one Termix .meta file at a time.");
      metaJson = text;
    } else documents.push({ file, text });
  }
  if (databases.length > 1) throw new Error("Import one Termix SQLite database at a time.");
  if (databases.length) {
    if (selectedKeys.length) throw new Error("Import the Termix database separately from SSH key files.");
    for (const doc of documents) {
      // Do not silently drop a second, supported client export in a mixed selection.
      let supported = Boolean(vaultFromText(doc.text));
      if (!supported) {
        try { importSshClientText(doc.text, doc.file.name, existingKeys); supported = true; } catch { /* unrelated archive entry */ }
      }
      if (supported) throw new Error("Import the Termix database separately from other SSH client exports or Sushi backups.");
      warnings.push(`Skipped ${doc.file.name}: not a supported export.`);
    }
    return { kind: "termix-sqlite", file: databases[0], metaJson, envText, warnings };
  }
  if (metaJson !== undefined && !documents.length && !selectedKeys.length) throw new Error("Select the Termix .meta file together with its encrypted SQLite database.");
  const vaults = documents.map((d) => ({ ...d, envelope: vaultFromText(d.text) })).filter((d) => d.envelope);
  if (vaults.length) {
    if (vaults.length > 1) throw new Error("Restore one Sushi vault backup at a time.");
    if (selectedKeys.length) throw new Error("Restore the Sushi backup separately from SSH key files.");
    for (const doc of documents) {
      if (doc.file === vaults[0].file) continue;
      try { importSshClientText(doc.text, doc.file.name, existingKeys); }
      catch { warnings.push(`Skipped ${doc.file.name}: not a supported export.`); continue; }
      throw new Error("Restore the Sushi backup separately from other SSH client exports.");
    }
    return { kind: "vault", envelope: vaults[0].envelope!, name: vaults[0].file.name, warnings };
  }
  if (metaJson !== undefined) warnings.push("The Termix .meta file was ignored because no database was selected.");
  if (envText !== undefined) warnings.push("The Termix .env file was ignored because no database was selected.");
  const hosts: TermixImportSummary["hosts"] = [];
  const sshKeys: TermixImportSummary["sshKeys"] = [...newKeys];
  const snippets: NonNullable<TermixImportSummary["snippets"]> = [];
  const formats = new Set<TermixImportSummary["detectedFormat"]>();
  const importedNames: string[] = selectedKeys.map((entry) => entry.name);
  if (selectedKeys.length) {
    formats.add("ssh-keys");
    warnings.push("Selected private key files will be added to the keychain. Verify automatically matched keys, assign any remaining keys, and enter key passphrases in the host editor if needed.");
  }
  let firstError: Error | null = null;
  for (const doc of documents) {
    try {
      const result = importSshClientText(doc.text, doc.file.name, [...existingKeys, ...sshKeys]);
      if (!result.hosts.length && !result.sshKeys.length && !result.snippets?.length) throw new Error("No importable hosts or keys in this file. " + result.warnings.slice(0, 3).join(" "));
      const references = result.keyReferences ?? {};
      let unresolvedKeys = 0;
      const resolvedHosts = result.hosts.map((host) => {
        if (!(host.id in references)) return host;
        const key = findSelectedKey(references[host.id], selectedKeys);
        if (!key) { unresolvedKeys++; return host; }
        return { ...host, sshKeyId: key.id, privateKey: key.privateKey };
      });
      hosts.push(...resolvedHosts); sshKeys.push(...result.sshKeys); snippets.push(...(result.snippets ?? []));
      formats.add(result.detectedFormat); importedNames.push(doc.file.name);
      warnings.push(...result.warnings
        .filter((warning) => unresolvedKeys > 0 || !warning.startsWith("Some hosts reference a private key or SSH agent"))
        .map((warning) => `${doc.file.name}: ${warning}`));
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Unrecognized file.");
      firstError ??= error;
      warnings.push(`Skipped ${doc.file.name}: ${error.message}`);
    }
  }
  if (!importedNames.length) {
    if (firstError) throw firstError;
    throw new Error("No supported SSH client exports were found. iCloud device backups must first be restored or exported from the original app.");
  }
  const format = importedNames.length === 1 ? [...formats][0] : "multiple-files";
  return { kind: "preview", name: importedNames.length === 1 ? importedNames[0] : `${importedNames.length} selected files`,
    summary: { hosts, sshKeys, snippets, detectedFormat: format, warnings: warnings.slice(0, 120) } };
}
