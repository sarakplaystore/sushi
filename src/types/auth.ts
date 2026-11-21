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

export type AuthRuntimeMode = "vps" | "vercel" | "gateway";
export type SharedStorageProvider = "turso" | "redis" | "firestore";

/** Safe, non-secret context for a failed account-status request. */
export interface AuthStorageProblem {
  mode: AuthRuntimeMode;
  reason: "configuration" | "unavailable";
  backend: SharedStorageProvider | "disk" | null;
}

export interface AuthStatusErrorResponse {
  ok: false;
  error: string;
  storageProblem: AuthStorageProblem;
}

export interface AuthStatusResponse {
  ok: boolean;
  authenticated: boolean;
  initialized: boolean;
  canBootstrapOnDisk: boolean;
  canBootstrapInteractive: boolean;
  mode: AuthRuntimeMode;
  storage?: "disk" | SharedStorageProvider | "none";
  username?: string;
  passkeyCount: number;
  envConfigured: boolean;
}
