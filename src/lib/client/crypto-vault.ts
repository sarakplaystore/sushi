import type {
  CommandSnippet,
  HostProfile,
  WhitelistedSshKey,
} from "@/types/connection";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  pbkdf2Sha256,
  randomBytes,
} from "./web-crypto";

export interface VaultPlaintext {
  version: 1;
  hosts: HostProfile[];
  snippets: CommandSnippet[];
  sshKeys?: WhitelistedSshKey[];
  enforceKeyWhitelist?: boolean;
}

export interface EncryptedVaultEnvelope {
  version: 1;
  mode: "device" | "passphrase";
  salt?: string; // base64 (required when mode === 'passphrase')
  iv: string; // base64
  ciphertext: string; // base64
  updatedAt: number;
}

const VAULT_STORAGE_KEY = "sushi_encrypted_vault_v1";
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
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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

export async function derivePassphraseKey(
  passphrase: string,
  saltBytes: Uint8Array
): Promise<Uint8Array> {
  return pbkdf2Sha256(passphrase, saltBytes, 210000, 32);
}

export async function encryptVaultData(
  data: VaultPlaintext,
  passphrase?: string | null
): Promise<EncryptedVaultEnvelope> {
  const iv = randomBytes(12);
  const encoded = new TextEncoder().encode(JSON.stringify(data));

  if (passphrase && passphrase.length > 0) {
    const salt = randomBytes(16);
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
    key = await getOrCreateDeviceKey();
  }

  try {
    const decrypted = await aesGcmDecrypt(key, iv, ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as VaultPlaintext;
    return {
      version: 1,
      hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
      snippets:
        Array.isArray(parsed.snippets) && parsed.snippets.length > 0
          ? parsed.snippets
          : DEFAULT_SNIPPETS,
      sshKeys: Array.isArray(parsed.sshKeys) ? parsed.sshKeys : [],
      enforceKeyWhitelist: Boolean(parsed.enforceKeyWhitelist),
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
    return JSON.parse(raw) as EncryptedVaultEnvelope;
  } catch {
    return null;
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
