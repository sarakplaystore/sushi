import assert from "node:assert/strict";
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
  buildExecScript,
  createSudoAnswerer,
} from "../src/lib/server/exec-script";
import {
  detectInteractiveProgram,
  parseElevationCommand,
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
  }

  // Serverless exec script: plain, sudo without a password, and sudo with one
  {
    const plain = buildExecScript({ command: "whoami", cwd: "/srv/app" });
    assert.equal(plain.feedPassword, null);
    assert.equal(plain.ptyModes, null);
    assert.match(plain.script, /cd -- '\/srv\/app'/);
    assert.match(plain.script, /whoami\n__sushi_ec=\$\?/);
    assert.match(plain.script, /SUSHI_META/);

    const nopass = buildExecScript({ command: "whoami", elevate: { user: "root" } });
    assert.equal(nopass.feedPassword, null);
    assert.equal(nopass.ptyModes, null);
    assert.match(nopass.script, /^sudo -n -- \/bin\/sh -c '/);
    assert.equal(nopass.script.includes("SushiPass"), false);

    const withPass = buildExecScript({
      command: "whoami",
      elevate: { user: "root", password: "hunter2" },
    });
    assert.equal(withPass.feedPassword, "hunter2");
    assert.deepEqual(withPass.ptyModes, { ECHO: 0 }); // password never echoed
    assert.match(withPass.script, /^sudo -S -- \/bin\/sh -c '/);
    assert.equal(withPass.script.includes("hunter2"), false, "password is not part of the script");

    const otherUser = buildExecScript({ command: "id", elevate: { user: "www-data" } });
    assert.match(otherUser.script, /^sudo -n -u 'www-data' -- \/bin\/sh -c '/);

    // Quoting: the sudo shell receives exactly the wrapper body we built (round-trip
    // through a real POSIX shell instead of eyeballing the escapes).
    const tricky = "echo \"it's $HOME `pwd`\" && printf '%s\\n' 'x y'";
    const bodyScript = buildExecScript({ command: tricky, cwd: "/srv/app" }).script;
    const elevatedScript = buildExecScript({
      command: tricky,
      cwd: "/srv/app",
      elevate: { user: "root" },
    }).script;
    const quotedArg = elevatedScript.slice(elevatedScript.indexOf("/bin/sh -c ") + "/bin/sh -c ".length);
    const roundTripped = execFileSync("sh", ["-c", `printf %s ${quotedArg}`], { encoding: "utf8" });
    assert.equal(roundTripped, bodyScript);
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
    "==> [8/9] Testing serverless exec stdin (live keystrokes + piped answers)..."
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

  console.log("==> [9/9] Cleaning up test servers...");
  httpServer.close();
  guacdMock.close();
  rdpMock.close();
  sshServer.close();
  console.log(
    "ALL AUTH, PASSKEY, KEY WHITELIST, TERMIX, SSH, SFTP, RDP, EXEC STDIN, FOLDER-DOWNLOAD, AND SELECTION-DOWNLOAD E2E TESTS PASSED!"
  );
}

runTests().catch((err) => {
  console.error("E2E test failure:", err);
  process.exit(1);
});
