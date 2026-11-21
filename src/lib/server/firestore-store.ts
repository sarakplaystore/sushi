import crypto from "node:crypto";
import { Firestore, type DocumentReference, type Transaction } from "@google-cloud/firestore";
import { GoogleAuth } from "google-auth-library";

/**
 * Firestore limits each document to 1 MiB. Keep each binary chunk comfortably
 * below that limit and write the manifest, new chunks and old-chunk deletions
 * in one transaction. A record is never visible partially, even on retries.
 */
const CHUNK_BYTES = 512 * 1024;
// Leave room for the vault's revision metadata in addition to the API limit.
const MAX_RECORD_BYTES = 4 * 1024 * 1024 + 16 * 1024;
const MAX_PARTS = Math.ceil(MAX_RECORD_BYTES / CHUNK_BYTES);
const COLLECTION = "sushi_state_v1";

type RecordName = "auth" | "vault";

export interface FirestoreStoreConfig {
  projectId: string;
  databaseId: string;
  prefix: string;
  credentials?: { client_email: string; private_key: string };
}

interface RecordManifest {
  size: number;
  sha256: string;
  parts: string[];
}

interface StateManifest {
  version: 1;
  auth: RecordManifest | null;
  vault: RecordManifest | null;
}

class InvalidFirestoreData extends Error {}

function invalidData(): never {
  throw new InvalidFirestoreData("Firestore storage data for the account or encrypted vault is incomplete or invalid; it has not been replaced.");
}

function parseRecordManifest(value: unknown): RecordManifest | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidData();
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0 || (record.size as number) > MAX_RECORD_BYTES ||
      typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256) ||
      !Array.isArray(record.parts) || record.parts.length < 1 || record.parts.length > MAX_PARTS ||
      record.parts.some((part: unknown) => typeof part !== "string" || !/^(auth|vault)-[a-f0-9-]{36}-\d{2}$/.test(part)) ||
      new Set(record.parts).size !== record.parts.length ||
      record.parts.length !== Math.max(1, Math.ceil((record.size as number) / CHUNK_BYTES))) {
    return invalidData();
  }
  return { size: record.size as number, sha256: record.sha256, parts: record.parts as string[] };
}

function parseManifest(exists: boolean, data: unknown): StateManifest {
  if (!exists) return { version: 1, auth: null, vault: null };
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalidData();
  const manifest = data as Record<string, unknown>;
  if (manifest.version !== 1 || !("auth" in manifest) || !("vault" in manifest)) return invalidData();
  const auth = parseRecordManifest(manifest.auth);
  const vault = parseRecordManifest(manifest.vault);
  // A corrupt manifest must not be allowed to point at the other record's
  // chunks; deleting/replacing one must never affect the other.
  if (auth?.parts.some((part) => !part.startsWith("auth-")) ||
      vault?.parts.some((part) => !part.startsWith("vault-"))) return invalidData();
  return { version: 1, auth, vault };
}

function partReference(root: DocumentReference, id: string): DocumentReference {
  return root.collection("parts").doc(id);
}

async function readRecord(transaction: Transaction, root: DocumentReference, record: RecordManifest | null): Promise<string | null> {
  if (!record) return null;
  const snapshots = await transaction.getAll(...record.parts.map((id) => partReference(root, id)));
  const chunks = snapshots.map((snapshot) => {
    if (!snapshot.exists) return invalidData();
    const bytes: unknown = snapshot.get("data");
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return invalidData();
    const chunk = Buffer.from(bytes);
    if (chunk.length > CHUNK_BYTES) return invalidData();
    return chunk;
  });
  const value = Buffer.concat(chunks);
  if (value.length !== record.size || crypto.createHash("sha256").update(value).digest("hex") !== record.sha256) {
    return invalidData();
  }
  // Reject invalid UTF-8 rather than silently replacing characters on reads.
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) return invalidData();
  return text;
}

function createRecordParts(transaction: Transaction, root: DocumentReference, name: RecordName, value: string): RecordManifest {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new InvalidFirestoreData("The account or encrypted vault is too large for Firestore to synchronize.");
  }
  const id = crypto.randomUUID();
  const parts: string[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES)); i++) {
    const part = `${name}-${id}-${String(i).padStart(2, "0")}`;
    parts.push(part);
    transaction.create(partReference(root, part), { data: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  }
  return { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), parts };
}

function writeRecord(transaction: Transaction, root: DocumentReference, manifest: StateManifest, name: RecordName, value: string): void {
  const record = createRecordParts(transaction, root, name, value);
  transaction.set(root, { ...manifest, [name]: record });
  for (const part of manifest[name]?.parts ?? []) transaction.delete(partReference(root, part));
}

