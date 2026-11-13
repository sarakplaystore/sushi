import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { NextRequest } from "next/server";

import {
  buildRDCleanPathError,
  buildRDCleanPathRequest,
  buildRDCleanPathResponse,
  encodeRdpStreamFrame,
  parseRDCleanPathRequest,
  parseRDCleanPathResponse,
  parseRdpDestination,
  RDCLEANPATH_VERSION_1,
  RdpFrameDecoder,
} from "../src/lib/server/rdcleanpath";
import { buildRdpParams } from "../src/lib/server/rdp-params";
import { createGatewayWebSockets } from "../src/lib/server/ws-gateway";
import { GET as getRdpWasm } from "../src/app/api/rdp/wasm/route";
import { POST as postRdpStream } from "../src/app/api/rdp/stream/route";
import { POST as postRdpInput } from "../src/app/api/rdp/input/route";
import { GET as getCapabilities } from "../src/app/api/system/capabilities/route";
import {
  buildServerlessRdpProxyUrl,
  installServerlessRdpWebSocketShim,
} from "../src/lib/client/rdp-serverless-ws";
import {
  clampEvenDesktopSize,
  describeIronRdpError,
  formatRdpDestination,
  KEYSYM_TO_SCANCODE,
} from "../src/lib/client/ironrdp-engine";
import { __setStreamingRequestBodySupport } from "../src/lib/client/exec-stdin";
import { resolvePersistedTabProfile } from "../src/lib/client/crypto-vault";
import type { HostProfile } from "../src/types/connection";

