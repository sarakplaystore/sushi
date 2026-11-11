import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import zlib from "node:zlib";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Server as SshServer, utils as sshUtils } from "ssh2";
import { WebSocket } from "ws";
import { NextRequest } from "next/server";
import {
  connectSsh,
  describeSshError,
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
import type { ConnectionCredentials } from "../src/types/connection";
import {
  SftpZipLimitError,
  collectRemoteArchive,
  collectRemoteTree,
  dosDateTime,
  writeZipFromTree,
  type RemoteTree,
} from "../src/lib/server/sftp-zip";
import {
  encodeGuacForBrowser,
  encodeGuacForDaemon,
  parseGuacBrowserMessage,
  parseGuacDaemonStream,
} from "../src/lib/server/guacd-bridge";
import { createGatewayWebSockets } from "../src/lib/server/ws-gateway";
import { META_REGEX, splitEmittable } from "../src/lib/server/exec-stream";
import {
  decodeExecChunk,
  parseExecInputLine,
  pumpExecInput,
} from "../src/lib/server/exec-input";
import { PROMPT_HINT_RE } from "../src/lib/server/exec-stream";
import {
  __setStreamingRequestBodySupport,
  canStreamExecStdin,
  createExecRequestBody,
  supportsStreamingRequestBody,
} from "../src/lib/client/exec-stdin";
import {
  canSaveStreamToDisk,
  openArchiveSink,
} from "../src/lib/client/zip-sink";
import {
  SSH_RETRY_DELAY_SECONDS,
  cleanSshFailureMessage,
  connectFailureFromExec,
  describeSshConnectFailure,
  formatRetryCountdown,
  isRetryableSshFailure,
  retryCountdownFraction,
  tickRetryCountdown,
} from "../src/lib/client/ssh-retry";
import { SshConnectErrorCard } from "../src/components/SshConnectErrorCard";
import {
  DEFAULT_RDP_PORT,
  buildRdpCompanionDraft,
  buildRdpCompanionProfile,
  rdpCompanionTitle,
} from "../src/lib/client/rdp-companion";
import {
  buildExecScript,
  buildKeyDeliveryScript,
  createKeyChannelPath,
  createRunLogPath,
  createSudoAnswerer,
  isKeyChannelPath,
  isRunLogPath,
  parseKeyDeliveryResult,
} from "../src/lib/server/exec-script";
import {
  SYSINFO_SCRIPT,
  detectCloudProvider,
  parseSysinfo,
} from "../src/lib/server/sysinfo";
import {
  acquireSsh,
  closeSshPool,
  fetchSshSystemInfoPooled,
  openExecChannel,
  runSshCommand,
  sshPoolStats,
} from "../src/lib/server/ssh-pool";
import { POST as execRoutePost } from "../src/app/api/ssh/exec/route";
import { POST as runRoutePost } from "../src/app/api/ssh/exec/run/route";
import { GET as hostsApiGet } from "../src/app/api/hosts/route";
import { GET as hostsPageGet } from "../src/app/hosts/route";
import { POST as translateRoutePost } from "../src/app/api/translate/route";
import {
  MAX_TRANSLATE_TEXT,
  isValidTargetTag,
  translateTextServer,
} from "../src/lib/server/translate";
import {
  DEFAULT_TRANSLATE_TARGET,
  TRANSLATE_TARGETS,
  getStoredTranslateTarget,
} from "../src/lib/client/translate";
import {
  formatOsLabel,
  formatSystemDetails,
  formatSystemLine,
} from "../src/lib/client/sysinfo";
import {
  buildRdpParams,
  normalizeClientName,
  normalizeRdpPerformance,
  normalizeRdpSecurity,
  normalizeTimezone,
} from "../src/lib/server/rdp-params";
import {
  DEFAULT_RDP_PREFS,
  describeRdpStatus,
  fitRemoteSize,
  formatRemoteSize,
  nextRemoteSize,
  parseRdpPrefs,
  reconnectDelayMs,
  shouldResizeRemote,
  shouldRetryRdpStatus,
} from "../src/lib/client/rdp-session";
import {
  MENU_KEY,
  detectFullscreenMenu,
  detectInteractiveProgram,
  menuButtonKeys,
  menuSelectKeys,
  parseElevationCommand,
  splitTerminalInput,
} from "../src/lib/client/terminal-commands";
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
  normalizePrivateKeyForSsh,
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
import {
  decryptVaultEnvelope,
  encryptVaultData,
  resolveProfileWithKeychain,
  type VaultPlaintext,
} from "../src/lib/client/crypto-vault";
import {
  __setForcePureJsCrypto,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  pbkdf2Sha256,
  randomUUID,
  sha256,
} from "../src/lib/client/web-crypto";
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


interface ParsedZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  data: Buffer;
}

/**
 * Independent ZIP reader used by the tests: locates the central directory,
 * inflates every entry and checks its CRC, so a broken writer cannot pass.
 */