function safeStorageError(error: unknown): never {
  if (error instanceof InvalidFirestoreData) throw error;
  // A failed response to a write does not prove it failed to commit. Do not
  // suggest that an account/vault was unchanged; callers must refresh first.
  throw new Error("Firestore storage is unavailable or the request could not be confirmed. Check its server configuration and refresh before retrying.");
}

/** Exported separately so the transaction protocol can be tested without credentials. */
export class FirestoreStateStore {
  private readonly root: DocumentReference;

  constructor(private readonly firestore: Firestore, prefix: string) {
    // The namespace is not used directly as a Firestore path or exposed in a URL.
    const id = crypto.createHash("sha256").update(prefix, "utf8").digest("hex");
    this.root = firestore.collection(COLLECTION).doc(id);
  }

  async read(name: RecordName): Promise<string | null> {
    try {
      // A read-write transaction provides a consistent snapshot and lets the
      // SDK roll back cleanly when the initial read fails (including outages).
      return await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(this.root);
        const manifest = parseManifest(snapshot.exists, snapshot.data());
        return readRecord(transaction, this.root, manifest[name]);
      });
    } catch (error) {
      return safeStorageError(error);
    }
  }

  /** Initialize both source records together only if this namespace is empty. */
  async initializeEmpty(auth: string | null, vault: string | null): Promise<boolean> {
    if (auth === null && vault === null) throw new InvalidFirestoreData("There is no persistent account or vault to migrate.");
    const total = Buffer.byteLength(auth ?? "", "utf8") + Buffer.byteLength(vault ?? "", "utf8");
    // Leave room for REST's base64 encoding and Firestore's 10 MiB commit limit.
    if (total > 6 * 1024 * 1024) throw new InvalidFirestoreData("The source account and encrypted vault are too large to migrate atomically to Firestore.");
    try {
      return await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(this.root);
        const manifest = parseManifest(snapshot.exists, snapshot.data());
        if (manifest.auth || manifest.vault) return false;
        transaction.set(this.root, {
          version: 1,
          auth: auth === null ? null : createRecordParts(transaction, this.root, "auth", auth),
          vault: vault === null ? null : createRecordParts(transaction, this.root, "vault", vault),
        });
        return true;
      });
    } catch (error) {
      return safeStorageError(error);
    }
  }

  async compareAndSwap(name: RecordName, expected: string | null, next: string): Promise<boolean> {
    try {
      return await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(this.root);
        const manifest = parseManifest(snapshot.exists, snapshot.data());
        if (await readRecord(transaction, this.root, manifest[name]) !== expected) return false;
        writeRecord(transaction, this.root, manifest, name, next);
        return true;
      });
    } catch (error) {
      return safeStorageError(error);
    }
  }

  async compareAndSwapAuthWithVaultGuard(expectedAuth: string | null, nextAuth: string, expectedVault: string | null): Promise<boolean> {
    try {
      return await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(this.root);
        const manifest = parseManifest(snapshot.exists, snapshot.data());
        const auth = await readRecord(transaction, this.root, manifest.auth);
        const vault = await readRecord(transaction, this.root, manifest.vault);
        if (auth !== expectedAuth || vault !== expectedVault) return false;
        writeRecord(transaction, this.root, manifest, "auth", nextAuth);
        return true;
      });
    } catch (error) {
      return safeStorageError(error);
    }
  }
}

let cached: { key: string; store: Promise<FirestoreStateStore> } | undefined;

export async function getFirestoreStateStore(config: FirestoreStoreConfig): Promise<FirestoreStateStore> {
  // Do not retain an unhashed credential in the cache key or in any response.
  const key = crypto.createHash("sha256").update(JSON.stringify({ ...config, emulator: process.env.FIRESTORE_EMULATOR_HOST || "" })).digest("hex");
  if (cached?.key === key) return cached.store;
  const store = (async () => {
    try {
      // Resolve ADC before initializing the SDK. Missing ADC must fail closed
      // and be caught here, rather than surfacing as a background stub rejection.
      if (!config.credentials && !process.env.FIRESTORE_EMULATOR_HOST) {
        await new GoogleAuth({ projectId: config.projectId }).getClient();
      }
      const firestore = new Firestore({
        projectId: config.projectId,
        databaseId: config.databaseId,
        ...(config.credentials ? { credentials: config.credentials } : {}),
        // REST works in serverless environments without a long-lived gRPC channel.
        preferRest: true,
      });
      return new FirestoreStateStore(firestore, config.prefix);
    } catch (error) {
      return safeStorageError(error);
    }
  })();
  cached = { key, store };
  try {
    return await store;
  } catch (error) {
    if (cached?.store === store) cached = undefined;
    throw error;
  }
}
