import crypto from "node:crypto";

type RecordName = "auth" | "vault";

export interface TursoStoreConfig {
  /** Normalized HTTP(S) base URL without trailing slash (e.g. https://db-org.turso.io). */
  httpUrl: string;
  token: string;
  prefix: string;
}

type HranaArg =
  | { type: "text"; value: string }
  | { type: "integer"; value: string };

interface HranaStmt {
  sql: string;
  args: HranaArg[];
  named_args: never[];
  want_rows: boolean;
}

type HranaStreamRequest =
  | { type: "execute"; stmt: HranaStmt }
  | { type: "close" };

interface HranaStmtResult {
  cols?: Array<{ name?: string | null; decltype?: string | null }>;
  rows?: Array<Array<{ type?: string; value?: unknown }>>;
  affected_row_count?: number;
}

type HranaStreamResult =
  | {
      type: "ok";
      response?: {
        type?: string;
        result?: HranaStmtResult;
      };
    }
  | {
      type: "error";
      error?: {
        message?: string;
        code?: string;
      };
    };

interface HranaPipelineResponse {
  baton?: string | null;
  base_url?: string | null;
  results?: HranaStreamResult[];
}

// Match Firestore's bounded record size (4 MiB vault limit + revision metadata).
const MAX_RECORD_BYTES = 4 * 1024 * 1024 + 16 * 1024;

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS sushi_state_v1 (" +
  "record_key TEXT PRIMARY KEY NOT NULL, " +
  "record_value TEXT NOT NULL, " +
  "updated_at INTEGER NOT NULL" +
  ")";

const ensuredTables = new Set<string>();

function tableCacheKey(httpUrl: string): string {
  return crypto.createHash("sha256").update(httpUrl, "utf8").digest("hex");
}

function recordKey(prefix: string, name: RecordName): string {
  return `${prefix}:${name}:v1`;
}

function textArg(value: string): HranaArg {
  return { type: "text", value };
}

function intArg(value: number): HranaArg {
  return { type: "integer", value: String(Math.trunc(value)) };
}

function checkRecordSize(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("The account or encrypted vault is too large for Turso storage to synchronize.");
  }
}