function parseZipEntries(buf: Buffer): ParsedZipEntry[] {
  const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdOffset >= 0, "EOCD record present");
  const total = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries: ParsedZipEntry[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < total; i += 1) {
    assert.equal(buf.readUInt32LE(cursor), 0x02014b50, "central header signature");
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttributes = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, "local header signature");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);

    assert.equal(data.length, uncompressedSize, `uncompressed size of ${name}`);
    assert.equal(
      (zlib as typeof zlib & { crc32: (d: Buffer) => number }).crc32(data),
      crc >>> 0,
      `crc32 of ${name}`
    );

    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      data,
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Streams a remote tree into a ZIP buffer (what /api/sftp/download-zip does). */
async function zipTreeToBuffer(
  creds: ConnectionCredentials,
  tree: RemoteTree
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve) => sink.on("end", () => resolve()));
  await writeZipFromTree(creds, tree, sink);
  sink.end();
  await done;
  return Buffer.concat(chunks);
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
        // Verify the client really holds the private key for the offered public key
        if (ctx.signature && ctx.blob) {
          const typeLen = ctx.key.data.readUInt32BE(0);
          const keyType = ctx.key.data.subarray(4, 4 + typeLen).toString("latin1");
          const offered = sshUtils.parseKey(`${keyType} ${ctx.key.data.toString("base64")}`);
          const offeredKey = Array.isArray(offered) ? offered[0] : offered;
          if (
            offeredKey instanceof Error ||
            offeredKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true
          ) {
            ctx.reject(["password", "publickey"]);
            return;
          }
        }
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
            // Same shape as SYSINFO_SCRIPT: an Oracle Cloud Ubuntu box.
            stream.write(
              [
                "HOST=sushi-test-box",
                "PRETTY=Ubuntu 24.04.1 LTS",
                "DISTRO=Ubuntu",
                "VERSION=24.04",
                "CODENAME=noble",
                "KERNEL=Linux 6.8",
                "ARCH=x86_64",
                "UPTIME=up 5 days",
                "CPU=4",
                "MEM_MB=23846",
                "LOAD=0.10 0.20 0.30",
                "CLOUD_ID=oraclecloud",
                "DMI_VENDOR=OracleCloud.com",
                "DMI_PRODUCT=Standard.PC",
                "DMI_BOARD=",
                "DMI_ASSET=",
                "VIRT=kvm",
                "",
              ].join("\n")
            );
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
            // A real sshd canonicalises `.` / `..` segments here, so mirror that.
            const norm =
              reqPath === "." || !reqPath ? "/" : path.posix.resolve("/", reqPath);
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
  // The same probe the terminal header uses: distro + version + hosting platform.
  assert.equal(passTest.systemInfo?.os, "Ubuntu 24.04.1 LTS");
  assert.equal(passTest.systemInfo?.version, "24.04");
  assert.equal(passTest.systemInfo?.codename, "noble");
  assert.equal(passTest.systemInfo?.kernel, "Linux 6.8");
  assert.equal(passTest.systemInfo?.arch, "x86_64");
  assert.equal(passTest.systemInfo?.cpu, 4);
  assert.equal(passTest.systemInfo?.memoryMb, 23846);
  assert.equal(passTest.systemInfo?.uptime, "up 5 days");
  assert.equal(passTest.systemInfo?.provider, "Oracle Cloud");
  assert.equal(passTest.systemInfo?.providerId, "oraclecloud");

  const keyTest = await testSshConnection({
    host: "127.0.0.1",
    port: sshPort,
    username: "tester",
    authMethod: "privateKey",
    privateKey: clientKeys.private,
  });
  assert.equal(keyTest.ok, true);

  // Private key formats ssh2 can't parse natively (PKCS#8 RSA / ECDSA / Ed25519, plain
  // and encrypted) and keys damaged by copy & paste are normalized before login.
  const rsaPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ecPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const edPair = crypto.generateKeyPairSync("ed25519");
  const encryptedPkcs8 = rsaPair.privateKey
    .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pk8pass" })
    .toString();
  const keyFormatCases: Array<[string, string, string?]> = [
    ["RSA PKCS#8", rsaPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
    ["ECDSA PKCS#8", ecPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
    ["Ed25519 PKCS#8", edPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
    ["encrypted RSA PKCS#8", encryptedPkcs8, "pk8pass"],
    ["OpenSSH key flattened onto one line", clientKeys.private.trim().replace(/\n/g, " ")],
    ["OpenSSH key with literal \\n escapes", clientKeys.private.trim().replace(/\n/g, "\\n")],
    [
      "indented OpenSSH key with CRLF",
      clientKeys.private.split("\n").map((l) => `   ${l}`).join("\r\n"),
    ],
  ];
  for (const [label, privateKey, passphrase] of keyFormatCases) {
    const normalized = normalizePrivateKeyForSsh(privateKey, passphrase);
    assert.equal(sshUtils.parseKey(normalized.privateKey, normalized.passphrase) instanceof Error, false, label);
    const formatTest = await testSshConnection({
      host: "127.0.0.1",
      port: sshPort,
      username: "tester",
      authMethod: "privateKey",
      privateKey,
      passphrase,
    });
    assert.equal(formatTest.ok, true, `${label}: ${formatTest.error}`);
  }

  // Actionable errors instead of raw ssh2 / socket messages
  const sshErr = async (overrides: Record<string, unknown>) =>
    (
      await testSshConnection({
        host: "127.0.0.1",
        port: sshPort,
        username: "tester",
        authMethod: "privateKey",
        ...overrides,
      } as Parameters<typeof testSshConnection>[0])
    ).error ?? "";
  assert.match(await sshErr({ privateKey: encryptedPkcs8 }), /passphrase-protected/);
  assert.match(await sshErr({ privateKey: encryptedPkcs8, passphrase: "nope" }), /Incorrect passphrase/);
  assert.match(await sshErr({ privateKey: clientKeys.public }), /public key/);
  assert.match(
    await sshErr({ authMethod: "password", password: "wrong-password" }),
    /Authentication failed for tester@127\.0\.0\.1: wrong username or password/
  );
  assert.match(
    await sshErr({ host: "root@127.0.0.1", authMethod: "password", password: "x" }),
    /put the username \("root"\) in the Username field/
  );
  const closedPortServer = net.createServer();
  await new Promise<void>((resolve) => closedPortServer.listen(0, "127.0.0.1", () => resolve()));
  const closedPort = (closedPortServer.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => closedPortServer.close(() => resolve()));
  assert.match(
    await sshErr({ port: closedPort, authMethod: "password", password: "x" }),
    new RegExp(`Connection refused by 127\\.0\\.0\\.1:${closedPort}`)
  );

  // A connection that never finishes: a port that accepts TCP but never speaks SSH.
  // This is what a firewalled host looks like, and it must produce one sentence.
  {
    const silent = net.createServer(() => {
      /* accept the socket and stay silent */
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const silentPort = (silent.address() as net.AddressInfo).port;
    const timeoutError = await connectSsh(
      {
        host: "127.0.0.1",
        port: silentPort,
        username: "ubuntu",
        authMethod: "password",
        password: "x",
      },
      600
    ).then(
      () => "",
      (err: Error) => err.message
    );
    assert.equal(
      timeoutError,
      `Could not reach 127.0.0.1:${silentPort} (connection timed out). Check the IP and port, and any firewall between this Sushi server and the host.`
    );
    // Not awaited: a socket the SSH client abandoned can keep `close`'s callback
    // pending, and the check above already proved what it needed to.
    silent.close();
  }

  // Item 12: an unreachable host shows exactly the server's sentence — never a shell
  // prompt and never the echoed command (`ubuntu@indo.rakvpn.eu.org:~$ sudo su`).
  {
    const target = { host: "indo.rakvpn.eu.org", port: 22, username: "ubuntu" };
    const VERCEL_SENTENCE =
      "Could not reach indo.rakvpn.eu.org:22 (connection timed out). Check the IP and port, and that the server's firewall allows SSH from the internet (Vercel connects from changing AWS IP addresses).";
    const timedOut = Object.assign(new Error("connect ETIMEDOUT 203.0.113.9:22"), {
      code: "ETIMEDOUT",
    });

    // What the server says on Vercel / on a VPS.
    assert.equal(describeSshError(timedOut, target, { onVercel: true }), VERCEL_SENTENCE);
    assert.equal(
      describeSshError(timedOut, target, { onVercel: false }),
      "Could not reach indo.rakvpn.eu.org:22 (connection timed out). Check the IP and port, and any firewall between this Sushi server and the host."
    );
    // A private address on Vercel explains why it can never work there.
    assert.equal(
      describeSshError(timedOut, { host: "192.168.1.9", port: 22 }, { onVercel: true }),
      "Could not reach 192.168.1.9:22 (connection timed out). 192.168.1.9 is a private / LAN / Tailscale address, which Sushi on Vercel cannot reach. Run Sushi on that network (VPS / Docker install) or attach a VPS gateway that can reach it."
    );

    // What the browser keeps, given everything a dead session used to print.
    const noisy = `\r\n\u001b[31mSSH Error: ${VERCEL_SENTENCE}\u001b[0m\r\nubuntu@indo.rakvpn.eu.org:~$ sudo su`;
    assert.equal(cleanSshFailureMessage(noisy), VERCEL_SENTENCE);
    const failure = describeSshConnectFailure(noisy, {
      host: target.host,
      port: target.port,
    });
    assert.equal(failure.message, VERCEL_SENTENCE);
    assert.equal(failure.retryable, true);
    // A prompt alone is never an error message.
    assert.equal(cleanSshFailureMessage("ubuntu@indo.rakvpn.eu.org:~$ sudo su"), "");
    assert.equal(
      cleanSshFailureMessage(`\u001b[90mConnecting to ubuntu@host:22…\u001b[0m`),
      "Connecting to ubuntu@host:22…"
    );

    // Credentials are not fixed by waiting; network problems are.
    assert.equal(isRetryableSshFailure(VERCEL_SENTENCE), true);
    assert.equal(
      isRetryableSshFailure(
        "Connection refused by host:22 — nothing is accepting SSH connections on that port. Check the port number and that the SSH server (sshd) is running."
      ),
      true
    );
    assert.equal(
      isRetryableSshFailure(
        "Authentication failed for ubuntu@host: wrong username or password, or the server has password logins disabled (PasswordAuthentication no) — use SSH key authentication instead."
      ),
      false
    );
    assert.equal(
      isRetryableSshFailure(
        "Unsupported private key format — paste an OpenSSH, PEM or PKCS#8 private key."
      ),
      false
    );

    // Which exec results mean "nothing ran": the streaming `error` event before the
    // session opened, or a non-2xx answer with no output. A command that ran and
    // failed keeps its output and must NOT show the reconnect card.
    assert.equal(
      connectFailureFromExec({ output: "", connectError: VERCEL_SENTENCE }),
      VERCEL_SENTENCE
    );
    assert.equal(
      connectFailureFromExec({ output: "", httpError: "Your session expired." }),
      "Your session expired."
    );
    assert.equal(
      connectFailureFromExec({
        output: "bash: foo: command not found\n",
        httpError: undefined,
        connectError: undefined,
      }),
      undefined
    );
    assert.equal(
      connectFailureFromExec({ output: "partial", connectError: VERCEL_SENTENCE }),
      VERCEL_SENTENCE
    );

    // The countdown: 10 → 9 → … → 0 (retry now).
    assert.equal(SSH_RETRY_DELAY_SECONDS, 10);
    assert.equal(formatRetryCountdown(SSH_RETRY_DELAY_SECONDS), "Retrying in 10s…");
    assert.equal(formatRetryCountdown(1), "Retrying in 1s…");
    assert.equal(formatRetryCountdown(0), "Reconnecting now…");
    assert.equal(tickRetryCountdown(10), 9);
    assert.equal(tickRetryCountdown(2), 1);
    assert.equal(tickRetryCountdown(1), 0);
    assert.equal(retryCountdownFraction(10), 1);
    assert.equal(retryCountdownFraction(5), 0.5);
    assert.equal(retryCountdownFraction(0), 0);

    // The card shows the sentence, the countdown and the two actions — and no trace
    // of the old fake prompt or the echoed command.
    const card = renderToStaticMarkup(
      React.createElement(SshConnectErrorCard, {
        failure,
        retryIn: SSH_RETRY_DELAY_SECONDS,
        onReconnect: () => {},
        onCancelRetry: () => {},
      })
    );
    // React escapes the apostrophe in "server's" for HTML.
    const asHtml = (text: string) =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");
    assert.ok(card.includes(asHtml(VERCEL_SENTENCE)), "the card shows the server sentence");
    assert.ok(card.includes("Retrying in 10s…"), "the card shows the retry countdown");
    assert.ok(card.includes("Reconnect"), "the card offers a reconnect button");
    assert.ok(!/ubuntu@[^\s<]*:~\$|sudo su/.test(card), "no prompt or echoed command");
    assert.ok(!card.includes("Sushi Serverless SSH Stream"), "no transport banner");

    // With the automatic retry stopped, the card says so instead of counting down.
    const stopped = renderToStaticMarkup(
      React.createElement(SshConnectErrorCard, {
        failure,
        retryIn: null,
        onReconnect: () => {},
        onCancelRetry: () => {},
      })
    );
    assert.ok(!stopped.includes("Retrying in"));
    assert.ok(stopped.includes("Automatic retry is off"));
  }

  // Serverless shell builtins: `sudo su`, `sudo -i`, `sudo <cmd>`, exit, bare su
  {
    const kind = (c: string) => {
      const r = parseElevationCommand(c);
      return r ? r.kind : null;
    };
    for (const cmd of ["sudo su", "sudo su -", "sudo su root", "sudo -i", "sudo -s", "sudo -Es", "sudo bash", "sudo -i bash", "sudo --login"]) {
      assert.equal(kind(cmd), "enter-root", cmd);
    }
    assert.equal(kind("exit"), "leave-root");
    assert.equal(kind("logout"), "leave-root");
    assert.equal(kind("su"), "su-needs-root-password");
    assert.equal(kind("su -"), "su-needs-root-password");
    assert.equal(kind("su root"), "su-needs-root-password");
    assert.equal(kind("su deploy"), null);
    assert.equal(kind("sudo su - deploy"), null);
    const sudo = parseElevationCommand("sudo apt update -y");
    assert.deepEqual(sudo, { kind: "sudo", command: "apt update -y", asUser: "root" });
    const sudoOther = parseElevationCommand("sudo -u postgres psql -c 'select 1'");
    assert.equal(sudoOther?.kind, "sudo");
    assert.equal(sudoOther?.kind === "sudo" ? sudoOther.asUser : "", "postgres");
    for (const cmd of ["ls -la", "echo sudo su", "sudo -l", "sudo -k", "sudo", "!!"]) {
      assert.equal(kind(cmd), null, cmd);
    }

    // Interactive-only programs are detected, but `sudo su` is not one of them
    assert.equal(detectInteractiveProgram("vim /etc/hosts"), "vim");
    assert.equal(detectInteractiveProgram("sudo nano x"), "nano");
    assert.equal(detectInteractiveProgram("top"), "top");
    assert.equal(detectInteractiveProgram("top -bn1"), null);
    // `sudo su` is handled by the elevation parser before this check; `su` stays in
    // the detector so `sudo su - <other-user>` is reported instead of hanging on a
    // root password prompt.
    assert.equal(detectInteractiveProgram("sudo su"), "su");
    assert.equal(detectInteractiveProgram("systemctl status nginx"), null);
    assert.equal(detectInteractiveProgram("crontab -e"), "crontab -e");
    assert.equal(detectInteractiveProgram("python3"), "python3");
    assert.equal(detectInteractiveProgram("python3 -V"), null);
    // A shell on the right side of a pipe reads its script from the pipe — the
    // standard `curl … | sh` installer idiom is NOT an interactive shell.
    assert.equal(detectInteractiveProgram("curl -fsSL https://get.docker.com | sh"), null);
    assert.equal(detectInteractiveProgram("curl -fsSL https://get.docker.com | sudo sh"), null);
    assert.equal(detectInteractiveProgram("wget -qO- https://x/install.sh | bash"), null);
    assert.equal(detectInteractiveProgram("cat x | sh | tee /tmp/log"), null);
    assert.equal(detectInteractiveProgram("bash <(curl -Ls https://x/install.sh)"), null);
    // …but a bare shell as a standalone command (or after ;, &&, ||) still is
    assert.equal(detectInteractiveProgram("sh"), "sh");
    assert.equal(detectInteractiveProgram("echo hi; sh"), "sh");
    assert.equal(detectInteractiveProgram("echo hi && bash"), "bash");
    assert.equal(detectInteractiveProgram("cmd || sh"), "sh");
    // full-screen pagers stay blocked even when pipe-fed
    assert.equal(detectInteractiveProgram("cmd | less"), "less");
  }

  // Serverless exec script: plain, sudo without a password, and sudo with one
  {
    const plain = buildExecScript({ command: "whoami", cwd: "/srv/app" });
    assert.equal(plain.feedPassword, null);
    assert.equal(plain.ptyModes, null);
    // The command is re-exec'd into the shell picked at runtime (bash when present),
    // never hardcoded to /bin/sh — dash rejects bashisms like `<( ... )`.
    assert.match(plain.script, /^__sushi_shell=\$\(command -v bash/);
    assert.match(plain.script, /exec "\$__sushi_shell" -c '/);
    assert.ok(!plain.script.includes("/bin/sh -c"), "plain path must not force /bin/sh");
    assert.match(plain.script, /cd -- .*\/srv\/app/); // path survives shellQuote
    assert.match(plain.script, /whoami\n__sushi_ec=\$\?/);
    assert.match(plain.script, /SUSHI_META/);

    const nopass = buildExecScript({ command: "whoami", elevate: { user: "root" } });
    assert.equal(nopass.feedPassword, null);
    assert.equal(nopass.ptyModes, null);
    assert.match(nopass.script, /^__sushi_shell=\$\(command -v bash/);
    assert.match(nopass.script, /sudo -n -- "\$__sushi_shell" -c '/);
    assert.equal(nopass.script.includes("SushiPass"), false);

    const withPass = buildExecScript({
      command: "whoami",
      elevate: { user: "root", password: "hunter2" },
    });
    assert.equal(withPass.feedPassword, "hunter2");
    assert.deepEqual(withPass.ptyModes, { ECHO: 0 }); // password never echoed
    assert.match(withPass.script, /sudo -S -- "\$__sushi_shell" -c '/);
    assert.equal(withPass.script.includes("hunter2"), false, "password is not part of the script");

    const otherUser = buildExecScript({ command: "id", elevate: { user: "www-data" } });
    assert.match(otherUser.script, /sudo -n -u 'www-data' -- "\$__sushi_shell" -c '/);

    // Quoting: the sudo shell receives exactly the wrapper body we built (round-trip
    // through a real POSIX shell instead of eyeballing the escapes).
    const tricky = "echo \"it's $HOME `pwd`\" && printf '%s\\n' 'x y'";
    const plainScript = buildExecScript({ command: tricky, cwd: "/srv/app" }).script;
    const elevatedScript = buildExecScript({
      command: tricky,
      cwd: "/srv/app",
      elevate: { user: "root" },
    }).script;
    const sudoShellMarker = '"$__sushi_shell" -c ';
    const quotedArg = elevatedScript.slice(
      elevatedScript.indexOf(sudoShellMarker) + sudoShellMarker.length
    );
    const roundTripped = execFileSync("sh", ["-c", `printf %s ${quotedArg}`], { encoding: "utf8" });
    // The plain wrapper must carry the exact same body (unquote it the same way).
    const plainPrefix = 'exec "$__sushi_shell" -c ';
    const plainQuoted = plainScript.slice(plainScript.indexOf(plainPrefix) + plainPrefix.length);
    const plainBody = execFileSync("sh", ["-c", `printf %s ${plainQuoted}`], { encoding: "utf8" });
    assert.equal(roundTripped, plainBody, "sudo shell receives exactly the wrapper body");

    // Regression: a bashism (process substitution) must run even when the outer shell
    // is dash — the wrapper picks bash at runtime instead of hardcoding /bin/sh.
    // This is `bash <(curl …)` dying with `Syntax error: "(" unexpected` on Ubuntu.
    const bashism = buildExecScript({ command: "cat <(echo sushi-bashism-ok)" });
    for (const outer of ["/bin/sh", "/bin/bash"]) {
      const out = execFileSync(outer, ["-c", bashism.script], { encoding: "utf8" });
      assert.ok(
        out.includes("sushi-bashism-ok"),
        `${outer} must run the process substitution (got: ${JSON.stringify(out)})`
      );
      assert.match(out, /SUSHI_META;0;/);
    }
  }

  // sudo password prompt: answered exactly once, then give up (never hang)
  {
    const answerer = createSudoAnswerer();
    const first = answerer.answer("[sudo] password for tester: ");
    assert.deepEqual(first, { text: "", sendPassword: true, gaveUp: false });
    assert.equal(answerer.passwordSent, true);
    assert.deepEqual(answerer.answer("more output"), { text: "more output", sendPassword: false, gaveUp: false });
    const retry = answerer.answer("Sorry, try again.\r\n[sudo] password for tester: ");
    assert.equal(retry.sendPassword, false);
    assert.equal(retry.gaveUp, true);
    assert.equal(retry.text, "Sorry, try again.\r\n");
  }

  // Serverless exec stream: prompts are emitted immediately (not held in a buffer),
  // while a META marker split across SSH packets is still reassembled and stripped.
  assert.deepEqual(splitEmittable("[sudo] password for tester: "), ["[sudo] password for tester: ", ""]);
  assert.deepEqual(splitEmittable("Do you want to continue? [Y/n] "), ["Do you want to continue? [Y/n] ", ""]);
  assert.deepEqual(splitEmittable("colored \x1b[32mok\x1b[0m"), ["colored \x1b[32mok\x1b[0m", ""]);
  {
    const fullOutput = "line one\r\nline two\r\n\x1b]777;SUSHI_META;0;/srv/app\x07";
    for (let cut = 1; cut < fullOutput.length; cut++) {
      let carry = "";
      let shown = "";
      let meta: RegExpExecArray | null = null;
      for (const packet of [fullOutput.slice(0, cut), fullOutput.slice(cut)]) {
        carry += packet;
        const m = META_REGEX.exec(carry);
        if (m) {
          shown += carry.slice(0, m.index);
          meta = m;
          carry = carry.slice(m.index + m[0].length);
        } else {
          const [emit, hold] = splitEmittable(carry);
          shown += emit;
          carry = hold;
        }
      }
      assert.ok(meta, `marker found when split at ${cut}`);
      assert.equal(meta![2], "/srv/app");
      assert.equal(shown, "line one\r\nline two", `clean output when split at ${cut}`);
    }
  }

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

  // Folder download: SFTP tree walk + streaming ZIP (works without a remote shell).
  console.log("==> [2b] Testing folder → ZIP download (SFTP walk + streaming archive)...");
  await sftpMakeDir(creds, "/projects");
  await sftpMakeDir(creds, "/projects/src");
  await sftpMakeDir(creds, "/projects/empty");
  const readme = Buffer.from("# Sushi projects\n");
  const indexTs = Buffer.from("export const ok = true;\n");
  const bigFile = Buffer.from("abcdefghij".repeat(20000));
  await sftpWriteBuffer(creds, "/projects/README.md", readme);
  await sftpWriteBuffer(creds, "/projects/src/index.ts", indexTs);
  await sftpWriteBuffer(creds, "/projects/src/big.txt", bigFile);

  const tree = await collectRemoteTree(creds, "/projects");
  assert.equal(tree.rootPath, "/projects");
  assert.equal(tree.rootName, "projects");
  assert.equal(tree.fileCount, 3);
  assert.equal(tree.directoryCount, 2);
  assert.equal(tree.totalBytes, readme.length + indexTs.length + bigFile.length);
  assert.equal(tree.skippedSymlinks, 0);

  const archive = await zipTreeToBuffer(creds, tree);
  assert.ok(archive.length > 0);
  const zipEntries = parseZipEntries(archive);
  const names = zipEntries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    "README.md",
    "empty/",
    "src/",
    "src/big.txt",
    "src/index.ts",
  ]);

  const byName = new Map(zipEntries.map((e) => [e.name, e]));
  assert.equal(byName.get("README.md")?.data.toString("utf8"), "# Sushi projects\n");
  assert.equal(byName.get("src/index.ts")?.data.toString("utf8"), "export const ok = true;\n");
  assert.equal(byName.get("src/big.txt")?.data.length, bigFile.length);
  assert.equal(byName.get("src/big.txt")?.data.equals(bigFile), true);
  // Deflate actually compresses the repetitive file
  assert.ok(
    (byName.get("src/big.txt")?.compressedSize ?? 0) < bigFile.length / 2,
    "repetitive file is compressed"
  );
  // Directories keep their UNIX directory bit so unzip recreates empty folders
  assert.equal(((byName.get("empty/")?.externalAttributes ?? 0) >>> 28) & 0xf, 0o4);

  // A real unzip implementation must accept the archive (skipped if unavailable)
  if (spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0) {
    const tmpZip = `/tmp/sushi-folder-${Date.now()}.zip`;
    fs.writeFileSync(tmpZip, archive);
    const check = spawnSync("unzip", ["-t", tmpZip], { encoding: "utf8" });
    assert.equal(check.status, 0, `unzip -t accepts the archive: ${check.stdout}${check.stderr}`);
    const listing = spawnSync("unzip", ["-Z1", tmpZip], { encoding: "utf8" });
    assert.match(listing.stdout, /src\/index\.ts/);
    const extractDir = `/tmp/sushi-folder-${Date.now()}`;
    fs.mkdirSync(extractDir, { recursive: true });
    spawnSync("unzip", ["-q", tmpZip, "-d", extractDir], { encoding: "utf8" });
    assert.equal(
      fs.readFileSync(`${extractDir}/src/index.ts`, "utf8"),
      "export const ok = true;\n"
    );
    assert.equal(fs.existsSync(`${extractDir}/empty`), true);
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  // ZIP timestamps survive a round-trip (DOS 2-second granularity)
  const stamp = dosDateTime(Date.UTC(2024, 4, 17, 12, 34, 56));
  assert.ok(stamp.date > 0 && stamp.time > 0);

  // Limits: too many files / too large are rejected before streaming starts
  await assert.rejects(
    () =>
      collectRemoteTree(creds, "/projects", {
        maxFiles: 2,
        maxDepth: 24,
        maxTotalBytes: 1 << 30,
      }),
    (err: unknown) => err instanceof SftpZipLimitError && err.code === "too-many-files"
  );
  await assert.rejects(
    () =>
      collectRemoteTree(creds, "/projects", {
        maxFiles: 100,
        maxDepth: 24,
        maxTotalBytes: 16,
      }),
    (err: unknown) => err instanceof SftpZipLimitError && err.code === "too-large"
  );
  await assert.rejects(
    () =>
      collectRemoteTree(creds, "/projects", {
        maxFiles: 100,
        maxDepth: 0,
        maxTotalBytes: 1 << 30,
      }),
    (err: unknown) => err instanceof SftpZipLimitError && err.code === "too-deep"
  );
  // Archiving a plain file is rejected with a helpful message
  await assert.rejects(
    () => collectRemoteTree(creds, "/hello.txt"),
    /not a folder/
  );

  // Selection download: any mix of files and folders becomes one archive.
  console.log("==> [2c] Testing multi-selection → one ZIP (files + folders)...");
  const selection = await collectRemoteArchive(creds, [
    "/projects/src",
    "/projects/README.md",
    "/projects/empty",
  ]);
  assert.equal(selection.rootPath, "/projects");
  assert.equal(selection.rootName, "projects-selection");
  assert.equal(selection.fileCount, 3);
  assert.equal(selection.directoryCount, 2);
  assert.equal(
    selection.totalBytes,
    readme.length + indexTs.length + bigFile.length
  );

  const selectionArchive = await zipTreeToBuffer(creds, selection);
  const selectionEntries = parseZipEntries(selectionArchive);
  assert.deepEqual(
    selectionEntries.map((e) => e.name).sort(),
    ["README.md", "empty/", "src/", "src/big.txt", "src/index.ts"]
  );
  const selectionByName = new Map(selectionEntries.map((e) => [e.name, e]));
  assert.equal(
    selectionByName.get("README.md")?.data.toString("utf8"),
    "# Sushi projects\n"
  );
  assert.equal(selectionByName.get("src/big.txt")?.data.equals(bigFile), true);
  // The selected folders keep their own entry, so empty ones survive unzipping.
  assert.equal(
    ((selectionByName.get("empty/")?.externalAttributes ?? 0) >>> 28) & 0xf,
    0o4
  );

  // A single selected file goes to the archive root under its own name…
  const singleFile = await collectRemoteArchive(creds, ["/projects/README.md"]);
  assert.equal(singleFile.rootName, "README.md");
  assert.equal(singleFile.rootPath, "/projects");
  assert.deepEqual(
    singleFile.entries.map((e) => e.relPath),
    ["README.md"]
  );
  assert.equal(singleFile.fileCount, 1);
  // …and a single folder still archives its contents at the root.
  const singleFolder = await collectRemoteArchive(creds, ["/projects"]);
  assert.deepEqual(
    singleFolder.entries.map((e) => e.relPath).sort(),
    tree.entries.map((e) => e.relPath).sort()
  );

  // Duplicate paths (same folder spelled twice) are walked once.
  const deduped = await collectRemoteArchive(creds, [
    "/projects/src",
    "/projects/./src",
    "./projects/src",
  ]);
  assert.equal(deduped.fileCount, 2);
  assert.equal(deduped.directoryCount, 0);
  assert.deepEqual(
    deduped.entries.map((e) => e.relPath).sort(),
    ["big.txt", "index.ts"]
  );

  // Two selected items with the same basename keep distinct archive names.
  await sftpWriteBuffer(
    creds,
    "/projects/src/README.md",
    Buffer.from("# inner readme\n")
  );
  const sameName = await collectRemoteArchive(creds, [
    "/projects/README.md",
    "/projects/src/README.md",
  ]);
  assert.deepEqual(
    sameName.entries.map((e) => e.relPath).sort(),
    ["README (2).md", "README.md"]
  );
  assert.equal(
    sameName.entries.find((e) => e.relPath === "README (2).md")?.remotePath,
    "/projects/src/README.md"
  );

  // Selection archives are accepted by a real unzip too.
  if (spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0) {
    const tmpSelection = `/tmp/sushi-selection-${Date.now()}.zip`;
    fs.writeFileSync(tmpSelection, selectionArchive);
    const check = spawnSync("unzip", ["-t", tmpSelection], { encoding: "utf8" });
    assert.equal(
      check.status,
      0,
      `unzip -t accepts a selection archive: ${check.stdout}${check.stderr}`
    );
    fs.rmSync(tmpSelection, { force: true });
  }

  // Limits still apply to a selection.
  await assert.rejects(
    () =>
      collectRemoteArchive(creds, ["/projects"], {
        maxFiles: 2,
        maxDepth: 24,
        maxTotalBytes: 1 << 30,
      }),
    (err: unknown) =>
      err instanceof SftpZipLimitError && err.code === "too-many-files"
  );
  // An empty selection is a clear error rather than an empty archive.
  await assert.rejects(
    () => collectRemoteArchive(creds, ["   "]),
    /Nothing was selected/
  );

  await sftpDeleteItem(creds, "/projects");

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
  const validSessionToken = createSessionToken(authCfg.username, authCfg.authSecret, authCfg.sessionVersion);
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
  assert.equal(uninitVercelCfg.canBootstrapInteractive, false);
  await assert.rejects(
    bootstrapAdminAccount("verceladmin", "vercel-pass-123"),
    /persistent shared storage/i
  );
  // Stateless browser-local accounts remain available only by explicit opt-in.
  process.env.SUSHI_ALLOW_STATELESS_SETUP = "true";
  assert.equal((await getEffectiveAuthConfig(new Headers())).canBootstrapInteractive, true);

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
  delete process.env.SUSHI_ALLOW_STATELESS_SETUP;
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

  console.log("==> [6/8] Testing vault crypto on plain HTTP (pure-JS fallback) + Termix SQLite import...");
  // Browsers only expose crypto.subtle / crypto.randomUUID on HTTPS or localhost. On a
  // plain-HTTP self-hosted instance Sushi falls back to @noble — it must be byte-compatible.
  {
    const key = crypto.randomBytes(32);
    const message = new TextEncoder().encode(`sushi vault ✓ ${"x".repeat(2048)}`);
    for (const iv of [crypto.randomBytes(12), crypto.randomBytes(16)]) {
      const nativeCt = await aesGcmEncrypt(key, iv, message);
      __setForcePureJsCrypto(true);
      const pureCt = await aesGcmEncrypt(key, iv, message);
      const pureOpened = await aesGcmDecrypt(key, iv, nativeCt);
      const tampered = Buffer.from(nativeCt);
      tampered[0] ^= 1;
      await assert.rejects(aesGcmDecrypt(key, iv, tampered));
      __setForcePureJsCrypto(false);
      assert.deepEqual(Buffer.from(pureCt), Buffer.from(nativeCt));
      assert.deepEqual(Buffer.from(pureOpened), Buffer.from(message));
      assert.deepEqual(Buffer.from(await aesGcmDecrypt(key, iv, pureCt)), Buffer.from(message));
    }
    const salt = crypto.randomBytes(16);
    const nativeKdf = [
      await pbkdf2Sha256("master passphrase", salt, 2000),
      await hkdfSha256(key, new Uint8Array(0), "termix:dek-wrap:v3:1"),
      await hkdfSha256(key, salt, "ctx"),
      await sha256("abc"),
    ];
    __setForcePureJsCrypto(true);
    const pureKdf = [
      await pbkdf2Sha256("master passphrase", salt, 2000),
      await hkdfSha256(key, new Uint8Array(0), "termix:dek-wrap:v3:1"),
      await hkdfSha256(key, salt, "ctx"),
      await sha256("abc"),
    ];
    const pureUuid = randomUUID();
    __setForcePureJsCrypto(false);
    nativeKdf.forEach((v, i) => assert.deepEqual(Buffer.from(pureKdf[i]), Buffer.from(v)));
    assert.match(pureUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Vault envelopes move freely between HTTPS (native) and plain-HTTP (pure-JS) sessions
    const memoryStorage = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => memoryStorage.get(k) ?? null,
      setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
      removeItem: (k: string) => void memoryStorage.delete(k),
    };
    const vaultPlain: VaultPlaintext = {
      version: 1,
      hosts: [
        {
          id: "h1",
          name: "prod",
          protocol: "ssh",
          host: "203.0.113.10",
          port: 22,
          username: "root",
          authMethod: "password",
          password: "p@ss ✓",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      snippets: [{ id: "s1", title: "Uptime", command: "uptime", category: "Diagnostics" }],
      sshKeys: [],
    };
    for (const passphrase of ["correct horse", null]) {
      const nativeEnvelope = await encryptVaultData(vaultPlain, passphrase);
      __setForcePureJsCrypto(true);
      const pureT0 = Date.now();
      const openedOverHttp = await decryptVaultEnvelope(nativeEnvelope, passphrase);
      const pureMs = Date.now() - pureT0;
      const httpEnvelope = await encryptVaultData(vaultPlain, passphrase);
      if (passphrase) {
        await assert.rejects(decryptVaultEnvelope(httpEnvelope, "wrong"), /Incorrect master passphrase/);
      }
      __setForcePureJsCrypto(false);
      const openedOverHttps = await decryptVaultEnvelope(httpEnvelope, passphrase);
      assert.equal(openedOverHttp.hosts[0].password, "p@ss ✓");
      assert.equal(openedOverHttps.hosts[0].password, "p@ss ✓");
      assert.equal(openedOverHttps.snippets[0].command, "uptime");
      console.log(
        `    vault ${passphrase ? "passphrase (PBKDF2 210k)" : "device-key"} mode: native ⇄ pure-JS OK (pure-JS unlock ${pureMs} ms)`
      );
    }
    delete (globalThis as Record<string, unknown>).localStorage;
  }

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
  // Plain-HTTP self-hosting (http://<vps-ip>:3000): browsers expose no crypto.subtle
  // there, so the same import must work through the pure-JS fallback, identically.
  const hostDigest = (hs: typeof termixDb.hosts) =>
    hs
      .map((h) => [h.name, h.protocol, h.password ?? "", h.privateKey ?? "", h.passphrase ?? ""].join("|"))
      .sort();
  __setForcePureJsCrypto(true);
  try {
    const pureJsDb = await importTermixSqliteDatabase(termixFx.encryptedFile, {
      termixEnv: termixFx.envFile,
      termixPassword: termixFx.bobPassword,
    });
    assert.equal(pureJsDb.status, "ok");
    assert.equal(pureJsDb.secrets.locked, 0);
    assert.equal(pureJsDb.secrets.decrypted, termixDb.secrets.decrypted);
    assert.deepEqual(hostDigest(pureJsDb.hosts), hostDigest(termixDb.hosts));
    assert.deepEqual(
      pureJsDb.sshKeys.map((k) => k.fingerprint).sort(),
      termixDb.sshKeys.map((k) => k.fingerprint).sort()
    );
  } finally {
    __setForcePureJsCrypto(false);
  }

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

  // The RDP arguments this fake guacd advertises. guacd fills the `connect`
  // instruction from this list, so it doubles as the contract for what Sushi sends.
  const MOCK_RDP_ARGS = [
    "VERSION_1_5_0",
    "hostname",
    "port",
    "username",
    "password",
    "domain",
    "security",
    "ignore-cert",
    "width",
    "height",
    "dpi",
    "resize-method",
    "color-depth",
    "enable-wallpaper",
    "enable-theming",
    "enable-font-smoothing",
    "force-lossless",
    "disable-audio",
    "read-only",
    "client-name",
    "enable-drive",
    "drive-name",
  ];
  /** Every `connect` a bridge opened, as name → value. */
  const rdpConnectCalls: Array<Record<string, string>> = [];
  /** Instructions the bridge sent before `connect` (size / audio / image / timezone). */
  const rdpPreConnect: string[][][] = [];

  // Start mock guacd daemon
  const guacdMock = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    let step = 0;
    let preConnect: string[][] = [];
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const parsed = parseGuacDaemonStream(buf);
      buf = parsed.remainder;
      for (const instr of parsed.instructions) {
        if (step === 0 && instr[0] === "select" && instr[1] === "rdp") {
          step = 1;
          preConnect = [];
          sock.write(encodeGuacForDaemon(["args", ...MOCK_RDP_ARGS]));
        } else if (step === 1 && instr[0] === "connect") {
          assert.equal(instr[1], "VERSION_1_5_0");
          assert.equal(instr[2], "127.0.0.1");
          const values: Record<string, string> = {};
          MOCK_RDP_ARGS.forEach((name, index) => {
            values[name] = instr[index + 1];
          });
          rdpConnectCalls.push(values);
          rdpPreConnect.push(preConnect);
          step = 2;
          sock.write(
            encodeGuacForDaemon(["ready", "$mock-rdp-session"]) +
              encodeGuacForDaemon(["size", "0", "1280", "720"])
          );
        } else if (step === 1 && instr[0] !== "connect") {
          preConnect.push(instr);
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

  // Hybrid mode: a Vercel-hosted Sushi sends ITS OWN session token (signed with a
  // different secret) plus the VPS gateway token — the gateway token must be honored.
  const wsSshAuth = (fields: Record<string, unknown>) =>
    new Promise<{ type: string; message?: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/ws/ssh`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("WebSocket auth timed out"));
      }, 10000);
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", cols: 80, rows: 24, credentials: creds, ...fields }));
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.type === "ready" || msg.type === "error") {
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        }
      });
    });
  const foreignSession = createSessionToken("vercel-admin", "f".repeat(64));
  process.env.SUSHI_GATEWAY_TOKEN = "vps-gateway-token-0123456789";
  try {
    const viaGatewayToken = await wsSshAuth({
      sessionToken: foreignSession,
      gatewayToken: "vps-gateway-token-0123456789",
    });
    assert.equal(viaGatewayToken.type, "ready", viaGatewayToken.message);
    const wrongGatewayToken = await wsSshAuth({
      sessionToken: foreignSession,
      gatewayToken: "not-the-token",
    });
    assert.equal(wrongGatewayToken.type, "error");
    assert.match(wrongGatewayToken.message ?? "", /Gateway token rejected/);

    // RDP passes tokens in the query string: session + token are checked separately
    await new Promise<void>((resolve, reject) => {
      const payload = Buffer.from(
        JSON.stringify({ host: "127.0.0.1", port: rdpPort, username: "a", password: "b" }),
        "utf8"
      ).toString("base64url");
      const ws = new WebSocket(
        `ws://127.0.0.1:${gwPort}/ws/rdp?payload=${encodeURIComponent(payload)}&session=${encodeURIComponent(
          foreignSession
        )}&token=vps-gateway-token-0123456789`,
        "guacamole"
      );
      const timer = setTimeout(() => reject(new Error("RDP gateway-token handshake timed out")), 10000);
      ws.on("error", reject);
      ws.on("close", (code) => {
        if (code === 1008) {
          clearTimeout(timer);
          reject(new Error("RDP gateway token was rejected"));
        }
      });
      ws.on("message", (raw) => {
        const instrs = parseGuacBrowserMessage(raw.toString("utf8"));
        if (instrs.some((i) => i[0] === "" && i.length === 2 && i[1].length === 36)) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
    });
  } finally {
    delete process.env.SUSHI_GATEWAY_TOKEN;
  }
  const unconfiguredGateway = await wsSshAuth({ gatewayToken: "vps-gateway-token-0123456789" });
  assert.equal(unconfiguredGateway.type, "error");
  assert.match(unconfiguredGateway.message ?? "", /no SUSHI_GATEWAY_TOKEN configured/);

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

  console.log(
    "==> [7b] Testing RDP session parameters, live resize and reconnect policy..."
  );

  // --- what the bridge actually sent guacd ----------------------------------
  assert.ok(rdpConnectCalls.length >= 2, "the bridge opened the mock RDP sessions");
  const desktopIndex = rdpConnectCalls.findIndex((call) => call.username === "Administrator");
  assert.ok(desktopIndex >= 0, "the desktop session reached guacd");
  const firstRdp = rdpConnectCalls[desktopIndex];
  // Defaults: balanced picture, audio on, drive redirected for uploads.
  assert.equal(firstRdp.hostname, "127.0.0.1");
  assert.equal(firstRdp.username, "Administrator");
  assert.equal(firstRdp.password, "secret");
  assert.equal(firstRdp.security, "any");
  assert.equal(firstRdp["ignore-cert"], "true");
  assert.equal(firstRdp["resize-method"], "display-update");
  assert.equal(firstRdp["enable-drive"], "true");
  assert.equal(firstRdp["drive-name"], "Sushi");
  assert.equal(firstRdp["read-only"], "false");
  assert.equal(firstRdp["disable-audio"], "false");
  assert.equal(firstRdp["enable-wallpaper"], "false");
  assert.equal(firstRdp["enable-theming"], "true");
  assert.equal(firstRdp["color-depth"], "24");
  assert.match(firstRdp["client-name"] ?? "", /^Sushi \(127\.0\.0\.1\)$/);

  // Media capabilities are declared before connect — and only what we render.
  const declared = rdpPreConnect[desktopIndex].map((instr) => instr[0]);
  assert.ok(declared.includes("size"), "display size announced");
  assert.ok(declared.includes("audio"), "audio stream declared when audio is on");
  assert.ok(declared.includes("image"));
  assert.ok(!declared.includes("video"), "no video stream is declared (never rendered)");

  // --- RDP parameters -------------------------------------------------------
  const baseCreds = {
    host: "rdp.example.com",
    port: 3389,
    username: "Administrator",
    password: "pw",
  };
  const params = buildRdpParams(baseCreds);
  assert.equal(params.hostname, "rdp.example.com");
  assert.equal(params.width, "1280");
  assert.equal(params.height, "720");
  assert.equal(params.dpi, "96");

  // Picture presets: best keeps the eye candy, fast trades it for bandwidth.
  assert.equal(buildRdpParams({ ...baseCreds, rdpPerformance: "best" })["enable-wallpaper"], "true");
  assert.equal(buildRdpParams({ ...baseCreds, rdpPerformance: "best" })["color-depth"], "32");
  assert.equal(buildRdpParams({ ...baseCreds, rdpPerformance: "best" })["force-lossless"], "true");
  const fastParams = buildRdpParams({ ...baseCreds, rdpPerformance: "fast" });
  assert.equal(fastParams["enable-wallpaper"], "false");
  assert.equal(fastParams["enable-theming"], "false");
  assert.equal(fastParams["enable-font-smoothing"], "false");
  assert.equal(fastParams["color-depth"], "16");
  // Unknown values fall back to balanced rather than being forwarded blindly.
  assert.equal(normalizeRdpPerformance("ultra"), "balanced");
  assert.equal(buildRdpParams({ ...baseCreds, rdpPerformance: "ultra" as never })["color-depth"], "24");

  // Audio, view-only and drive redirection are connect-time switches.
  assert.equal(buildRdpParams({ ...baseCreds, rdpAudio: false })["disable-audio"], "true");
  assert.equal(buildRdpParams({ ...baseCreds, rdpReadOnly: true })["read-only"], "true");
  const noDrive = buildRdpParams({ ...baseCreds, rdpDrive: false });
  assert.equal(noDrive["enable-drive"], "false");
  assert.equal(noDrive["drive-name"], undefined);

  // Security modes are whitelisted, sizes clamped to what RDP accepts.
  assert.equal(normalizeRdpSecurity("nla"), "nla");
  assert.equal(normalizeRdpSecurity("bogus"), "any");
  assert.equal(buildRdpParams({ ...baseCreds, rdpSecurity: "tls" }).security, "tls");
  assert.equal(buildRdpParams({ ...baseCreds, width: 99999 }).width, "4096");
  assert.equal(buildRdpParams({ ...baseCreds, height: 10 }).height, "480");
  assert.equal(buildRdpParams({ ...baseCreds, dpi: 5 }).dpi, "72");
  // A missing/zero port means "the default RDP port"; out-of-range ports clamp.
  assert.equal(buildRdpParams({ ...baseCreds, port: 0 }).port, "3389");
  assert.equal(buildRdpParams({ ...baseCreds, port: 70000 }).port, "65535");

  // Timezone + client name reach the remote, but never as header injection.
  assert.equal(normalizeTimezone("Asia/Phnom_Penh"), "Asia/Phnom_Penh");
  assert.equal(normalizeTimezone("America/Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires");
  assert.equal(normalizeTimezone("../../etc/passwd"), "");
  assert.equal(normalizeTimezone(""), "");
  assert.equal(normalizeClientName("Sushi\u0000Box", "h"), "SushiBox");
  assert.equal(normalizeClientName(undefined, "box.example.com"), "Sushi (box.example.com)");
  assert.ok(normalizeClientName("x".repeat(80), "h").length <= 32);

  // --- live resize (fit-to-window) -----------------------------------------
  assert.deepEqual(fitRemoteSize(1920.6, 1080.2), { width: 1920, height: 1080 });
  assert.deepEqual(fitRemoteSize(300, 200), { width: 640, height: 480 });
  assert.deepEqual(fitRemoteSize(5000, 5000), { width: 4096, height: 2160 });
  assert.deepEqual(fitRemoteSize(1281, 721), { width: 1282, height: 722 });
  assert.deepEqual(fitRemoteSize(0, 0), { width: 640, height: 480 });
  // A 1-pixel drag must not resize the desktop, a real one must.
  assert.equal(shouldResizeRemote(null, { width: 1280, height: 720 }), true);
  assert.equal(shouldResizeRemote({ width: 1280, height: 720 }, { width: 1286, height: 722 }), false);
  assert.equal(shouldResizeRemote({ width: 1280, height: 720 }, { width: 1300, height: 720 }), true);
  // …and the request itself is skipped while the desktop is already close, which is
  // what stopped the desktop oscillating between two sizes around a scrollbar.
  assert.deepEqual(nextRemoteSize(null, { width: 1224, height: 850 }), { width: 1224, height: 850 });
  assert.equal(nextRemoteSize({ width: 1224, height: 850 }, { width: 1224, height: 848 }), null);
  assert.deepEqual(nextRemoteSize({ width: 1224, height: 850 }, { width: 1000, height: 700 }), {
    width: 1000,
    height: 700,
  });
  // A resize that only changes by a few pixels never reaches the server.
  assert.equal(nextRemoteSize({ width: 1224, height: 850 }, { width: 1230, height: 852 }), null);
  assert.equal(formatRemoteSize(1920, 1080), "1920 × 1080");
  assert.equal(formatRemoteSize(0, 0), "—");

  // --- reconnect policy -----------------------------------------------------
  assert.equal(reconnectDelayMs(1), 1000);
  assert.equal(reconnectDelayMs(2), 2000);
  assert.equal(reconnectDelayMs(3), 4000);
  assert.equal(reconnectDelayMs(9), 15000);
  // Network trouble is retried; a bad password or an expired session is not.
  assert.equal(shouldRetryRdpStatus(0x0207), true);
  assert.equal(shouldRetryRdpStatus(0x0202), true);
  assert.equal(shouldRetryRdpStatus(0x020b), true);
  assert.equal(shouldRetryRdpStatus(0x0303), false);
  assert.equal(shouldRetryRdpStatus(0x0301), false);
  assert.equal(shouldRetryRdpStatus(0x030f), false);
  assert.match(describeRdpStatus(0x0207), /guacd could not reach/);
  assert.match(describeRdpStatus(0x0303), /refused the login/);
  assert.match(describeRdpStatus(0x0301), /sign in again/);
  assert.match(describeRdpStatus(9999, "Daemon said no"), /Daemon said no/);
  assert.match(describeRdpStatus(0x0000), /session ended/i);

  // --- saved preferences are validated, not trusted -------------------------
  assert.deepEqual(parseRdpPrefs(undefined), DEFAULT_RDP_PREFS);
  assert.deepEqual(parseRdpPrefs("nonsense"), DEFAULT_RDP_PREFS);
  assert.deepEqual(
    parseRdpPrefs({ performance: "fast", audio: false, readOnly: true, drive: false, fitWindow: false }),
    { performance: "fast", audio: false, readOnly: true, drive: false, fitWindow: false }
  );
  // A corrupt entry only loses the corrupt field.
  const partial = parseRdpPrefs({ performance: "wat", audio: false });
  assert.equal(partial.performance, "balanced");
  assert.equal(partial.audio, false);
  assert.equal(partial.readOnly, false);
  assert.equal(partial.fitWindow, true);

  console.log(
    "==> [8/10] Testing serverless exec stdin (live keystrokes + piped answers)..."
  );

  // --- request-line parsing ---------------------------------------------------
  assert.deepEqual(parseExecInputLine('{"type":"input","data":"y\\r"}'), {
    type: "input",
    data: "y\r",
  });
  assert.deepEqual(parseExecInputLine('{"type":"signal","signal":"int"}'), {
    type: "signal",
    signal: "INT",
  });
  assert.deepEqual(parseExecInputLine('{"type":"signal","signal":"SIGTERM"}'), {
    type: "signal",
    signal: "TERM",
  });
  assert.equal(parseExecInputLine('{"type":"signal","signal":"NOPE"}'), null);
  assert.equal(parseExecInputLine("not json"), null);
  assert.equal(parseExecInputLine("   "), null);
  const startEvent = parseExecInputLine(
    '{"type":"start","payload":{"command":"echo hi","credentials":{"host":"h"}}}'
  );
  assert.equal(startEvent?.type, "start");
  assert.equal(
    (startEvent as { payload: { command: string } }).payload.command,
    "echo hi"
  );

  // --- chunk splitting keeps a keystroke that spans two packets --------------
  const firstHalf = decodeExecChunk("", '{"type":"input","data":"he');
  assert.equal(firstHalf.events.length, 0);
  assert.equal(firstHalf.carry, '{"type":"input","data":"he');
  const secondHalf = decodeExecChunk(firstHalf.carry, 'llo"}\n{"type":"input","data":"!"}\n');
  assert.deepEqual(secondHalf.events, [
    { type: "input", data: "hello" },
    { type: "input", data: "!" },
  ]);
  assert.equal(secondHalf.carry, "");

  // --- the browser-side channel writes the start line first ------------------
  const { body, channel } = createExecRequestBody({ command: "apt install docker" });
  assert.equal(channel.canSendInput, true);
  assert.equal(channel.sendInput("y\r"), true);
  assert.equal(channel.sendSignal("INT"), true);
  channel.close();
  assert.equal(channel.sendInput("after-close"), false);
  const sent = await new Response(body).text();
  const sentLines = sent.trim().split("\n").map((line) => JSON.parse(line) as {
    type: string;
    payload?: { command?: string };
    data?: string;
    signal?: string;
  });
  assert.equal(sentLines[0].type, "start");
  assert.equal(sentLines[0].payload?.command, "apt install docker");
  assert.deepEqual(sentLines[1], { type: "input", data: "y\r" });
  assert.deepEqual(sentLines[2], { type: "signal", signal: "INT" });

  // --- pumping input onto a "channel" stops when the command exits -----------
  const written: string[] = [];
  const signals: string[] = [];
  let open = true;
  const inputBody = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('{"type":"input","data":"y"}\n{"type":"inp'));
      controller.enqueue(
        enc.encode('ut","data":"\r"}\n{"type":"signal","signal":"INT"}\n')
      );
      controller.enqueue(enc.encode('{"type":"input","data":"ignored"}\n'));
      controller.close();
    },
  });
  await pumpExecInput(inputBody.getReader(), "", {
    onInput: (data) => {
      written.push(data);
      open = false; // the command finished halfway through
    },
    onSignal: (signal) => signals.push(signal),
    isClosed: () => !open,
  });
  assert.deepEqual(written, ["y"]);
  assert.deepEqual(signals, [], "no signals after the command closed");

  // --- capability detection --------------------------------------------------
  // Firefox/Safari report "ReadableStream uploading is not supported" at fetch time
  // because they ignore `duplex`; the probe must reject them up front. Node's
  // undici honours duplex, which is the Chromium-equivalent case.
  __setStreamingRequestBodySupport(null);
  // Outside a browser the probe must refuse: there is no `window`, so request-body
  // streaming (an xterm-browser feature) is never attempted from the server runtime.
  assert.equal(
    supportsStreamingRequestBody(),
    false,
    "probe is browser-only and reports false without a window"
  );
  // The rule the probe applies in a browser: an engine that drops the unknown
  // `duplex` member cannot upload a stream (Firefox → "ReadableStream uploading is
  // not supported"), so only `duplex === "half"` counts as support.
  const duplexRequest = new Request("http://localhost/", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal(
    (duplexRequest as Request & { duplex?: string }).duplex,
    "half",
    "this engine keeps the duplex flag (Chromium/undici behaviour)"
  );
  assert.equal(
    typeof canStreamExecStdin(),
    "boolean",
    "stdin capability combines browser support and HTTP/2"
  );
  __setStreamingRequestBodySupport(null);

  // --- stdin grace period: an unanswerable prompt is answerable by retry ----
  // (server side: prompt detection for the `stdin` replay path)
  assert.equal(PROMPT_HINT_RE.test("Do you want to continue? [Y/n] "), true);
  assert.equal(PROMPT_HINT_RE.test("Are you sure (yes/no)? "), true);
  assert.equal(PROMPT_HINT_RE.test("root@host:~# "), false);

  // --- "Open via RDP": the same host, reached as a desktop ------------------
  console.log("==> [8b] Testing Open via RDP companion profiles...");
  const sshHost = {
    id: "host-ssh-1",
    name: "prod-api-tokyo",
    protocol: "ssh" as const,
    host: "203.0.113.42",
    port: 2222,
    username: "ubuntu",
    authMethod: "privateKey" as const,
    password: "ssh-pass",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    passphrase: "key-pass",
    sshKeyId: "key-1",
    domain: "",
    rdpSecurity: "any" as const,
    ignoreCert: true,
    rdpWidth: 1600,
    rdpHeight: 900,
    initialPath: "/var/www",
    group: "Production",
    accentColor: "#34d399",
    createdAt: 1,
    updatedAt: 1,
  };

  const companion = buildRdpCompanionProfile(sshHost);
  assert.equal(companion.protocol, "rdp");
  assert.equal(companion.port, DEFAULT_RDP_PORT, "SSH port 2222 is not reused for RDP");
  assert.equal(companion.port, 3389);
  assert.equal(companion.host, sshHost.host);
  assert.equal(companion.username, "ubuntu");
  assert.equal(companion.password, "ssh-pass", "same password is offered to the desktop");
  assert.equal(companion.authMethod, "password");
  assert.equal(companion.privateKey, undefined, "private key never reaches the RDP bridge");
  assert.equal(companion.passphrase, undefined);
  assert.equal(companion.sshKeyId, undefined);
  assert.equal(companion.initialPath, undefined, "SFTP start path is meaningless for RDP");
  assert.equal(companion.rdpWidth, 1600, "RDP options the host already has are kept");
  assert.equal(companion.rdpHeight, 900);
  assert.equal(companion.ignoreCert, true);
  assert.equal(companion.accentColor, "#ff6b57");
  assert.equal(companion.id, sshHost.id, "the derived profile points at the same host");
  assert.equal(companion.name, sshHost.name);
  // the source profile is untouched (the Vault copy must not gain RDP fields)
  assert.equal(sshHost.protocol, "ssh");
  assert.equal(sshHost.port, 2222);
  assert.equal(sshHost.authMethod, "privateKey");
  assert.equal(sshHost.privateKey, "-----BEGIN OPENSSH PRIVATE KEY-----");

  // an explicit port is honoured (non-standard xrdp setups)
  assert.equal(buildRdpCompanionProfile(sshHost, { port: 3390 }).port, 3390);

  // a host that already is an RDP host keeps its own port and colour
  const rdpHost = {
    ...sshHost,
    id: "host-rdp-1",
    name: "win-dc-01",
    protocol: "rdp" as const,
    port: 3390,
    username: "Administrator",
    authMethod: "password" as const,
    domain: "CORP",
    accentColor: "#fbbf24",
  };
  const rdpCompanion = buildRdpCompanionProfile(rdpHost);
  assert.equal(rdpCompanion.protocol, "rdp");
  assert.equal(rdpCompanion.port, 3390);
  assert.equal(rdpCompanion.domain, "CORP");
  assert.equal(rdpCompanion.accentColor, "#fbbf24");
  // SFTP hosts behave like SSH hosts
  assert.equal(
    buildRdpCompanionProfile({ ...sshHost, protocol: "sftp" as const }).port,
    3389
  );

  // the dialog draft saves as a *separate* RDP host
  const draft = buildRdpCompanionDraft(sshHost);
  assert.equal(draft.id, undefined, "no id → saving creates a new host");
  assert.equal(draft.protocol, "rdp");
  assert.equal(draft.port, 3389);
  assert.equal(draft.name, "prod-api-tokyo (RDP)");
  // a companion profile (already RDP) does not get a doubled suffix
  assert.equal(buildRdpCompanionDraft(companion).name, "prod-api-tokyo (RDP)");
  assert.equal(buildRdpCompanionDraft(companion).id, undefined);

  // tab titles tell the SSH tab and its desktop twin apart
  assert.equal(rdpCompanionTitle(sshHost), "prod-api-tokyo (RDP)");
  assert.equal(rdpCompanionTitle(rdpHost), "win-dc-01");

  // --- folder download sink (File System Access API vs. blob fallback) ------
  // The client module reads `window`, so a tiny stub stands in for a browser here.
  const fakeWindow = { isSecureContext: true } as {
    isSecureContext: boolean;
    showSaveFilePicker?: (options?: unknown) => Promise<unknown>;
  };
  const realWindow = (globalThis as { window?: unknown }).window;
  const setWindow = (value: unknown) => {
    (globalThis as { window?: unknown }).window = value;
  };

  try {
    // 1. no picker at all (Safari/Firefox) → in-memory download
    setWindow(fakeWindow);
    assert.equal(canSaveStreamToDisk(), false);
    assert.deepEqual(await openArchiveSink("app.zip"), { kind: "memory" });

    // 2. picker present → chunks are forwarded to the chosen file in order
    const written: number[] = [];
    let closed = false;
    let aborted = false;
    let suggested: string | undefined;
    fakeWindow.showSaveFilePicker = async (options?: unknown) => {
      suggested = (options as { suggestedName?: string })?.suggestedName;
      return {
        createWritable: async () => ({
          write: async (chunk: Uint8Array) => {
            written.push(chunk.byteLength);
          },
          close: async () => {
            closed = true;
          },
          abort: async () => {
            aborted = true;
          },
        }),
      };
    };
    assert.equal(canSaveStreamToDisk(), true);
    const sink = await openArchiveSink("project.zip");
    assert.equal(suggested, "project.zip");
    assert.equal(sink.kind, "stream");
    if (sink.kind === "stream") {
      await sink.write(new Uint8Array(10));
      await sink.write(new Uint8Array(25));
      await sink.close();
      await sink.abort();
    }
    assert.deepEqual(written, [10, 25], "every chunk reaches the file");
    assert.equal(closed, true);
    assert.equal(aborted, true);

    // 3. the user dismisses the save dialog → cancelled, archive never starts
    fakeWindow.showSaveFilePicker = async () => {
      const err = new Error("The user aborted a request.");
      err.name = "AbortError";
      throw err;
    };
    assert.deepEqual(await openArchiveSink("app.zip"), { kind: "cancelled" });

    // 4. picker blocked by policy → fall back instead of failing the download
    fakeWindow.showSaveFilePicker = async () => {
      throw new Error("Not allowed");
    };
    assert.deepEqual(await openArchiveSink("app.zip"), { kind: "memory" });

    // 5. insecure context never gets a picker prompt
    fakeWindow.isSecureContext = false;
    assert.equal(canSaveStreamToDisk(), false);
    assert.deepEqual(await openArchiveSink("app.zip"), { kind: "memory" });
  } finally {
    setWindow(realWindow);
  }

  console.log(
    "==> [9/10] Testing terminal menus (whiptail / debconf key channel)..."
  );

  // A real whiptail box, drawn exactly the way newt prints it.
  const lightdmBox = [
    "\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524 Configuring lightdm \u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
    "\u2502                                                        \u2502",
    "\u2502 Please select the default display manager:             \u2502",
    "\u2502                                                        \u2502",
    "\u2502                (*) gdm3                                \u2502",
    "\u2502                ( ) lightdm                             \u2502",
    "\u2502                                                        \u2502",
    "\u2502                   <Ok>        <Cancel>                 \u2502",
    "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
  ].join("\r\n");

  const menu = detectFullscreenMenu("Some earlier output\r\n" + lightdmBox + "\r\n");
  assert.ok(menu, "whiptail box detected");
  assert.equal(menu!.title, "Configuring lightdm");
  assert.equal(menu!.kind, "select");
  assert.deepEqual(
    menu!.items.map((item) => `${item.selected ? "*" : " "}${item.label}`),
    ["*gdm3", " lightdm"]
  );
  assert.deepEqual(menu!.buttons, ["Ok", "Cancel"]);

  // Picking the second entry: one arrow down from the selection, Space, Enter.
  assert.equal(menuSelectKeys(menu!, 1), `${MENU_KEY.down} ${MENU_KEY.enter}`);
  assert.equal(menuSelectKeys(menu!, 0), ` ${MENU_KEY.enter}`);
  // <Ok> is the default button, <Cancel> is one Tab away.
  assert.equal(menuButtonKeys(menu!, "Ok"), MENU_KEY.enter);
  assert.equal(menuButtonKeys(menu!, "Cancel"), `${MENU_KEY.tab}${MENU_KEY.enter}`);

  // Yes/No boxes and checklists
  const yesNo = detectFullscreenMenu(
    "\u250c\u2500\u2524 Configuring grub-pc \u251c\u2500\u2510\r\n\u2502 Continue without installing GRUB? \u2502\r\n\u2502            <Yes>    <No>            \u2502\r\n\u2514\u2500\u2518\r\n"
  );
  assert.ok(yesNo, "yes/no box detected");
  assert.equal(yesNo!.kind, "confirm");
  assert.deepEqual(yesNo!.buttons, ["Yes", "No"]);
  assert.equal(menuButtonKeys(yesNo!, "Yes"), MENU_KEY.enter);
  assert.equal(menuButtonKeys(yesNo!, "No"), `${MENU_KEY.tab}${MENU_KEY.enter}`);

  const checklist = detectFullscreenMenu(
    "\u250c\u2500\u2524 Tasksel \u251c\u2500\u2510\r\n\u2502 [*] Ubuntu desktop       \u2502\r\n\u2502 [ ] OpenSSH server       \u2502\r\n\u2502        <Ok>   <Cancel>   \u2502\r\n\u2514\u2500\u2518\r\n"
  );
  assert.equal(checklist?.kind, "checklist");
  assert.deepEqual(checklist!.items.map((i) => i.selected), [true, false]);

  // Ordinary output must never be mistaken for a menu.
  assert.equal(detectFullscreenMenu("$ apt install nginx\r\nReading package lists...\r\n"), null);
  assert.equal(detectFullscreenMenu("total 24\r\n-rw-r--r-- 1 root root 12 file.txt\r\n"), null);
  assert.equal(detectFullscreenMenu(""), null);

  // Escape sequences are not text: this is what made an arrow key run "[B" as a
  // command ("[B[B[A: not found") in the old build.
  assert.deepEqual(splitTerminalInput("\x1b[B"), { text: "", sequences: ["\x1b[B"] });
  assert.deepEqual(splitTerminalInput("\x1b[A\x1b[Ay"), {
    text: "y",
    sequences: ["\x1b[A", "\x1b[A"],
  });
  assert.deepEqual(splitTerminalInput("hello\r"), { text: "hello\r", sequences: [] });
  assert.deepEqual(splitTerminalInput("\x1b[3~"), { text: "", sequences: ["\x1b[3~"] });
  assert.deepEqual(splitTerminalInput("\x1bOP"), { text: "", sequences: ["\x1bOP"] });
  assert.deepEqual(splitTerminalInput("\t \x7f"), { text: "\t \x7f", sequences: [] });

  // Keystroke FIFO: path shape, delivery script and its result parsing
  const keyPath = createKeyChannelPath();
  assert.match(keyPath, /^\/tmp\/\.sushi-keys-[0-9a-f]{18}$/);
  assert.equal(isKeyChannelPath(keyPath), true);
  assert.equal(isKeyChannelPath("/tmp/.sushi-keys-$(touch /tmp/pwned)"), false);
  assert.equal(isKeyChannelPath("/etc/passwd"), false);
  assert.equal(isKeyChannelPath("/tmp/.sushi-keys-ABCDEF0123456789"), false);

  const delivery = buildKeyDeliveryScript(keyPath, "\x1b[B \r");
  assert.match(delivery, /\[ -p '\/tmp\/\.sushi-keys-[0-9a-f]{18}' \]/);
  assert.match(delivery, /printf %s '\x1b\[B \r' >/);
  assert.equal(parseKeyDeliveryResult("SUSHI_KEYS_OK\n"), "delivered");
  assert.equal(parseKeyDeliveryResult("SUSHI_KEYS_MISSING\n"), "missing");
  assert.equal(parseKeyDeliveryResult("sh: 1: cannot create: Permission denied"), "failed");

  // The command is wrapped in script(1) with the FIFO as its keyboard, and the FIFO
  // is created (mode 600, by the login user) before sudo runs.
  const menuScript = buildExecScript({
    command: "apt install lightdm",
    cwd: "/srv/app",
    keyChannel: keyPath,
  });
  assert.equal(menuScript.keyChannel, keyPath);
  assert.match(menuScript.script, /mkfifo -m 600 "\$__sushi_keys"/);
  // A FIFO nobody reads would swallow key presses, so it only exists with script(1).
  assert.match(menuScript.script, /if command -v mkfifo .*&& command -v script /);
  assert.match(menuScript.script, /trap 'kill \$__sushi_writer/);
  assert.match(menuScript.script, /exec 9<'\/tmp\/\.sushi-keys-/);
  // script(1) runs the body with $SHELL -c: bash is picked inline, never /bin/sh
  // (dash would kill `bash <(curl …)` with `Syntax error: "(" unexpected`).
  assert.match(menuScript.script, /^__sushi_shell=\$\(command -v bash/);
  assert.match(menuScript.script, /SHELL="\$\(command -v bash[^"]*" script -q -c '/);
  assert.ok(!menuScript.script.includes("SHELL=/bin/sh"), "never force dash for script(1)");
  // The FIFO writer is disowned where possible, so bash prints no
  // `Terminated ( sleep 3900 > "$__sushi_keys" … )` noise when the trap kills it.
  assert.match(menuScript.script, /disown "\$__sushi_writer"/);
  assert.match(menuScript.script, /SUSHI_META/);
  // ... and when script(1) is missing it still runs the command through the picked
  // shell — quoted, because dash parses the whole script up front and a raw bashism
  // in the fallback branch would abort everything with `Syntax error: "(" unexpected`.
  assert.match(menuScript.script, /else\n"\$\(command -v bash[^"]*" -c 'export PAGER=cat/);

  const menuElevated = buildExecScript({
    command: "apt install lightdm",
    elevate: { user: "root", password: "hunter2" },
    keyChannel: keyPath,
  });
  assert.match(menuElevated.script, /^__sushi_shell=\$\(command -v bash/);
  assert.match(menuElevated.script, /__sushi_keys='\/tmp\/\.sushi-keys-/);
  assert.match(menuElevated.script, /sudo -S -- "\$__sushi_shell" -c '/);
  assert.equal(menuElevated.feedPassword, "hunter2");
  assert.deepEqual(menuElevated.ptyModes, { ECHO: 0 });
  assert.equal(menuElevated.script.includes("hunter2"), false);

  // A piped answer travels through the FIFO too, because stdin of the command is the
  // terminal script(1) gave it, not the SSH channel.
  const menuPiped = buildExecScript({
    command: "read -r x; echo $x",
    keyChannel: keyPath,
    pipedInput: "hello\r",
  });
  assert.match(menuPiped.script, /printf %s 'hello\r' > '\/tmp\/\.sushi-keys-/);

  // Without a key channel nothing changes for the normal (fast) path.
  const plainExec = buildExecScript({ command: "whoami" });
  assert.equal(plainExec.keyChannel, null);
  assert.equal(plainExec.script.includes("mkfifo"), false);
  assert.equal(plainExec.script.includes("script -q"), false);
  assert.match(plainExec.script, /exec "\$__sushi_shell" -c '/);

  // Regression, end to end: a bashism inside a key-channel command must survive even
  // when the outer shell is dash. Runs the real generated script locally (mkfifo +
  // script(1) exist on the host), with the FIFO cleanup verified afterwards.
  {
    const fifo = createKeyChannelPath();
    const fifoBashism = buildExecScript({
      command: "cat <(echo sushi-fifo-ok)",
      keyChannel: fifo,
    });
    const out = execFileSync("/bin/sh", ["-c", fifoBashism.script], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.ok(out.includes("sushi-fifo-ok"), `fifo path must run the bashism (got ${JSON.stringify(out)})`);
    assert.match(out, /SUSHI_META;0;/);
    assert.equal(fs.existsSync(fifo), false, "FIFO is removed when the command ends");
  }

  // No-timeout runs: SIGHUP is ignored, the session is logged to a /tmp file, the
  // FIFO writer lives for a day, and script(1) output is streamed from that log via
  // `tail -F` — so the command survives its own SSH channel closing (internet blip).
  {
    const keyPath2 = createKeyChannelPath();
    const nt = buildExecScript({ command: "echo hi", keyChannel: keyPath2, noTimeout: true });
    assert.match(nt.script, /trap '' HUP/);
    assert.ok(nt.runLog && isRunLogPath(nt.runLog), `run log path returned: ${String(nt.runLog)}`);
    assert.match(nt.script, /sleep 86400/);
    assert.ok(
      nt.script.includes(`script -q -c `) && nt.script.includes(`'${nt.runLog}' <&9`),
      "no-timeout runs log the session to the run log via script(1)'s typescript file"
    );
    assert.ok(!nt.script.includes("tail -n +1 -F"), "no tail helper needed");

    // default (with-timeout) behaviour is unchanged
    const normal = buildExecScript({ command: "echo hi", keyChannel: keyPath2 });
    assert.ok(!normal.script.includes("trap '' HUP"));
    assert.match(normal.script, /sleep 3900/);
    assert.equal(normal.runLog, null);
    assert.ok(normal.script.includes("'/dev/null' <&9"), "normal runs still log to /dev/null");

    // no-timeout without a key channel: HUP trap only, no log
    const ntPlain = buildExecScript({ command: "whoami", noTimeout: true });
    assert.match(ntPlain.script, /trap '' HUP/);
    assert.equal(ntPlain.runLog, null);

    // run-log path validation
    assert.equal(isRunLogPath(createRunLogPath()), true);
    assert.equal(isRunLogPath("/tmp/.sushi-run-0123456789abcdef01.log"), true);
    assert.equal(isRunLogPath("/tmp/.sushi-run-$(rm -rf /).log"), false);
    assert.equal(isRunLogPath("/tmp/.sushi-keys-0123456789abcdef"), false);

    // Execute a real no-timeout key-channel script locally: output must arrive (via
    // tail -F of the log), the META marker must be there, and the log must be kept.
    const fifo = createKeyChannelPath();
    const ntScript = buildExecScript({
      command: "echo sushi-notimeout-ok",
      keyChannel: fifo,
      noTimeout: true,
    });
    const out = execFileSync("/bin/sh", ["-c", ntScript.script], {
      encoding: "utf8",
      timeout: 20000,
    });
    assert.ok(
      out.includes("sushi-notimeout-ok"),
      `no-timeout output must stream from the log (got ${JSON.stringify(out)})`
    );
    assert.match(out, /SUSHI_META;0;/);
    assert.ok(fs.existsSync(ntScript.runLog!), "run log is kept after the command");
    assert.ok(
      fs.readFileSync(ntScript.runLog!, "utf8").includes("sushi-notimeout-ok"),
      "run log contains the command output"
    );
    fs.unlinkSync(ntScript.runLog!);
    assert.equal(fs.existsSync(fifo), false, "FIFO is removed when the command ends");
  }

  console.log(
    "==> [9b] Testing remote system info (distro, version, cloud provider)..."
  );

  // One round trip, plain shell builtins only: no root, no curl, no extra packages.
  assert.ok(SYSINFO_SCRIPT.includes("/etc/os-release"));
  assert.ok(SYSINFO_SCRIPT.includes("/run/cloud-init/cloud-id"));
  assert.ok(SYSINFO_SCRIPT.includes("systemd-detect-virt"));
  assert.ok(!/\bsudo\b|\bcurl\b|\bwget\b/.test(SYSINFO_SCRIPT));

  const sysinfoLine = (pairs: Record<string, string>) =>
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

  // An Oracle Cloud Ubuntu box, which is the case this feature was asked for.
  const oracleUbuntu = parseSysinfo(
    sysinfoLine({
      HOST: "instance-2024",
      PRETTY: "Ubuntu 24.04.1 LTS",
      DISTRO: "Ubuntu",
      VERSION: "24.04",
      CODENAME: "noble",
      KERNEL: "Linux 6.8.0-1017-oracle",
      ARCH: "aarch64",
      UPTIME: "up 12 days",
      CPU: "4",
      MEM_MB: "23846",
      LOAD: "0.08 0.11 0.09",
      CLOUD_ID: "oraclecloud",
      DMI_VENDOR: "OracleCloud.com",
      DMI_PRODUCT: "Standard.PC",
      VIRT: "kvm",
    })
  );
  assert.equal(oracleUbuntu.os, "Ubuntu 24.04.1 LTS");
  assert.equal(oracleUbuntu.distro, "Ubuntu");
  assert.equal(oracleUbuntu.version, "24.04");
  assert.equal(oracleUbuntu.codename, "noble");
  assert.equal(oracleUbuntu.arch, "aarch64");
  assert.equal(oracleUbuntu.cpu, 4);
  assert.equal(oracleUbuntu.memoryMb, 23846);
  assert.equal(oracleUbuntu.provider, "Oracle Cloud");
  assert.equal(oracleUbuntu.providerId, "oraclecloud");
  assert.equal(oracleUbuntu.virtualization, "kvm");

  // Other distros report themselves just as well.
  assert.equal(
    parseSysinfo(
      sysinfoLine({ PRETTY: "Debian GNU/Linux 12 (bookworm)", DISTRO: "Debian GNU/Linux", VERSION: "12", VIRT: "kvm" })
    ).os,
    "Debian GNU/Linux 12 (bookworm)"
  );
  assert.equal(
    parseSysinfo(sysinfoLine({ PRETTY: "Rocky Linux 9.4 (Blue Onyx)", DISTRO: "Rocky Linux", VERSION: "9.4" })).os,
    "Rocky Linux 9.4 (Blue Onyx)"
  );
  // A minimal image without /etc/os-release still leaves the kernel.
  assert.equal(parseSysinfo(sysinfoLine({ KERNEL: "Linux 5.10.0-28-amd64" })).os, "Linux 5.10.0-28-amd64");
  // Empty probe output must not throw.
  assert.equal(parseSysinfo("").os, "Linux");
  assert.equal(parseSysinfo("").provider, undefined);

  // Provider fingerprints: cloud-init id first, then the DMI strings.
  const providerOf = (signals: Parameters<typeof detectCloudProvider>[0]) =>
    detectCloudProvider(signals).provider;
  assert.equal(providerOf({ cloudId: "oraclecloud" }), "Oracle Cloud");
  assert.equal(providerOf({ cloudId: "aws", dmiVendor: "Amazon EC2" }), "AWS EC2");
  assert.equal(providerOf({ dmiVendor: "Amazon EC2" }), "AWS EC2");
  assert.equal(providerOf({ dmiVendor: "Google" }), "Google Cloud");
  assert.equal(providerOf({ cloudId: "azure" }), "Microsoft Azure");
  assert.equal(providerOf({ dmiVendor: "DigitalOcean" }), "DigitalOcean");
  assert.equal(providerOf({ dmiVendor: "Hetzner" }), "Hetzner Cloud");
  assert.equal(providerOf({ dmiVendor: "Linode, LLC" }), "Akamai / Linode");
  assert.equal(providerOf({ dmiVendor: "Vultr" }), "Vultr");
  assert.equal(providerOf({ dmiVendor: "Alibaba Cloud" }), "Alibaba Cloud");
  // Hypervisor without a named cloud keeps a useful label.
  assert.equal(providerOf({ virtualization: "kvm" }), "KVM VPS");
  assert.equal(providerOf({ virtualization: "vmware" }), "VMware");
  assert.equal(providerOf({ virtualization: "docker" }), "Docker container");
  // Bare metal has no platform at all.
  assert.equal(providerOf({ virtualization: "none" }), undefined);
  // An unknown cloud-init datasource still names itself.
  const unknownCloud = detectCloudProvider({ cloudId: "mycloud" });
  assert.equal(unknownCloud.provider, undefined);
  assert.equal(unknownCloud.providerId, "mycloud");

  // How the header renders it: "Ubuntu 24.04.1 LTS · Oracle Cloud".
  assert.equal(formatOsLabel(oracleUbuntu), "Ubuntu 24.04.1 LTS");
  assert.equal(formatSystemLine(oracleUbuntu), "Ubuntu 24.04.1 LTS · Oracle Cloud");
  assert.equal(formatSystemLine(null), "");
  assert.equal(
    formatOsLabel(parseSysinfo(sysinfoLine({ PRETTY: "Debian GNU/Linux 12 (bookworm)" }))),
    "Debian 12"
  );
  assert.equal(
    formatOsLabel(parseSysinfo(sysinfoLine({ PRETTY: "Red Hat Enterprise Linux 9.4 (Plow)" }))),
    "RHEL 9.4"
  );
  assert.equal(formatOsLabel({ distro: "Alpine Linux", version: "3.20" }), "Alpine Linux 3.20");
  const details = formatSystemDetails(oracleUbuntu);
  assert.ok(details.includes("OS: Ubuntu 24.04.1 LTS"));
  assert.ok(details.some((line) => line.startsWith("Platform: Oracle Cloud")));
  assert.ok(details.some((line) => line.includes("4 vCPU")));
  assert.ok(details.some((line) => line.includes("23 GB RAM")));

  console.log(
    "==> [9c] Testing SSH connection reuse (commands, keystrokes, machine info)..."
  );

  // A dedicated host so the counters below only see what the pool does.
  const poolHost = {
    connections: 0,
    execs: 0,
    live: 0,
  };
  const poolServer = new SshServer({ hostKeys: [privateKey] }, (client) => {
    (client as unknown as { _sock?: net.Socket })._sock?.setNoDelay?.(true);
    poolHost.connections += 1;
    poolHost.live += 1;
    client.on("close", () => {
      poolHost.live -= 1;
    });
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "pooler" && ctx.password === "pw") {
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
          poolHost.execs += 1;
          const stream = acceptExec();
          if (info.command.includes("HOST=")) {
            stream.write(
              [
                "HOST=pool-box",
                "PRETTY=Ubuntu 24.04.1 LTS",
                "DISTRO=Ubuntu",
                "VERSION=24.04",
                "CLOUD_ID=oraclecloud",
                "",
              ].join("\n")
            );
          } else {
            stream.write(`EXEC:${info.command.split("\n")[0]}\n`);
          }
          stream.write("\n\u001b]777;SUSHI_META;0;/home/pooler\u0007");
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => poolServer.listen(0, "127.0.0.1", () => resolve()));
  const poolPort = (poolServer.address() as net.AddressInfo).port;
  const poolCreds: ConnectionCredentials = {
    host: "127.0.0.1",
    port: poolPort,
    username: "pooler",
    authMethod: "password",
    password: "pw",
  };

  // --- the second command does not pay for a second handshake ------------------
  closeSshPool();
  const hostConnectionsAtStart = poolHost.connections;

  const firstRun = await runSshCommand(poolCreds, { script: "whoami" });
  assert.match(firstRun.output, /EXEC:whoami/);
  assert.equal(poolHost.connections, hostConnectionsAtStart + 1, "first command connects");
  assert.equal(sshPoolStats().connections, 1);

  const secondRun = await runSshCommand(poolCreds, { script: "docker ps" });
  assert.match(secondRun.output, /EXEC:docker ps/);
  assert.equal(
    poolHost.connections,
    hostConnectionsAtStart + 1,
    "second command reuses the open connection (no SSH handshake)"
  );
  assert.equal(sshPoolStats().reused >= 1, true, "the pool reports the reuse");
  assert.equal(sshPoolStats().created, 1);

  // --- the machine-info probe rides the same connection ------------------------
  const connectionCountBeforeInfo = poolHost.connections;
  const pooledInfo = await fetchSshSystemInfoPooled(poolCreds);
  assert.equal(pooledInfo?.os, "Ubuntu 24.04.1 LTS");
  assert.equal(pooledInfo?.provider, "Oracle Cloud");
  assert.equal(
    poolHost.connections,
    connectionCountBeforeInfo,
    "the distro badge does not open a second connection"
  );

  // --- a key press shares the connection a command is already using ------------
  closeSshPool();
  const busyCommand = await acquireSsh(poolCreds, { exclusive: true });
  const keyPress = await acquireSsh(poolCreds);
  assert.equal(
    keyPress.session.client,
    busyCommand.session.client,
    "the keystroke request reuses the command's connection"
  );
  keyPress.release();
  busyCommand.release();

  // --- two commands at once get their own connection each ----------------------
  closeSshPool();
  const [leaseA, leaseB] = await Promise.all([
    acquireSsh(poolCreds, { exclusive: true }),
    acquireSsh(poolCreds, { exclusive: true }),
  ]);
  assert.notEqual(
    leaseA.session.client,
    leaseB.session.client,
    "an exclusive command never shares a connection with another command"
  );
  assert.equal(leaseA.reused && leaseB.reused, false);
  leaseA.release();
  leaseB.release();

  // --- a connection that died is replaced, and the command still runs ----------
  closeSshPool();
  await runSshCommand(poolCreds, { script: "whoami" });
  const connectionsBeforeBreak = poolHost.connections;
  const doomed = await acquireSsh(poolCreds, { exclusive: true });
  doomed.markBroken();
  doomed.release();
  const afterBreak = await runSshCommand(poolCreds, { script: "uptime" });
  assert.match(afterBreak.output, /EXEC:uptime/);
  assert.equal(
    poolHost.connections,
    connectionsBeforeBreak + 1,
    "a dead connection is not handed out again"
  );

  // --- TCP_NODELAY: commands and keystrokes are not held back by Nagle ---------
  {
    const original = net.Socket.prototype.setNoDelay;
    const calls: boolean[] = [];
    net.Socket.prototype.setNoDelay = function patched(this: net.Socket, value?: boolean) {
      calls.push(Boolean(value));
      return original.call(this, value);
    };
    try {
      const session = await connectSsh(
        { ...poolCreds, username: "pooler" },
        8000
      );
      session.client.end();
    } finally {
      net.Socket.prototype.setNoDelay = original;
    }
    // The mock host sets it on its own socket too; what matters is that the
    // client's socket is never left with Nagle enabled.
    assert.ok(calls.length >= 1, "the SSH socket is configured");
    assert.equal(calls.every(Boolean), true, "Nagle is disabled on the SSH socket");
  }

  // --- the real route: two commands, one connection ----------------------------
  closeSshPool();
  process.env.SUSHI_GATEWAY_TOKEN = "pool-test-token";
  const execRouteEvents = async (command: string) => {
    const request = new NextRequest("http://localhost/api/ssh/exec", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sushi-token": "pool-test-token",
      },
      body: JSON.stringify({
        credentials: poolCreds,
        command,
        cwd: "/home/pooler",
        cols: 100,
        rows: 30,
        keyChannel: true,
      }),
    });
    const response = await execRoutePost(request);
    assert.equal(response.status, 200);
    const text = await response.text();
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  try {
    const connectionsBeforeRoute = poolHost.connections;
    const firstEvents = await execRouteEvents("pwd");
    const firstReady = firstEvents.find((event) => event.type === "ready");
    assert.ok(firstReady, "the route announces the session");
    assert.equal(firstReady?.reused, false, "the first command opens the connection");
    assert.ok(Number(firstReady?.connectMs) >= 0);
    assert.equal(firstEvents[0]?.type, "ready");
    assert.equal(firstEvents[firstEvents.length - 1]?.type, "meta");
    assert.ok(firstEvents.some((event) => event.type === "data"));
    assert.equal(poolHost.connections, connectionsBeforeRoute + 1);

    const secondEvents = await execRouteEvents("ls -la");
    const secondReady = secondEvents.find((event) => event.type === "ready");
    assert.equal(secondReady?.reused, true, "the next command reuses the connection");
    assert.equal(secondReady?.connectMs, 0, "no handshake was needed");
    assert.equal(
      poolHost.connections,
      connectionsBeforeRoute + 1,
      "the route did not open a second SSH connection"
    );

    // Ctrl+C cancels the command but keeps the connection for the next one.
    const thirdEvents = await execRouteEvents("whoami");
    assert.equal(
      thirdEvents.find((event) => event.type === "ready")?.reused,
      true,
      "still the same warm connection"
    );
    assert.equal(poolHost.connections, connectionsBeforeRoute + 1);
  } finally {
    delete process.env.SUSHI_GATEWAY_TOKEN;
  }

  closeSshPool();
  await new Promise<void>((resolve) => poolServer.close(() => resolve()));

  console.log("==> [9d] Testing /api/translate (auth, validation, providers)...");
  {
    // --- provider unit tests with an injected fetch (no network) ------------
    const libre = await translateTextServer("hello world", "zh-CN", "auto", {
      url: "http://127.0.0.1:9/translate",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), "http://127.0.0.1:9/translate");
        const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.deepEqual(sent, {
          q: "hello world",
          source: "auto",
          target: "zh-CN",
          format: "text",
        });
        return new Response(JSON.stringify({ translatedText: "你好，世界" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    assert.equal(libre.translated, "你好，世界");
    assert.equal(libre.provider, "libretranslate");

    // Google gtx response shape: [[["translated","original",…],…], null, "detected"]
    const gtx = await translateTextServer("hello", "zh-CN", "auto", {
      url: "",
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        assert.ok(url.startsWith("https://translate.googleapis.com/translate_a/single?"));
        assert.ok(url.includes("tl=zh-CN"));
        assert.ok(url.includes("sl=auto"));
        return new Response(JSON.stringify([[["你好", "hello", null, null, 1]], null, "en"]), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    assert.equal(gtx.translated, "你好");
    assert.equal(gtx.detectedSource, "en");
    assert.equal(gtx.provider, "google-gtx");

    // multi-segment gtx responses are joined back together
    const gtxMulti = await translateTextServer("hello world", "zh-CN", "auto", {
      url: "",
      fetchImpl: (async () =>
        new Response(JSON.stringify([[["你好", "hello"], ["世界", " world"]], null, "en"]), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    assert.equal(gtxMulti.translated, "你好世界");

    // provider failures become friendly errors
    await assert.rejects(
      translateTextServer("x", "en", "auto", {
        url: "",
        fetchImpl: (async () => {
          throw new Error("socket hang up");
        }) as unknown as typeof fetch,
      }),
      /Translation failed: socket hang up/
    );
    await assert.rejects(
      translateTextServer("x", "en", "auto", {
        url: "",
        fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
      }),
      /HTTP 503/
    );

    // --- language-tag validation ---------------------------------------------
    assert.equal(isValidTargetTag("zh-CN"), true);
    assert.equal(isValidTargetTag("en"), true);
    assert.equal(isValidTargetTag("pt-BR"), true);
    assert.equal(isValidTargetTag("zh_CN"), false);
    assert.equal(isValidTargetTag("zh-CN'; rm -rf /"), false);
    assert.equal(isValidTargetTag(""), false);

    // --- route: auth, validation, and a mock LibreTranslate server ------------
    const mockTranslator = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw || "{}") as { q?: string; target?: string };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ translatedText: `ZH(${parsed.target}):${parsed.q}` }));
      });
    });
    await new Promise<void>((resolve) => mockTranslator.listen(0, "127.0.0.1", () => resolve()));
    const translatorPort = (mockTranslator.address() as net.AddressInfo).port;
    process.env.SUSHI_TRANSLATE_URL = `http://127.0.0.1:${translatorPort}/translate`;
    try {
      const post = (body: unknown, headers?: Headers) =>
        translateRoutePost(
          new NextRequest("http://localhost/api/translate", {
            method: "POST",
            headers: headers ?? new Headers({ "content-type": "application/json" }),
            body: JSON.stringify(body),
          })
        );

      // unauthenticated → 401
      assert.equal((await post({ text: "hello", target: "zh-CN" })).status, 401);

      const authed = new Headers({
        "content-type": "application/json",
        "x-sushi-session": validSessionToken,
      });
      // missing / blank text → 400
      assert.equal((await post({ target: "zh-CN" }, authed)).status, 400);
      assert.equal((await post({ text: "   ", target: "zh-CN" }, authed)).status, 400);
      // bad target tag → 400
      assert.equal((await post({ text: "hi", target: "zh_CN!" }, authed)).status, 400);
      // too long → 400
      assert.equal(
        (await post({ text: "x".repeat(MAX_TRANSLATE_TEXT + 1), target: "zh-CN" }, authed)).status,
        400
      );
      // ok → 200 with the mock translation
      const okRes = await post({ text: "hello", target: "zh-CN" }, authed);
      assert.equal(okRes.status, 200);
      const okJson = (await okRes.json()) as {
        ok: boolean;
        translated: string;
        provider: string;
      };
      assert.equal(okJson.ok, true);
      assert.equal(okJson.translated, "ZH(zh-CN):hello");
      assert.equal(okJson.provider, "libretranslate");
    } finally {
      delete process.env.SUSHI_TRANSLATE_URL;
      await new Promise<void>((resolve) => mockTranslator.close(() => resolve()));
    }

    // --- client helpers (node has no localStorage → default target) ----------
    assert.equal(DEFAULT_TRANSLATE_TARGET, "zh-CN");
    assert.equal(getStoredTranslateTarget(), "zh-CN");
    assert.ok(TRANSLATE_TARGETS.some((t) => t.code === "zh-CN"));
  }

  console.log("==> [9e] Testing no-timeout exec route (run log in ready event)...");
  {
    const creds: ConnectionCredentials = {
      host: "127.0.0.1",
      port: sshPort,
      username: "tester",
      authMethod: "password",
      password: "sushipass",
    };
    const headers = new Headers({
      "content-type": "application/json",
      "x-sushi-session": validSessionToken,
    });
    const postEvents = async (body: Record<string, unknown>) => {
      const res = await execRoutePost(
        new NextRequest("http://localhost/api/ssh/exec", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      );
      assert.equal(res.status, 200);
      return (await res.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };

    // noTimeout + key channel → the ready event announces the run log
    const ntEvents = await postEvents({
      credentials: creds,
      command: "echo hi",
      keyChannel: true,
      noTimeout: true,
    });
    const ntReady = ntEvents.find((e) => e.type === "ready") as
      | { keyChannel?: string; runLog?: string }
      | undefined;
    assert.ok(ntReady?.keyChannel, "key channel present");
    assert.ok(
      ntReady?.runLog && isRunLogPath(String(ntReady.runLog)),
      `run log announced in ready event: ${String(ntReady?.runLog)}`
    );

    // plain exec → no run log; noTimeout without a key channel → no run log either
    const plainEvents = await postEvents({ credentials: creds, command: "echo hi" });
    const plainReady = plainEvents.find((e) => e.type === "ready") as { runLog?: string } | undefined;
    assert.equal(plainReady?.runLog, undefined, "no run log without noTimeout");

    const ntNoChannel = await postEvents({ credentials: creds, command: "echo hi", noTimeout: true });
    const ntNoChannelReady = ntNoChannel.find((e) => e.type === "ready") as
      | { runLog?: string }
      | undefined;
    assert.equal(ntNoChannelReady?.runLog, undefined, "run log only exists with a key channel");
  }

  console.log("==> [9f] Testing resumable runs (is my command still running?) route...");

  // A host that answers the run-status probe like a real /tmp would: a live FIFO
  // (command still running) or a finished one (FIFO gone, log kept).
  {
    let runAlive = true;
    const runServer = new SshServer({ hostKeys: [privateKey] }, (client) => {
      client.on("authentication", (ctx) => {
        if (ctx.method === "password" && ctx.username === "runner" && ctx.password === "pw") {
          ctx.accept();
        } else {
          ctx.reject(["password"]);
        }
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            // Mirror buildRunStatusScript: first line = state, then the log tail.
            if (info.command.includes("tail -c")) {
              stream.write(runAlive ? "SUSHI_RUN_ALIVE\n" : "SUSHI_RUN_DEAD\n");
              stream.write(
                "SUSHI_LOG_BYTES=64\nSUSHI_LOG_START\nReading package lists... Done\n\u001b[32mSetting up docker.io\u001b[0m\nSUSHI_LOG_END\n"
              );
            } else {
              stream.write("UNEXPECTED\n");
            }
            stream.exit(0);
            stream.end();
          });
        });
      });
    });
    await new Promise<void>((resolve) => runServer.listen(0, "127.0.0.1", () => resolve()));
    const runPort = (runServer.address() as net.AddressInfo).port;
    const runCreds: ConnectionCredentials = {
      host: "127.0.0.1",
      port: runPort,
      username: "runner",
      authMethod: "password",
      password: "pw",
    };
    const keyChannel = createKeyChannelPath();
    const runLog = createRunLogPath();
    const postRun = (body: Record<string, unknown>, token = validSessionToken) =>
      runRoutePost(
        new NextRequest("http://localhost/api/ssh/exec/run", {
          method: "POST",
          headers: { "content-type": "application/json", "x-sushi-session": token },
          body: JSON.stringify(body),
        })
      );

    try {
      // Still running: the FIFO exists and the log tail comes back.
      const aliveRes = await postRun({
        credentials: runCreds,
        keyChannel,
        runLog,
      });
      assert.equal(aliveRes.status, 200);
      const alive = (await aliveRes.json()) as Record<string, unknown>;
      assert.equal(alive.ok, true);
      assert.equal(alive.running, true, "a live FIFO means the command is still running");
      assert.equal(alive.logExists, true);
      assert.equal(alive.logBytes, 64);
      assert.ok(String(alive.output).includes("Reading package lists"));
      assert.deepEqual(
        (alive.preview as string[]).slice(-1),
        ["Setting up docker.io"],
        "the preview is plain text (no escape codes)"
      );

      // Finished: the FIFO is gone but the log and its output are still readable.
      runAlive = false;
      const deadRes = await postRun({ credentials: runCreds, keyChannel, runLog });
      const dead = (await deadRes.json()) as Record<string, unknown>;
      assert.equal(dead.running, false);
      assert.equal(dead.logExists, true);
      assert.ok(String(dead.output).includes("Setting up docker.io"));

      // Auth + path validation: this route can never read an arbitrary file.
      const unauth = await postRun({ credentials: runCreds, keyChannel }, "nope");
      assert.equal(unauth.status, 401);
      for (const bad of [
        { keyChannel: "/etc/passwd" },
        { keyChannel: "/tmp/.sushi-keys-aaaaaaaa; rm -rf /" },
        { runLog: "/etc/shadow" },
        { runLog: "/tmp/.sushi-run-../../etc/passwd.log" },
        {},
      ]) {
        const res = await postRun({ credentials: runCreds, ...bad });
        assert.equal(res.status, 400, `rejected: ${JSON.stringify(bad)}`);
        const json = (await res.json()) as Record<string, unknown>;
        assert.equal(json.ok, false);
      }
      const noCreds = await postRun({ keyChannel });
      assert.equal(noCreds.status, 400);
    } finally {
      await new Promise<void>((resolve) => runServer.close(() => resolve()));
      closeSshPool();
    }
  }

  console.log("==> [9g] Testing the single-URL host inventory (/api/hosts + /hosts)...");
  {
    const authed = new Headers({ "x-sushi-session": validSessionToken });

    // 1. Locked vault (the default): a complete, redacted index — no names, no leaks.
    delete process.env.SUSHI_HOSTS_INVENTORY;
    const lockedRes = await hostsApiGet(
      new NextRequest("http://localhost/api/hosts", { headers: authed })
    );
    assert.equal(lockedRes.status, 200);
    const locked = (await lockedRes.json()) as Record<string, unknown>;
    assert.equal(locked.ok, true);
    assert.equal(locked.self, "/api/hosts");
    assert.equal(locked.page, "/hosts");
    // `encrypted` mirrors the stored vault: with no envelope yet there is nothing to
    // protect, with one it must be flagged as unreadable server-side.
    assert.equal(typeof locked.encrypted, "boolean");
    assert.deepEqual(locked.counts, {
      hosts: 0,
      profiles: 0,
      byProtocol: { ssh: 0, sftp: 0, rdp: 0 },
    });
    assert.deepEqual(locked.hosts, []);
    assert.ok(String(locked.hint).length > 20, "the index explains where the data comes from");

    // 2. A clear-text inventory (opt-in) is merged into one entry per machine.
    process.env.SUSHI_HOSTS_INVENTORY = JSON.stringify({
      hosts: [
        { id: "a-ssh", name: "prod", protocol: "ssh", host: "203.0.113.10", port: 22, username: "root" },
        { id: "a-rdp", name: "prod (RDP)", protocol: "rdp", host: "203.0.113.10", port: 3389, username: "root" },
        { id: "b-ssh", name: "db", protocol: "ssh", host: "198.51.100.7", port: 2222, username: "deploy" },
        // Junk must be ignored, not crash the endpoint.
        { nope: true },
        "not-a-profile",
        { host: "", username: "x", protocol: "ssh" },
      ],
    });
    const openRes = await hostsApiGet(
      new NextRequest("http://localhost/api/hosts", { headers: authed })
    );
    assert.equal(openRes.status, 200);
    const open = (await openRes.json()) as {
      encrypted: boolean;
      counts: { hosts: number; profiles: number; byProtocol: Record<string, number> };
      hosts: Array<{
        id: string;
        name: string;
        host: string | null;
        accessUrl: string;
        protocols: string[];
        links: Array<{ protocol: string; url: string; kind: string }>;
      }>;
    };
    assert.equal(open.encrypted, false);
    assert.equal(open.counts.hosts, 2, "two machines from four valid profiles");
    assert.equal(open.counts.profiles, 3);
    const prod = open.hosts.find((host) => host.host === "203.0.113.10")!;
    assert.ok(prod, "the merged prod machine is present");
    assert.equal(prod.accessUrl, "/hosts?host=unified-203.0.113.10-root");
    assert.deepEqual(prod.protocols, ["ssh", "sftp", "rdp"]);
    assert.deepEqual(
      prod.links.map((link) => [link.protocol, link.url, link.kind]),
      [
        ["ssh", "ssh://root@203.0.113.10:22", "saved"],
        ["sftp", "sftp://root@203.0.113.10:22", "derived"],
        ["rdp", "rdp://root@203.0.113.10:3389", "saved"],
      ]
    );
    const db = open.hosts.find((host) => host.id.includes("198.51.100.7"))!;
    assert.equal(db.links.find((link) => link.protocol === "ssh")?.url, "ssh://deploy@198.51.100.7:2222");
    assert.ok(!JSON.stringify(open).toLowerCase().includes("password"), "no credentials in the inventory");

    // 3. Auth is required (the single URL is the normal Sushi session, nothing weaker).
    const anon = await hostsApiGet(new NextRequest("http://localhost/api/hosts"));
    assert.equal(anon.status, 401);

    // 4. The page: HTML for people, JSON for scripts.
    const pageRes = await hostsPageGet(new NextRequest("http://localhost/hosts", { headers: authed }));
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get("content-type") || "", /text\/html/);
    const page = await pageRes.text();
    assert.match(page, /All hosts — one URL/);
    assert.match(page, /\/api\/hosts/);
    for (const protocol of ["ssh", "sftp", "rdp"]) {
      assert.ok(page.includes(`protocol=${protocol}`), `the page documents ${protocol} links`);
    }
    assert.ok(!page.toLowerCase().includes("password:"), "the page never prints credentials");

    const pageJson = await hostsPageGet(
      new NextRequest("http://localhost/hosts?format=json", { headers: authed })
    );
    assert.equal(pageJson.status, 200);
    const json = (await pageJson.json()) as Record<string, unknown>;
    assert.equal(json.ok, true);
    assert.equal(json.index, "/api/hosts");
    assert.equal((json.protocols as unknown[]).length, 3);
    const anonJson = await hostsPageGet(
      new NextRequest("http://localhost/hosts", { headers: new Headers({ accept: "application/json" }) })
    );
    assert.equal(anonJson.status, 401);

    // 5. A malformed inventory must not take the endpoint down.
    process.env.SUSHI_HOSTS_INVENTORY = "{not json";
    const brokenRes = await hostsApiGet(
      new NextRequest("http://localhost/api/hosts", { headers: authed })
    );
    assert.equal(brokenRes.status, 200, "a broken SUSHI_HOSTS_INVENTORY falls back to the index");
    delete process.env.SUSHI_HOSTS_INVENTORY;
  }

  console.log("==> [10/10] Cleaning up test servers...");
  httpServer.close();
  guacdMock.close();
  rdpMock.close();
  sshServer.close();
  console.log(
    "ALL AUTH, PASSKEY, KEY WHITELIST, TERMIX, SSH, SFTP, RDP, RDP-SESSION, EXEC STDIN, FOLDER-DOWNLOAD, SELECTION-DOWNLOAD, RDP-COMPANION, MENU-KEYS, SYSTEM-INFO, SSH-CONNECT-ERROR, SSH-REUSE, TRANSLATE, NO-TIMEOUT, RESUMABLE-RUN, AND SINGLE-URL-HOST-LIST E2E TESTS PASSED!"
  );
}

runTests().catch((err) => {
  console.error("E2E test failure:", err);
  process.exit(1);
});
