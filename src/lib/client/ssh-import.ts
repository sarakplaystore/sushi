import { parse as parseYaml } from "yaml";
import type { HostProfile, ProtocolType, WhitelistedSshKey } from "@/types/connection";
import { importFromTermixContent, type TermixImportSummary } from "./termix-porter";
import { isEncryptionFlag, isUnavailableSecret } from "./import-secrets";
import { randomUUID } from "./web-crypto";

/** Importers read only the files the user picks. They never run commands or follow paths. */
type Format = TermixImportSummary["detectedFormat"];
type RecordValue = Record<string, unknown>;

interface ImportRow {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  protocol?: unknown;
  password?: unknown;
  privateKey?: unknown;
  keyReference?: unknown;
  passphrase?: unknown;
  encryptedPassword?: boolean;
  encryptedPassphrase?: boolean;
  encryptedPrivateKey?: boolean;
  auth?: unknown;
  group?: unknown;
  tags?: unknown;
  notes?: unknown;
  initialPath?: unknown;
  domain?: unknown;
  route?: boolean;
  forwards?: boolean;
  agent?: boolean;
}

const MAX_ROWS = 10000;
const MAX_WARNINGS = 100;

function clean(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Passwords and passphrases may legitimately begin or end with whitespace. */
function secret(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function field(obj: RecordValue, ...aliases: string[]): unknown {
  const entries = Object.entries(obj);
  for (const alias of aliases) {
    const entry = entries.find(([key, value]) =>
      normalizedName(key) === normalizedName(alias) && value !== undefined && value !== null && value !== ""
    );
    if (entry) return entry[1];
  }
  return undefined;
}

function hasSetting(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  if (typeof value === "string") return !["", "0", "false", "none", "[]"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter((v): v is string => Boolean(v));
  return typeof value === "string"
    ? value.split(/[,;]+/).map((v) => v.trim()).filter(Boolean)
    : [];
}

function privateKeyText(value: unknown): string | undefined {
  const text = clean(value);
  return text && (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text) ||
    /^PuTTY-User-Key-File-\d+:/i.test(text))
    ? text
    : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hostAndUser(address: string): { host: string; username?: string; port?: number } {
  let host = address.trim();
  let username: string | undefined;
  let port: number | undefined;
  // PuTTY allows user@host. Do not treat URLs (which may contain passwords) as hostnames.
  if (!host.includes("://") && host.includes("@")) {
    const index = host.lastIndexOf("@");
    username = host.slice(0, index) || undefined;
    host = host.slice(index + 1);
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if (/^[^:]+:\d+$/.test(host)) {
    const index = host.lastIndexOf(":");
    port = Number(host.slice(index + 1));
    host = host.slice(0, index);
  }
  return { host, username, port };
}

function protocolFrom(value: unknown): ProtocolType | "scp" | null {
  const protocol = clean(value)?.toLowerCase();
  if (!protocol || protocol === "ssh" || protocol === "ssh2") return "ssh";
  if (protocol === "sftp") return "sftp";
  if (protocol === "rdp") return "rdp";
  if (protocol === "scp") return "scp";
  return null;
}

class ImportBuilder {
  readonly hosts: HostProfile[] = [];
  readonly keys: WhitelistedSshKey[] = [];
  readonly warnings: string[] = [];
  readonly keyReferences: Record<string, string> = Object.create(null);
  private readonly warningSet = new Set<string>();

  constructor(private readonly existingKeys: WhitelistedSshKey[]) {}

  warn(message: string) {
    if (this.warningSet.has(message)) return;
    this.warningSet.add(message);
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(message);
    else if (this.warnings.length === MAX_WARNINGS) this.warnings.push("Additional warnings were omitted.");
  }

  add(row: ImportRow) {
    if (this.hosts.length >= MAX_ROWS) throw new Error(`Import is limited to ${MAX_ROWS} hosts per file.`);
    const label = clean(row.name) || "Unnamed";
    const rawHost = clean(row.host);
    if (!rawHost) {
      this.warn(`Skipped "${label}": no hostname or IP address.`);
      return;
    }
    const address = hostAndUser(rawHost);
    if (!address.host || /[\s/\\?#*%$]/.test(address.host) || address.host.includes("://")) {
      this.warn(`Skipped "${label}": the host address is invalid or requires expansion.`);
      return;
    }
    const kind = protocolFrom(row.protocol);
    if (!kind) {
      this.warn(`Skipped "${label}": its protocol is not SSH, SFTP, SCP, or RDP.`);
      return;
    }
    const protocol: ProtocolType = kind === "scp" ? "ssh" : kind;
    if (kind === "scp") this.warn("SCP entries are imported as SSH; Sushi's file browser requires SFTP on the server.");

    const portValue = clean(row.port);
    const port = portValue ? Number(portValue) : address.port ?? (protocol === "rdp" ? 3389 : 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (portValue && !/^\d+$/.test(portValue))) {
      this.warn(`Skipped "${label}": invalid port.`);
      return;
    }
    const username = clean(row.username) || address.username || "";
    if (!username) this.warn("Some hosts have no username in the export. Edit them before connecting.");

    const sealedKey = Boolean(row.encryptedPrivateKey || isUnavailableSecret(row.privateKey));
    const sealedPassword = Boolean(row.encryptedPassword || isUnavailableSecret(row.password));
    const sealedPassphrase = Boolean(row.encryptedPassphrase || isUnavailableSecret(row.passphrase));
    const keyText = (sealedKey ? undefined : privateKeyText(row.privateKey)) || privateKeyText(row.keyReference);
    const keyRef = keyText ? undefined : clean(row.keyReference) || (sealedKey ? undefined : clean(row.privateKey));
    const auth = clean(row.auth)?.toLowerCase() || "";
    const usesKey = protocol !== "rdp" && (Boolean(keyText || keyRef || (sealedKey && row.privateKey)) || /key|agent/.test(auth));
    let sshKeyId: string | undefined;
    const passphrase = sealedPassphrase ? undefined : secret(row.passphrase);
    if ((sealedKey && row.privateKey) || (sealedPassword && row.password) || (sealedPassphrase && row.passphrase)) {
      this.warn("Some credentials are encrypted or reference another secret store and were not imported. Enter them in Sushi after import.");
    }
    if (keyText) {
      let key = [...this.existingKeys, ...this.keys].find((k) => k.privateKey.trim() === keyText);
      if (!key) {
        key = { id: randomUUID(), name: `${label} Key`, privateKey: keyText, passphrase, createdAt: Date.now() };
        this.keys.push(key);
      }
      sshKeyId = key.id;
      if (keyText.startsWith("PuTTY-User-Key-File-")) {
        this.warn("PuTTY keys are supported only for .ppk v2 RSA. Convert other .ppk keys to OpenSSH with PuTTYgen.");
      }
    } else if (usesKey) {
      this.warn("Some hosts reference a private key or SSH agent that cannot be read from the export. Add the key to Sushi and select it for those hosts.");
    }
    if (row.password !== undefined && row.password !== null && typeof row.password !== "string") {
      this.warn("Some credentials are not plaintext and could not be imported. Enter them in Sushi after import.");
    }
    if (row.route) this.warn("Some hosts use a proxy or jump host. Sushi does not import that route; review the host before connecting directly.");
    if (row.forwards) this.warn("Some port forwards or tunnels were not imported.");
    if (row.agent) this.warn("SSH agent forwarding is not imported and must be configured separately if needed.");

    const notes = [clean(row.notes), keyRef ? `Original key reference: ${keyRef}` : undefined,
      row.route ? "Proxy/jump settings were not imported. Review the connection route." : undefined]
      .filter(Boolean).join("\n");
    const group = Array.isArray(row.group) ? row.group.map(clean).filter(Boolean).join(" / ") : clean(row.group);
    const now = Date.now();
    const id = randomUUID();
    if (usesKey && !keyText) this.keyReferences[id] = keyRef || "";
    this.hosts.push({
      id, name: clean(row.name) || address.host, protocol, host: address.host, port,
      username, authMethod: usesKey ? "privateKey" : "password",
      password: sealedPassword ? undefined : secret(row.password), privateKey: usesKey ? keyText : undefined,
      passphrase: usesKey ? passphrase : undefined, sshKeyId: usesKey ? sshKeyId : undefined,
      group: group || "Imported", tags: list(row.tags), notes: notes || undefined,
      domain: protocol === "rdp" ? clean(row.domain) : undefined,
      initialPath: protocol === "sftp" ? clean(row.initialPath) : undefined,
      accentColor: protocol === "rdp" ? "#ff6b57" : protocol === "sftp" ? "#38bdf8" : "#34d399",
      createdAt: now, updatedAt: now,
    });
  }

  result(detectedFormat: Format): TermixImportSummary {
    if (!this.hosts.length && !this.keys.length) {
      const detail = this.warnings.length ? ` ${this.warnings.slice(0, 3).join(" ")}` : "";
      throw new Error(`No supported hosts found in this file.${detail}`);
    }
    return { hosts: this.hosts, sshKeys: this.keys, keyReferences: this.keyReferences, detectedFormat, warnings: this.warnings };
  }
}

function rowFromRecord(obj: RecordValue): ImportRow {
  const encrypted = isEncryptionFlag(field(obj, "encrypted", "isEncrypted", "secretsEncrypted", "credentialsEncrypted"));
  return {
    name: field(obj, "name", "label", "title", "sessionName"),
    host: field(obj, "hostname/ip", "host", "hostname", "ip", "ipAddress", "address", "server"),
    port: field(obj, "port", "portNumber", "sshPort"),
    username: field(obj, "username", "user", "login", "loginName"),
    protocol: field(obj, "protocol", "connectionType"),
    password: field(obj, "password"),
    privateKey: field(obj, "privateKey", "private_key", "key"),
    keyReference: field(obj, "sshKey", "sshKeyFile", "identityFile", "privateKeyPath"),
    passphrase: field(obj, "passphrase", "keyPassword", "keyPassphrase"),
    encryptedPassword: encrypted || isEncryptionFlag(field(obj, "passwordEncrypted", "isPasswordEncrypted")),
    encryptedPassphrase: encrypted || isEncryptionFlag(field(obj, "passphraseEncrypted", "isPassphraseEncrypted")),
    encryptedPrivateKey: encrypted || isEncryptionFlag(field(obj, "privateKeyEncrypted", "isPrivateKeyEncrypted")),
    auth: field(obj, "authMethod", "authType", "authentication"),
    group: field(obj, "group", "groups", "folder"),
    tags: field(obj, "tags"), notes: field(obj, "notes", "description"),
    initialPath: field(obj, "initialPath", "remoteDirectory"), domain: field(obj, "domain"),
    route: ["proxyJump", "jumpHost", "jumpHostId", "jumpHostIdList", "jumpHosts", "proxyCommand", "proxyHost", "proxy", "gateway", "socks5Host", "useSocks5"].some((key) => hasSetting(field(obj, key))),
    forwards: ["forwardedPorts", "portForwardings", "localForward", "remoteForward", "dynamicForward", "tunnels"].some((key) => hasSetting(field(obj, key))),
    agent: ["agentForwarding", "forwardAgent"].some((key) => hasSetting(field(obj, key))),
  };
}

/** RFC 4180 CSV: quoted commas, quotes and embedded newlines are significant. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  let closedQuote = false;
  const endField = () => { row.push(value); value = ""; closedQuote = false; };
  const endRow = () => {
    endField();
    if (row.some((v) => v.length > 0)) rows.push(row);
    if (rows.length > MAX_ROWS + 1) throw new Error(`CSV import is limited to ${MAX_ROWS} rows.`);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else value += char;
    } else if (char === '"' && !value && !closedQuote) quoted = true;
    else if (char === ",") endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      if (closedQuote && !/\s/.test(char)) throw new Error("Invalid CSV: unexpected text after a quoted field.");
      if (!closedQuote) value += char;
    }
  }
  if (quoted) throw new Error("Invalid CSV: a quoted field is not closed.");
  if (value || row.length || closedQuote) endRow();
  return rows;
}

function importCsv(text: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new Error("The CSV file is empty.");
  const header = rows[0].map(normalizedName);
  const hostAliases = ["hostnameip", "host", "hostname", "ip", "ipaddress", "address", "server"];
  const hasHeader = header.some((h) => hostAliases.includes(h));
  const columns = hasHeader ? rows.shift()! : ["name", "address", "username"];
  if (!hasHeader && (rows[0].length < 2 || rows[0].length > 3)) {
    throw new Error("CSV needs a hostname/address column, or Name,Address,Username rows.");
  }
  const builder = new ImportBuilder(existingKeys);
  for (const values of rows) {
    const obj: RecordValue = Object.create(null);
    columns.forEach((column, index) => { if (column) obj[column] = values[index] ?? ""; });
    builder.add(rowFromRecord(obj));
  }
  return builder.result("ssh-csv");
}

interface IniSection { name: string; entries: Array<[string, string]> }
function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | null = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) { current = { name: section[1], entries: [] }; sections.push(current); continue; }
    const eq = line.indexOf("=");
    if (current && eq > 0) current.entries.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return sections;
}
function iniValue(section: IniSection | undefined, key: string): string | undefined {
  return section?.entries.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}

function importPutty(text: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  const builder = new ImportBuilder(existingKeys);
  let name: string | null = null;
  let values: RecordValue = Object.create(null);
  const flush = () => {
    if (!name || !clean(values.hostname)) return;
    const proxy = clean(values.proxymethod);
    builder.add({ name: safeDecode(name), host: values.hostname, username: values.username,
      port: values.portnumber, protocol: values.protocol, keyReference: values.publickeyfile,
      route: Boolean(proxy && proxy !== "0"), notes: clean(values.portforwardings) ? "PuTTY port forwarding was not imported." : undefined });
    if (clean(values.portforwardings)) builder.warn("PuTTY port forwards were not imported.");
  };
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      flush(); values = Object.create(null);
      const match = /^\[HKEY_[^\]]*\\(?:SimonTatham\\PuTTY|PuTTY)\\Sessions\\([^\]]+)\]$/i.exec(line);
      name = match?.[1] ?? null;
      continue;
    }
    if (!name) continue;
    const valueMatch = /^"((?:\\.|[^"\\])+)"=(.*)$/.exec(line);
    if (!valueMatch) continue;
    const key = valueMatch[1].toLowerCase();
    const rawValue = valueMatch[2].trim();
    if (/^dword:[0-9a-f]+$/i.test(rawValue)) values[key] = String(parseInt(rawValue.slice(6), 16));
    else if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      values[key] = rawValue.slice(1, -1).replace(/\\([\\"])/g, "$1");
    }
  }
  flush();
  builder.warn("PuTTY session exports do not contain passwords or private key files. Add credentials separately.");
  return builder.result("putty-reg");
}

function importMoba(text: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  const builder = new ImportBuilder(existingKeys);
  let sections = parseIni(text).filter((s) => /^bookmarks(?:_\d+)?$/i.test(s.name));
  // A single .moba file contains a session line without a [Bookmarks] header.
  if (!sections.length && /#\d+#\d+%/.test(text)) sections = parseIni(`[Bookmarks]\n${text}`);
  for (const section of sections) {
    const group = iniValue(section, "SubRep");
    for (const [name, data] of section.entries) {
      const match = /#\d+#([^#]*)/.exec(data);
      if (!match) continue;
      const parts = match[1].split("%");
      if (parts[0] !== "0") { builder.warn("Non-SSH MobaXterm sessions were skipped."); continue; }
      builder.add({ name, host: parts[1], port: parts[2], username: parts[3] === "<default>" ? "" : parts[3],
        group: group || "MobaXterm Imported", keyReference: parts[14],
        route: Boolean(parts[8] || (parts[19] && parts[19] !== "0")) });
    }
  }
  builder.warn("MobaXterm session exports do not include its encrypted credential store. Add passwords separately.");
  return builder.result("mobaxterm");
}

function importWinScp(text: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  const builder = new ImportBuilder(existingKeys);
  for (const section of parseIni(text)) {
    const match = /^Sessions\\(.+)$/i.exec(section.name);
    if (!match) continue;
    const fs = iniValue(section, "FSProtocol");
    // WinSCP TFSProtocol: 0 = SCP only, 1 = SFTP with SCP fallback, 2 = SFTP only.
    if (fs && !["0", "1", "2"].includes(fs)) { builder.warn("Non-SSH WinSCP sessions were skipped."); continue; }
    const rawName = safeDecode(match[1]);
    const split = rawName.lastIndexOf("/");
    const proxy = iniValue(section, "ProxyMethod");
    builder.add({ name: split >= 0 ? rawName.slice(split + 1) : rawName,
      group: split >= 0 ? rawName.slice(0, split) : "WinSCP Imported",
      host: safeDecode(iniValue(section, "HostName") || ""), username: safeDecode(iniValue(section, "UserName") || ""),
      port: iniValue(section, "PortNumber"), protocol: fs === "0" ? "scp" : "sftp",
      keyReference: safeDecode(iniValue(section, "PublicKeyFile") || ""),
      initialPath: safeDecode(iniValue(section, "RemoteDirectory") || ""),
      route: Boolean(proxy && proxy !== "0") });
    if (iniValue(section, "Password")) builder.warn("WinSCP's stored passwords are encoded or encrypted and were not imported. Enter them again in Sushi.");
  }
  return builder.result("winscp-ini");
}

function importXshell(text: string, filename: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  const builder = new ImportBuilder(existingKeys);
  const sections = parseIni(text);
  const connection = sections.find((s) => s.name.toLowerCase() === "connection");
  const auth = sections.find((s) => ["connection:authentication", "authentication"].includes(s.name.toLowerCase()));
  const proxy = sections.find((s) => s.name.toLowerCase() === "connection:proxy");
  builder.add({ name: filename.replace(/^.*[\\/]/, "").replace(/\.xsh$/i, ""),
    host: iniValue(connection, "Host"), port: iniValue(connection, "Port"),
    protocol: iniValue(connection, "Protocol"), username: iniValue(auth, "UserName") || iniValue(connection, "UserName"),
    keyReference: iniValue(auth, "PrivateKey") || iniValue(auth, "UserKey"),
    route: Boolean(iniValue(proxy, "Proxy")) });
  if (iniValue(auth, "Password")) builder.warn("Xshell passwords may be encrypted and were not imported. Enter them in Sushi.");
  return builder.result("xshell");
}

/** SecureCRT typed per-session INI files. Password fields are encrypted. */
function importSecureCrt(text: string, filename: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  const builder = new ImportBuilder(existingKeys);
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[SD]:"([^"]+)"=(.*)$/i.exec(line.replace(/^\uFEFF/, ""));
    if (match) values.set(match[1].toLowerCase(), match[2].trim());
  }
  const get = (key: string) => values.get(key.toLowerCase());
  const protocol = (get("Protocol Name") || "SSH2").toLowerCase();
  const portHex = get("[SSH2] Port");
  if (portHex && !/^[0-9a-f]+$/i.test(portHex)) throw new Error("SecureCRT session has an invalid hexadecimal port.");
  const key = (get("Identity Filename V2") || get("Identity Filename") || "").split("::")[0].replace(/\.pub$/i, "");
  const parts = filename.replace(/\\/g, "/").split("/");
  const name = parts.pop()!.replace(/\.ini$/i, "");
  const sessionsIndex = parts.findIndex((part) => part.toLowerCase() === "sessions");
  const group = (sessionsIndex >= 0 ? parts.slice(sessionsIndex + 1) : parts.slice(1)).join(" / ");
  builder.add({ name, group: group || "SecureCRT Imported", host: get("Hostname"), username: get("Username"),
    protocol, port: portHex ? parseInt(portHex, 16) : undefined, keyReference: key, route: hasSetting(get("Firewall Name")) });
  if (get("Password") || get("Password V2")) builder.warn("SecureCRT stored passwords are encrypted and were not imported. Enter them in Sushi.");
  return builder.result("securecrt");
}

function importTabby(obj: RecordValue, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  if (isEncryptionFlag(obj.encrypted) || (isRecord(obj.metadata) && isEncryptionFlag(obj.metadata.encrypted))) {
    throw new Error("This Tabby configuration is encrypted. Export unencrypted profiles from Tabby before importing.");
  }
  const builder = new ImportBuilder(existingKeys);
  if (obj.vault) builder.warn("Tabby's vault or OS keychain is not decrypted. Add passwords and private keys in Sushi.");
  const ssh = isRecord(obj.ssh) ? obj.ssh : {};
  const profiles = Array.isArray(obj.profiles) ? obj.profiles : Array.isArray(ssh.connections) ? ssh.connections : [];
  const defaults = isRecord(obj.profileDefaults) && isRecord(obj.profileDefaults.ssh) ? obj.profileDefaults.ssh : {};
  const groups = Array.isArray(obj.groups) ? obj.groups.filter(isRecord) : [];
  for (const profile of profiles) {
    if (!isRecord(profile)) continue;
    if (profile.type && String(profile.type).toLowerCase() !== "ssh") continue;
    const options = isRecord(profile.options) ? profile.options : profile;
    const merged = { ...defaults, ...options };
    const keys = Array.isArray(merged.privateKeys) ? merged.privateKeys : [];
    const groupId = clean(profile.group);
    const group = groups.find((g) => clean(g.id) === groupId);
    builder.add({ name: profile.name || merged.name, host: merged.host, port: merged.port,
      username: merged.user || merged.username, protocol: "ssh", auth: merged.auth,
      // vault:// and file:// are references, never key contents.
      privateKey: merged.privateKey, keyReference: keys[0], group: clean(group?.name) || groupId || "Tabby Imported",
      route: Boolean(merged.jumpHost || merged.proxy || merged.proxyHost) });
    if (Array.isArray(merged.forwardedPorts) && merged.forwardedPorts.length) builder.warn("Tabby port forwards were not imported.");
  }
  return builder.result("tabby");
}

/** Tokenize OpenSSH values without executing Include, ProxyCommand or shell syntax. */
function sshTokens(value: string): string[] {
  const tokens: string[] = [];
  let token = "", quote = "", escaped = false;
  for (const char of value) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else token += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "#") break;
    if (/\s/.test(char)) { if (token) { tokens.push(token); token = ""; } }
    else token += char;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Invalid OpenSSH config: an opening quote is not closed.");
  if (token) tokens.push(token);
  return tokens;
}

interface SshBlock { patterns: string[] | null; values: Array<[string, string]> }
interface MatchBudget { remaining: number }
// Match '*' and '?' without constructing a potentially catastrophic regular expression.
function patternMatches(alias: string, pattern: string, budget: MatchBudget): boolean {
  const text = alias.toLowerCase(), glob = pattern.toLowerCase();
  let i = 0, j = 0, star = -1, retry = 0;
  while (i < text.length) {
    if (--budget.remaining < 0) throw new Error("OpenSSH config is too complex to import at once. Split it into smaller files.");
    if (j < glob.length && (glob[j] === "?" || glob[j] === text[i])) { i++; j++; }
    else if (glob[j] === "*") { star = j++; retry = i; }
    else if (star >= 0) { j = star + 1; i = ++retry; }
    else return false;
  }
  while (glob[j] === "*") j++;
  return j === glob.length;
}
function blockMatches(alias: string, patterns: string[], budget: MatchBudget): boolean {
  return patterns.some((p) => !p.startsWith("!") && patternMatches(alias, p, budget)) &&
    !patterns.some((p) => p.startsWith("!") && patternMatches(alias, p.slice(1), budget));
}
function importOpenSsh(text: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  const builder = new ImportBuilder(existingKeys);
  const blocks: SshBlock[] = [{ patterns: null, values: [] }];
  let current: SshBlock | null = blocks[0];
  const aliases = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const args = sshTokens(match[2]);
    if (key === "host") {
      current = { patterns: args, values: [] }; blocks.push(current);
      for (const alias of args) if (!/[!?*\s]/.test(alias)) {
        aliases.add(alias);
        if (aliases.size > MAX_ROWS) throw new Error(`Import is limited to ${MAX_ROWS} hosts per file.`);
      }
    } else if (key === "match") {
      current = null;
      builder.warn("OpenSSH Match blocks are not evaluated. Review affected hosts before connecting.");
    } else if (key === "include") {
      builder.warn("OpenSSH Include files are not followed. Select those files separately if needed.");
    } else if (current && args.length) {
      current.values.push([key, args.join(" ")]);
    }
  }
  // Bound block and wildcard work so crafted configs cannot freeze the browser.
  const complexity = blocks.reduce((sum, block) => sum + (block.patterns?.length || 1) + block.values.length, 0);
  if (aliases.size * complexity > 2_000_000) throw new Error("OpenSSH config is too complex to import at once. Split it into smaller files.");
  const matchBudget: MatchBudget = { remaining: 10_000_000 };
  for (const alias of aliases) {
    const effective: Record<string, string> = Object.create(null);
    for (const block of blocks) {
      if (block.patterns && !blockMatches(alias, block.patterns, matchBudget)) continue;
      for (const [key, value] of block.values) if (!(key in effective)) effective[key] = value;
    }
    const hostname = (effective.hostname || alias).replace(/%h/g, alias);
    const unresolvedUser = effective.user && effective.user.includes("%");
    if (unresolvedUser) builder.warn("Some OpenSSH usernames use tokens that cannot be resolved in the browser. Enter them in Sushi.");
    const identity = effective.identityfile && effective.identityfile.toLowerCase() !== "none" ? effective.identityfile : undefined;
    const route = Boolean((effective.proxyjump && effective.proxyjump.toLowerCase() !== "none") ||
      (effective.proxycommand && effective.proxycommand.toLowerCase() !== "none"));
    builder.add({ name: alias, host: hostname, username: unresolvedUser ? "" : effective.user,
      port: effective.port, keyReference: identity, group: "Imported (SSH Config)", route,
      agent: Boolean(effective.forwardagent && effective.forwardagent.toLowerCase() !== "no") });
    if (effective.localforward || effective.remoteforward || effective.dynamicforward) builder.warn("OpenSSH port forwards were not imported.");
  }
  builder.warn("OpenSSH config does not contain passwords or host-key trust. Enter missing credentials and verify server fingerprints.");
  return builder.result("ssh-config");
}

