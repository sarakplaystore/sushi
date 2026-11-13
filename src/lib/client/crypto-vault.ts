import { OS_COMMAND_SNIPPETS } from "./os-commands";
import {
  mergeWorkspaceStates,
  normalizeSyncedWorkspaceState,
  type PersistedSessionTab,
  type SyncedWorkspaceState,
} from "./session-resume";
import type {
  CommandSnippet,
  HostProfile,
  WhitelistedSshKey,
} from "@/types/connection";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  isNativeWebCryptoAvailable,
  pbkdf2Sha256,
  randomBytes,
} from "./web-crypto";

export interface VaultPlaintext {
  version: 1;
  hosts: HostProfile[];
  snippets: CommandSnippet[];
  sshKeys?: WhitelistedSshKey[];
  enforceKeyWhitelist?: boolean;
  /** Encrypted cross-device workspace state (open tabs, running commands, recent hosts). */
  workspace?: SyncedWorkspaceState;
}

export interface EncryptedVaultEnvelope {
  version: 1;
  mode: "device" | "passphrase";
  // Account/session vaults are passphrase envelopes for compatibility with
  // portable backups and existing encrypted storage.
  keySource?: "account" | "independent" | "session";
  salt?: string; // base64 (required when mode === 'passphrase')
  iv: string; // base64
  ciphertext: string; // base64
  updatedAt: number;
}

export const VAULT_STORAGE_KEY = "sushi_encrypted_vault_v1";
const DEVICE_KEY_STORAGE_KEY = "sushi_device_aes_key_v1";

export const DEFAULT_SNIPPETS: CommandSnippet[] = [
  {
    id: "snip-sys-overview",
    title: "System Overview",
    category: "Diagnostics",
    command: "uname -a && uptime && free -h && df -h /",
    description: "Kernel, uptime, memory, and root disk usage",
  },
  {
    id: "snip-docker-ps",
    title: "Docker Containers",
    category: "Containers",
    command: 'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"',
    description: "Formatted list of running containers and ports",
  },
  {
    id: "snip-open-ports",
    title: "Listening Ports",
    category: "Network",
    command: "ss -tulpn || netstat -tulpn",
    description: "Active TCP/UDP listening sockets and PIDs",
  },
  {
    id: "snip-top-procs",
    title: "Top CPU & RAM Processes",
    category: "Diagnostics",
    command: "ps aux --sort=-%mem | head -n 15",
    description: "Top 15 memory-consuming processes",
  },
  {
    id: "snip-journal-err",
    title: "Recent Systemd Errors",
    category: "Logs",
    command: "journalctl -p 3 -xb --no-pager | tail -n 40",
    description: "Last 40 critical/error entries from systemd journal",
  },
  {
    id: "snip-nginx-test",
    title: "Test & Reload Nginx",
    category: "Web Server",
    command: "sudo nginx -t && sudo systemctl reload nginx",
    description: "Validate Nginx syntax before graceful reload",
  },
  // Which OS (and which release) is this host? Ubuntu, Debian, RHEL/Rocky/Alma,
  // Fedora, Arch, Alpine, SUSE and Amazon Linux, plus a probe that works anywhere.
  ...OS_COMMAND_SNIPPETS,
];

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x2000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, i + CHUNK_SIZE);
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(""));
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Device-mode vault key: 256-bit AES key stored (base64, raw bytes) in localStorage.
 * Raw bytes are used directly so the vault also works outside secure contexts
 * (plain-HTTP self-hosting), where `crypto.subtle` is unavailable.
 */
async function getOrCreateDeviceKey(): Promise<Uint8Array> {
  const existing = localStorage.getItem(DEVICE_KEY_STORAGE_KEY);
  if (existing) {
    return base64ToBytes(existing);
  }
  const key = randomBytes(32);
  localStorage.setItem(DEVICE_KEY_STORAGE_KEY, bytesToBase64(key));
  return key;
}

const DERIVED_KEY_CACHE_LIMIT = 8;
const derivedKeyCache = new Map<string, Uint8Array>();

