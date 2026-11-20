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

export interface StorageBackendSetup {
  key: "turso" | "redis" | "firestore";
  name: string;
  description: string;
  /** True when this backend has a complete set of usable env vars. */
  configured: boolean;
  /** Env var names already present on the server for this backend. */
  present: string[];
  /** Env var names still required to finish this backend. */
  missing: string[];
}

export interface StorageSetupStatus {
  /** True when any shared backend is ready for first-run setup. */
  configured: boolean;
  /** Resolved backend, or "none" when nothing usable is configured. */
  backend: "disk" | "redis" | "turso" | "firestore" | "none";
  /** Set when the current storage configuration is invalid. */
  error?: string;
  backends: StorageBackendSetup[];
  /** Backend the setup guide should focus on first. */
  recommended: "turso" | "redis" | "firestore";
}

export interface AuthStatusResponse {
  ok: boolean;
  authenticated: boolean;
  initialized: boolean;
  canBootstrapOnDisk: boolean;
  canBootstrapInteractive: boolean;
  mode: "vps" | "vercel" | "gateway";
  storage?: "disk" | "redis" | "turso" | "firestore" | "none";
  storageSetup?: StorageSetupStatus;
  username?: string;
  passkeyCount: number;
  envConfigured: boolean;
}
