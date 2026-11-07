import type {
  CommandSnippet,
  HostProfile,
  ProtocolType,
  RdpSecurityMode,
  WhitelistedSshKey,
} from "@/types/connection";
import { isEncryptionFlag, isUnavailableSecret } from "./import-secrets";
import { randomUUID } from "./web-crypto";

/**
 * Termix Host Export & Share Export format (`Termix-SSH/Termix`)
 * Matches `src/backend/hosts/import/host-export.ts` & `host-normalizers.ts`
 * as well as `src/backend/utils/user-data-export.ts` (`v2.0` user data export)
 * and OpenSSH `~/.ssh/config`.
 */
export interface TermixExportCredential {
  id?: number | string;
  alias: string;
  name: string;
  description?: string | null;
  folder?: string | null;
  tags?: string[];
  authType: "password" | "key";
  username?: string | null;
  password?: string | null;
  key?: string | null;
  keyPassword?: string | null;
  keyType?: string | null;
}

export interface TermixExportHost {
  exportId?: number | string;
  connectionType: string;
  name: string;
  ip: string;
  port: number;
  username: string;
  password: string | null;
  folder: string | null;
  tags: string[];
  pin: boolean;
  notes: string | null;
  authType?: string;
  key?: string | null;
  keyPassword?: string | null;
  keyType?: string | null;
  credentialId?: number | string | null;
  credentialAlias?: string;
  overrideCredentialUsername?: boolean;
  enableSsh?: boolean;
  protocolAuth?: Record<
    string,
    {
      authType?: string;
      credentialId?: number | null;
      username?: string | null;
      password?: string | null;
      fields?: Record<string, unknown>;
    }
  >;
  pluginSettings?: Record<string, unknown>;
}

export interface TermixExportFile {
  version: string;
  exportedAt: string;
  credentials?: TermixExportCredential[];
  hosts: TermixExportHost[];
}

export interface TermixImportSummary {
  hosts: HostProfile[];
  sshKeys: WhitelistedSshKey[];
  /** Command snippets (Termix SQLite databases include the `snippets` table). */
  snippets?: CommandSnippet[];
  /** Local key references, used only to match explicitly selected key files. */
  keyReferences?: Record<string, string>;
  detectedFormat:
    | "termix-host-export"
    | "termix-user-data-v2"
    | "termix-sqlite"
    | "ssh-config"
    | "sushi-hosts"
    | "ssh-csv"
    | "ssh-json"
    | "putty-reg"
    | "winscp-ini"
    | "mobaxterm"
    | "tabby"
    | "xshell"
    | "securecrt"
    | "securecrt-xml"
    | "mremoteng"
    | "sshborg"
    | "seven-term"
    | "ssh-keys"
    | "multiple-files";
  warnings: string[];
}

function asCleanString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function asValidPort(v: unknown): number | undefined {
  const num =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number(v)
        : NaN;
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : undefined;
}

function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