function generateSelfSignedCert(): { keyPem: string; certPem: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sushi-rdp-cert-"));
  const keyPath = path.join(tmpDir, "key.pem");
  const certPath = path.join(tmpDir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "2",
        "-nodes",
        "-subj",
        "/CN=sushi-rdp-test.local",
      ],
      { stdio: "ignore" }
    );
    return {
      keyPem: fs.readFileSync(keyPath, "utf8"),
      certPem: fs.readFileSync(certPath, "utf8"),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function installMinimalDomForIronRdp(): HTMLCanvasElement {
  const g = globalThis as Record<string, unknown>;

  class MockCanvasRenderingContext2D {
    putImageData() {}
  }
  class MockImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  class MockWindow extends EventTarget {
    readonly performance = globalThis.performance;
    readonly navigator = globalThis.navigator ?? { userAgent: "node" };
  }
  if (typeof g.CloseEvent !== "function") {
    class MockCloseEvent extends Event {
      code: number;
      reason: string;
      wasClean: boolean;
      constructor(
        type: string,
        init?: { code?: number; reason?: string; wasClean?: boolean }
      ) {
        super(type);
        this.code = init?.code ?? 1000;
        this.reason = init?.reason ?? "";
        this.wasClean = init?.wasClean ?? true;
      }
    }
    g.CloseEvent = MockCloseEvent;
  }

  g.CanvasRenderingContext2D = MockCanvasRenderingContext2D;
  g.ImageData = MockImageData;
  g.Window = MockWindow;
  g.window = new MockWindow();
  const storageMap = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  const ctx = new MockCanvasRenderingContext2D();
  const canvas = {
    width: 1280,
    height: 720,
    style: { cursor: "default", width: "", height: "" },
    getContext: (kind: string) => (kind === "2d" ? ctx : null),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  } as unknown as HTMLCanvasElement;
  return canvas;
}

function buildX224Confirm(selectedProto: number, isFailure = false): Buffer {
  // 19-byte TPKT + X.224 CC + RDP_NEG_RSP / RDP_NEG_FAILURE
  const buf = Buffer.alloc(19);
  buf[0] = 0x03; // TPKT v3
  buf[1] = 0x00;
  buf.writeUInt16BE(19, 2);
  buf[4] = 14; // X.224 LI
  buf[5] = 0xd0; // X.224 Connection Confirm
  buf.writeUInt16BE(0x0000, 6);
  buf.writeUInt16BE(0x1234, 8);
  buf[10] = 0x00;
  buf[11] = isFailure ? 0x03 : 0x02; // TYPE_RDP_NEG_FAILURE or TYPE_RDP_NEG_RSP
  buf[12] = 0x00;
  buf.writeUInt16LE(8, 13);
  buf.writeUInt32LE(selectedProto, 15);
  return buf;
}

interface MockTlsRdpServer {
  port: number;
  receivedTlsPayloads: Buffer[];
  waitForNextTlsPayload: (timeoutMs?: number) => Promise<Buffer>;
  close: () => Promise<void>;
}

async function startMockTlsRdpServer(options: {
  keyPem: string;
  certPem: string;
  negotiationFailureCode?: number;
  splitTpktResponse?: boolean;
}): Promise<MockTlsRdpServer> {
  const receivedTlsPayloads: Buffer[] = [];
  let payloadWaiters: Array<(buf: Buffer) => void> = [];
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((tcpSock) => {
    openSockets.add(tcpSock);
    tcpSock.on("close", () => openSockets.delete(tcpSock));
    tcpSock.setNoDelay(true);

    let x224Buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      x224Buf = Buffer.concat([x224Buf, chunk]);
      if (x224Buf.length < 4) return;
      const tpktLen = x224Buf.readUInt16BE(2);
      if (x224Buf.length < tpktLen) return;
      tcpSock.removeListener("data", onData);

      // Parse requestedProtocols from RDP_NEG_REQ at the end of X.224 CR (after Cookie: mstshash=...\r\n)
      let reqProto = 0x01; // PROTOCOL_SSL
      if (tpktLen >= 19 && x224Buf[tpktLen - 8] === 0x01) {
        reqProto = x224Buf.readUInt32LE(tpktLen - 4);
      }

      if (options.negotiationFailureCode !== undefined) {
        const failPdu = buildX224Confirm(options.negotiationFailureCode, true);
        tcpSock.write(failPdu, () => tcpSock.end());
        return;
      }

      // Select Hybrid (NLA) if requested, else SSL (TLS)
      const selectedProto = reqProto & 0x02 ? 0x02 : 0x01;
      const confirmPdu = buildX224Confirm(selectedProto, false);

      const startTls = () => {
        const tlsSock = new tls.TLSSocket(tcpSock, {
          isServer: true,
          key: options.keyPem,
          cert: options.certPem,
        });
        openSockets.add(tlsSock);
        tlsSock.on("close", () => openSockets.delete(tlsSock));

        tlsSock.on("data", (plainChunk: Buffer) => {
          const copy = Buffer.from(plainChunk);
          receivedTlsPayloads.push(copy);
          const waiters = payloadWaiters;
          payloadWaiters = [];
          for (const w of waiters) w(copy);
          // Close cleanly after capturing the initial MCS / CredSSP PDU so builder.connect() settles fast
          setTimeout(() => {
            if (!tlsSock.destroyed) tlsSock.end();
          }, 30);
        });
        tlsSock.on("error", () => {});
      };

      if (options.splitTpktResponse) {
        // Deliberately split the 19-byte TPKT across 2 TCP writes to test framing!
        tcpSock.write(confirmPdu.subarray(0, 7));
        setTimeout(() => {
          tcpSock.write(confirmPdu.subarray(7), startTls);
        }, 15);
      } else {
        tcpSock.write(confirmPdu, startTls);
      }
    };

    tcpSock.on("data", onData);
    tcpSock.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    receivedTlsPayloads,
    waitForNextTlsPayload(timeoutMs = 6000) {
      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for decrypted TLS payload from IronRDP WASM")),
          timeoutMs
        );
        payloadWaiters.push((buf) => {
          clearTimeout(timer);
          resolve(buf);
        });
      });
    },
    async close() {
      for (const s of openSockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  console.log("==> [1/6] Testing RDCleanPath ASN.1 DER codec, frame splitter & RDP helpers...");

  const sampleX224 = Buffer.from("030000130ee000000000000100080003000000", "hex");
  const encodedReq = buildRDCleanPathRequest({
    destination: "10.20.30.40:3389",
    proxyAuth: "jwt-token",
    x224ConnectionRequest: sampleX224,
  });
  const parsedReq = parseRDCleanPathRequest(encodedReq);
  assert.equal(parsedReq.version, RDCLEANPATH_VERSION_1);
  assert.equal(parsedReq.destination, "10.20.30.40:3389");
  assert.equal(parsedReq.proxyAuth, "jwt-token");
  assert.deepEqual(parsedReq.x224ConnectionRequest, sampleX224);

  const fakeCert = Buffer.alloc(350, 0xab);
  const encodedResp = buildRDCleanPathResponse({
    serverAddr: "10.20.30.40:3389",
    x224Response: buildX224Confirm(0x02),
    certChain: [fakeCert],
  });
  const parsedResp = parseRDCleanPathResponse(encodedResp);
  assert.equal(parsedResp.version, RDCLEANPATH_VERSION_1);
  assert.equal(parsedResp.serverAddr, "10.20.30.40:3389");
  assert.equal(parsedResp.certChain?.length, 1);
  assert.deepEqual(parsedResp.certChain?.[0], fakeCert);

  const encodedErr = buildRDCleanPathError({
    errorCode: 1,
    httpStatusCode: 502,
    wsaErrorCode: 10061,
  });
  const parsedErr = parseRDCleanPathResponse(encodedErr);
  assert.deepEqual(parsedErr.error, {
    errorCode: 1,
    httpStatusCode: 502,
    wsaErrorCode: 10061,
  });

  // Destination IPv4 / hostname / IPv6 parsing
  assert.deepEqual(parseRdpDestination("win.example.com:3390"), {
    host: "win.example.com",
    port: 3390,
  });
  assert.deepEqual(parseRdpDestination("[2001:db8::42]:3389"), {
    host: "2001:db8::42",
    port: 3389,
  });
  assert.equal(formatRdpDestination("2001:db8::42", 3389), "[2001:db8::42]:3389");
  assert.deepEqual(clampEvenDesktopSize(1365, 769), { width: 1364, height: 768 });
  assert.equal(KEYSYM_TO_SCANCODE[0xffff], 0xe053);

  // Frame decoder handles arbitrary 1-byte and coalesced chunk boundaries
  const decoder = new RdpFrameDecoder();
  const f1 = Buffer.from("hello-ironrdp");
  const f2 = Buffer.alloc(0); // heartbeat frame
  const f3 = crypto.getRandomValues(new Uint8Array(1024));
  const streamBytes = Buffer.concat([
    encodeRdpStreamFrame(f1),
    encodeRdpStreamFrame(f2),
    encodeRdpStreamFrame(f3),
  ]);
  const reassembled: Buffer[] = [];
  for (let i = 0; i < streamBytes.length; i += 7) {
    reassembled.push(...decoder.push(streamBytes.subarray(i, i + 7)));
  }
  assert.equal(reassembled.length, 3);
  assert.deepEqual(reassembled[0], f1);
  assert.equal(reassembled[1].length, 0);
  assert.deepEqual(reassembled[2], Buffer.from(f3));

  // Verify guacd drive-path fix + path traversal sanitization
  const driveParams = buildRdpParams({
    host: "win.example.com",
    port: 3389,
    username: "../Admin\\User",
    password: "pw",
  });
  assert.equal(driveParams["enable-drive"], "true");
  assert.equal(driveParams["create-drive-path"], "true");
  assert.match(driveParams["drive-path"] ?? "", /^\/tmp\/sushi-drive\/win\.example\.com-/);
  assert.ok(!driveParams["drive-path"]!.includes(".."));

  // Verify companion RDP tab credential recovery & saved-RDP upgrade
  const sshSource: HostProfile = {
    id: "ssh-1",
    name: "Prod Box",
    protocol: "ssh",
    host: "203.0.113.55",
    port: 22,
    username: "ubuntu",
    authMethod: "password",
    password: "ubuntu-desktop-pass",
    createdAt: 1,
    updatedAt: 1,
  };
  const persistedCompanion = {
    id: "tab-rdp-1",
    title: "Prod Box (RDP)",
    protocol: "rdp" as const,
    profile: {
      ...sshSource,
      id: "rdp-companion-ssh-1",
      protocol: "rdp" as const,
      port: 3389,
      password: undefined,
    },
    hostId: null,
    createdAt: 10,
    updatedAt: 10,
  };
  const recoveredCompanion = resolvePersistedTabProfile(
    persistedCompanion,
    [sshSource],
    [],
    false
  );
  assert.equal(recoveredCompanion?.password, "ubuntu-desktop-pass");

  const savedRdpHost: HostProfile = {
    ...sshSource,
    id: "rdp-saved-1",
    name: "Prod Box (Windows)",
    protocol: "rdp",
    port: 3389,
    username: "Administrator",
    password: "win-admin-secret",
  };
  const upgradedCompanion = resolvePersistedTabProfile(
    persistedCompanion,
    [sshSource, savedRdpHost],
    [],
    false
  );
  assert.equal(upgradedCompanion?.id, "rdp-saved-1");
  assert.equal(upgradedCompanion?.username, "Administrator");
  assert.equal(upgradedCompanion?.password, "win-admin-secret");

  console.log("==> [2/6] Verifying /api/rdp/wasm & /api/system/capabilities...");

  const wasmRes = await getRdpWasm(new NextRequest("http://localhost/api/rdp/wasm"));
  assert.equal(wasmRes.status, 200);
  assert.equal(wasmRes.headers.get("content-type"), "application/wasm");
  const wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
  assert.ok(wasmBytes.byteLength > 1_000_000, "IronRDP WASM binary served (>1 MB)");
  // WebAssembly magic header: \0asm
  assert.deepEqual(Array.from(wasmBytes.subarray(0, 4)), [0x00, 0x61, 0x73, 0x6d]);

  const capsRes = await getCapabilities(
    new NextRequest("http://localhost/api/system/capabilities")
  );
  const capsJson = (await capsRes.json()) as { rdpCleanPath?: boolean };
  assert.equal(capsJson.rdpCleanPath, true);

  console.log("==> [3/6] Initializing REAL IronRDP WebAssembly engine in Node 22...");

  const canvas = installMinimalDomForIronRdp();
  const ironMod = await import("ironrdp-wasm");
  ironMod.initSync({ module: wasmBytes });
  const { SessionBuilder, DesktopSize, Extension } = ironMod;

  process.env.SUSHI_GATEWAY_TOKEN = "rdp-e2e-gateway-secret";
  process.env.BLOCK_PRIVATE_NETWORKS = "false";

  const { keyPem, certPem } = generateSelfSignedCert();
  const rdpServer = await startMockTlsRdpServer({
    keyPem,
    certPem,
    splitTpktResponse: true,
  });

  // Start HTTP + WebSocket server exposing BOTH /ws/rdp-cleanpath AND /api/rdp/stream + /api/rdp/input
  const wsDispatcher = createGatewayWebSockets();
  const httpServer = http.createServer(async (req, res) => {
    try {
      const reqUrl = `http://127.0.0.1:${httpPort}${req.url || "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }

      if (req.url?.startsWith("/api/rdp/stream")) {
        const bodyStream = new ReadableStream<Uint8Array>({
          start(controller) {
            req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            req.on("end", () => {
              try {
                controller.close();
              } catch {}
            });
            req.on("error", (err) => {
              try {
                controller.error(err);
              } catch {}
            });
          },
        });
        const nextReq = new NextRequest(reqUrl, {
          method: req.method || "POST",
          headers,
          body: bodyStream,
          duplex: "half",
        });
        const nextRes = await postRdpStream(nextReq);
        res.writeHead(nextRes.status, Object.fromEntries(nextRes.headers.entries()));
        res.flushHeaders();
        if (nextRes.body) {
          const reader = nextRes.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) res.write(Buffer.from(value));
          }
        }
        res.end();
        return;
      }

      if (req.url?.startsWith("/api/rdp/input")) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const nextReq = new NextRequest(reqUrl, {
          method: "POST",
          headers,
          body: new Uint8Array(Buffer.concat(chunks)),
        });
        const nextRes = await postRdpInput(nextReq);
        res.writeHead(nextRes.status, Object.fromEntries(nextRes.headers.entries()));
        res.end(Buffer.from(await nextRes.arrayBuffer()));
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : "Server error");
    }
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (wsDispatcher.canHandle(pathname)) {
      wsDispatcher.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const httpPort = (httpServer.address() as net.AddressInfo).port;

  const configureCommonBuilder = (
    builder: import("ironrdp-wasm").SessionBuilder,
    w = 1280,
    h = 720
  ) => {
    builder.authToken("none");
    builder.desktopSize(new DesktopSize(w, h));
    builder.renderCanvas(canvas);
    builder.setCursorStyleCallbackContext(canvas);
    builder.setCursorStyleCallback(() => {});
  };

  try {
    console.log(
      "==> [4/6] Testing REAL IronRDP WASM over /ws/rdp-cleanpath (CredSSP/NLA + TLS MCS)..."
    );

    // 4a. CredSSP / NLA mode (`enable_credssp: true`) -> IronRDP validates certChain[0] & sends TSRequest NTLMSSP_NEGOTIATE!
    {
      const nextTlsData = rdpServer.waitForNextTlsPayload();
      const builder = new SessionBuilder();
      builder.username("Administrator");
      builder.password("SuperSecret123!");
      builder.serverDomain("CORP");
      builder.destination(`127.0.0.1:${rdpServer.port}`);
      builder.proxyAddress(
        `ws://127.0.0.1:${httpPort}/ws/rdp-cleanpath?token=rdp-e2e-gateway-secret&ignoreCert=1`
      );
      configureCommonBuilder(builder, 1280, 720);
      builder.extension(new Extension("enable_credssp", true));

      // Server closes TLS right after capturing IronRDP's CredSSP TSRequest, so connect() rejects after handshake
      const connectPromise = builder.connect().catch((e) => e);
      const tlsPayload = await nextTlsData;
      await connectPromise;

      // CredSSP TSRequest starts with ASN.1 SEQUENCE (0x30) and contains "NTLMSSP\0"
      assert.equal(tlsPayload[0], 0x30, "CredSSP TSRequest is ASN.1 DER SEQUENCE");
      assert.ok(
        tlsPayload.includes(Buffer.from("NTLMSSP\0", "ascii")),
        "Real IronRDP WASM transmitted NTLMSSP_NEGOTIATE inside TLS over /ws/rdp-cleanpath!"
      );
    }

    // 4b. Pure TLS RDP mode (`enable_credssp: false`) -> IronRDP sends TPKT + X.224 + MCS Connect-Initial (0x7f 0x65)!
    {
      const nextTlsData = rdpServer.waitForNextTlsPayload();
      const builder = new SessionBuilder();
      builder.username("xrdpuser");
      builder.password("linuxpass");
      builder.destination(`127.0.0.1:${rdpServer.port}`);
      builder.proxyAddress(
        `ws://127.0.0.1:${httpPort}/ws/rdp-cleanpath?token=rdp-e2e-gateway-secret&ignoreCert=1`
      );
      configureCommonBuilder(builder, 1024, 768);
      builder.extension(new Extension("enable_credssp", false));

      const connectPromise = builder.connect().catch((e) => e);
      const tlsPayload = await nextTlsData;
      await connectPromise;

      assert.equal(tlsPayload[0], 0x03, "MCS Connect-Initial wrapped in TPKT v3");
      assert.ok(
        tlsPayload.includes(Buffer.from([0x7f, 0x65])),
        "Real IronRDP WASM transmitted T.125 MCS Connect-Initial (BER 0x7f65) inside TLS!"
      );
    }

    console.log(
      "==> [5/6] Testing REAL IronRDP WASM over Vercel Serverless HTTP Transport (Duplex AND Safari Split-Stream)..."
    );

    installServerlessRdpWebSocketShim();

    // 5a. Full-Duplex HTTP Streaming mode (`POST /api/rdp/stream` with `duplex: "half"`)
    {
      __setStreamingRequestBodySupport(true);
      const nextTlsData = rdpServer.waitForNextTlsPayload();
      const proxyUrl = buildServerlessRdpProxyUrl({
        httpBase: `http://127.0.0.1:${httpPort}`,
        gatewaySettings: {
          gatewayUrl: `http://127.0.0.1:${httpPort}`,
          gatewayToken: "rdp-e2e-gateway-secret",
        },
        ignoreCert: true,
      });

      const builder = new SessionBuilder();
      builder.username("Administrator");
      builder.password("VercelDuplexPass!");
      builder.destination(`127.0.0.1:${rdpServer.port}`);
      builder.proxyAddress(proxyUrl);
      configureCommonBuilder(builder, 1280, 720);
      builder.extension(new Extension("enable_credssp", true));

      const connectPromise = builder.connect().catch((e) => e);
      const tlsPayload = await nextTlsData;
      await connectPromise;

      assert.ok(
        tlsPayload.includes(Buffer.from("NTLMSSP\0", "ascii")),
        "Real IronRDP WASM transmitted CredSSP NTLMSSP over single-request Serverless Duplex HTTP!"
      );
    }

    // 5b. Safari / Firefox Split-Stream HTTP mode (`POST /api/rdp/stream` JSON + `POST /api/rdp/input`)
    {
      __setStreamingRequestBodySupport(false);
      const nextTlsData = rdpServer.waitForNextTlsPayload();
      const proxyUrl = buildServerlessRdpProxyUrl({
        httpBase: `http://127.0.0.1:${httpPort}`,
        gatewaySettings: {
          gatewayUrl: `http://127.0.0.1:${httpPort}`,
          gatewayToken: "rdp-e2e-gateway-secret",
        },
        ignoreCert: true,
        forceSplitStream: true,
      });

      const builder = new SessionBuilder();
      builder.username("safari-user");
      builder.password("SafariSplitPass!");
      builder.destination(`127.0.0.1:${rdpServer.port}`);
      builder.proxyAddress(proxyUrl);
      configureCommonBuilder(builder, 1280, 720);
      builder.extension(new Extension("enable_credssp", true));

      const connectPromise = builder.connect().catch((e) => e);
      const tlsPayload = await nextTlsData;
      await connectPromise;

      assert.ok(
        tlsPayload.includes(Buffer.from("NTLMSSP\0", "ascii")),
        "Real IronRDP WASM transmitted CredSSP NTLMSSP over Safari/Firefox Split-Stream HTTP (/api/rdp/stream + /api/rdp/input)!"
      );
      __setStreamingRequestBodySupport(null);
    }

    console.log(
      "==> [6/6] Testing Auth Rejection, Metadata SSRF Block, ECONNREFUSED & NegotiationFailure Diagnostics..."
    );

    // 6a. Wrong gateway token -> HTTP 401 non-retryable diagnosis
    {
      const unauthRes = await postRdpStream(
        new NextRequest(`http://127.0.0.1:${httpPort}/api/rdp/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sushi-Token": "wrong-token",
          },
          body: JSON.stringify({
            sessionId: "rdpsess_1234567890abcdef",
            firstFrame: encodedReq.toString("base64"),
          }),
        })
      );
      assert.equal(unauthRes.status, 401);
    }

    // 6b. Cloud metadata SSRF (`169.254.169.254:3389`) blocked with RDCleanPath HTTP 403 / WSA 10013
    {
      const proxyUrl = buildServerlessRdpProxyUrl({
        httpBase: `http://127.0.0.1:${httpPort}`,
        gatewaySettings: {
          gatewayUrl: `http://127.0.0.1:${httpPort}`,
          gatewayToken: "rdp-e2e-gateway-secret",
        },
        forceSplitStream: true,
      });
      const builder = new SessionBuilder();
      builder.username("admin");
      builder.password("pw");
      builder.destination("169.254.169.254:3389");
      builder.proxyAddress(proxyUrl);
      configureCommonBuilder(builder, 800, 600);
      builder.extension(new Extension("enable_credssp", true));

      let caught: unknown = null;
      try {
        await builder.connect();
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "Metadata SSRF connection rejected");
      const diag = describeIronRdpError(caught);
      assert.equal(diag.retryable, false);
      assert.match(diag.title, /blocked/i);
    }

    // 6c. Closed port (`ECONNREFUSED`) -> WSA 10061 diagnosis
    {
      // Reserve and close an ephemeral port to guarantee ECONNREFUSED
      const closedSocketServer = net.createServer();
      await new Promise<void>((r) => closedSocketServer.listen(0, "127.0.0.1", () => r()));
      const deadPort = (closedSocketServer.address() as net.AddressInfo).port;
      await new Promise<void>((r) => closedSocketServer.close(() => r()));

      const builder = new SessionBuilder();
      builder.username("admin");
      builder.password("pw");
      builder.destination(`127.0.0.1:${deadPort}`);
      builder.proxyAddress(
        `ws://127.0.0.1:${httpPort}/ws/rdp-cleanpath?token=rdp-e2e-gateway-secret`
      );
      configureCommonBuilder(builder, 800, 600);
      builder.extension(new Extension("enable_credssp", true));

      let caught: unknown = null;
      try {
        await builder.connect();
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "Closed port connection rejected");
      const diag = describeIronRdpError(caught);
      assert.equal(diag.codeLabel, "ECONNREFUSED");
      assert.equal(diag.retryable, true);
    }

    // 6d. RDP server returning TYPE_RDP_NEG_FAILURE (`HYBRID_REQUIRED_BY_SERVER = 0x05`)
    {
      const nlaOnlyServer = await startMockTlsRdpServer({
        keyPem,
        certPem,
        negotiationFailureCode: 0x05, // HYBRID_REQUIRED_BY_SERVER
      });
      try {
        const builder = new SessionBuilder();
        builder.username("admin");
        builder.password("pw");
        builder.destination(`127.0.0.1:${nlaOnlyServer.port}`);
        builder.proxyAddress(
          `ws://127.0.0.1:${httpPort}/ws/rdp-cleanpath?token=rdp-e2e-gateway-secret`
        );
        configureCommonBuilder(builder, 800, 600);
        builder.extension(new Extension("enable_credssp", false));

        let caught: unknown = null;
        try {
          await builder.connect();
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, "Negotiation failure surfaced cleanly without TLS hang");
        const diag = describeIronRdpError(caught);
        assert.equal(diag.retryable, false);
        assert.equal(diag.codeLabel, "NegotiationFailure");
        assert.match(diag.detail, /NLA/i);
      } finally {
        await nlaOnlyServer.close();
      }
    }
  } finally {
    await rdpServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  console.log(
    "LIVE IRONRDP WASM + RDCLEANPATH (WEBSOCKET + SERVERLESS DUPLEX + SAFARI SPLIT-STREAM) E2E TESTS PASSED!"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
