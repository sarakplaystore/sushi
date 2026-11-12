import type { ConnectionCredentials, HostProfile } from "@/types/connection";

/**
 * "Your command is still running — want to go back?"
 *
 * Sushi's serverless shell already keeps a long command alive on the host: with the
 * **No timeout** toggle a command ignores SIGHUP, writes its session to
 * `/tmp/.sushi-run-*.log` and answers keys through a keystroke FIFO
 * (`/api/ssh/exec/keys`). What was missing was memory: closing or reloading the tab
 * threw away the tab, the command line and the paths, so the running job became
 * unreachable even though it was still running.
 *
 * A *resumable run* is exactly that: the host + user, the command line, the keystroke
 * FIFO path, the output log, and — when the run started in no-timeout mode — a note
 * that it survives the tab. It is kept in `localStorage` (never in the encrypted
 * vault: it is per-browser session state, not a saved host), so after a reload or a
 * crash the workspace can offer to reopen that session, replay the command line and
 * take over the still-running command.
 *
 * Nothing here stores secrets: the FIFO path, the log path, the working directory and
 * the command text only.
 */

export const RESUMABLE_RUNS_KEY = "sushi_resumable_runs_v1";
export const RECENT_HOSTS_KEY = "sushi_recent_hosts_v1";
export const OPEN_TABS_KEY = "sushi_open_tabs_v1";
export const WORKSPACE_TOMBSTONES_KEY = "sushi_workspace_tombstones_v1";
/** A finished run is remembered this long so "go back?" still works after lunch. */
const MAX_RUN_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_RUNS = 20;
/** Recently connected hosts shown on the launchpad (history, not saved hosts). */
const MAX_RECENT_HOSTS = 8;
/** Maximum open tabs persisted/synced across reloads and devices. */
const MAX_OPEN_TABS = 24;
const MAX_TOMBSTONES = 64;

export type RunState = "running" | "finished";

export interface ResumableRun {
  /** Stable id (`run-<uuid>`), also used as the React key of the reopened tab. */
  id: string;
  /** Host profile the run belongs to (name, colour, tags) — credentials resolved later. */
  profile: HostProfile;
  /** The command line exactly as it was typed. */
  command: string;
  /** Working directory the command ran in. */
  cwd: string;
  /** Where the session output is logged on the host (no-timeout runs only). */
  runLog?: string;
  /** Keystroke FIFO of the running command, for `/api/ssh/exec/keys`. */
  keyChannel?: string;
  /** `true` when the wrapper ignores SIGHUP, i.e. the run survives the tab closing. */
  detached: boolean;
  /** `false` until the remote META marker arrived (the command ended on the host). */
  running: boolean;
  /** Exit code once known. */
  exitCode?: number;
  /** Epoch ms when the command was started. */
  startedAt: number;
  /** Epoch ms of the last update (output, key press, poll). */
  updatedAt: number;
}

export interface RecentHostEntry {
  /** Stable key: protocol + user + host + port. */
  key: string;
  name: string;
  protocol: HostProfile["protocol"];
  host: string;
  port: number;
  username: string;
  /** Vault id when the host is saved, `null` for an ad-hoc connection. */
  profileId: string | null;
  /** Snapshot of the profile, so an ad-hoc connection can be reopened as-is. */
  profile: HostProfile;
  lastConnectedAt: number;
  /** How many times it was opened in this browser. */
  connects: number;
}

/** Key that identifies one host + account (two users on one box are two entries). */
export function hostHistoryKey(profile: {
  protocol?: string;
  host: string;
  port?: number;
  username: string;
}): string {
  const protocol = profile.protocol || "ssh";
  return [protocol, (profile.username || "").trim(), (profile.host || "").trim().toLowerCase(), Number(profile.port || 22)].join("|");
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

/** Keeps only the fields that are safe and useful to persist. */
function sanitizeProfile(profile: HostProfile): HostProfile {
  return {
    ...profile,
    // Never persist typed credentials outside the encrypted vault.
    password: undefined,
    passphrase: undefined,
    privateKey: undefined,
  };
}

function isHostProfile(value: unknown): value is HostProfile {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.host === "string" &&
    Boolean(data.host.trim()) &&
    typeof data.username === "string" &&
    Boolean(data.username.trim())
  );
}