async function executeStmt(
  config: TursoStoreConfig,
  stmt: HranaStmt,
  forceCreateTable = false
): Promise<HranaStmtResult> {
  const cacheKey = tableCacheKey(config.httpUrl);
  const includeCreate = forceCreateTable || !ensuredTables.has(cacheKey);

  const requests: HranaStreamRequest[] = [];
  if (includeCreate) {
    requests.push({
      type: "execute",
      stmt: {
        sql: CREATE_TABLE_SQL,
        args: [],
        named_args: [],
        want_rows: false,
      },
    });
  }
  requests.push({ type: "execute", stmt });
  requests.push({ type: "close" });

  let response: Response;
  try {
    response = await fetch(`${config.httpUrl}/v2/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Turso storage is unavailable. Try again before creating or changing an account.");
  }

  if (!response.ok) {
    throw new Error("Turso storage is unavailable or rejected its credentials.");
  }

  let body: HranaPipelineResponse;
  try {
    body = (await response.json()) as HranaPipelineResponse;
  } catch {
    throw new Error("Turso storage returned an invalid response.");
  }

  if (!body || typeof body !== "object" || !Array.isArray(body.results) || body.results.length !== requests.length) {
    throw new Error("Turso storage returned an invalid response.");
  }

  for (const item of body.results) {
    if (!item || typeof item !== "object") {
      throw new Error("Turso storage returned an invalid response.");
    }
    if (item.type === "error") {
      const msg = typeof item.error?.message === "string" ? item.error.message : "";
      if (!includeCreate && /no such table/i.test(msg)) {
        ensuredTables.delete(cacheKey);
        return executeStmt(config, stmt, true);
      }
      throw new Error("Turso storage could not complete the request.");
    }
    if (item.type !== "ok") {
      throw new Error("Turso storage returned an invalid response.");
    }
  }

  if (includeCreate) {
    const createRes = body.results[0];
    if (createRes.type !== "ok" || createRes.response?.type !== "execute") {
      throw new Error("Turso storage returned an invalid response.");
    }
    ensuredTables.add(cacheKey);
  }

  const mainRes = body.results[includeCreate ? 1 : 0];
  if (
    mainRes.type !== "ok" ||
    mainRes.response?.type !== "execute" ||
    !mainRes.response.result ||
    typeof mainRes.response.result !== "object"
  ) {
    throw new Error("Turso storage returned an invalid response.");
  }

  return mainRes.response.result;
}

export async function readTursoRecord(
  config: TursoStoreConfig,
  name: RecordName
): Promise<string | null> {
  const result = await executeStmt(config, {
    sql: "SELECT record_value FROM sushi_state_v1 WHERE record_key = ? LIMIT 1",
    args: [textArg(recordKey(config.prefix, name))],
    named_args: [],
    want_rows: true,
  });

  if (!Array.isArray(result.rows)) {
    throw new Error("Turso storage returned invalid Sushi data.");
  }
  if (result.rows.length === 0) {
    return null;
  }
  if (result.rows.length !== 1 || !Array.isArray(result.rows[0]) || result.rows[0].length < 1) {
    throw new Error("Turso storage returned invalid Sushi data.");
  }
  const cell = result.rows[0][0];
  if (!cell || cell.type !== "text" || typeof cell.value !== "string") {
    throw new Error("Turso storage returned invalid Sushi data.");
  }
  return cell.value;
}

export async function compareAndSwapTursoRecord(
  config: TursoStoreConfig,
  name: RecordName,
  expected: string | null,
  next: string
): Promise<boolean> {
  checkRecordSize(next);
  const key = recordKey(config.prefix, name);
  const now = Date.now();

  const stmt: HranaStmt =
    expected === null
      ? {
          sql:
            "INSERT INTO sushi_state_v1 (record_key, record_value, updated_at) " +
            "VALUES (?, ?, ?) ON CONFLICT(record_key) DO NOTHING",
          args: [textArg(key), textArg(next), intArg(now)],
          named_args: [],
          want_rows: false,
        }
      : {
          sql:
            "UPDATE sushi_state_v1 SET record_value = ?, updated_at = ? " +
            "WHERE record_key = ? AND record_value = ?",
          args: [textArg(next), intArg(now), textArg(key), textArg(expected)],
          named_args: [],
          want_rows: false,
        };

  const result = await executeStmt(config, stmt);
  if (result.affected_row_count !== 0 && result.affected_row_count !== 1) {
    throw new Error("Turso storage returned an invalid write result.");
  }
  return result.affected_row_count === 1;
}

export async function compareAndSwapTursoAuthWithVaultGuard(
  config: TursoStoreConfig,
  expectedAuth: string | null,
  nextAuth: string,
  expectedVault: string | null
): Promise<boolean> {
  checkRecordSize(nextAuth);
  const authKey = recordKey(config.prefix, "auth");
  const vaultKey = recordKey(config.prefix, "vault");
  const now = Date.now();

  let stmt: HranaStmt;
  if (expectedAuth === null && expectedVault === null) {
    stmt = {
      sql:
        "INSERT INTO sushi_state_v1 (record_key, record_value, updated_at) " +
        "SELECT ?, ?, ? " +
        "WHERE NOT EXISTS (SELECT 1 FROM sushi_state_v1 WHERE record_key = ?) " +
        "ON CONFLICT(record_key) DO NOTHING",
      args: [textArg(authKey), textArg(nextAuth), intArg(now), textArg(vaultKey)],
      named_args: [],
      want_rows: false,
    };
  } else if (expectedAuth === null && expectedVault !== null) {
    stmt = {
      sql:
        "INSERT INTO sushi_state_v1 (record_key, record_value, updated_at) " +
        "SELECT ?, ?, ? " +
        "WHERE EXISTS (SELECT 1 FROM sushi_state_v1 WHERE record_key = ? AND record_value = ?) " +
        "ON CONFLICT(record_key) DO NOTHING",
      args: [textArg(authKey), textArg(nextAuth), intArg(now), textArg(vaultKey), textArg(expectedVault)],
      named_args: [],
      want_rows: false,
    };
  } else if (expectedAuth !== null && expectedVault === null) {
    stmt = {
      sql:
        "UPDATE sushi_state_v1 SET record_value = ?, updated_at = ? " +
        "WHERE record_key = ? AND record_value = ? " +
        "AND NOT EXISTS (SELECT 1 FROM sushi_state_v1 WHERE record_key = ?)",
      args: [textArg(nextAuth), intArg(now), textArg(authKey), textArg(expectedAuth), textArg(vaultKey)],
      named_args: [],
      want_rows: false,
    };
  } else {
    stmt = {
      sql:
        "UPDATE sushi_state_v1 SET record_value = ?, updated_at = ? " +
        "WHERE record_key = ? AND record_value = ? " +
        "AND EXISTS (SELECT 1 FROM sushi_state_v1 WHERE record_key = ? AND record_value = ?)",
      args: [
        textArg(nextAuth),
        intArg(now),
        textArg(authKey),
        textArg(expectedAuth!),
        textArg(vaultKey),
        textArg(expectedVault!),
      ],
      named_args: [],
      want_rows: false,
    };
  }

  const result = await executeStmt(config, stmt);
  if (result.affected_row_count !== 0 && result.affected_row_count !== 1) {
    throw new Error("Turso storage returned an invalid write result.");
  }
  return result.affected_row_count === 1;
}
