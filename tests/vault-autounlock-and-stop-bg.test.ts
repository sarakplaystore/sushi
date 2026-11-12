import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { Server as SshServer, utils as sshUtils } from "ssh2";
import { POST as setup } from "../src/app/api/auth/setup/route";
import { PUT as changeAccount } from "../src/app/api/auth/account/route";
import { POST as stopExecPost } from "../src/app/api/ssh/exec/stop/route";
import { GET as getVault, POST as postVault } from "../src/app/api/vault/route";
import {
  decryptVaultEnvelope,
  encryptVaultData,
  type EncryptedVaultEnvelope,
  type VaultPlaintext,
} from "../src/lib/client/crypto-vault";
import { closeSshPool } from "../src/lib/server/ssh-pool";

const envKeys = [
  "DATA_DIR",
  "VERCEL",
  "VERCEL_PROJECT_ID",
  "VERCEL_ENV",
  "SUSHI_AUTH_USERNAME",
  "SUSHI_AUTH_PASSWORD",
  "SUSHI_AUTH_PASSWORD_HASH",
  "SUSHI_AUTH_SECRET",
  "SUSHI_GATEWAY_TOKEN",
  "GATEWAY_ONLY",
  "SUSHI_REDIS_REST_URL",
  "SUSHI_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "SUSHI_TURSO_DATABASE_URL",
  "SUSHI_TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "SUSHI_STORAGE_PREFIX",
  "SUSHI_STORAGE_BACKEND",
  "SUSHI_SERVER_VAULT",
  "SUSHI_ALLOW_STATELESS_SETUP",
  "SUSHI_FIRESTORE_PROJECT_ID",
  "SUSHI_FIRESTORE_DATABASE_ID",
  "SUSHI_FIRESTORE_CREDENTIALS_JSON",
] as const;

for (const key of envKeys) delete process.env[key];