function sanitizeRun(value: unknown): ResumableRun | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (!isHostProfile(data.profile)) return null;
  if (typeof data.command !== "string" || !data.command.trim()) return null;
  if (typeof data.id !== "string" || !data.id) return null;
  const startedAt = Number(data.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  return {
    id: data.id,
    profile: sanitizeProfile(data.profile),
    command: data.command,
    cwd: typeof data.cwd === "string" ? data.cwd : "",
    runLog: typeof data.runLog === "string" ? data.runLog : undefined,
    keyChannel: typeof data.keyChannel === "string" ? data.keyChannel : undefined,
    detached: Boolean(data.detached),
    running: Boolean(data.running),
    exitCode: Number.isFinite(Number(data.exitCode)) ? Number(data.exitCode) : undefined,
    startedAt,
    updatedAt: Number(data.updatedAt) > 0 ? Number(data.updatedAt) : startedAt,
  };
}

/** Reads the run list, pruning anything malformed or older than a week. */
export function loadResumableRuns(now = Date.now()): ResumableRun[] {
  const store = storage();
  if (!store) return [];
  const parsed = safeParse(store.getItem(RESUMABLE_RUNS_KEY));
  if (!Array.isArray(parsed)) return [];
  const runs = parsed
    .map(sanitizeRun)
    .filter((run): run is ResumableRun => Boolean(run))
    .filter((run) => now - run.startedAt <= MAX_RUN_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RUNS);
  return runs;
}

function writeRuns(runs: ResumableRun[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      RESUMABLE_RUNS_KEY,
      JSON.stringify(runs.slice(0, MAX_RUNS).map((run) => ({ ...run, profile: sanitizeProfile(run.profile) })))
    );
  } catch {
    // Storage full / private mode: resume history is best effort.
  }
}

/**
 * Inserts or updates one run. A run is identified by its id; updating an existing
 * id keeps the original `startedAt` and only bumps `updatedAt`.
 */
export function upsertResumableRun(
  run: ResumableRun,
  now = Date.now()
): ResumableRun[] {
  const runs = loadResumableRuns(now);
  const index = runs.findIndex((item) => item.id === run.id);
  const next: ResumableRun = {
    ...run,
    profile: sanitizeProfile(run.profile),
    startedAt: index >= 0 ? runs[index].startedAt : run.startedAt || now,
    updatedAt: now,
  };
  if (index >= 0) runs[index] = next;
  else runs.unshift(next);
  const sorted = runs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RUNS);
  writeRuns(sorted);
  return sorted;
}

export function removeResumableRun(id: string, now = Date.now()): ResumableRun[] {
  recordDismissedRun(id, now);
  const runs = loadResumableRuns(now).filter((run) => run.id !== id);
  writeRuns(runs);
  return runs;
}

export function clearResumableRuns(): void {
  storage()?.removeItem(RESUMABLE_RUNS_KEY);
}

/** The newest run that satisfies `predicate` (used to find this tab's last run). */
export function findResumableRun(
  runs: ResumableRun[],
  predicate: (run: ResumableRun) => boolean
): ResumableRun | undefined {
  return runs.find(predicate);
}

/**
 * Runs worth offering on the launchpad: still running on the host, or finished
 * recently (so "go back and read the output" works). Newest first.
 */
export function resumableRunCandidates(
  runs: ResumableRun[],
  now = Date.now()
): ResumableRun[] {
  return runs.filter((run) =>
    run.running ? true : now - run.updatedAt <= MAX_RUN_AGE_MS
  );
}

/** One-line state for the UI: `running · 4m 12s` or `finished · exit 0`. */
export function describeRunState(run: ResumableRun, now = Date.now()): string {
  if (run.running) return `running · ${formatRunDuration(now - run.startedAt)}`;
  if (typeof run.exitCode === "number" && run.exitCode !== 0) {
    return `finished · exit ${run.exitCode}`;
  }
  return "finished · exit 0";
}

/** `0s`, `42s`, `4m 12s`, `2h 05m`, `3d 4h`. */
export function formatRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

// ---------------------------------------------------------------------------------
// Recently connected hosts
// ---------------------------------------------------------------------------------

