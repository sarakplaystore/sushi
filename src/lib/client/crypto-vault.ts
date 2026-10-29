import type { CommandSnippet, HostProfile } from "@/types/connection";

export interface VaultPlaintext {
  version: 1;
  hosts: HostProfile[];
  snippets: CommandSnippet[];
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

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  const existing = localStorage.getItem(DEVICE_KEY_STORAGE_KEY);
  if (existing) {
    const raw = base64ToBytes(existing);
    return crypto.subtle.importKey(
      "raw",
      raw.buffer as ArrayBuffer,
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );
  }

  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const exported = await crypto.subtle.exportKey("raw", key);
  localStorage.setItem(DEVICE_KEY_STORAGE_KEY, bytesToBase64(new Uint8Array(exported)));
  return key;
}

export async function derivePassphraseKey(
  passphrase: string,
  saltBytes: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes.buffer as ArrayBuffer,
      iterations: 210000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptVaultData(
  data: VaultPlaintext,
  passphrase?: string | null
): Promise<EncryptedVaultEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));

  if (passphrase && passphrase.length > 0) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await derivePassphraseKey(passphrase, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoded
    );
    return {
      version: 1,
      mode: "passphrase",
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      updatedAt: Date.now(),
    };
  }

  const deviceKey = await getOrCreateDeviceKey();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    deviceKey,
    encoded
  );
  return {
    version: 1,
    mode: "device",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    updatedAt: Date.now(),
  };
}

export async function decryptVaultEnvelope(
  envelope: EncryptedVaultEnvelope,
  passphrase?: string | null
): Promise<VaultPlaintext> {
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  let key: CryptoKey;
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
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      ciphertext.buffer as ArrayBuffer
    );
    const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as VaultPlaintext;
    return {
      version: 1,
      hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
      snippets:
        Array.isArray(parsed.snippets) && parsed.snippets.length > 0
          ? parsed.snippets
          : DEFAULT_SNIPPETS,
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
