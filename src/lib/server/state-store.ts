import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** The self-hosted account and encrypted vault are ordinary files, not a database.
 * Vercel has an ephemeral filesystem and therefore has no server-side store.
 */
type RecordName = "auth" | "vault";
export type StoreKind = "disk" | "none";

// These are detected only to prevent an upgraded deployment from silently
// starting with an empty account/vault. Their values are never read or used to
// connect to a database. Remove them after backing up and migrating the old data.
const LEGACY_DATABASE_ENV = [
  "SUSHI_TURSO_DATABASE_URL", "SUSHI_TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
  "SUSHI_FIRESTORE_PROJECT_ID", "SUSHI_FIRESTORE_DATABASE_ID", "SUSHI_FIRESTORE_CREDENTIALS_JSON",
  "SUSHI_REDIS_REST_URL", "SUSHI_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN",
  // Compose forwards presence-only markers, not the old credential values.
  "SUSHI_LEGACY_TURSO_CONFIGURED", "SUSHI_LEGACY_FIRESTORE_CONFIGURED", "SUSHI_LEGACY_REDIS_CONFIGURED",
] as const;

export function getStateStoreKind(): StoreKind {
  const selected = process.env.SUSHI_STORAGE_BACKEND?.trim().toLowerCase() || "auto";
  if (["redis", "turso", "firestore"].includes(selected) ||
      LEGACY_DATABASE_ENV.some((name) => Boolean(process.env[name]?.trim()))) {
    throw new Error(
      "Legacy database configuration detected. Sushi no longer connects to database storage. " +
      "Back up your account and vault using the previous version, then remove the old database " +
      "environment variables and redeploy. See the migration guide in the README."
    );
  }
  if (selected !== "auto" && selected !== "disk") {
    throw new Error("SUSHI_STORAGE_BACKEND must be auto or disk.");
  }
  if (selected === "disk" && process.env.VERCEL === "1") {
    throw new Error("Server disk is ephemeral on Vercel. Remove SUSHI_STORAGE_BACKEND=disk and configure environment-based login.");
  }
  return process.env.VERCEL === "1" ? "none" : "disk";
}

export function hasPersistentStateStore(): boolean {
  return getStateStoreKind() === "disk";
}

function recordPath(name: RecordName): string {
  const directory = process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");
  // Runtime data lives outside the deployed bundle; do not trace local account
  // files into serverless output.
  return path.join(/*turbopackIgnore: true*/ directory, name === "auth" ? "auth.json" : "vault.enc.json");
}

async function readDiskFile(name: RecordName): Promise<string | null> {
  try {
    return await fs.readFile(/*turbopackIgnore: true*/ recordPath(name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Could not read persistent Sushi data; the existing account and vault have not been reset.");
  }
}

export async function readStateRecord(name: RecordName): Promise<string | null> {
  return getStateStoreKind() === "disk" ? readDiskFile(name) : null;
}

// Lock files coordinate separate Node processes on the same persistent disk.
// Never automatically remove a stale lock: failing closed is safer than
// deleting an active writer's lock and overwriting another device's changes.
async function withDiskLock<T>(name: RecordName, action: () => Promise<T>): Promise<T> {
  const filename = recordPath(name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const lock = `${filename}.lock`;
  let handle: fs.FileHandle | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      handle = await fs.open(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!handle) throw new Error("Persistent storage is busy; no changes were saved. Try again.");
  try {
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(lock).catch(() => {});
  }
}

async function atomicDiskWrite(name: RecordName, value: string): Promise<void> {
  const filename = recordPath(name);
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, value, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, filename);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

/** Update auth only while both the account and vault are unchanged. */
export async function compareAndSwapAuthWithVaultGuard(
  expectedAuth: string | null,
  nextAuth: string,
  expectedVault: string | null
): Promise<boolean> {
  if (getStateStoreKind() !== "disk") throw new Error("Persistent storage is not configured.");
  // All multi-record mutations acquire auth before vault. Ordinary vault writes
  // take only the vault lock, so the guard and the account write are atomic.
  return withDiskLock("auth", () => withDiskLock("vault", async () => {
    const auth = await readDiskFile("auth");
    const vault = await readDiskFile("vault");
    if (auth !== expectedAuth || vault !== expectedVault) return false;
    await atomicDiskWrite("auth", nextAuth);
    return true;
  }));
}

/** Write only if the exact record read by the caller has not changed. */
export async function compareAndSwapStateRecord(
  name: RecordName,
  expected: string | null,
  next: string
): Promise<boolean> {
  if (getStateStoreKind() !== "disk") throw new Error("Persistent storage is not configured.");
  return withDiskLock(name, async () => {
    const current = await readDiskFile(name);
    if (current !== expected) return false;
    await atomicDiskWrite(name, next);
    return true;
  });
}