function hasSetting(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return !["", "0", "false", "none", "[]"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function normalizeTags(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((item) => asCleanString(item))
      .filter((item): item is string => Boolean(item));
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function defaultColorForProtocol(protocol: ProtocolType): string {
  if (protocol === "rdp") return "#ff6b57";
  if (protocol === "sftp") return "#38bdf8";
  return "#34d399";
}

function parseOpenSshConfigText(content: string): HostProfile[] {
  const results: HostProfile[] = [];
  let current: {
    name: string;
    hostname?: string;
    user?: string;
    port?: number;
  } | null = null;

  const flush = () => {
    if (current && current.hostname) {
      const now = Date.now();
      results.push({
        id: randomUUID(),
        name: current.name,
        protocol: "ssh",
        host: current.hostname,
        port: current.port || 22,
        username: current.user || "root",
        authMethod: "password",
        group: "Imported (SSH Config)",
        accentColor: "#34d399",
        createdAt: now,
        updatedAt: now,
      });
    }
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const val = match[2].trim();

    if (key === "host") {
      flush();
      if (val === "*" || val.includes("*") || val.includes("?")) {
        current = null;
      } else {
        current = { name: val };
      }
      continue;
    }
    if (!current) continue;
    if (key === "hostname") current.hostname = val;
    else if (key === "user") current.user = val;
    else if (key === "port") {
      const p = asValidPort(val);
      if (p) current.port = p;
    }
  }
  flush();
  return results;
}

/**
 * Parses a Termix JSON export (`host-export.ts`, `shareMode`, `user-data-export.ts` v2.0)
 * or OpenSSH config file into Sushi `HostProfile[]` and `WhitelistedSshKey[]`.
 */
export function importFromTermixContent(
  rawContent: string,
  existingSshKeys: WhitelistedSshKey[] = []
): TermixImportSummary {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new Error("The selected import file is empty.");
  }

  // Check if OpenSSH config text instead of JSON
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const sshCfgHosts = parseOpenSshConfigText(trimmed);
    if (sshCfgHosts.length > 0) {
      return {
        hosts: sshCfgHosts,
        sshKeys: [],
        detectedFormat: "ssh-config",
        warnings: [
          "Imported host entries from OpenSSH config. Add passwords or select whitelisted private keys for authentication.",
        ],
      };
    }
    throw new Error(
      "Unrecognized file format. Expected a Termix JSON export (.json) or OpenSSH config."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid JSON file — could not parse Termix export.");
  }

  const warnings: string[] = [];
  let encryptedSecrets = false;
  let rawHosts: Record<string, unknown>[] = [];
  let rawCredentials: Record<string, unknown>[] = [];
  let detectedFormat: TermixImportSummary["detectedFormat"] =
    "termix-host-export";

  if (Array.isArray(parsed)) {
    rawHosts = parsed.filter(
      (x): x is Record<string, unknown> => Boolean(x && typeof x === "object")
    );
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    // Detect Sushi encrypted vault file accidentally uploaded here
    if (obj.ciphertext && obj.iv) {
      throw new Error(
        "This is an AES-256-GCM Encrypted Sushi Vault backup (.enc.json). Use the 'Restore Vault Backup' button instead."
      );
    }

    const meta = (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {}) as Record<string, unknown>;
    if (isEncryptionFlag(obj.encrypted) || isEncryptionFlag(meta.encrypted)) {
      encryptedSecrets = true;
      warnings.push(
        "This Termix export is marked encrypted. Host addresses were imported, but re-export plaintext from Termix to include passwords and private keys."
      );
    }

    // Format A: Termix User Data Export v2.0 (`userData.sshHosts` + `userData.sshCredentials`)
    if (obj.userData && typeof obj.userData === "object") {
      detectedFormat = "termix-user-data-v2";
      const ud = obj.userData as Record<string, unknown>;
      if (Array.isArray(ud.sshHosts)) {
        rawHosts = ud.sshHosts.filter(
          (x): x is Record<string, unknown> => Boolean(x && typeof x === "object")
        );
      }
      if (Array.isArray(ud.sshCredentials)) {
        rawCredentials = ud.sshCredentials.filter(
          (x): x is Record<string, unknown> => Boolean(x && typeof x === "object")
        );
      }
    } else if (Array.isArray(obj.hosts)) {
      // Format B: Termix Host Export / Share Export (`{ hosts: [...], credentials?: [...] }`)
      detectedFormat = "termix-host-export";
      rawHosts = obj.hosts.filter(
        (x): x is Record<string, unknown> => Boolean(x && typeof x === "object")
      );
      if (Array.isArray(obj.credentials)) {
        rawCredentials = obj.credentials.filter(
          (x): x is Record<string, unknown> => Boolean(x && typeof x === "object")
        );
      }
    }
  }

  if (rawHosts.length === 0 && rawCredentials.length === 0) {
    throw new Error("No hosts or SSH credentials found in the Termix file.");
  }

  if (rawHosts.length > 10000 || rawCredentials.length > 10000) throw new Error("Termix exports are limited to 10,000 hosts and credentials per file.");

  const unavailableWarning = "Some credentials are encrypted or reference another secret store and were not imported. Enter them in Sushi after import.";
  const plaintextSecret = (value: unknown, flagged = false): string | undefined => {
    const text = asCleanString(value);
    if (!text) return undefined;
    if (encryptedSecrets || flagged || isUnavailableSecret(value)) {
      if (!encryptedSecrets && !warnings.includes(unavailableWarning)) warnings.push(unavailableWarning);
      return undefined;
    }
    return text;
  };

  const isPrivateKeyMaterial = (value: string | undefined) => Boolean(value && (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(value) || /^PuTTY-User-Key-File-\d+:/i.test(value)));
  const keyReferences: Record<string, string> = Object.create(null);
  const missingKeyWarning = "Some hosts reference a private key or SSH agent that cannot be read from the export. Add the key to Sushi and select it for those hosts.";

  // 1. Import Termix reusable credentials into Sushi's Whitelisted SSH Keychain
  const newSshKeys: WhitelistedSshKey[] = [];
  const credByIdOrAlias = new Map<
    string,
    {
      username?: string;
      password?: string;
      privateKey?: string;
      keyReference?: string;
      passphrase?: string;
      sshKeyId?: string;
      authType: "password" | "key";
    }
  >();

  const findOrRegisterWhitelistedKey = (
    privateKeyRaw: string,
    keyName: string,
    passphrase?: string,
    keyType?: string
  ): string => {
    const cleanKey = privateKeyRaw.trim();
    const existing = [...existingSshKeys, ...newSshKeys].find(
      (k) => k.privateKey.trim() === cleanKey
    );
    if (existing) return existing.id;

    const id = randomUUID();
    newSshKeys.push({
      id,
      name: keyName,
      privateKey: cleanKey,
      passphrase: passphrase || undefined,
      keyType: keyType || undefined,
      createdAt: Date.now(),
    });
    return id;
  };

  for (const cred of rawCredentials) {
    const alias =
      asCleanString(cred.alias) ||
      asCleanString(cred.name) ||
      `Termix Key ${newSshKeys.length + 1}`;
    const credId = cred.id !== undefined && cred.id !== null ? String(cred.id) : undefined;
    const allSealed = isEncryptionFlag(cred.encrypted) || isEncryptionFlag(cred.isEncrypted) || isEncryptionFlag(cred.secretsEncrypted);
    const rawKey = plaintextSecret(cred.key, allSealed || isEncryptionFlag(cred.privateKeyEncrypted)) ||
      plaintextSecret(cred.privateKey, allSealed || isEncryptionFlag(cred.privateKeyEncrypted));
    const privKey = isPrivateKeyMaterial(rawKey) ? rawKey : undefined;
    const keyReference = !privKey ? rawKey || asCleanString(cred.privateKeyPath) || asCleanString(cred.identityFile) : undefined;
    const keyPass = plaintextSecret(cred.keyPassword, allSealed || isEncryptionFlag(cred.passphraseEncrypted)) ||
      plaintextSecret(cred.passphrase, allSealed || isEncryptionFlag(cred.passphraseEncrypted));
    const pass = plaintextSecret(cred.password, allSealed || isEncryptionFlag(cred.passwordEncrypted));
    const user = asCleanString(cred.username);
    const authType =
      ["key", "privatekey"].includes((asCleanString(cred.authType) || "").toLowerCase()) || Boolean(privKey || keyReference) ? "key" : "password";

    let sshKeyId: string | undefined;
    if (privKey) {
      sshKeyId = findOrRegisterWhitelistedKey(
        privKey,
        alias,
        keyPass,
        asCleanString(cred.keyType)
      );
    }

    const resolvedEntry = {
      username: user,
      password: pass,
      privateKey: privKey,
      keyReference,
      passphrase: keyPass,
      sshKeyId,
      authType: authType as "password" | "key",
    };

    credByIdOrAlias.set(`alias:${alias}`, resolvedEntry);
    if (credId) {
      credByIdOrAlias.set(`id:${credId}`, resolvedEntry);
    }
  }

  // 2. Normalize and import Termix hosts
  const importedHosts: HostProfile[] = [];
  const now = Date.now();

  for (const row of rawHosts) {
    const hostname =
      asCleanString(row.ip) ||
      asCleanString(row.address) ||
      asCleanString(row.host) ||
      asCleanString(row.hostname);

    if (!hostname) {
      warnings.push(
        `Skipped host "${asCleanString(row.name) || "Unnamed"}" because it has no IP/hostname.`
      );
      continue;
    }

    if (/[\s/\\?#*%$]/.test(hostname) || hostname.includes("://")) {
      warnings.push(`Skipped host "${asCleanString(row.name) || "Unnamed"}": invalid address.`);
      continue;
    }

    // Determine protocol from Termix connectionType or legacy enable<Proto> flags
    const rawConnType = (
      asCleanString(row.connectionType) ||
      asCleanString(row.protocol) ||
      (asBool(row.enableRdp) ? "rdp" : "") ||
      (asBool(row.enableFileManager) && row.enableSsh === false ? "sftp" : "") ||
      "ssh"
    ).toLowerCase();

    let protocol: ProtocolType;
    if (rawConnType.includes("rdp")) {
      protocol = "rdp";
    } else if (rawConnType.includes("sftp") || rawConnType.includes("file")) {
      protocol = "sftp";
    } else if (rawConnType === "ssh" || rawConnType === "ssh2" || rawConnType === "scp") {
      protocol = "ssh";
      if (rawConnType === "scp" && !warnings.includes("SCP entries are imported as SSH; Sushi's file browser requires SFTP on the server.")) {
        warnings.push("SCP entries are imported as SSH; Sushi's file browser requires SFTP on the server.");
      }
    } else {
      warnings.push(`Skipped host "${asCleanString(row.name) || hostname}": its protocol is not SSH, SFTP, SCP, or RDP.`);
      continue;
    }

    const suppliedPort = row.port ?? (protocol === "rdp" ? row.rdpPort : row.sshPort);
    if (suppliedPort !== undefined && suppliedPort !== null && suppliedPort !== "" && !asValidPort(suppliedPort)) {
      warnings.push(`Skipped host "${asCleanString(row.name) || hostname}": invalid port.`);
      continue;
    }
    const port = asValidPort(suppliedPort) || (protocol === "rdp" ? 3389 : 22);

    // Check linked Termix credential (`credentialId` or `credentialAlias`)
    const credLookup =
      (row.credentialId !== undefined && row.credentialId !== null
        ? credByIdOrAlias.get(`id:${String(row.credentialId)}`)
        : undefined) ||
      (asCleanString(row.credentialAlias)
        ? credByIdOrAlias.get(`alias:${asCleanString(row.credentialAlias)!}`)
        : undefined) ||
      (asCleanString(row.credentialName)
        ? credByIdOrAlias.get(`alias:${asCleanString(row.credentialName)!}`)
        : undefined);

    // Check Termix `protocolAuth` (used by Termix RDP plugin)
    const protoAuthMap =
      row.protocolAuth && typeof row.protocolAuth === "object"
        ? (row.protocolAuth as Record<string, Record<string, unknown>>)
        : {};
    const rdpProtoAuth = protoAuthMap.rdp || {};
    const rdpFields =
      rdpProtoAuth.fields && typeof rdpProtoAuth.fields === "object"
        ? (rdpProtoAuth.fields as Record<string, unknown>)
        : {};

    const overrideUser = asBool(row.overrideCredentialUsername, false);
    const username =
      (overrideUser ? asCleanString(row.username) : undefined) ||
      (protocol === "rdp" ? asCleanString(rdpProtoAuth.username) : undefined) ||
      credLookup?.username ||
      asCleanString(row.username) ||
      asCleanString(row.user) || "";
    if (!username && !warnings.includes("Some hosts have no username in the export. Edit them before connecting.")) warnings.push("Some hosts have no username in the export. Edit them before connecting.");

    const allSealed = isEncryptionFlag(row.encrypted) || isEncryptionFlag(row.isEncrypted) || isEncryptionFlag(row.secretsEncrypted);
    const keyFlagged = allSealed || isEncryptionFlag(row.privateKeyEncrypted);
    const inlineKeyBlocked = [row.key, row.privateKey].some((value) => Boolean(asCleanString(value)) && (keyFlagged || isUnavailableSecret(value)));
    const inlineRawKey = plaintextSecret(row.key, keyFlagged) || plaintextSecret(row.privateKey, keyFlagged);
    const inlineKey = isPrivateKeyMaterial(inlineRawKey) ? inlineRawKey : undefined;
    const inlineKeyReference = !inlineKey ? inlineRawKey || asCleanString(row.privateKeyPath) || asCleanString(row.identityFile) : undefined;
    const keyPassFlagged = allSealed || isEncryptionFlag(row.passphraseEncrypted);
    const inlinePassBlocked = [row.keyPassword, row.passphrase].some((value) => Boolean(asCleanString(value)) && (keyPassFlagged || isUnavailableSecret(value)));
    const inlineKeyPass = plaintextSecret(row.keyPassword, keyPassFlagged) || plaintextSecret(row.passphrase, keyPassFlagged);
    const passwordFlagged = allSealed || isEncryptionFlag(row.passwordEncrypted);
    const rdpPasswordFlagged = allSealed || isEncryptionFlag(rdpProtoAuth.encrypted) || isEncryptionFlag(rdpProtoAuth.passwordEncrypted);
    const inlinePasswordBlocked = (Boolean(asCleanString(row.password)) && (passwordFlagged || isUnavailableSecret(row.password))) ||
      (protocol === "rdp" && Boolean(asCleanString(rdpProtoAuth.password)) && (rdpPasswordFlagged || isUnavailableSecret(rdpProtoAuth.password)));
    const inlinePassword = (protocol === "rdp" ? plaintextSecret(rdpProtoAuth.password, rdpPasswordFlagged) : undefined) ||
      plaintextSecret(row.password, passwordFlagged) || (!inlinePasswordBlocked ? credLookup?.password : undefined);

    const rawAuthType = (
      asCleanString(row.authType) ||
      asCleanString(row.authMethod) ||
      ""
    ).toLowerCase();

    const usesKey =
      protocol !== "rdp" &&
      (rawAuthType === "key" ||
        rawAuthType === "privatekey" ||
        Boolean(inlineKey || inlineKeyReference || inlineKeyBlocked) ||
        credLookup?.authType === "key");

    const hasInlineKey = Boolean(inlineKey || inlineKeyReference || inlineKeyBlocked);
    const effectiveKey = inlineKey || (!hasInlineKey ? credLookup?.privateKey : undefined);
    const effectiveReference = inlineKeyReference || (!hasInlineKey ? credLookup?.keyReference : undefined);
    const effectivePassphrase = inlineKeyPass || (!inlinePassBlocked ? credLookup?.passphrase : undefined);
    let sshKeyId = inlineKeyBlocked || inlineKeyReference || (inlineKey && inlineKey !== credLookup?.privateKey) ? undefined : credLookup?.sshKeyId;

    const displayName =
      asCleanString(row.name) ||
      asCleanString(row.label) ||
      `${username}@${hostname}`;
    const hasRoute = [row.proxyJump, row.jumpHost, row.jumpHostId, row.jumpHosts, row.proxyCommand,
      row.proxyHost, row.proxy, row.gateway, row.socks5Host, row.useSocks5].some(hasSetting);
    const routeWarning = "Some hosts use a proxy or jump host. Sushi does not import that route; review the host before connecting directly.";
    if (hasRoute && !warnings.includes(routeWarning)) warnings.push(routeWarning);
    const hasForwards = [row.forwardedPorts, row.portForwardings, row.localForward, row.remoteForward, row.dynamicForward, row.tunnels].some(hasSetting);
    const forwardWarning = "Some port forwards or tunnels were not imported.";
    if (hasForwards && !warnings.includes(forwardWarning)) warnings.push(forwardWarning);

    // Automatically register inline private keys in Whitelisted Keychain so whitelist mode works seamlessly
    if (usesKey && effectiveKey && !sshKeyId) {
      sshKeyId = findOrRegisterWhitelistedKey(
        effectiveKey,
        `${displayName} Key`,
        effectivePassphrase,
        asCleanString(row.keyType)
      );
    }

    const rdpSecRaw = (
      asCleanString(rdpFields.security) ||
      asCleanString(row.rdpSecurity) ||
      "any"
    ).toLowerCase();
    const rdpSecurity: RdpSecurityMode = ["any", "nla", "tls", "rdp"].includes(
      rdpSecRaw
    )
      ? (rdpSecRaw as RdpSecurityMode)
      : "any";

    const hostId = randomUUID();
    if (usesKey && !effectiveKey) {
      keyReferences[hostId] = effectiveReference || "";
      if (!warnings.includes(missingKeyWarning)) warnings.push(missingKeyWarning);
    }
    if (effectiveKey?.startsWith("PuTTY-User-Key-File-") && !warnings.includes("PuTTY keys are supported only for .ppk v2 RSA. Convert other .ppk keys to OpenSSH with PuTTYgen.")) warnings.push("PuTTY keys are supported only for .ppk v2 RSA. Convert other .ppk keys to OpenSSH with PuTTYgen.");
    importedHosts.push({
      id: hostId,
      name: displayName,
      protocol,
      host: hostname,
      port,
      username,
      authMethod: usesKey ? "privateKey" : "password",
      password: inlinePassword,
      privateKey: usesKey ? effectiveKey : undefined,
      passphrase: usesKey ? effectivePassphrase : undefined,
      sshKeyId: usesKey ? sshKeyId : undefined,
      domain:
        protocol === "rdp"
          ? asCleanString(rdpFields.domain) || asCleanString(row.domain)
          : undefined,
      rdpSecurity: protocol === "rdp" ? rdpSecurity : undefined,
      ignoreCert:
        protocol === "rdp"
          ? asBool(rdpFields.ignoreCert ?? row.ignoreCert, true)
          : undefined,
      rdpWidth: asValidPort(row.rdpWidth) || 1280,
      rdpHeight: asValidPort(row.rdpHeight) || 720,
      initialPath:
        protocol === "sftp" ? asCleanString(row.initialPath) : undefined,
      group:
        asCleanString(row.folder) ||
        asCleanString(row.group) ||
        "Termix Imported",
      tags: normalizeTags(row.tags),
      accentColor:
        asCleanString(row.accentColor) || defaultColorForProtocol(protocol),
      notes: [asCleanString(row.notes), effectiveReference ? `Original key reference: ${effectiveReference}` : undefined, hasRoute ? "Proxy/jump settings were not imported. Review the connection route." : undefined]
        .filter(Boolean).join("\n") || undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    hosts: importedHosts,
    sshKeys: newSshKeys,
    keyReferences,
    detectedFormat,
    warnings,
  };
}

/**
 * Exports Sushi `HostProfile[]` and `WhitelistedSshKey[]` to a 100% Termix-compatible
 * JSON export (`{ version: "1", exportedAt, credentials, hosts }`).
 */
export function exportToTermixFile(
  hosts: HostProfile[],
  sshKeys: WhitelistedSshKey[] = [],
  options: { shareMode?: boolean } = {}
): TermixExportFile {
  const shareMode = Boolean(options.shareMode);
  const keyMap = new Map(sshKeys.map((k) => [k.id, k]));

  const credentials: TermixExportCredential[] = sshKeys.map((k, idx) => ({
    id: idx + 1,
    alias: k.name,
    name: k.name,
    description: k.fingerprint ? `Fingerprint: ${k.fingerprint}` : null,
    folder: "Sushi Keychain",
    tags: ["sushi"],
    authType: "key",
    username: null,
    password: null,
    key: shareMode ? null : k.privateKey,
    keyPassword: shareMode ? null : k.passphrase || null,
    keyType: k.keyType || "ssh-ed25519",
  }));

  const termixHosts: TermixExportHost[] = hosts.map((h, idx): TermixExportHost => {
    const linkedKey = h.sshKeyId ? keyMap.get(h.sshKeyId) : undefined;
    const effectivePrivKey = linkedKey?.privateKey || h.privateKey || null;
    const effectivePassphrase = linkedKey?.passphrase || h.passphrase || null;

    if (h.protocol === "rdp") {
      return {
        exportId: idx + 1,
        connectionType: "rdp",
        name: h.name,
        ip: h.host,
        port: h.port || 3389,
        username: h.username,
        password: shareMode ? null : h.password || null,
        folder: h.group || null,
        tags: h.tags || [],
        pin: false,
        notes: h.notes || null,
        enableSsh: false,
        protocolAuth: {
          rdp: {
            authType: "direct",
            credentialId: null,
            username: h.username,
            password: shareMode ? null : h.password || null,
            fields: {
              domain: h.domain || "",
              security: h.rdpSecurity || "any",
              ignoreCert: h.ignoreCert !== false,
            },
          },
        },
        pluginSettings: {},
      };
    }

    const isKeyAuth = h.authMethod === "privateKey";
    return {
      exportId: idx + 1,
      connectionType: "ssh",
      name: h.name,
      ip: h.host,
      port: h.port || 22,
      username: h.username,
      password:
        shareMode || isKeyAuth ? null : h.password || null,
      folder: h.group || null,
      tags:
        h.protocol === "sftp"
          ? Array.from(new Set([...(h.tags || []), "sftp"]))
          : h.tags || [],
      pin: false,
      notes: h.notes || null,
      authType: isKeyAuth
        ? shareMode && linkedKey
          ? "credential"
          : "key"
        : "password",
      key: shareMode || !isKeyAuth ? null : effectivePrivKey,
      keyPassword: shareMode || !isKeyAuth ? null : effectivePassphrase,
      keyType: isKeyAuth ? linkedKey?.keyType || "ssh-ed25519" : null,
      credentialAlias: linkedKey ? linkedKey.name : undefined,
      overrideCredentialUsername: true,
      enableSsh: true,
      protocolAuth: {},
      pluginSettings:
        h.protocol === "sftp" && h.initialPath
          ? { sftpInitialPath: h.initialPath }
          : {},
    };
  });

  return {
    version: "1",
    exportedAt: new Date().toISOString(),
    credentials,
    hosts: termixHosts,
  };
}