function importJson(parsed: unknown, raw: string, existingKeys: WhitelistedSshKey[]): TermixImportSummary {
  if (isRecord(parsed) && parsed.ciphertext && parsed.iv) {
    throw new Error("This is an encrypted Sushi vault backup. Use Import Encrypted Vault in Vault Encryption.");
  }
  if (isRecord(parsed) && (Array.isArray(parsed.profiles) || (isRecord(parsed.ssh) && Array.isArray(parsed.ssh.connections)))) {
    return importTabby(parsed, existingKeys);
  }
  const rows = Array.isArray(parsed) ? parsed : isRecord(parsed)
    ? (Array.isArray(parsed.hosts) ? parsed.hosts : Array.isArray(parsed.connections) ? parsed.connections : Array.isArray(parsed.servers) ? parsed.servers : [])
    : [];
  const looksTermix = isRecord(parsed) && (Boolean(parsed.userData) || Array.isArray(parsed.credentials)) ||
    rows.some((r) => isRecord(r) && ("credentialId" in r || "credentialAlias" in r || "protocolAuth" in r || "enableSsh" in r));
  if (looksTermix) return importFromTermixContent(raw, existingKeys);
  if (isRecord(parsed) && (isEncryptionFlag(parsed.encrypted) || (isRecord(parsed.metadata) && isEncryptionFlag(parsed.metadata.encrypted)))) {
    throw new Error("This export is encrypted. Export or decrypt it in the original SSH client first.");
  }
  const builder = new ImportBuilder(existingKeys);
  // Based on the published SSHBorg Android/iOS and 7 Term backup schemas.
  const isSeven = isRecord(parsed) && typeof parsed.formatVersion === "number" && typeof parsed.appVersion === "string" &&
    isRecord(parsed.settings) && "paletteID" in parsed.settings;
  const isBorg = isRecord(parsed) && typeof parsed.exported_at === "string" && Array.isArray(parsed.groups) &&
    rows.some((row) => isRecord(row) && "label" in row && "hostname" in row);
  if (isSeven && (parsed as RecordValue).formatVersion !== 1) throw new Error("Unsupported 7 Term backup version. Export a compatible backup from 7 Term.");
  if (isSeven) builder.warn("7 Term backups omit Keychain passwords and private keys. Select referenced key files separately and enter missing credentials.");
  if (isBorg) {
    builder.warn("SSHBorg backups omit passwords, private keys, and trusted host keys. Add credentials and verify fingerprints in Sushi.");
    if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version > 7) builder.warn("This SSHBorg backup uses a newer format version; review the imported hosts for unsupported fields.");
  }
  for (const row of rows) if (isRecord(row)) {
    if (isSeven && row.kind && row.kind !== "ssh") { builder.warn("Non-SSH 7 Term entries were skipped."); continue; }
    const mapped = rowFromRecord(row);
    if (isBorg && clean(row.keyLabel)) {
      mapped.auth = "key";
      mapped.notes = [clean(mapped.notes), `SSHBorg key label: ${clean(row.keyLabel)}`].filter(Boolean).join("\n");
    }
    builder.add(mapped);
  }
  return builder.result(isSeven ? "seven-term" : isBorg ? "sshborg" : "ssh-json");
}

