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

export interface AuthStatusResponse {
  ok: boolean;
  authenticated: boolean;
  initialized: boolean;
  canBootstrapOnDisk: boolean;
  mode: "vps" | "vercel" | "gateway";
  username?: string;
  passkeyCount: number;
  envConfigured: boolean;
}