function makeRequest(
  route: string,
  method = "GET",
  body?: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {}
) {
  return new NextRequest(`http://localhost${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-sushi-session": token } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // On Linux, a zombie (Z) still responds to kill(pid, 0); treat zombies as dead.
    const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    if (stat.status === 0) {
      const s = stat.stdout.trim();
      if (!s || s.startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function run() {
  console.log(
    "==> Testing automatic session vault unlock (no Unlock Sushi Vault gate) & Stop Background SSH..."
  );

  // 1. Ensure the "Unlock Sushi Vault" screen & manual lock UI are gone, and Stop BG UI exists.
  const workspaceSrc = await fs.readFile(
    path.join(process.cwd(), "src/components/SushiWorkspace.tsx"),
    "utf8"
  );
  const modalSrc = await fs.readFile(
    path.join(process.cwd(), "src/components/VaultSecurityModal.tsx"),
    "utf8"
  );
  const termSrc = await fs.readFile(
    path.join(process.cwd(), "src/components/SshTerminalSession.tsx"),
    "utf8"
  );

  assert.equal(
    workspaceSrc.includes("Unlock Sushi Vault"),
    false,
    "Unlock Sushi Vault gate should be removed from SushiWorkspace.tsx"
  );
  assert.equal(
    workspaceSrc.includes("Unlock Workspace"),
    false,
    "Unlock Workspace button should be removed from SushiWorkspace.tsx"
  );
  assert.equal(
    modalSrc.includes("Lock Vault Now"),
    false,
    "Lock Vault Now button should be removed from VaultSecurityModal.tsx"
  );
  assert.equal(
    workspaceSrc.includes("Stop Background SSH"),
    true,
    "SushiWorkspace.tsx should expose Stop Background SSH button"
  );
  assert.equal(
    termSrc.includes("handleStopBackgroundProcesses"),
    true,
    "SshTerminalSession.tsx should expose Stop Background button handler"
  );

  // 2. Session-derived vault key auto-unlock & password rotation without re-prompt
  const tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sushi-autounlock-"));
  process.env.DATA_DIR = tmpDataDir;
  process.env.SUSHI_GATEWAY_TOKEN = "gateway-only-secret-token";

  try {
    const setupRes = await setup(
      makeRequest("/api/auth/setup", "POST", {
        username: "admin",
        password: "initial-strong-password-123",
      })
    );
    assert.equal(setupRes.status, 200);
    const setupJson = (await setupRes.json()) as { ok: boolean; sessionToken: string };
    assert.equal(setupJson.ok, true);
    const session1 = setupJson.sessionToken;

    // Unauthenticated & gateway-only token callers must NEVER receive vaultKey
    const unauthVault = await getVault(makeRequest("/api/vault", "GET"));
    assert.equal(unauthVault.status, 401);

    const gwOnlyVault = await getVault(
      makeRequest("/api/vault", "GET", undefined, undefined, {
        authorization: "Bearer gateway-only-secret-token",
      })
    );
    assert.equal(gwOnlyVault.status, 401);

    // Authenticated session receives vaultKey
    const vaultRes1 = await getVault(makeRequest("/api/vault", "GET", undefined, session1));
    assert.equal(vaultRes1.status, 200);
    const vaultJson1 = (await vaultRes1.json()) as {
      ok: boolean;
      enabled: boolean;
      envelope: EncryptedVaultEnvelope | null;
      revision: string | null;
      vaultKey: string;
    };
    assert.equal(vaultJson1.ok, true);
    assert.equal(typeof vaultJson1.vaultKey, "string");
    assert.ok(vaultJson1.vaultKey.length >= 40, "Expected 32-byte base64url vaultKey");

    const plain: VaultPlaintext = {
      version: 1,
      hosts: [
        {
          id: "host-auto-1",
          name: "Auto-Unlocked Production Box",
          protocol: "ssh",
          host: "198.51.100.42",
          port: 22,
          username: "ubuntu",
          authMethod: "password",
          password: "super-secret-ssh-pw",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      snippets: [],
      sshKeys: [],
      enforceKeyWhitelist: false,
    };

    const sessionEnvelope: EncryptedVaultEnvelope = {
      ...(await encryptVaultData(plain, vaultJson1.vaultKey)),
      keySource: "session",
    };

    const saveRes = await postVault(
      makeRequest(
        "/api/vault",
        "POST",
        { envelope: sessionEnvelope, baseRevision: null },
        session1
      )
    );
    assert.equal(saveRes.status, 200);
    const saveJson = (await saveRes.json()) as { ok: boolean; revision: string };
    assert.equal(saveJson.ok, true);

    // Simulate reload / passkey login on another device (no password in memory!)
    const reloadVaultRes = await getVault(
      makeRequest("/api/vault", "GET", undefined, session1)
    );
    const reloadVaultJson = (await reloadVaultRes.json()) as {
      ok: boolean;
      envelope: EncryptedVaultEnvelope;
      revision: string;
      vaultKey: string;
    };
    assert.equal(reloadVaultJson.envelope.keySource, "session");
    const decryptedOnReload = await decryptVaultEnvelope(
      reloadVaultJson.envelope,
      reloadVaultJson.vaultKey
    );
    assert.equal(decryptedOnReload.hosts.length, 1);
    assert.equal(decryptedOnReload.hosts[0].name, "Auto-Unlocked Production Box");
    assert.equal(decryptedOnReload.hosts[0].password, "super-secret-ssh-pw");

    // Changing account password succeeds WITHOUT 409 Conflict and preserves vaultKey!
    const pwChangeRes = await changeAccount(
      makeRequest(
        "/api/auth/account",
        "PUT",
        {
          currentPassword: "initial-strong-password-123",
          newPassword: "rotated-strong-password-456",
        },
        session1
      )
    );
    assert.equal(
      pwChangeRes.status,
      200,
      "Password rotation should not conflict when vault uses keySource='session'"
    );
    const pwChangeJson = (await pwChangeRes.json()) as {
      ok: boolean;
      sessionToken: string;
    };
    const session2 = pwChangeJson.sessionToken;

    const afterRotateRes = await getVault(
      makeRequest("/api/vault", "GET", undefined, session2)
    );
    const afterRotateJson = (await afterRotateRes.json()) as {
      envelope: EncryptedVaultEnvelope;
      vaultKey: string;
    };
    assert.equal(afterRotateJson.vaultKey, vaultJson1.vaultKey);
    const decryptedAfterRotate = await decryptVaultEnvelope(
      afterRotateJson.envelope,
      afterRotateJson.vaultKey
    );
    assert.equal(decryptedAfterRotate.hosts[0].password, "super-secret-ssh-pw");

    // 3. Test POST /api/ssh/exec/stop against a real local ssh2 server & real child processes
    const hostKeyPem = sshUtils.generateKeyPairSync("ed25519").private;

    const sshServer = new SshServer({ hostKeys: [hostKeyPem] }, (client) => {
      client.on("authentication", (ctx) => {
        if (
          ctx.method === "password" &&
          ctx.username === "bgtester" &&
          ctx.password === "bgpass"
        ) {
          ctx.accept();
        } else {
          ctx.reject(["password"]);
        }
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("pty", (acceptPty) => {
            acceptPty?.();
          });
          session.on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            const child = spawn("sh", ["-c", info.command], {
              env: {
                ...process.env,
                SSH_CONNECTION: "127.0.0.1 54321 127.0.0.1 22",
              },
              stdio: ["pipe", "pipe", "pipe"],
            });
            child.stdout.on("data", (d: Buffer) => stream.write(d));
            child.stderr.on("data", (d: Buffer) => stream.stderr.write(d));
            child.on("close", (code) => {
              stream.exit(code ?? 0);
              stream.end();
            });
          });
        });
      });
    });

    await new Promise<void>((resolve) => sshServer.listen(0, "127.0.0.1", () => resolve()));
    const sshPort = (sshServer.address() as AddressInfo).port;

    const testFifoPath = `/tmp/.sushi-keys-autotest-${process.pid}`;
    spawnSync("rm", ["-f", testFifoPath]);
    spawnSync("mkfifo", [testFifoPath]);

    // Spawn (A) a detached SSH background job (SSH_CONNECTION in env, new session -> tpgid = -1)
    const detachedSshJob = spawn("sleep", ["45"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SSH_CONNECTION: "127.0.0.1 59999 127.0.0.1 2222",
      },
    });
    detachedSshJob.unref();

    // Spawn (B) a Sushi background run wrapper (matches SUSHI_META / .sushi-run-)
    const sushiRunWrapper = spawn(
      "sh",
      ["-c", "sleep 45 # SUSHI_META /tmp/.sushi-run-autotest.log"],
      {
        detached: true,
        stdio: "ignore",
      }
    );
    sushiRunWrapper.unref();

    try {
      assert.ok(detachedSshJob.pid && isPidAlive(detachedSshJob.pid));
      assert.ok(sushiRunWrapper.pid && isPidAlive(sushiRunWrapper.pid));

      // Unauthenticated stop call must be rejected with 401
      const unauthStop = await stopExecPost(
        makeRequest("/api/ssh/exec/stop", "POST", {
          credentials: {
            host: "127.0.0.1",
            port: sshPort,
            username: "bgtester",
            authMethod: "password",
            password: "bgpass",
          },
        })
      );
      assert.equal(unauthStop.status, 401);

      // Authenticated stop call kills both background jobs & cleans up FIFO
      const stopRes = await stopExecPost(
        makeRequest(
          "/api/ssh/exec/stop",
          "POST",
          {
            credentials: {
              host: "127.0.0.1",
              port: sshPort,
              username: "bgtester",
              authMethod: "password",
              password: "bgpass",
            },
          },
          session2
        )
      );
      assert.equal(stopRes.status, 200);
      const stopJson = (await stopRes.json()) as {
        ok: boolean;
        stoppedCount: number;
        cleanedChannels: number;
        processes: string[];
      };
      assert.equal(stopJson.ok, true);
      assert.ok(
        stopJson.stoppedCount >= 2,
        `Expected stoppedCount >= 2, got ${stopJson.stoppedCount}`
      );
      assert.ok(
        stopJson.cleanedChannels >= 1,
        `Expected cleanedChannels >= 1, got ${stopJson.cleanedChannels}`
      );

      // Wait briefly for kernel process reap
      await new Promise((r) => setTimeout(r, 250));

      assert.equal(
        isPidAlive(detachedSshJob.pid!),
        false,
        "Detached SSH background job should be stopped"
      );
      assert.equal(
        isPidAlive(sushiRunWrapper.pid!),
        false,
        "Sushi detached run wrapper should be stopped"
      );
      const fifoExists = await fs
        .stat(testFifoPath)
        .then(() => true)
        .catch(() => false);
      assert.equal(fifoExists, false, "Keystroke FIFO should be removed");
    } finally {
      try {
        if (detachedSshJob.pid) process.kill(-detachedSshJob.pid, "SIGKILL");
      } catch {}
      try {
        if (sushiRunWrapper.pid) process.kill(-sushiRunWrapper.pid, "SIGKILL");
      } catch {}
      spawnSync("rm", ["-f", testFifoPath]);
      closeSshPool();
      await new Promise<void>((resolve) => sshServer.close(() => resolve()));
    }
  } finally {
    await fs.rm(tmpDataDir, { recursive: true, force: true });
  }

  console.log("VAULT AUTO-UNLOCK & STOP BACKGROUND SSH TESTS PASSED!");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
