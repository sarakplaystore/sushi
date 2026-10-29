export interface StoredPasskeyRecord {
  id: string; // base64url credential ID
  publicKey: string; // base64url COSE public key bytes
  counter: number;
  transports?: string[];
  label: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

export interface PublicPasskeySummary {
  id: string;
  label: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: number;
  lastUsedAt?: number;
  source: "server" | "certificate";
}

export interface AuthorizedKeyRecord {
  id: string; // SHA256:... fingerprint
  fingerprint: string; // SHA256:...
  keyType: string; // e.g. ssh-ed25519, ssh-rsa
  publicKeyOpenSSH: string; // e.g. "ssh-ed25519 AAAAC3... admin"
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  source?: "server" | "env" | "certificate";
}

export interface AuthStatusResponse {
  ok: boolean;
  authenticated: boolean;
  initialized: boolean;
  canBootstrapOnDisk: boolean;
  canBootstrapInteractive: boolean;
  mode: "vps" | "vercel" | "gateway";
  username?: string;
  passkeyCount: number;
  authorizedKeyCount: number;
  envConfigured: boolean;
}
