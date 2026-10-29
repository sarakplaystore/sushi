import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Server as SshServer, utils as sshUtils } from "ssh2";
import { WebSocket } from "ws";
import {
  sftpChmodItem,
  sftpDeleteItem,
  sftpListDirectory,
  sftpMakeDir,
  sftpReadBuffer,
  sftpRenameItem,
  sftpWriteBuffer,
  testSshConnection,
} from "../src/lib/server/ssh-client";
import { probeRdpServer } from "../src/lib/server/rdp-probe";
import {
  encodeGuacForBrowser,
  encodeGuacForDaemon,
  parseGuacBrowserMessage,
  parseGuacDaemonStream,
} from "../src/lib/server/guacd-bridge";
import { createGatewayWebSockets } from "../src/lib/server/ws-gateway";
import {
  bootstrapAdminAccount,
  createChallengeToken,
  createSessionToken,
  getEffectiveAuthConfig,
  issueSignedPasskeyCertificate,
  verifyChallengeToken,
  verifyIncomingAuth,
  verifySignedPasskeyCertificates,
} from "../src/lib/server/auth";
import {
  generateEd25519KeyPair,
  verifyPrivateKeyAgainstWhitelist,
} from "../src/lib/server/ssh-key-utils";
import {
  exportToTermixFile,
  importFromTermixContent,
} from "../src/lib/client/termix-porter";
import {
  importTermixSqliteDatabase,
  looksLikeTermixDatabaseFile,
  parseTermixEnvSecrets,
} from "../src/lib/client/termix-sqlite";
import { resolveProfileWithKeychain } from "../src/lib/client/crypto-vault";
import {
  buildTermixFixture,
  termixEncryptDatabaseTwoFile,
} from "./fixtures/termix-sqlite-fixture";

const OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
};

const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
};

interface MemNode {
  type: "file" | "dir";
  mode: number;
  content: Buffer;
  mtime: number;
}

