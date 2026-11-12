import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as setup } from "../src/app/api/auth/setup/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as getVault, POST as postVault } from "../src/app/api/vault/route";
import {
  DEFAULT_SNIPPETS,
  decryptVaultEnvelope,
  encryptVaultData,
  mergeVaultPlaintexts,
  resolvePersistedTabProfile,
  type EncryptedVaultEnvelope,
  type VaultPlaintext,
} from "../src/lib/client/crypto-vault";
import {
  OPEN_TABS_KEY,
  RECENT_HOSTS_KEY,
  RESUMABLE_RUNS_KEY,
  WORKSPACE_TOMBSTONES_KEY,
  matchRunningCommandForTab,
  mergeWorkspaceStates,
  readLocalWorkspaceState,
  recordClosedTab,
  recordRecentHost,
  removeRecentHost,
  removeResumableRun,
  savePersistedTabs,
  upsertResumableRun,
  writeLocalWorkspaceState,
  type PersistedSessionTab,
  type ResumableRun,
  type SyncedWorkspaceState,
} from "../src/lib/client/session-resume";
import type { HostProfile, WhitelistedSshKey } from "../src/types/connection";

function makeRequest(route: string, method = "GET", body?: unknown, token?: string) {
  return new NextRequest(`http://localhost${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      ...(token ? { "x-sushi-session": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function run() {
  console.log("==> Testing cross-device persistent sessions & live conflict-free workspace merge...");

  // Install isolated in-memory localStorage to verify zero secrets leak locally.
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  } as Storage;

  const now = Date.now() - 60_000;
  const sshKey: WhitelistedSshKey = {
    id: "key-main",
    name: "Prod Ed25519",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER-SECRET-KEY\n-----END OPENSSH PRIVATE KEY-----",
    passphrase: "key-secret-passphrase",
    createdAt: now - 100_000,
  };
  const prodHost: HostProfile = {
    id: "host-prod",
    name: "Prod API",
    protocol: "ssh",
    host: "198.51.100.10",
    port: 22,
    username: "ubuntu",
    authMethod: "privateKey",
    sshKeyId: "key-main",
    createdAt: now - 90_000,
    updatedAt: now - 90_000,
  };
  const dbHost: HostProfile = {
    id: "host-db",
    name: "Core Postgres",
    protocol: "ssh",
    host: "198.51.100.20",
    port: 2222,
    username: "root",
    authMethod: "password",
    password: "db-root-secret-password",
    createdAt: now - 80_000,
    updatedAt: now - 80_000,
  };

  // 1. Local persistence strips all secrets while preserving open tabs, runs, and recent hosts.
  const tabProd: PersistedSessionTab = {
    id: "tab-prod-ssh",
    title: "Prod API",
    protocol: "ssh",
    profile: { ...prodHost, privateKey: sshKey.privateKey, passphrase: sshKey.passphrase },
    hostId: prodHost.id,
    initialPath: "/srv/app",
    createdAt: now - 10_000,
    updatedAt: now - 5_000,
    runId: "run-deploy-1",
  };
  const tabProdSftp: PersistedSessionTab = {
    id: "tab-prod-sftp",
    title: "Prod API",
    protocol: "sftp",
    profile: { ...prodHost, protocol: "sftp", privateKey: sshKey.privateKey },
    hostId: prodHost.id,
    initialPath: "/srv/app/releases",
    createdAt: now - 8_000,
    updatedAt: now - 4_000,
  };
  savePersistedTabs([tabProd, tabProdSftp], "tab-prod-ssh", now - 3_000);

  const runningDeploy: ResumableRun = {
    id: "run-deploy-1",
    profile: { ...prodHost, privateKey: sshKey.privateKey },
    command: "docker compose pull && docker compose up -d",
    cwd: "/srv/app",
    runLog: "/tmp/.sushi-run-aabbccddeeff001122.log",
    keyChannel: "/tmp/.sushi-keys-aabbccddeeff001122",
    detached: true,
    running: true,
    startedAt: now - 6_000,
    updatedAt: now - 2_000,
  };
  upsertResumableRun(runningDeploy, now - 2_000);
  recordRecentHost({ ...prodHost, privateKey: sshKey.privateKey }, { isSaved: true, now: now - 2_000 });

  const allLocalRaw = [
    store.get(OPEN_TABS_KEY) ?? "",
    store.get(RESUMABLE_RUNS_KEY) ?? "",
    store.get(RECENT_HOSTS_KEY) ?? "",
    store.get(WORKSPACE_TOMBSTONES_KEY) ?? "",
  ].join("\n");
  assert.ok(!allLocalRaw.includes("SUPER-SECRET-KEY"), "SSH private key never touches localStorage");
  assert.ok(!allLocalRaw.includes("key-secret-passphrase"), "key passphrase never touches localStorage");
  assert.ok(!allLocalRaw.includes("db-root-secret-password"), "host password never touches localStorage");

  const deviceAWorkspace = readLocalWorkspaceState(now);
  assert.equal(deviceAWorkspace.openTabs.length, 2);
  assert.equal(deviceAWorkspace.activeTabId, "tab-prod-ssh");
  assert.equal(deviceAWorkspace.resumableRuns.length, 1);
  assert.equal(deviceAWorkspace.resumableRuns[0].running, true);
  assert.equal(deviceAWorkspace.recentHosts.length, 1);

  // 2. Encrypting on Device A and decrypting on Device B restores full workspace + resolves credentials.
  const accountPassword = "cross-device-passphrase-99!";
  const basePlain: VaultPlaintext = {
    version: 1,
    hosts: [prodHost, dbHost],
    snippets: DEFAULT_SNIPPETS,
    sshKeys: [sshKey],
    enforceKeyWhitelist: true,
    workspace: deviceAWorkspace,
  };
  const encrypted = await encryptVaultData(basePlain, accountPassword);
  assert.ok(!JSON.stringify(encrypted).includes("docker compose"), "commands are encrypted inside the vault");
  assert.ok(!JSON.stringify(encrypted).includes("198.51.100.10"), "host IPs are encrypted inside the vault");

  const decryptedOnDeviceB = await decryptVaultEnvelope(encrypted, accountPassword);
  assert.ok(decryptedOnDeviceB.workspace, "workspace state round-trips through encrypted vault");
  assert.equal(decryptedOnDeviceB.workspace!.openTabs.length, 2);
  assert.equal(decryptedOnDeviceB.workspace!.activeTabId, "tab-prod-ssh");
  assert.equal(decryptedOnDeviceB.workspace!.resumableRuns[0].runLog, runningDeploy.runLog);
  assert.equal(decryptedOnDeviceB.workspace!.resumableRuns[0].keyChannel, runningDeploy.keyChannel);

  // Resolve credentials for both SSH and companion SFTP tabs on Device B.
  const resolvedSsh = resolvePersistedTabProfile(
    decryptedOnDeviceB.workspace!.openTabs[0],
    decryptedOnDeviceB.hosts,
    decryptedOnDeviceB.sshKeys!,
    true
  );
  assert.ok(resolvedSsh, "SSH tab resolves credentials from vault");
  assert.equal(resolvedSsh!.privateKey, sshKey.privateKey);
  assert.equal(resolvedSsh!.passphrase, sshKey.passphrase);
  assert.equal(resolvedSsh!.initialPath, "/srv/app");

  const resolvedSftp = resolvePersistedTabProfile(
    decryptedOnDeviceB.workspace!.openTabs[1],
    decryptedOnDeviceB.hosts,
    decryptedOnDeviceB.sshKeys!,
    true
  );
  assert.ok(resolvedSftp, "Companion SFTP tab resolves credentials from sibling SSH host");
  assert.equal(resolvedSftp!.protocol, "sftp");
  assert.equal(resolvedSftp!.privateKey, sshKey.privateKey);

  // Matching running command attaches once to the right SSH tab, never to SFTP.
  const claimed = new Set<string>();
  const matchedForSsh = matchRunningCommandForTab(
    decryptedOnDeviceB.workspace!.openTabs[0],
    decryptedOnDeviceB.workspace!.resumableRuns,
    claimed
  );
  assert.equal(matchedForSsh?.id, "run-deploy-1");
  claimed.add(matchedForSsh!.id);
  assert.equal(
    matchRunningCommandForTab(
      decryptedOnDeviceB.workspace!.openTabs[1],
      decryptedOnDeviceB.workspace!.resumableRuns,
      claimed
    ),
    null
  );

  // Deleted host with no remaining credentials returns null on fresh restore instead of a broken tab.
  assert.equal(
    resolvePersistedTabProfile(decryptedOnDeviceB.workspace!.openTabs[0], [], [], false),
    null
  );

  // 3. Concurrent changes on Device B while Device A keeps running: CRDT + 3-way merge.
  // Device A starts a second command on dbHost; meanwhile Device B rotates dbHost's password,
  // adds a new staging host, opens a tab for staging, and closes the old SFTP tab.
  const tabDbOnA: PersistedSessionTab = {
    id: "tab-db-ssh",
    title: "Core Postgres",
    protocol: "ssh",
    profile: { ...dbHost, password: undefined },
    hostId: dbHost.id,
    createdAt: now + 1_000,
    updatedAt: now + 2_000,
    runId: "run-backup-2",
  };
  const backupRunOnA: ResumableRun = {
    id: "run-backup-2",
    profile: { ...dbHost, password: undefined },
    command: "pg_dumpall -U postgres > /backups/full.sql",
    cwd: "/backups",
    runLog: "/tmp/.sushi-run-998877665544332211.log",
    keyChannel: "/tmp/.sushi-keys-998877665544332211",
    detached: true,
    running: true,
    startedAt: now + 1_500,
    updatedAt: now + 2_000,
  };
  const deviceAState: SyncedWorkspaceState = mergeWorkspaceStates(
    deviceAWorkspace,
    {
      openTabs: [...deviceAWorkspace.openTabs, tabDbOnA],
      activeTabId: "tab-db-ssh",
      activeTabUpdatedAt: now + 2_000,
      resumableRuns: [backupRunOnA, ...deviceAWorkspace.resumableRuns],
    },
    now + 5_000
  );

  const stagingHostOnB: HostProfile = {
    id: "host-staging",
    name: "Staging Worker",
    protocol: "ssh",
    host: "198.51.100.30",
    port: 22,
    username: "deploy",
    authMethod: "password",
    password: "staging-password",
    createdAt: now + 3_000,
    updatedAt: now + 3_000,
  };
  const rotatedDbHostOnB: HostProfile = {
    ...dbHost,
    password: "rotated-db-password-v2",
    updatedAt: now + 3_500,
  };
  const tabStagingOnB: PersistedSessionTab = {
    id: "tab-staging-ssh",
    title: "Staging Worker",
    protocol: "ssh",
    profile: { ...stagingHostOnB, password: undefined },
    hostId: stagingHostOnB.id,
    createdAt: now + 3_100,
    updatedAt: now + 3_200,
  };
  const deviceBState: SyncedWorkspaceState = mergeWorkspaceStates(
    deviceAWorkspace,
    {
      openTabs: [tabProd, tabStagingOnB],
      closedTabs: { "tab-prod-sftp": now + 3_300 },
      activeTabId: "tab-staging-ssh",
      activeTabUpdatedAt: now + 3_400,
    },
    now + 5_000
  );

  // Commutativity check: merge(A, B) === merge(B, A)
  const mergedAB = mergeWorkspaceStates(deviceAState, deviceBState, now + 5_000);
  const mergedBA = mergeWorkspaceStates(deviceBState, deviceAState, now + 5_000);
  assert.deepEqual(mergedAB, mergedBA, "workspace merge is commutative");
  assert.deepEqual(
    mergeWorkspaceStates(mergedAB, deviceAState, now + 5_000),
    mergedAB,
    "workspace merge is idempotent"
  );
  assert.deepEqual(
    mergedAB.openTabs.map((t) => t.id),
    ["tab-prod-ssh", "tab-db-ssh", "tab-staging-ssh"],
    "keeps tabs from both devices while honoring explicit close tombstone"
  );
  assert.equal(mergedAB.resumableRuns.length, 2, "both devices' running commands stay alive");
  assert.ok(mergedAB.resumableRuns.every((r) => r.running));

  // Tombstones for dismissed runs and removed recent hosts prevent resurrection.
  store.clear();
  writeLocalWorkspaceState(mergedAB, now + 5_000);
  recordClosedTab("tab-staging-ssh", now + 6_000);
  removeResumableRun("run-deploy-1", now + 6_000);
  removeRecentHost(mergedAB.recentHosts[0].key, now + 6_000);
  const afterDismissals = mergeWorkspaceStates(readLocalWorkspaceState(now + 6_000), mergedAB, now + 6_000);
  assert.ok(!afterDismissals.openTabs.some((t) => t.id === "tab-staging-ssh"));
  assert.ok(!afterDismissals.resumableRuns.some((r) => r.id === "run-deploy-1"));
  assert.equal(afterDismissals.resumableRuns.length, 1);
  assert.equal(afterDismissals.resumableRuns[0].id, "run-backup-2");
  assert.equal(afterDismissals.recentHosts.length, 0);

  // Full 3-way VaultPlaintext merge over a simulated /api/vault 409 conflict!
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sushi-cross-device-"));
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  try {
    const setupRes = await setup(
      makeRequest("/api/auth/setup", "POST", { username: "admin", password: accountPassword })
    );
    assert.equal(setupRes.status, 200);
    const tokenA = ((await setupRes.json()) as { sessionToken: string }).sessionToken;
    const loginRes = await login(
      makeRequest("/api/auth/login", "POST", { username: "admin", password: accountPassword })
    );
    const tokenB = ((await loginRes.json()) as { sessionToken: string }).sessionToken;

    const initialEnv: EncryptedVaultEnvelope = {
      ...(await encryptVaultData(basePlain, accountPassword)),
      keySource: "account",
    };
    const r1Res = await postVault(
      makeRequest("/api/vault", "POST", { envelope: initialEnv, baseRevision: null }, tokenA)
    );
    assert.equal(r1Res.status, 200);
    const rev1 = ((await r1Res.json()) as { revision: string }).revision;

    // Device B saves host edits + new staging tab against rev1 -> succeeds (rev2).
    const plainB: VaultPlaintext = {
      ...basePlain,
      hosts: [prodHost, rotatedDbHostOnB, stagingHostOnB],
      workspace: deviceBState,
    };
    const envB: EncryptedVaultEnvelope = {
      ...(await encryptVaultData(plainB, accountPassword)),
      keySource: "account",
    };
    const r2Res = await postVault(
      makeRequest("/api/vault", "POST", { envelope: envB, baseRevision: rev1 }, tokenB)
    );
    assert.equal(r2Res.status, 200);
    const rev2 = ((await r2Res.json()) as { revision: string }).revision;

    // Device A tries to save its new backup run against stale rev1 -> gets 409,
    // fetches rev2, runs mergeVaultPlaintexts(basePlain, plainA, remotePlain), and saves rev3!
    const plainA: VaultPlaintext = {
      ...basePlain,
      workspace: deviceAState,
    };
    const staleEnvA: EncryptedVaultEnvelope = {
      ...(await encryptVaultData(plainA, accountPassword)),
      keySource: "account",
    };
    const conflictRes = await postVault(
      makeRequest("/api/vault", "POST", { envelope: staleEnvA, baseRevision: rev1 }, tokenA)
    );
    assert.equal(conflictRes.status, 409);

    const latestFromServer = (await (
      await getVault(makeRequest("/api/vault", "GET", undefined, tokenA))
    ).json()) as { envelope: EncryptedVaultEnvelope; revision: string };
    assert.equal(latestFromServer.revision, rev2);
    const remotePlain = await decryptVaultEnvelope(latestFromServer.envelope, accountPassword);
    const mergedPlain = mergeVaultPlaintexts(basePlain, plainA, remotePlain, now + 5_000);

    const mergedEnv: EncryptedVaultEnvelope = {
      ...(await encryptVaultData(mergedPlain, accountPassword)),
      keySource: "account",
    };
    const r3Res = await postVault(
      makeRequest(
        "/api/vault",
        "POST",
        { envelope: mergedEnv, baseRevision: latestFromServer.revision },
        tokenA
      )
    );
    assert.equal(r3Res.status, 200);

    // Verify final state read back on Device B has EVERYTHING from both devices!
    const finalRead = (await (
      await getVault(makeRequest("/api/vault", "GET", undefined, tokenB))
    ).json()) as { envelope: EncryptedVaultEnvelope; revision: string };
    const finalPlain = await decryptVaultEnvelope(finalRead.envelope, accountPassword);

    assert.equal(finalPlain.hosts.length, 3, "all 3 hosts preserved");
    assert.equal(
      finalPlain.hosts.find((h) => h.id === "host-db")?.password,
      "rotated-db-password-v2",
      "Device B's rotated password preserved"
    );
    assert.ok(
      finalPlain.hosts.some((h) => h.id === "host-staging"),
      "Device B's newly added staging host preserved"
    );
    assert.deepEqual(
      finalPlain.workspace?.openTabs.map((t) => t.id),
      ["tab-prod-ssh", "tab-db-ssh", "tab-staging-ssh"],
      "open tabs from both devices preserved"
    );
    assert.equal(
      finalPlain.workspace?.resumableRuns.length,
      2,
      "running commands from both devices preserved"
    );
  } finally {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log("CROSS-DEVICE PERSISTENT WORKSPACE & MERGE TESTS PASSED");
}

void run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