function sanitizeRecent(value: unknown): RecentHostEntry | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (!isHostProfile(data.profile)) return null;
  const lastConnectedAt = Number(data.lastConnectedAt);
  if (!Number.isFinite(lastConnectedAt) || lastConnectedAt <= 0) return null;
  return {
    key:
      typeof data.key === "string" && data.key
        ? data.key
        : hostHistoryKey(data.profile),
    name:
      typeof data.name === "string" && data.name.trim()
        ? data.name
        : data.profile.name || `${data.profile.username}@${data.profile.host}`,
    protocol: data.profile.protocol || "ssh",
    host: data.profile.host,
    port: Number(data.profile.port || 22),
    username: data.profile.username,
    // An explicit `null` means "ad-hoc, not in the vault" and must survive a reload;
    // only a missing field falls back to the profile's own id.
    profileId:
      data.profileId === null
        ? null
        : typeof data.profileId === "string" && data.profileId
          ? data.profileId
          : data.profile.id || null,
    profile: sanitizeProfile(data.profile),
    lastConnectedAt,
    connects: Number(data.connects) > 0 ? Number(data.connects) : 1,
  };
}

/** Recently connected hosts, newest first. Never touches the encrypted vault. */
export function loadRecentHosts(now = Date.now()): RecentHostEntry[] {
  const store = storage();
  if (!store) return [];
  const parsed = safeParse(store.getItem(RECENT_HOSTS_KEY));
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(sanitizeRecent)
    .filter((entry): entry is RecentHostEntry => Boolean(entry))
    .filter((entry) => now - entry.lastConnectedAt <= MAX_RUN_AGE_MS)
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, MAX_RECENT_HOSTS);
}

function writeRecentHosts(entries: RecentHostEntry[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      RECENT_HOSTS_KEY,
      JSON.stringify(
        entries
          .slice(0, MAX_RECENT_HOSTS)
          .map((entry) => ({ ...entry, profile: sanitizeProfile(entry.profile) }))
      )
    );
  } catch {
    // best effort
  }
}

/**
 * Records that a host was opened (called when a session actually connects, not when
 * a tab is created, so a host that never answered is not "recently connected").
 * `connectedAt` markers from the same host keep the newest profile snapshot.
 */
export function recordRecentHost(
  profile: HostProfile,
  options: { isSaved?: boolean; now?: number } = {}
): RecentHostEntry[] {
  const now = options.now ?? Date.now();
  const entries = loadRecentHosts(now);
  const key = hostHistoryKey(profile);
  const existing = entries.find((entry) => entry.key === key);
  const entry: RecentHostEntry = {
    key,
    name: profile.name || `${profile.username}@${profile.host}`,
    protocol: profile.protocol,
    host: profile.host,
    port: Number(profile.port || 22),
    username: profile.username,
    profileId: existing?.profileId ?? (options.isSaved === false ? null : profile.id || null),
    profile: sanitizeProfile(profile),
    lastConnectedAt: now,
    connects: (existing?.connects || 0) + 1,
  };
  const next = [entry, ...entries.filter((item) => item.key !== key)]
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, MAX_RECENT_HOSTS);
  writeRecentHosts(next);
  return next;
}

export function removeRecentHost(key: string, now = Date.now()): RecentHostEntry[] {
  recordRemovedRecentHost(key, now);
  const next = loadRecentHosts(now).filter((entry) => entry.key !== key);
  writeRecentHosts(next);
  return next;
}

export function clearRecentHosts(): void {
  storage()?.removeItem(RECENT_HOSTS_KEY);
}

// ---------------------------------------------------------------------------------
// Cross-device & reload persistent workspace state (open tabs + runs + recent hosts)
// ---------------------------------------------------------------------------------

export interface PersistedSessionTab {
  /** Stable tab id (`tab-<uuid>`), preserved across reloads and devices. */
  id: string;
  title: string;
  protocol: HostProfile["protocol"];
  /** Sanitized host snapshot (credentials resolved from the encrypted vault). */
  profile: HostProfile;
  /** Vault HostProfile.id when backed by a saved connection, `null` for ad-hoc. */
  hostId?: string | null;
  initialPath?: string;
  createdAt: number;
  updatedAt: number;
  /** Active ResumableRun id tracked by this tab, if any. */
  runId?: string | null;
}

export interface WorkspaceTombstones {
  closedTabs: Record<string, number>;
  dismissedRuns: Record<string, number>;
  removedRecentHosts: Record<string, number>;
}

export interface SyncedWorkspaceState {
  openTabs: PersistedSessionTab[];
  activeTabId: string;
  activeTabUpdatedAt: number;
  closedTabs: Record<string, number>;
  resumableRuns: ResumableRun[];
  dismissedRuns: Record<string, number>;
  recentHosts: RecentHostEntry[];
  removedRecentHosts: Record<string, number>;
}