async function runTests() {
  console.log("==> [1/8] Starting ephemeral SSH2 + SFTP test server...");
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  // Generate client keypair to test SSH Private Key auth too
  const clientKeys = sshUtils.generateKeyPairSync("ed25519");

  const memFs = new Map<string, MemNode>();
  const nowSec = Math.floor(Date.now() / 1000);
  memFs.set("/", { type: "dir", mode: 0o040755, content: Buffer.alloc(0), mtime: nowSec });
  memFs.set("/hello.txt", {
    type: "file",
    mode: 0o100644,
    content: Buffer.from("Hello from Sushi SFTP!\n", "utf8"),
    mtime: nowSec,
  });

  const sshServer = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "tester" && ctx.password === "sushipass") {
        ctx.accept();
      } else if (ctx.method === "publickey" && ctx.username === "tester") {
        ctx.accept();
      } else {
        ctx.reject(["password", "publickey"]);
      }
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => {
          acceptPty?.();
        });
        session.on("window-change", () => {
          // handle window resize cleanly
        });
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          if (info.command.includes("HOST=")) {
            stream.write("HOST=sushi-test-box\nKERNEL=Linux 6.8\nOS=Ubuntu Test\nUPTIME=up 5 days\n");
          } else {
            stream.write(`EXEC_OK:${info.command}\n`);
          }
          stream.exit(0);
          stream.end();
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("Welcome to Sushi PTY!\r\n$ ");
          stream.on("data", (data: Buffer) => {
            const txt = data.toString("utf8");
            if (txt.includes("whoami")) {
              stream.write("tester\r\n$ ");
            } else if (txt.includes("exit")) {
              stream.exit(0);
              stream.end();
            }
          });
        });
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { kind: "dir" | "file"; path: string; emitted?: boolean; pos: number }>();
          let nextHandle = 1;

          const makeAttrs = (node: MemNode) => ({
            mode: node.mode,
            uid: 1000,
            gid: 1000,
            size: node.content.length,
            atime: node.mtime,
            mtime: node.mtime,
          });

          sftp.on("REALPATH", (reqId, reqPath) => {
            const norm = reqPath === "." || !reqPath ? "/" : reqPath;
            sftp.name(reqId, [{ filename: norm, longname: norm, attrs: {} as never }]);
          });

          sftp.on("STAT", (reqId, reqPath) => {
            const node = memFs.get(reqPath);
            if (!node) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(reqId, makeAttrs(node));
          });

          sftp.on("LSTAT", (reqId, reqPath) => {
            const node = memFs.get(reqPath);
            if (!node) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(reqId, makeAttrs(node));
          });

          sftp.on("OPENDIR", (reqId, reqPath) => {
            const node = memFs.get(reqPath);
            if (!node || node.type !== "dir") return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            const h = nextHandle++;
            handles.set(h, { kind: "dir", path: reqPath, emitted: false, pos: 0 });
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(h, 0);
            sftp.handle(reqId, buf);
          });

          sftp.on("READDIR", (reqId, handleBuf) => {
            const h = handleBuf.readUInt32BE(0);
            const state = handles.get(h);
            if (!state || state.emitted) return sftp.status(reqId, STATUS_CODE.EOF);
            state.emitted = true;
            const prefix = state.path === "/" ? "/" : `${state.path}/`;
            const items = [];
            for (const [k, v] of memFs.entries()) {
              if (k === state.path || !k.startsWith(prefix)) continue;
              const rest = k.slice(prefix.length);
              if (!rest || rest.includes("/")) continue;
              items.push({
                filename: rest,
                longname: rest,
                attrs: makeAttrs(v),
              });
            }
            sftp.name(reqId, items);
          });

          sftp.on("OPEN", (reqId, filename, flags) => {
            let node = memFs.get(filename);
            if ((flags & OPEN_MODE.CREAT) && !node) {
              node = { type: "file", mode: 0o100644, content: Buffer.alloc(0), mtime: nowSec };
              memFs.set(filename, node);
            }
            if (!node) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            if (flags & OPEN_MODE.TRUNC) {
              node.content = Buffer.alloc(0);
            }
            const h = nextHandle++;
            handles.set(h, { kind: "file", path: filename, pos: 0 });
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(h, 0);
            sftp.handle(reqId, buf);
          });

          sftp.on("READ", (reqId, handleBuf, offset, length) => {
            const h = handleBuf.readUInt32BE(0);
            const state = handles.get(h);
            const node = state ? memFs.get(state.path) : undefined;
            if (!node) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            if (offset >= node.content.length) return sftp.status(reqId, STATUS_CODE.EOF);
            sftp.data(reqId, node.content.subarray(offset, offset + length));
          });

          sftp.on("WRITE", (reqId, handleBuf, offset, data) => {
            const h = handleBuf.readUInt32BE(0);
            const state = handles.get(h);
            const node = state ? memFs.get(state.path) : undefined;
            if (!node) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            const end = offset + data.length;
            if (end > node.content.length) {
              const grown = Buffer.alloc(end);
              node.content.copy(grown, 0);
              node.content = grown;
            }
            data.copy(node.content, offset);
            sftp.status(reqId, STATUS_CODE.OK);
          });

          sftp.on("CLOSE", (reqId, handleBuf) => {
            handles.delete(handleBuf.readUInt32BE(0));
            sftp.status(reqId, STATUS_CODE.OK);
          });

          sftp.on("MKDIR", (reqId, dirPath) => {
            memFs.set(dirPath, { type: "dir", mode: 0o040755, content: Buffer.alloc(0), mtime: nowSec });
            sftp.status(reqId, STATUS_CODE.OK);
          });

          sftp.on("RENAME", (reqId, oldP, newP) => {
            const node = memFs.get(oldP);
            if (!node) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            memFs.delete(oldP);
            memFs.set(newP, node);
            sftp.status(reqId, STATUS_CODE.OK);
          });

          sftp.on("SETSTAT", (reqId, targetP, attrs) => {
            const node = memFs.get(targetP);
            if (!node) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
            if (typeof attrs.mode === "number") {
              const typeBits = node.mode & 0o170000;
              node.mode = typeBits | (attrs.mode & 0o7777);
            }
            sftp.status(reqId, STATUS_CODE.OK);
          });

          sftp.on("REMOVE", (reqId, targetP) => {
            memFs.delete(targetP);
            sftp.status(reqId, STATUS_CODE.OK);
          });

          sftp.on("RMDIR", (reqId, targetP) => {
            memFs.delete(targetP);
            sftp.status(reqId, STATUS_CODE.OK);
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => sshServer.listen(0, "127.0.0.1", () => resolve()));
  const sshPort = (sshServer.address() as net.AddressInfo).port;

  console.log("==> [2/8] Testing SSH password + Ed25519 private key authentication & SFTP operations...");
  const passTest = await testSshConnection({
    host: "127.0.0.1",
    port: sshPort,
    username: "tester",
    authMethod: "password",
    password: "sushipass",
  });
  assert.equal(passTest.ok, true);
  assert.ok(passTest.fingerprint?.startsWith("SHA256:"));
  assert.equal(passTest.systemInfo?.hostname, "sushi-test-box");

  const keyTest = await testSshConnection({
    host: "127.0.0.1",
    port: sshPort,
    username: "tester",
    authMethod: "privateKey",
    privateKey: clientKeys.private,
  });
  assert.equal(keyTest.ok, true);

  const creds = {
    host: "127.0.0.1",
    port: sshPort,
    username: "tester",
    password: "sushipass",
  };

  const list1 = await sftpListDirectory(creds, "/");
  assert.equal(list1.cwd, "/");
  assert.equal(list1.entries.length, 1);
  assert.equal(list1.entries[0].name, "hello.txt");

  await sftpMakeDir(creds, "/configs");
  await sftpWriteBuffer(creds, "/configs/app.env", Buffer.from("PORT=8080\n"));
  const readBack = await sftpReadBuffer(creds, "/configs/app.env");
  assert.equal(readBack.buffer.toString("utf8"), "PORT=8080\n");

  await sftpChmodItem(creds, "/configs/app.env", "0600");
  await sftpRenameItem(creds, "/configs/app.env", "/configs/prod.env");
  const listConfigs = await sftpListDirectory(creds, "/configs");
  assert.equal(listConfigs.entries[0].name, "prod.env");
  assert.equal(listConfigs.entries[0].octal, "0600");

  await sftpDeleteItem(creds, "/configs");
  const listAfterDel = await sftpListDirectory(creds, "/");
  assert.equal(listAfterDel.entries.some((e) => e.name === "configs"), false);

  console.log("==> [3/8] Testing MS-RDPBCGR X.224 RDP Server Probe...");
  const rdpMock = net.createServer((sock) => {
    sock.once("data", (data) => {
      // Verify TPKT v3 & X.224 CR (0xE0)
      assert.equal(data[0], 0x03);
      assert.equal(data[5], 0xe0);
      // Reply with X.224 Connection Confirm (0xD0) + RDP_NEG_RSP (Standard RDP = 0x00)
      const resp = Buffer.alloc(19);
      resp[0] = 0x03;
      resp[1] = 0x00;
      resp.writeUInt16BE(19, 2);
      resp[4] = 14;
      resp[5] = 0xd0;
      resp[11] = 0x02; // TYPE_RDP_NEG_RSP
      resp.writeUInt16LE(8, 13);
      resp.writeUInt32LE(0x00000000, 15);
      sock.write(resp);
    });
  });
  await new Promise<void>((resolve) => rdpMock.listen(0, "127.0.0.1", () => resolve()));
  const rdpPort = (rdpMock.address() as net.AddressInfo).port;

  const rdpRes = await probeRdpServer("127.0.0.1", rdpPort, 4000);
  assert.equal(rdpRes.ok, true);
  assert.equal(rdpRes.reachable, true);
  assert.ok(rdpRes.supportedProtocols.includes("Standard RDP"));

  console.log("==> [4/8] Testing Username/Password + Passkey Certificate & Session Protection...");
  process.env.SUSHI_AUTH_USERNAME = "sushiadmin";
  process.env.SUSHI_AUTH_PASSWORD = "correct-horse-battery";
  process.env.SUSHI_AUTH_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const authCfg = await getEffectiveAuthConfig();
  assert.equal(authCfg.initialized, true);
  assert.equal(await authCfg.verifyPassword("correct-horse-battery"), true);
  assert.equal(await authCfg.verifyPassword("wrong-password"), false);

  // Verify unauthenticated request is rejected
  const unauthCheck = await verifyIncomingAuth(new Headers());
  assert.equal(unauthCheck.ok, false);

  // Issue valid session token and verify access
  const validSessionToken = createSessionToken(authCfg.username, authCfg.authSecret);
  const authedHeaders = new Headers({ "x-sushi-session": validSessionToken });
  const authedCheck = await verifyIncomingAuth(authedHeaders);
  assert.equal(authedCheck.ok, true);
  assert.equal(authedCheck.username, "sushiadmin");

  // Verify WebAuthn challenge signing & stateless Passkey HMAC certificate
  const chTok = createChallengeToken(
    {
      challenge: "test-webauthn-challenge-xyz",
      rpID: "localhost",
      origin: "http://localhost:3000",
      purpose: "login",
    },
    authCfg.authSecret
  );
  const verifiedCh = verifyChallengeToken(chTok, "login", authCfg.authSecret);
  assert.equal(verifiedCh?.challenge, "test-webauthn-challenge-xyz");
  assert.equal(verifyChallengeToken(chTok, "register", authCfg.authSecret), null);

  const signedCert = issueSignedPasskeyCertificate(
    {
      id: "cred-id-123",
      publicKey: "cHVibGljLWtleS1ieXRlcw",
      counter: 1,
      label: "Test YubiKey",
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: Date.now(),
    },
    authCfg.username,
    authCfg.authSecret
  );
  const tamperedCert = signedCert.slice(0, -4) + "AAAA";
  const verifiedCerts = verifySignedPasskeyCertificates(
    [signedCert, tamperedCert],
    authCfg.username,
    authCfg.authSecret
  );
  assert.equal(verifiedCerts.length, 1);
  assert.equal(verifiedCerts[0].id, "cred-id-123");

  // Verify Interactive Stateless Vercel Setup (VERCEL="1" without SUSHI_AUTH_USERNAME)
  delete process.env.SUSHI_AUTH_USERNAME;
  delete process.env.SUSHI_AUTH_PASSWORD;
  process.env.VERCEL = "1";
  const uninitVercelCfg = await getEffectiveAuthConfig(new Headers());
  assert.equal(uninitVercelCfg.initialized, false);
  assert.equal(uninitVercelCfg.canBootstrapInteractive, true);

  const loginKp = generateEd25519KeyPair("vercel-admin@sushi");
  const rogueKp = generateEd25519KeyPair("rogue@attacker");
  const bootstrappedVercel = await bootstrapAdminAccount(
    "verceladmin",
    "vercel-pass-123",
    [loginKp.record]
  );
  assert.equal(bootstrappedVercel.persistedOnDisk, false);
  assert.ok(bootstrappedVercel.adminProfileCert);

  const vercelHeaders = new Headers({
    "x-sushi-admin-cert": bootstrappedVercel.adminProfileCert,
  });
  const initVercelCfg = await getEffectiveAuthConfig(vercelHeaders);
  assert.equal(initVercelCfg.initialized, true);
  assert.equal(initVercelCfg.username, "verceladmin");
  assert.equal(await initVercelCfg.verifyPassword("vercel-pass-123"), true);
  assert.equal(await initVercelCfg.verifyPassword("wrong"), false);

  // Verify Whitelisted Private Key Cryptographic Login
  const okKeyAuth = verifyPrivateKeyAgainstWhitelist(
    loginKp.privateKey,
    undefined,
    initVercelCfg.authorizedKeys
  );
  assert.equal(okKeyAuth.ok, true);
  if (okKeyAuth.ok) {
    assert.equal(okKeyAuth.matchedKey.fingerprint, loginKp.record.fingerprint);
  }
  // Rogue private key must be rejected
  const rogueKeyAuth = verifyPrivateKeyAgainstWhitelist(
    rogueKp.privateKey,
    undefined,
    initVercelCfg.authorizedKeys
  );
  assert.equal(rogueKeyAuth.ok, false);
  // Submitting only the public key must be rejected!
  const pubOnlyAttempt = verifyPrivateKeyAgainstWhitelist(
    loginKp.publicKey,
    undefined,
    initVercelCfg.authorizedKeys
  );
  assert.equal(pubOnlyAttempt.ok, false);

  // Restore env for WS tests below
  delete process.env.VERCEL;
  process.env.SUSHI_AUTH_USERNAME = "sushiadmin";
  process.env.SUSHI_AUTH_PASSWORD = "correct-horse-battery";

  // Verify Vault SSH Key Whitelist Enforcement & Termix Export/Import Round-Trip
  console.log("==> [5/8] Testing Vault Key Whitelist Enforcement & Termix File Export/Import...");
  const whitelistedVaultKey = {
    id: "vault-key-1",
    name: "Prod Ed25519",
    privateKey: loginKp.privateKey,
    publicKey: loginKp.publicKey,
    fingerprint: loginKp.record.fingerprint,
    keyType: "ssh-ed25519",
    createdAt: Date.now(),
  };

  // Unwhitelisted inline key blocked when enforceKeyWhitelist = true
  const blockedInline = resolveProfileWithKeychain(
    {
      id: "h1",
      name: "rogue-host",
      protocol: "ssh",
      host: "10.0.0.5",
      port: 22,
      username: "ubuntu",
      authMethod: "privateKey",
      privateKey: rogueKp.privateKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    [whitelistedVaultKey],
    true
  );
  assert.equal(blockedInline.ok, false);

  // Linked whitelisted key succeeds when enforceKeyWhitelist = true
  const allowedLinked = resolveProfileWithKeychain(
    {
      id: "h2",
      name: "prod-ssh",
      protocol: "ssh",
      host: "10.0.0.10",
      port: 2222,
      username: "deploy",
      authMethod: "privateKey",
      sshKeyId: "vault-key-1",
      group: "Production",
      tags: ["web", "tokyo"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    [whitelistedVaultKey],
    true
  );
  assert.equal(allowedLinked.ok, true);
  if (allowedLinked.ok) {
    assert.equal(allowedLinked.profile.privateKey, loginKp.privateKey);
  }

  // Termix Export -> Import round-trip (SSH Key + RDP protocolAuth)
  const sampleRdpHost = {
    id: "h3",
    name: "win-bastion",
    protocol: "rdp" as const,
    host: "10.0.0.50",
    port: 3389,
    username: "Administrator",
    authMethod: "password" as const,
    password: "WinPass!99",
    domain: "CORP",
    rdpSecurity: "nla" as const,
    ignoreCert: true,
    group: "Windows",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const exportedTermix = exportToTermixFile(
    [allowedLinked.ok ? allowedLinked.profile : sampleRdpHost, sampleRdpHost],
    [whitelistedVaultKey],
    { shareMode: false }
  );
  assert.equal(exportedTermix.hosts.length, 2);
  assert.equal(exportedTermix.credentials?.length, 1);

  const reimported = importFromTermixContent(
    JSON.stringify(exportedTermix),
    []
  );
  assert.equal(reimported.detectedFormat, "termix-host-export");
  assert.equal(reimported.hosts.length, 2);
  assert.equal(reimported.sshKeys.length, 1);
  assert.equal(reimported.hosts[0].host, "10.0.0.10");
  assert.equal(reimported.hosts[0].port, 2222);
  assert.equal(reimported.hosts[0].authMethod, "privateKey");
  assert.equal(reimported.hosts[1].protocol, "rdp");
  assert.equal(reimported.hosts[1].domain, "CORP");
  assert.equal(reimported.hosts[1].password, "WinPass!99");

  // Also test Termix v2.0 User Data Export format
  const termixV2 = JSON.stringify({
    version: "v2.0",
    exportedAt: new Date().toISOString(),
    userData: {
      sshCredentials: [
        {
          id: 77,
          name: "Cluster Key",
          authType: "key",
          username: "ec2-user",
          key: loginKp.privateKey,
        },
      ],
      sshHosts: [
        {
          id: 1,
          name: "aws-node-01",
          ip: "198.51.100.88",
          port: 22,
          authType: "credential",
          credentialId: 77,
          folder: "AWS",
          tags: "prod,k8s",
        },
      ],
    },
    metadata: { encrypted: false },
  });
  const importedV2 = importFromTermixContent(termixV2, []);
  assert.equal(importedV2.detectedFormat, "termix-user-data-v2");
  assert.equal(importedV2.hosts.length, 1);
  assert.equal(importedV2.hosts[0].username, "ec2-user");
  assert.equal(importedV2.hosts[0].authMethod, "privateKey");
  assert.deepEqual(importedV2.hosts[0].tags, ["prod", "k8s"]);

  console.log("==> [6/8] Testing Termix SQLite database import (db.sqlite & db.sqlite.encrypted)...");
  const termixFx = await buildTermixFixture({ sshTestPort: sshPort });
  assert.equal(looksLikeTermixDatabaseFile(termixFx.encryptedFile, "db.sqlite.encrypted"), true);
  assert.equal(looksLikeTermixDatabaseFile(termixFx.sqlite, "backup.bin"), true);
  assert.equal(looksLikeTermixDatabaseFile(new TextEncoder().encode(termixV2), "export.json"), false);

  // .env parsing: Termix .env file, docker-compose style, and a bare hex key
  const parsedEnv = parseTermixEnvSecrets(termixFx.envFile);
  assert.equal(Buffer.from(parsedEnv.databaseKey!).toString("hex"), termixFx.databaseKeyHex);
  assert.equal(Buffer.from(parsedEnv.encryptionKey!).toString("hex"), termixFx.encryptionKeyHex);
  const composeEnv = parseTermixEnvSecrets(`  - DATABASE_KEY: "${termixFx.databaseKeyHex}"`);
  assert.equal(Buffer.from(composeEnv.databaseKey!).toString("hex"), termixFx.databaseKeyHex);
  assert.equal(parseTermixEnvSecrets(termixFx.databaseKeyHex).bareKey, true);

  // Encrypted at rest: needs DATABASE_KEY and rejects a wrong one
  const lockedDb = await importTermixSqliteDatabase(termixFx.encryptedFile);
  assert.equal(lockedDb.status, "needs_database_key");
  assert.equal(lockedDb.fileKind, "termix-encrypted-v2");
  const wrongKeyDb = await importTermixSqliteDatabase(termixFx.encryptedFile, {
    termixEnv: `DATABASE_KEY=${"ab".repeat(32)}`,
  });
  assert.equal(wrongKeyDb.status, "needs_database_key");
  assert.match(wrongKeyDb.message ?? "", /could not decrypt/);

  // DATABASE_KEY alone opens the file, but per-user secrets stay sealed
  const dbKeyOnly = await importTermixSqliteDatabase(termixFx.encryptedFile, {
    termixEnv: termixFx.databaseKeyHex,
  });
  assert.equal(dbKeyOnly.status, "ok");
  assert.equal(dbKeyOnly.secrets.decrypted, 0);
  assert.ok(dbKeyOnly.secrets.locked > 0);
  assert.ok(dbKeyOnly.warnings.some((w) => w.includes("ENCRYPTION_KEY")));
  assert.ok(dbKeyOnly.warnings.some((w) => w.includes("bob") && w.includes("password")));

  // Full Termix .env (v3 ENCRYPTION_KEY data keys) + Termix 2.x account password
  const termixDb = await importTermixSqliteDatabase(termixFx.encryptedFile, {
    termixEnv: termixFx.envFile,
    termixPassword: termixFx.bobPassword,
  });
  assert.equal(termixDb.status, "ok");
  assert.equal(termixDb.fileKind, "termix-encrypted-v2");
  assert.equal(termixDb.secrets.locked, 0);
  assert.equal(termixDb.skippedHosts, 1); // VNC-only host
  assert.equal(termixDb.hosts.length, 8);
  const tHost = (name: string) => termixDb.hosts.find((h) => h.name === name);
  assert.equal(tHost("web-01")?.password, "Sup3rSecret!");
  assert.equal(tHost("web-01")?.group, "Production/Web");
  assert.deepEqual(tHost("web-01")?.tags, ["web", "prod", "pinned"]);
  assert.equal(tHost("web-01")?.notes, "Primary nginx node");
  assert.equal(tHost("db-01")?.username, "deploy");
  assert.equal(tHost("db-01")?.authMethod, "privateKey");
  assert.match(tHost("db-01")?.notes ?? "", /jump hosts: web-01/);
  assert.equal(tHost("build-box")?.port, 2222);
  assert.equal(tHost("build-box")?.passphrase, "kp-123");
  assert.equal(tHost("win-bastion")?.protocol, "rdp");
  assert.equal(tHost("win-bastion")?.username, "Administrator");
  assert.equal(tHost("win-bastion")?.password, "WinCred!42");
  assert.equal(tHost("win-bastion")?.domain, "CORP");
  assert.equal(tHost("win-bastion")?.rdpSecurity, "nla");
  assert.equal(tHost("win-bastion")?.ignoreCert, true);
  assert.equal(tHost("dual-stack")?.protocol, "ssh");
  assert.equal(tHost("dual-stack")?.password, "ssh-dual-pass");
  assert.equal(tHost("dual-stack (RDP)")?.port, 3390);
  assert.equal(tHost("dual-stack (RDP)")?.username, "rdpuser");
  assert.equal(tHost("dual-stack (RDP)")?.password, "rdp-dual-pass");
  assert.equal(tHost("dual-stack (RDP)")?.domain, "LAB");
  assert.equal(tHost("dual-stack (RDP)")?.rdpSecurity, "tls");
  assert.match(tHost("dual-stack")?.notes ?? "", /SOCKS5 proxy: proxy\.lan:1080/);
  assert.equal(tHost("bob-pi")?.password, "raspberry");
  assert.equal(termixDb.sshKeys.length, 2);
  const importedClusterKey = termixDb.sshKeys.find((k) => k.name === "Prod Cluster Key");
  assert.equal(importedClusterKey?.fingerprint, termixFx.clusterKey.fingerprint);
  assert.equal(importedClusterKey?.keyType, "ssh-ed25519");
  assert.equal(
    importedClusterKey?.publicKey?.split(" ").slice(0, 2).join(" "),
    termixFx.clusterKey.publicKey.split(" ").slice(0, 2).join(" ")
  );
  assert.equal(tHost("db-01")?.sshKeyId, importedClusterKey?.id);
  assert.equal(
    termixDb.sshKeys.find((k) => k.id === tHost("build-box")?.sshKeyId)?.fingerprint,
    termixFx.buildKey.fingerprint
  );
  assert.deepEqual(termixDb.snippets.map((s) => s.command).sort(), ["df -h", "vcgencmd measure_temp"]);
  const termixAdmin = termixDb.users.find((u) => u.username === "admin");
  const termixBob = termixDb.users.find((u) => u.username === "bob");
  assert.equal(termixAdmin?.unlockMethod, "encryption_key");
  assert.equal(termixBob?.unlockMethod, "password");

  // An imported Termix host connects through the enforced Vault key whitelist
  const termixE2eHost = tHost("sushi-e2e");
  assert.ok(termixE2eHost);
  assert.equal(termixE2eHost.username, "tester"); // override_credential_username
  const resolvedTermixHost = resolveProfileWithKeychain(termixE2eHost, termixDb.sshKeys, true);
  assert.equal(resolvedTermixHost.ok, true);
  if (resolvedTermixHost.ok) {
    const termixSshTest = await testSshConnection({
      host: resolvedTermixHost.profile.host,
      port: resolvedTermixHost.profile.port,
      username: resolvedTermixHost.profile.username,
      authMethod: "privateKey",
      privateKey: resolvedTermixHost.profile.privateKey,
    });
    assert.equal(termixSshTest.ok, true);
  }

  // Per-user scope on a plain db.sqlite, keychain de-duplication & legacy two-file layout
  const bobOnly = await importTermixSqliteDatabase(termixFx.sqlite, {
    termixEnv: termixFx.envFile,
    termixPassword: termixFx.bobPassword,
    onlyUserId: termixBob!.id,
  });
  assert.equal(bobOnly.fileKind, "sqlite");
  assert.deepEqual(bobOnly.hosts.map((h) => h.name), ["bob-pi"]);
  assert.deepEqual(bobOnly.snippets.map((s) => s.title), ["Pi temp"]);
  assert.equal(bobOnly.sshKeys.length, 0);

  const existingClusterKey = {
    id: "existing-cluster",
    name: "Cluster (already whitelisted)",
    privateKey: termixFx.clusterKey.privateKey,
    fingerprint: termixFx.clusterKey.fingerprint,
    createdAt: Date.now(),
  };
  const dedupedDb = await importTermixSqliteDatabase(termixFx.sqlite, {
    termixEnv: termixFx.envFile,
    existingSshKeys: [existingClusterKey],
  });
  assert.equal(dedupedDb.sshKeys.length, 1);
  assert.equal(dedupedDb.hosts.find((h) => h.name === "db-01")?.sshKeyId, "existing-cluster");

  const twoFileDb = termixEncryptDatabaseTwoFile(
    termixFx.sqlite,
    Buffer.from(termixFx.databaseKeyHex, "hex")
  );
  const twoFileImport = await importTermixSqliteDatabase(twoFileDb.encrypted, {
    termixEnv: termixFx.envFile,
    metaJson: twoFileDb.metaJson,
  });
  assert.equal(twoFileImport.status, "ok");
  assert.equal(twoFileImport.hosts.length, termixDb.hosts.length);

  console.log("==> [7/8] Testing Protected WebSocket SSH PTY & Guacamole RDP Bridge (/ws/ssh & /ws/rdp)...");
  // Start mock guacd daemon
  const guacdMock = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    let step = 0;
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const parsed = parseGuacDaemonStream(buf);
      buf = parsed.remainder;
      for (const instr of parsed.instructions) {
        if (step === 0 && instr[0] === "select" && instr[1] === "rdp") {
          step = 1;
          sock.write(
            encodeGuacForDaemon([
              "args",
              "VERSION_1_5_0",
              "hostname",
              "port",
              "username",
              "password",
            ])
          );
        } else if (step === 1 && instr[0] === "connect") {
          assert.equal(instr[1], "VERSION_1_5_0");
          assert.equal(instr[2], "127.0.0.1");
          step = 2;
          sock.write(
            encodeGuacForDaemon(["ready", "$mock-rdp-session"]) +
              encodeGuacForDaemon(["size", "0", "1280", "720"])
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => guacdMock.listen(0, "127.0.0.1", () => resolve()));
  const guacdPort = (guacdMock.address() as net.AddressInfo).port;
  process.env.GUACD_HOST = "127.0.0.1";
  process.env.GUACD_PORT = String(guacdPort);

  const gw = createGatewayWebSockets();
  const httpServer = http.createServer((_req, res) => res.end("ok"));
  httpServer.on("upgrade", (req, socket, head) => {
    gw.handleUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const gwPort = (httpServer.address() as net.AddressInfo).port;

  // Verify unauthenticated /ws/ssh is rejected!
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/ws/ssh`);
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", cols: 80, rows: 24, credentials: creds }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (msg.type === "error" && /Authentication required|Unauthorized/i.test(msg.message)) {
        resolve();
      }
    });
  });

  // Test authenticated /ws/ssh interactive shell
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/ws/ssh`);
    let outputAcc = "";
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "auth",
          sessionToken: validSessionToken,
          cols: 100,
          rows: 30,
          credentials: creds,
        })
      );
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (msg.type === "ready") {
        ws.send(JSON.stringify({ type: "input", data: "whoami\r" }));
      } else if (msg.type === "data") {
        outputAcc += Buffer.from(msg.data, "base64").toString("utf8");
        if (outputAcc.includes("tester")) {
          ws.close();
          resolve();
        }
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
      }
    });
  });

  // Test /ws/rdp Guacamole subprotocol handshake + ping echo + size frame
  await new Promise<void>((resolve, reject) => {
    const payload = Buffer.from(
      JSON.stringify({
        host: "127.0.0.1",
        port: rdpPort,
        username: "Administrator",
        password: "secret",
      }),
      "utf8"
    ).toString("base64url");

    const ws = new WebSocket(
      `ws://127.0.0.1:${gwPort}/ws/rdp?payload=${encodeURIComponent(payload)}&session=${encodeURIComponent(validSessionToken)}`,
      "guacamole"
    );

    let gotUuid = false;
    let gotSize = false;
    let gotPingEcho = false;

    ws.on("error", reject);
    ws.on("message", (raw) => {
      const instrs = parseGuacBrowserMessage(raw.toString("utf8"));
      for (const i of instrs) {
        if (i[0] === "" && i.length === 2 && i[1].length === 36) {
          gotUuid = true;
          // Send internal tunnel ping just like Guacamole.WebSocketTunnel
          ws.send(encodeGuacForBrowser(["", "ping", "123456"]));
        } else if (i[0] === "size" && i[2] === "1280" && i[3] === "720") {
          gotSize = true;
        } else if (i[0] === "" && i[1] === "ping" && i[2] === "123456") {
          gotPingEcho = true;
        }
      }
      if (gotUuid && gotSize && gotPingEcho) {
        ws.close();
        resolve();
      }
    });
  });

  console.log("==> [8/8] Cleaning up test servers...");
  httpServer.close();
  guacdMock.close();
  rdpMock.close();
  sshServer.close();
  console.log("ALL AUTH, PASSKEY, KEY WHITELIST, TERMIX, SSH, SFTP, AND RDP E2E TESTS PASSED!");
}

runTests().catch((err) => {
  console.error("E2E test failure:", err);
  process.exit(1);
});
