import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Small durable store for the single admin account and encrypted vault.
 * Vercel's filesystem is ephemeral; a Redis REST store is required there.
 */
type RecordName = "auth" | "vault";
type StoreKind = "disk" | "redis" | "none";

interface RedisConfig {
  url: string;
  token: string;
  prefix: string;
}

function redisConfig(): RedisConfig | null {
  const candidates = [
    [process.env.SUSHI_REDIS_REST_URL, process.env.SUSHI_REDIS_REST_TOKEN],
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
  ];
  for (const [rawUrl, rawToken] of candidates) {
    const url = rawUrl?.trim() || "";
    const token = rawToken?.trim() || "";
    if (!url && !token) continue;
    if (!url || !token) {
      throw new Error("Shared storage is misconfigured: both the Redis REST URL and token are required.");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Shared storage has an invalid Redis REST URL.");
    }
    const localHttp = parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Shared storage requires an HTTPS Redis REST URL without embedded credentials.");
    }
    const fallback = [
      "sushi",
      process.env.VERCEL_PROJECT_ID?.trim() || "default",
      process.env.VERCEL_ENV?.trim() || "default",
    ].join(":");
    const prefix = process.env.SUSHI_STORAGE_PREFIX?.trim() || fallback;
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(prefix)) {
      throw new Error("SUSHI_STORAGE_PREFIX must contain only letters, numbers, colons, underscores, or hyphens.");
    }
    return { url: url.replace(/\/+$/, ""), token, prefix };
  }
  return null;
}

export function getStateStoreKind(): StoreKind {
  if (redisConfig()) return "redis";
  return process.env.VERCEL === "1" ? "none" : "disk";
}

export function hasPersistentStateStore(): boolean {
  return getStateStoreKind() !== "none";
}

function recordPath(name: RecordName): string {
  const directory = process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");
  // Runtime data lives outside the deployed bundle; do not trace the whole
  // project (or accidentally include local account data) into serverless output.
  return path.join(/*turbopackIgnore: true*/ directory, name === "auth" ? "auth.json" : "vault.enc.json");
}

function redisKey(config: RedisConfig, name: RecordName): string {
  // A shared hash tag also keeps both keys in the same Redis Cluster slot,
  // allowing a password change to guard the vault revision atomically.
  return `{${config.prefix}}:${name}:v1`;
}

async function command(config: RedisConfig, args: (string | number)[]): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Shared storage is unavailable. Try again before creating or changing an account.");
  }
  if (!response.ok) throw new Error("Shared storage is unavailable or rejected its credentials.");
  let body: { result?: unknown; error?: unknown };
  try {
    body = await response.json() as { result?: unknown; error?: unknown };
  } catch {
    throw new Error("Shared storage returned an invalid response.");
  }
  if (body.error || !("result" in body)) throw new Error("Shared storage could not complete the request.");
  return body.result;
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
  const config = redisConfig();
  if (config) {
    const result = await command(config, ["GET", redisKey(config, name)]);
    if (result === null) return null;
    if (typeof result !== "string") throw new Error("Shared storage returned invalid Sushi data.");
    return result;
  }
  return getStateStoreKind() === "disk" ? readDiskFile(name) : null;
}

// A lock file coordinates separate Node processes on the same persistent disk.
// A stale lock is not automatically removed: failing closed is safer than
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
  const config = redisConfig();
  if (config) {
    const script = `
      local auth = redis.call('GET', KEYS[1])
      local vault = redis.call('GET', KEYS[2])
      if (ARGV[1] == 'missing' and auth) or (ARGV[1] == 'present' and auth ~= ARGV[2]) then return 0 end
      if (ARGV[3] == 'missing' and vault) or (ARGV[3] == 'present' and vault ~= ARGV[4]) then return 0 end
      redis.call('SET', KEYS[1], ARGV[5])
      return 1
    `;
    const result = await command(config, [
      "EVAL", script, 2, redisKey(config, "auth"), redisKey(config, "vault"),
      expectedAuth === null ? "missing" : "present", expectedAuth ?? "",
      expectedVault === null ? "missing" : "present", expectedVault ?? "", nextAuth,
    ]);
    if (result !== 0 && result !== 1) throw new Error("Shared storage returned an invalid write result.");
    return result === 1;
  }
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
  const config = redisConfig();
  if (config) {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if ARGV[1] == 'missing' then
        if current then return 0 end
      elseif not current or current ~= ARGV[2] then
        return 0
      end
      redis.call('SET', KEYS[1], ARGV[3])
      return 1
    `;
    const result = await command(config, [
      "EVAL", script, 1, redisKey(config, name),
      expected === null ? "missing" : "present", expected ?? "", next,
    ]);
    if (result !== 0 && result !== 1) throw new Error("Shared storage returned an invalid write result.");
    return result === 1;
  }
  if (getStateStoreKind() !== "disk") throw new Error("Persistent storage is not configured.");
  return withDiskLock(name, async () => {
    const current = await readDiskFile(name);
    if (current !== expected) return false;
    await atomicDiskWrite(name, next);
    return true;
  });
}