function sanitizeTimestampMap(
  value: unknown,
  now = Date.now(),
  maxAgeMs = MAX_RUN_AGE_MS
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k, ts]) => Boolean(k) && Number.isFinite(Number(ts)) && Number(ts) > 0 && now - Number(ts) <= maxAgeMs)
    .map(([k, ts]) => [k, Number(ts)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOMBSTONES);
  return Object.fromEntries(entries);
}

function mergeTimestampMaps(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
  now = Date.now()
): Record<string, number> {
  const combined: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [key, rawTs] of Object.entries(src)) {
      const ts = Number(rawTs);
      if (!key || !Number.isFinite(ts) || ts <= 0 || now - ts > MAX_RUN_AGE_MS) continue;
      combined[key] = Math.max(combined[key] || 0, ts);
    }
  }
  return sanitizeTimestampMap(combined, now);
}

export function loadWorkspaceTombstones(now = Date.now()): WorkspaceTombstones {
  const store = storage();
  if (!store) return { closedTabs: {}, dismissedRuns: {}, removedRecentHosts: {} };
  const parsed = safeParse(store.getItem(WORKSPACE_TOMBSTONES_KEY));
  if (!parsed || typeof parsed !== "object") {
    return { closedTabs: {}, dismissedRuns: {}, removedRecentHosts: {} };
  }
  const data = parsed as Record<string, unknown>;
  return {
    closedTabs: sanitizeTimestampMap(data.closedTabs, now),
    dismissedRuns: sanitizeTimestampMap(data.dismissedRuns, now),
    removedRecentHosts: sanitizeTimestampMap(data.removedRecentHosts, now),
  };
}

function writeWorkspaceTombstones(tombstones: WorkspaceTombstones, now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      WORKSPACE_TOMBSTONES_KEY,
      JSON.stringify({
        closedTabs: sanitizeTimestampMap(tombstones.closedTabs, now),
        dismissedRuns: sanitizeTimestampMap(tombstones.dismissedRuns, now),
        removedRecentHosts: sanitizeTimestampMap(tombstones.removedRecentHosts, now),
      })
    );
  } catch {
    // best effort
  }
}

export function recordClosedTab(tabId: string, now = Date.now()): void {
  if (!tabId) return;
  const tombstones = loadWorkspaceTombstones(now);
  tombstones.closedTabs[tabId] = now;
  writeWorkspaceTombstones(tombstones, now);
}

export function recordDismissedRun(runId: string, now = Date.now()): void {
  if (!runId) return;
  const tombstones = loadWorkspaceTombstones(now);
  tombstones.dismissedRuns[runId] = now;
  writeWorkspaceTombstones(tombstones, now);
}

export function recordRemovedRecentHost(key: string, now = Date.now()): void {
  if (!key) return;
  const tombstones = loadWorkspaceTombstones(now);
  tombstones.removedRecentHosts[key] = now;
  writeWorkspaceTombstones(tombstones, now);
}

function sanitizePersistedTab(value: unknown): PersistedSessionTab | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id.trim()) return null;
  if (!isHostProfile(data.profile)) return null;
  const protoRaw = data.protocol;
  const protocol: HostProfile["protocol"] =
    protoRaw === "sftp" || protoRaw === "rdp" || protoRaw === "ssh"
      ? protoRaw
      : data.profile.protocol || "ssh";
  const createdAt = Number(data.createdAt);
  const validCreatedAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
  const updatedAt = Number(data.updatedAt);
  const validUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : validCreatedAt;
  return {
    id: data.id,
    title:
      typeof data.title === "string" && data.title.trim()
        ? data.title
        : data.profile.name || `${data.profile.username}@${data.profile.host}`,
    protocol,
    profile: sanitizeProfile(data.profile),
    hostId:
      data.hostId === null
        ? null
        : typeof data.hostId === "string" && data.hostId
          ? data.hostId
          : data.profile.id || null,
    initialPath: typeof data.initialPath === "string" ? data.initialPath : undefined,
    createdAt: validCreatedAt,
    updatedAt: validUpdatedAt,
    runId: typeof data.runId === "string" && data.runId ? data.runId : null,
  };
}