export async function derivePassphraseKey(
  passphrase: string,
  saltBytes: Uint8Array
): Promise<Uint8Array> {
  const engineTag = isNativeWebCryptoAvailable() ? "native" : "pure";
  const cacheKey = `${engineTag}:${bytesToBase64(saltBytes)}:${passphrase}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) {
    derivedKeyCache.delete(cacheKey);
    derivedKeyCache.set(cacheKey, cached);
    return cached;
  }

  const derived = await pbkdf2Sha256(passphrase, saltBytes, 210000, 32);
  if (derivedKeyCache.size >= DERIVED_KEY_CACHE_LIMIT) {
    const oldestKey = derivedKeyCache.keys().next().value;
    if (oldestKey !== undefined) derivedKeyCache.delete(oldestKey);
  }
  derivedKeyCache.set(cacheKey, derived);
  return derived;
}

export async function encryptVaultData(
  data: VaultPlaintext,
  passphrase?: string | null,
  options?: { reuseSalt?: string | null }
): Promise<EncryptedVaultEnvelope> {
  const iv = randomBytes(12);
  const encoded = new TextEncoder().encode(JSON.stringify(data));

  if (passphrase && passphrase.length > 0) {
    let salt: Uint8Array;
    if (options?.reuseSalt) {
      const parsed = base64ToBytes(options.reuseSalt);
      salt = parsed.byteLength >= 16 ? parsed : randomBytes(16);
    } else {
      salt = randomBytes(16);
    }
    const key = await derivePassphraseKey(passphrase, salt);
    const encrypted = await aesGcmEncrypt(key, iv, encoded);
    return {
      version: 1,
      mode: "passphrase",
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(encrypted),
      updatedAt: Date.now(),
    };
  }

  const deviceKey = await getOrCreateDeviceKey();
  const encrypted = await aesGcmEncrypt(deviceKey, iv, encoded);
  return {
    version: 1,
    mode: "device",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(encrypted),
    updatedAt: Date.now(),
  };
}

export async function decryptVaultEnvelope(
  envelope: EncryptedVaultEnvelope,
  passphrase?: string | null
): Promise<VaultPlaintext> {
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  let key: Uint8Array;
  if (envelope.mode === "passphrase") {
    if (!passphrase) {
      throw new Error("Master passphrase required to unlock vault.");
    }
    if (!envelope.salt) {
      throw new Error("Encrypted vault is missing PBKDF2 salt.");
    }
    key = await derivePassphraseKey(passphrase, base64ToBytes(envelope.salt));
  } else {
    const existing = localStorage.getItem(DEVICE_KEY_STORAGE_KEY);
    if (!existing) throw new Error("This device vault key is unavailable. Open the vault on its original browser.");
    key = base64ToBytes(existing);
  }

  try {
    const decrypted = await aesGcmDecrypt(key, iv, ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as VaultPlaintext;
    const workspace = normalizeSyncedWorkspaceState(parsed.workspace);
    return {
      version: 1,
      hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
      snippets:
        Array.isArray(parsed.snippets) && parsed.snippets.length > 0
          ? parsed.snippets
          : DEFAULT_SNIPPETS,
      sshKeys: Array.isArray(parsed.sshKeys) ? parsed.sshKeys : [],
      enforceKeyWhitelist: Boolean(parsed.enforceKeyWhitelist),
      ...(workspace ? { workspace } : {}),
    };
  } catch {
    throw new Error(
      envelope.mode === "passphrase"
        ? "Incorrect master passphrase."
        : "Unable to decrypt local device vault."
    );
  }
}

export function loadLocalEnvelope(): EncryptedVaultEnvelope | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as EncryptedVaultEnvelope;
    if (!envelope || envelope.version !== 1 ||
        (envelope.mode !== "device" && envelope.mode !== "passphrase") ||
        typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
      throw new Error("Invalid local vault");
    }
    return envelope;
  } catch {
    throw new Error("The local encrypted vault could not be read. It has not been reset or overwritten.");
  }
}

export function saveLocalEnvelope(envelope: EncryptedVaultEnvelope): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(envelope));
}

export function clearDeviceKey(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(DEVICE_KEY_STORAGE_KEY);
}

/**
 * Resolves a HostProfile's SSH private key from the Vault Whitelisted Keychain
 * (`sshKeyId`) and enforces `enforceKeyWhitelist` if enabled.
 */
export function resolveProfileWithKeychain(
  profile: HostProfile,
  sshKeys: WhitelistedSshKey[],
  enforceKeyWhitelist = false
): { ok: true; profile: HostProfile } | { ok: false; error: string } {
  if (profile.protocol === "rdp" || profile.authMethod !== "privateKey") {
    return { ok: true, profile };
  }

  if (profile.sshKeyId) {
    const matched = sshKeys.find((k) => k.id === profile.sshKeyId);
    if (!matched) {
      return {
        ok: false,
        error:
          "The whitelisted SSH key linked to this host was removed from Vault. Edit the host to select an active whitelisted key.",
      };
    }
    return {
      ok: true,
      profile: {
        ...profile,
        privateKey: matched.privateKey,
        passphrase: matched.passphrase ?? profile.passphrase,
      },
    };
  }

  if (enforceKeyWhitelist) {
    const cleanInline = (profile.privateKey || "").trim();
    const matchedByContent = sshKeys.find(
      (k) => k.privateKey.trim() === cleanInline && cleanInline.length > 0
    );
    if (!matchedByContent) {
      return {
        ok: false,
        error:
          "Private Key Whitelist Enforcement is enabled: add this private key to your Vault SSH Key Whitelist before connecting.",
      };
    }
    return {
      ok: true,
      profile: {
        ...profile,
        sshKeyId: matchedByContent.id,
        privateKey: matchedByContent.privateKey,
        passphrase: matchedByContent.passphrase ?? profile.passphrase,
      },
    };
  }

  return { ok: true, profile };
}

/**
 * Resolves a persisted/synced workspace tab back into a live `HostProfile` using
 * the unlocked Vault (`hosts` + `sshKeys`). Returns `null` if the tab's host was
 * deleted and no longer has usable SSH/SFTP credentials.
 */
export function resolvePersistedTabProfile(
  tab: PersistedSessionTab,
  hosts: HostProfile[],
  sshKeys: WhitelistedSshKey[],
  enforceKeyWhitelist = false
): HostProfile | null {
  const targetId = tab.hostId ?? tab.profile.id;
  const targetHost = (tab.profile.host || "").trim().toLowerCase();
  const targetPort = Number(tab.profile.port || (tab.protocol === "rdp" ? 3389 : 22));
  const targetUser = (tab.profile.username || "").trim();

  const exactIdAndProto = targetId
    ? hosts.find((h) => h.id === targetId && h.protocol === tab.protocol)
    : undefined;
  const sameIdSibling =
    !exactIdAndProto && targetId && (tab.protocol === "ssh" || tab.protocol === "sftp")
      ? hosts.find(
          (h) => h.id === targetId && (h.protocol === "ssh" || h.protocol === "sftp")
        )
      : undefined;
  const exactIdentity =
    !exactIdAndProto && !sameIdSibling
      ? hosts.find(
          (h) =>
            h.protocol === tab.protocol &&
            h.host.trim().toLowerCase() === targetHost &&
            Number(h.port) === targetPort &&
            h.username.trim() === targetUser
        )
      : undefined;
  const siblingIdentity =
    !exactIdAndProto &&
    !sameIdSibling &&
    !exactIdentity &&
    (tab.protocol === "ssh" || tab.protocol === "sftp")
      ? hosts.find(
          (h) =>
            (h.protocol === "ssh" || h.protocol === "sftp") &&
            h.host.trim().toLowerCase() === targetHost &&
            Number(h.port) === targetPort &&
            h.username.trim() === targetUser
        )
      : undefined;

  const saved = exactIdAndProto ?? sameIdSibling ?? exactIdentity ?? siblingIdentity;

  // Derived "Open via RDP" companion tabs (`rdp-companion-<sourceId>`) strip their
  // password when persisted; recover credentials from any saved RDP host on that
  // machine or from the source SSH/SFTP host in the Vault.
  const companionSourceId =
    !saved && tab.protocol === "rdp" && targetId?.startsWith("rdp-companion-")
      ? targetId.slice("rdp-companion-".length)
      : null;
  const savedRdpOnSameHost =
    !saved && tab.protocol === "rdp"
      ? hosts.find(
          (h) =>
            h.protocol === "rdp" &&
            h.host.trim().toLowerCase() === targetHost &&
            (h.username.trim() === targetUser || Number(h.port) === targetPort)
        ) ??
        (companionSourceId
          ? hosts.find(
              (h) => h.protocol === "rdp" && h.host.trim().toLowerCase() === targetHost
            )
          : undefined)
      : undefined;
  const companionSource =
    !saved && !savedRdpOnSameHost && companionSourceId
      ? hosts.find((h) => h.id === companionSourceId) ??
        hosts.find(
          (h) =>
            (h.protocol === "ssh" || h.protocol === "sftp") &&
            h.host.trim().toLowerCase() === targetHost &&
            h.username.trim() === targetUser
        )
      : undefined;

  const candidate: HostProfile = saved
    ? {
        ...saved,
        protocol: tab.protocol,
        initialPath: tab.initialPath ?? saved.initialPath,
      }
    : savedRdpOnSameHost
      ? {
          ...savedRdpOnSameHost,
          protocol: "rdp",
        }
      : companionSource
        ? {
            ...tab.profile,
            protocol: "rdp",
            authMethod: "password",
            password:
              tab.profile.password ??
              (companionSource.authMethod === "password"
                ? companionSource.password
                : undefined),
          }
        : {
            ...tab.profile,
            protocol: tab.protocol,
            initialPath: tab.initialPath ?? tab.profile.initialPath,
          };

  // Unsaved SSH/SFTP tabs have no persisted secrets outside the vault; skip
  // restoring them if no saved entry supplies credentials.
  if (!saved && (tab.protocol === "ssh" || tab.protocol === "sftp")) {
    const needsSecret =
      candidate.authMethod === "privateKey"
        ? !candidate.sshKeyId && !candidate.privateKey
        : !candidate.password;
    if (needsSecret) return null;
  }

  const resolved = resolveProfileWithKeychain(candidate, sshKeys, enforceKeyWhitelist);
  return resolved.ok ? resolved.profile : null;
}

function mergeCollectionById<T extends { id: string }>(
  baseItems: T[] | undefined,
  localItems: T[],
  remoteItems: T[],
  getTimestamp: (item: T) => number
): T[] {
  const baseMap = new Map((baseItems ?? []).map((item) => [item.id, item]));
  const localMap = new Map(localItems.map((item) => [item.id, item]));
  const remoteMap = new Map(remoteItems.map((item) => [item.id, item]));

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const item of [...localItems, ...remoteItems]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      orderedIds.push(item.id);
    }
  }

  const merged: T[] = [];
  for (const id of orderedIds) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (l && r) {
      const lJson = JSON.stringify(l);
      const rJson = JSON.stringify(r);
      if (lJson === rJson) {
        merged.push(l);
        continue;
      }
      const bJson = b ? JSON.stringify(b) : null;
      if (bJson !== null && lJson === bJson) {
        merged.push(r);
      } else if (bJson !== null && rJson === bJson) {
        merged.push(l);
      } else {
        merged.push(getTimestamp(l) >= getTimestamp(r) ? l : r);
      }
    } else if (l && !r) {
      if (!b) {
        merged.push(l);
      } else if (JSON.stringify(l) !== JSON.stringify(b)) {
        merged.push(l);
      }
    } else if (!l && r) {
      if (!b) {
        merged.push(r);
      } else if (JSON.stringify(r) !== JSON.stringify(b)) {
        merged.push(r);
      }
    }
  }

  return merged;
}

/**
 * 3-way non-destructive merge of two concurrent `VaultPlaintext` snapshots so
 * edits or session updates on another device never cause lost data or blocking
 * conflicts.
 */
export function mergeVaultPlaintexts(
  base: VaultPlaintext | null,
  local: VaultPlaintext,
  remote: VaultPlaintext,
  now = Date.now()
): VaultPlaintext {
  const hosts = mergeCollectionById(
    base?.hosts,
    local.hosts,
    remote.hosts,
    (h) => h.updatedAt || h.createdAt || 0
  );
  const sshKeys = mergeCollectionById(
    base?.sshKeys,
    local.sshKeys ?? [],
    remote.sshKeys ?? [],
    (k) => k.createdAt || 0
  );
  const snippets = mergeCollectionById(
    base?.snippets,
    local.snippets,
    remote.snippets,
    () => 0
  );
  const enforceKeyWhitelist = base
    ? Boolean(local.enforceKeyWhitelist) !== Boolean(base.enforceKeyWhitelist)
      ? Boolean(local.enforceKeyWhitelist)
      : Boolean(remote.enforceKeyWhitelist)
    : Boolean(local.enforceKeyWhitelist || remote.enforceKeyWhitelist);

  const workspace =
    local.workspace || remote.workspace
      ? mergeWorkspaceStates(remote.workspace, local.workspace, now)
      : undefined;

  return {
    version: 1,
    hosts,
    snippets: snippets.length > 0 ? snippets : DEFAULT_SNIPPETS,
    sshKeys,
    enforceKeyWhitelist,
    ...(workspace ? { workspace } : {}),
  };
}