/** Auto-detect supported, explicitly selected client exports. Unknown/proprietary backups fail closed. */
export function importSshClientText(text: string, filename = "", existingKeys: WhitelistedSshKey[] = []): TermixImportSummary {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("The selected import file is empty.");
  if (/^Windows Registry Editor|^REGEDIT4|\[HKEY_[^\]]*\\PuTTY\\Sessions\\/im.test(trimmed)) return importPutty(trimmed, existingKeys);
  if (/^\[Bookmarks(?:_\d+)?\]/im.test(trimmed) || /\.moba$/i.test(filename)) return importMoba(trimmed, existingKeys);
  if (/^\[Sessions\\/im.test(trimmed)) return importWinScp(trimmed, existingKeys);
  if (/\.xsh$/i.test(filename) && /^\[CONNECTION\]/im.test(trimmed)) return importXshell(trimmed, filename, existingKeys);
  if (/^\s*S:"(?:Hostname|Protocol Name)"=/im.test(trimmed)) return importSecureCrt(trimmed, filename, existingKeys);
  if (/\.ya?ml$/i.test(filename) || /^(?:profiles|ssh|encrypted):\s/im.test(trimmed)) {
    let parsed: unknown;
    try { parsed = parseYaml(trimmed, { maxAliasCount: 10, uniqueKeys: true, logLevel: "error" }); }
    catch { throw new Error("Invalid YAML file. Export a valid Tabby config.yaml."); }
    if (!isRecord(parsed)) throw new Error("This YAML file does not contain Tabby profiles.");
    return importTabby(parsed, existingKeys);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error("Invalid JSON file."); }
    return importJson(parsed, trimmed, existingKeys);
  }
  if (/\.csv$/i.test(filename) || /^(?:groups?|name|label|hostname(?:\/ip)?|host|address|ip)(?:,|\s*,)/i.test(trimmed)) return importCsv(text, existingKeys);
  if (/^\s*Host(?:\s+|\s*=)/im.test(trimmed)) return importOpenSsh(trimmed, existingKeys);
  throw new Error("Unrecognized SSH client export. Use a supported CSV, JSON, OpenSSH config, PuTTY, MobaXterm, WinSCP, Tabby, Xshell, or SecureCRT file.");
}