export function loadPersistedTabs(): {
  openTabs: PersistedSessionTab[];
  activeTabId: string;
  activeTabUpdatedAt: number;
} {
  const store = storage();
  if (!store) return { openTabs: [], activeTabId: "launchpad", activeTabUpdatedAt: 0 };
  const parsed = safeParse(store.getItem(OPEN_TABS_KEY));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { openTabs: [], activeTabId: "launchpad", activeTabUpdatedAt: 0 };
  }
  const data = parsed as Record<string, unknown>;
  const openTabs = Array.isArray(data.openTabs)
    ? data.openTabs
        .map(sanitizePersistedTab)
        .filter((tab): tab is PersistedSessionTab => Boolean(tab))
        .slice(0, MAX_OPEN_TABS)
    : [];
  const rawActive = typeof data.activeTabId === "string" && data.activeTabId ? data.activeTabId : "launchpad";
  const activeTabId =
    rawActive === "launchpad" || openTabs.some((tab) => tab.id === rawActive)
      ? rawActive
      : "launchpad";
  const activeTabUpdatedAt =
    Number.isFinite(Number(data.activeTabUpdatedAt)) && Number(data.activeTabUpdatedAt) > 0
      ? Number(data.activeTabUpdatedAt)
      : 0;
  return { openTabs, activeTabId, activeTabUpdatedAt };
}

export function savePersistedTabs(
  tabs: PersistedSessionTab[],
  activeTabId: string,
  activeTabUpdatedAt = Date.now()
): void {
  const store = storage();
  if (!store) return;
  const sanitized = tabs
    .slice(0, MAX_OPEN_TABS)
    .map((tab) => ({ ...tab, profile: sanitizeProfile(tab.profile) }));
  const validActive =
    activeTabId === "launchpad" || sanitized.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : "launchpad";
  try {
    store.setItem(
      OPEN_TABS_KEY,
      JSON.stringify({
        openTabs: sanitized,
        activeTabId: validActive,
        activeTabUpdatedAt,
      })
    );
  } catch {
    // best effort
  }
}

export function normalizeSyncedWorkspaceState(
  value: unknown,
  now = Date.now()
): SyncedWorkspaceState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const closedTabs = sanitizeTimestampMap(data.closedTabs, now);
  const dismissedRuns = sanitizeTimestampMap(data.dismissedRuns, now);
  const removedRecentHosts = sanitizeTimestampMap(data.removedRecentHosts, now);

  const openTabs = (Array.isArray(data.openTabs) ? data.openTabs : [])
    .map(sanitizePersistedTab)
    .filter((tab): tab is PersistedSessionTab => Boolean(tab))
    .filter((tab) => (closedTabs[tab.id] ?? 0) < tab.updatedAt)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, MAX_OPEN_TABS);

  const resumableRuns = (Array.isArray(data.resumableRuns) ? data.resumableRuns : [])
    .map(sanitizeRun)
    .filter((run): run is ResumableRun => Boolean(run))
    .filter((run) => now - run.startedAt <= MAX_RUN_AGE_MS && (dismissedRuns[run.id] ?? 0) < run.updatedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RUNS);

  const recentHosts = (Array.isArray(data.recentHosts) ? data.recentHosts : [])
    .map(sanitizeRecent)
    .filter((entry): entry is RecentHostEntry => Boolean(entry))
    .filter(
      (entry) =>
        now - entry.lastConnectedAt <= MAX_RUN_AGE_MS &&
        (removedRecentHosts[entry.key] ?? 0) < entry.lastConnectedAt
    )
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, MAX_RECENT_HOSTS);

  const rawActive = typeof data.activeTabId === "string" && data.activeTabId ? data.activeTabId : "launchpad";
  const activeTabId =
    rawActive === "launchpad" || openTabs.some((tab) => tab.id === rawActive)
      ? rawActive
      : "launchpad";
  const activeTabUpdatedAt =
    Number.isFinite(Number(data.activeTabUpdatedAt)) && Number(data.activeTabUpdatedAt) > 0
      ? Number(data.activeTabUpdatedAt)
      : 0;

  return {
    openTabs,
    activeTabId,
    activeTabUpdatedAt,
    closedTabs,
    resumableRuns,
    dismissedRuns,
    recentHosts,
    removedRecentHosts,
  };
}

/**
 * Commutative, associative, idempotent merge of two devices' workspace states.
 * Neither device loses open tabs, running commands, or recent hosts when changes
 * happen concurrently across devices.
 */
export function mergeWorkspaceStates(
  a?: Partial<SyncedWorkspaceState> | null,
  b?: Partial<SyncedWorkspaceState> | null,
  now = Date.now()
): SyncedWorkspaceState {
  const closedTabs = mergeTimestampMaps(a?.closedTabs, b?.closedTabs, now);
  const dismissedRuns = mergeTimestampMaps(a?.dismissedRuns, b?.dismissedRuns, now);
  const removedRecentHosts = mergeTimestampMaps(a?.removedRecentHosts, b?.removedRecentHosts, now);

  const tabMap = new Map<string, PersistedSessionTab>();
  for (const raw of [...(a?.openTabs ?? []), ...(b?.openTabs ?? [])]) {
    const tab = sanitizePersistedTab(raw);
    if (!tab) continue;
    const prev = tabMap.get(tab.id);
    if (!prev) {
      tabMap.set(tab.id, tab);
    } else {
      const newer = tab.updatedAt >= prev.updatedAt ? tab : prev;
      const older = newer === tab ? prev : tab;
      tabMap.set(tab.id, {
        ...newer,
        createdAt: Math.min(prev.createdAt, tab.createdAt),
        runId: newer.runId !== undefined ? newer.runId : older.runId,
      });
    }
  }
  const openTabs = [...tabMap.values()]
    .filter((tab) => (closedTabs[tab.id] ?? 0) < tab.updatedAt)
    .sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id))
    .slice(0, MAX_OPEN_TABS);

  const runMap = new Map<string, ResumableRun>();
  for (const raw of [...(a?.resumableRuns ?? []), ...(b?.resumableRuns ?? [])]) {
    const run = sanitizeRun(raw);
    if (!run || now - run.startedAt > MAX_RUN_AGE_MS) continue;
    const prev = runMap.get(run.id);
    if (!prev) {
      runMap.set(run.id, run);
    } else {
      const newer =
        run.updatedAt > prev.updatedAt
          ? run
          : run.updatedAt < prev.updatedAt
            ? prev
            : !run.running
              ? run
              : prev;
      const older = newer === run ? prev : run;
      runMap.set(run.id, {
        ...newer,
        startedAt: Math.min(prev.startedAt, run.startedAt),
        updatedAt: Math.max(prev.updatedAt, run.updatedAt),
        keyChannel: newer.keyChannel ?? older.keyChannel,
        runLog: newer.runLog ?? older.runLog,
        detached: Boolean(prev.detached || run.detached),
        exitCode: newer.running ? undefined : (newer.exitCode ?? older.exitCode),
      });
    }
  }
  const resumableRuns = [...runMap.values()]
    .filter((run) => (dismissedRuns[run.id] ?? 0) < run.updatedAt)
    .sort((x, y) => y.updatedAt - x.updatedAt || x.id.localeCompare(y.id))
    .slice(0, MAX_RUNS);

  const recentMap = new Map<string, RecentHostEntry>();
  for (const raw of [...(a?.recentHosts ?? []), ...(b?.recentHosts ?? [])]) {
    const entry = sanitizeRecent(raw);
    if (!entry || now - entry.lastConnectedAt > MAX_RUN_AGE_MS) continue;
    const prev = recentMap.get(entry.key);
    if (!prev) {
      recentMap.set(entry.key, entry);
    } else {
      const newer = entry.lastConnectedAt >= prev.lastConnectedAt ? entry : prev;
      recentMap.set(entry.key, {
        ...newer,
        connects: Math.max(prev.connects, entry.connects),
      });
    }
  }
  const recentHosts = [...recentMap.values()]
    .filter((entry) => (removedRecentHosts[entry.key] ?? 0) < entry.lastConnectedAt)
    .sort((x, y) => y.lastConnectedAt - x.lastConnectedAt || x.key.localeCompare(y.key))
    .slice(0, MAX_RECENT_HOSTS);

  const aTs = Number(a?.activeTabUpdatedAt) || 0;
  const bTs = Number(b?.activeTabUpdatedAt) || 0;
  const preferredActive = bTs > aTs ? b?.activeTabId : a?.activeTabId;
  const fallbackActive = bTs > aTs ? a?.activeTabId : b?.activeTabId;
  const isValidTab = (id?: string | null) =>
    Boolean(id && (id === "launchpad" || openTabs.some((t) => t.id === id)));
  const activeTabId = isValidTab(preferredActive)
    ? preferredActive!
    : isValidTab(fallbackActive)
      ? fallbackActive!
      : openTabs[openTabs.length - 1]?.id ?? "launchpad";
  const activeTabUpdatedAt = Math.max(aTs, bTs);

  return {
    openTabs,
    activeTabId,
    activeTabUpdatedAt,
    closedTabs,
    resumableRuns,
    dismissedRuns,
    recentHosts,
    removedRecentHosts,
  };
}

export function readLocalWorkspaceState(now = Date.now()): SyncedWorkspaceState {
  const tabsState = loadPersistedTabs();
  const tombstones = loadWorkspaceTombstones(now);
  return mergeWorkspaceStates(
    {
      openTabs: tabsState.openTabs,
      activeTabId: tabsState.activeTabId,
      activeTabUpdatedAt: tabsState.activeTabUpdatedAt,
      closedTabs: tombstones.closedTabs,
      resumableRuns: loadResumableRuns(now),
      dismissedRuns: tombstones.dismissedRuns,
      recentHosts: loadRecentHosts(now),
      removedRecentHosts: tombstones.removedRecentHosts,
    },
    null,
    now
  );
}

export function writeLocalWorkspaceState(state: SyncedWorkspaceState, now = Date.now()): void {
  writeWorkspaceTombstones(
    {
      closedTabs: state.closedTabs,
      dismissedRuns: state.dismissedRuns,
      removedRecentHosts: state.removedRecentHosts,
    },
    now
  );
  savePersistedTabs(state.openTabs, state.activeTabId, state.activeTabUpdatedAt);
  writeRuns(state.resumableRuns);
  writeRecentHosts(state.recentHosts);
}

/**
 * Finds a still-running command on the remote host that belongs to an SSH tab,
 * either via its explicit `runId` or by matching `protocol + user + host + port`.
 */
export function matchRunningCommandForTab(
  tab: { protocol: HostProfile["protocol"]; profile: HostProfile; runId?: string | null },
  runs: ResumableRun[],
  claimedRunIds?: Set<string>
): ResumableRun | null {
  if (tab.protocol !== "ssh") return null;
  if (tab.runId) {
    const exact = runs.find(
      (run) => run.id === tab.runId && run.running && !claimedRunIds?.has(run.id)
    );
    if (exact) return exact;
  }
  const targetKey = hostHistoryKey(tab.profile);
  const byHost = runs
    .filter(
      (run) =>
        run.running &&
        !claimedRunIds?.has(run.id) &&
        hostHistoryKey(run.profile) === targetKey
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return byHost ?? null;
}

// ---------------------------------------------------------------------------------
// "Go back?" prompt
// ---------------------------------------------------------------------------------

export interface ResumePrompt {
  /** Newest still-running run to offer, if any. */
  run: ResumableRun;
  /** True when the run survives without the tab (no-timeout + keystroke FIFO). */
  survivesTab: boolean;
  title: string;
  body: string;
  /** Primary action label. */
  acceptLabel: string;
}

/**
 * What the workspace asks after a reload: was a command left running? Only runs that
 * are still `running` on the host and were touched recently are offered — a finished
 * run has nothing to go back to (its output is already in the log).
 */
export function buildResumePrompt(
  runs: ResumableRun[],
  options: { now?: number; maxAgeMs?: number } = {}
): ResumePrompt | null {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? 1000 * 60 * 60 * 24 * 2;
  const candidate = runs
    .filter((run) => run.running && now - run.updatedAt <= maxAge)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!candidate) return null;

  const elapsed = formatRunDuration(now - candidate.startedAt);
  const where = `${candidate.profile.username}@${candidate.profile.host}`;
  const command = candidate.command.length > 90
    ? `${candidate.command.slice(0, 87)}…`
    : candidate.command;
  const survivesTab = candidate.detached && Boolean(candidate.keyChannel);

  return {
    run: candidate,
    survivesTab,
    title: survivesTab
      ? "A command is still running on the host"
      : "Your last command may still be running",
    body: survivesTab
      ? `\`${command}\` on ${where} has been running for ${elapsed}. It kept running after you left because No timeout was on. Go back to that session, or stop it on the host.`
      : `\`${command}\` on ${where} was still running ${elapsed} ago. Go back to that session to see the output.`,
    acceptLabel: "Go back to the session",
  };
}
