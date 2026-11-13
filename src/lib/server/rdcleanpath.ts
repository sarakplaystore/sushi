import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { WebSocket } from "ws";
import { validateTargetHost } from "./security";

export const RDCLEANPATH_VERSION_1 = 3390; // 3389 + 1

const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8STRING = 0x0c;
const TAG_CTX = (n: number) => 0xa0 + n;

const TYPE_RDP_NEG_RSP = 0x02;
const TYPE_RDP_NEG_FAILURE = 0x03;

export const MAX_RDP_FRAME_BYTES = 16 * 1024 * 1024;

export interface RDCleanPathRequest {
  version: number;
  destination: string;
  proxyAuth?: string;
  serverAuth?: string;
  preconnectionBlob?: string;
  x224ConnectionRequest: Buffer;
}

export interface RDCleanPathErrorDetails {
  errorCode: number;
  httpStatusCode?: number;
  wsaErrorCode?: number;
  tlsAlertCode?: number;
}

export interface ParsedRDCleanPathResponse {
  version: number;
  error?: RDCleanPathErrorDetails;
  x224Response?: Buffer;
  certChain?: Buffer[];
  serverAddr?: string;
}

export class RDCleanPathHandshakeError extends Error {
  readonly details: RDCleanPathErrorDetails;

  constructor(message: string, details: RDCleanPathErrorDetails) {
    super(message);
    this.name = "RDCleanPathHandshakeError";
    this.details = details;
  }
}

/* -------------------------------------------------------------------------- */
/* ASN.1 DER Codec                                                            */
/* -------------------------------------------------------------------------- */

function derEncodeLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp = Math.floor(temp / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag: number, content: Buffer): Buffer {
  const len = derEncodeLength(content.length);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function derEncodeInteger(value: number): Buffer {
  const intVal = Math.trunc(value);
  if (intVal === 0) {
    return derWrap(TAG_INTEGER, Buffer.from([0]));
  }
  if (intVal < 0) {
    throw new Error(`Negative DER integer not supported: ${intVal}`);
  }
  const bytes: number[] = [];
  let temp = intVal;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp = Math.floor(temp / 256);
  }
  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }
  return derWrap(TAG_INTEGER, Buffer.from(bytes));
}

function derEncodeUtf8String(str: string): Buffer {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, "utf8"));
}

function derEncodeOctetString(buf: Buffer): Buffer {
  return derWrap(TAG_OCTET_STRING, buf);
}

function derWrapContext(tagNum: number, content: Buffer): Buffer {
  return derWrap(TAG_CTX(tagNum), content);
}

function derDecodeLength(
  buf: Buffer,
  offset: number
): { length: number; bytesRead: number } {
  if (offset >= buf.length) {
    throw new Error("Truncated ASN.1 DER length");
  }
  const first = buf[offset];
  if (first < 0x80) {
    return { length: first, bytesRead: 1 };
  }
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4 || offset + 1 + numBytes > buf.length) {
    throw new Error("Invalid or unsupported ASN.1 DER length encoding");
  }
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = length * 256 + buf[offset + 1 + i];
  }
  return { length, bytesRead: 1 + numBytes };
}

function derDecodeTLV(
  buf: Buffer,
  offset: number
): { tag: number; value: Buffer; totalLength: number } {
  if (offset >= buf.length) {
    throw new Error("Truncated ASN.1 DER TLV");
  }
  const tag = buf[offset];
  const { length, bytesRead } = derDecodeLength(buf, offset + 1);
  const headerLen = 1 + bytesRead;
  if (offset + headerLen + length > buf.length) {
    throw new Error("ASN.1 DER value exceeds buffer length");
  }
  const value = buf.subarray(offset + headerLen, offset + headerLen + length);
  return { tag, value, totalLength: headerLen + length };
}

function derDecodeInteger(buf: Buffer): number {
  if (buf.length === 0 || buf.length > 6) {
    throw new Error("Invalid ASN.1 DER INTEGER length");
  }
  let val = 0;
  for (let i = 0; i < buf.length; i++) {
    val = val * 256 + buf[i];
  }
  return val;
}

function derDecodeChildren(
  buf: Buffer
): Array<{ tag: number; value: Buffer; totalLength: number }> {
  const children: Array<{ tag: number; value: Buffer; totalLength: number }> = [];
  let offset = 0;
  while (offset < buf.length) {
    const tlv = derDecodeTLV(buf, offset);
    if (tlv.totalLength <= 0) {
      throw new Error("Zero-length ASN.1 DER element");
    }
    children.push(tlv);
    offset += tlv.totalLength;
  }
  return children;
}

export function parseRDCleanPathRequest(data: Uint8Array | Buffer): RDCleanPathRequest {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const outer = derDecodeTLV(buf, 0);
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected RDCleanPath SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`);
  }

  const children = derDecodeChildren(outer.value);
  let version: number | null = null;
  let destination: string | null = null;
  let proxyAuth: string | undefined;
  let serverAuth: string | undefined;
  let preconnectionBlob: string | undefined;
  let x224ConnectionRequest: Buffer | null = null;

  for (const child of children) {
    if ((child.tag & 0xe0) !== 0xa0) continue;
    const ctxTag = child.tag & 0x1f;
    switch (ctxTag) {
      case 0: {
        const intTlv = derDecodeTLV(child.value, 0);
        version = derDecodeInteger(intTlv.value);
        break;
      }
      case 2: {
        const strTlv = derDecodeTLV(child.value, 0);
        destination = strTlv.value.toString("utf8");
        break;
      }
      case 3: {
        const strTlv = derDecodeTLV(child.value, 0);
        proxyAuth = strTlv.value.toString("utf8");
        break;
      }
      case 4: {
        const strTlv = derDecodeTLV(child.value, 0);
        serverAuth = strTlv.value.toString("utf8");
        break;
      }
      case 5: {
        const strTlv = derDecodeTLV(child.value, 0);
        preconnectionBlob = strTlv.value.toString("utf8");
        break;
      }
      case 6: {
        const octTlv = derDecodeTLV(child.value, 0);
        x224ConnectionRequest = Buffer.from(octTlv.value);
        break;
      }
    }
  }

  if (version !== RDCLEANPATH_VERSION_1) {
    throw new Error(
      `Unsupported RDCleanPath version: ${String(version)} (expected ${RDCLEANPATH_VERSION_1})`
    );
  }
  if (!destination) {
    throw new Error("Missing destination in RDCleanPath request");
  }
  if (!x224ConnectionRequest || x224ConnectionRequest.length === 0) {
    throw new Error("Missing x224_connection_pdu in RDCleanPath request");
  }

  return {
    version,
    destination,
    proxyAuth,
    serverAuth,
    preconnectionBlob,
    x224ConnectionRequest,
  };
}

export function buildRDCleanPathRequest(params: {
  destination: string;
  x224ConnectionRequest: Buffer;
  proxyAuth?: string;
  preconnectionBlob?: string;
}): Buffer {
  const parts: Buffer[] = [
    derWrapContext(0, derEncodeInteger(RDCLEANPATH_VERSION_1)),
    derWrapContext(2, derEncodeUtf8String(params.destination)),
  ];
  if (params.proxyAuth !== undefined) {
    parts.push(derWrapContext(3, derEncodeUtf8String(params.proxyAuth)));
  }
  if (params.preconnectionBlob !== undefined) {
    parts.push(derWrapContext(5, derEncodeUtf8String(params.preconnectionBlob)));
  }
  parts.push(derWrapContext(6, derEncodeOctetString(params.x224ConnectionRequest)));
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

export function buildRDCleanPathResponse(params: {
  serverAddr: string;
  x224Response: Buffer;
  certChain: Buffer[];
}): Buffer {
  const certOctets = params.certChain.map((cert) => derEncodeOctetString(cert));
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certOctets));

  const parts: Buffer[] = [
    derWrapContext(0, derEncodeInteger(RDCLEANPATH_VERSION_1)),
    derWrapContext(6, derEncodeOctetString(params.x224Response)),
    derWrapContext(7, certSeq),
    derWrapContext(9, derEncodeUtf8String(params.serverAddr)),
  ];

  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

export function buildRDCleanPathError(details: RDCleanPathErrorDetails): Buffer {
  const errParts: Buffer[] = [
    derWrapContext(0, derEncodeInteger(details.errorCode)),
  ];
  if (details.httpStatusCode !== undefined) {
    errParts.push(derWrapContext(1, derEncodeInteger(details.httpStatusCode)));
  }
  if (details.wsaErrorCode !== undefined) {
    errParts.push(derWrapContext(2, derEncodeInteger(details.wsaErrorCode)));
  }
  if (details.tlsAlertCode !== undefined) {
    errParts.push(derWrapContext(3, derEncodeInteger(details.tlsAlertCode)));
  }
  const errSeq = derWrap(TAG_SEQUENCE, Buffer.concat(errParts));

  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      derWrapContext(0, derEncodeInteger(RDCLEANPATH_VERSION_1)),
      derWrapContext(1, errSeq),
    ])
  );
}

export function parseRDCleanPathResponse(
  data: Uint8Array | Buffer
): ParsedRDCleanPathResponse {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const outer = derDecodeTLV(buf, 0);
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected RDCleanPath SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`);
  }

  const children = derDecodeChildren(outer.value);
  let version = 0;
  let error: RDCleanPathErrorDetails | undefined;
  let x224Response: Buffer | undefined;
  let certChain: Buffer[] | undefined;
  let serverAddr: string | undefined;

  for (const child of children) {
    if ((child.tag & 0xe0) !== 0xa0) continue;
    const ctxTag = child.tag & 0x1f;
    switch (ctxTag) {
      case 0:
        version = derDecodeInteger(derDecodeTLV(child.value, 0).value);
        break;
      case 1: {
        const errSeq = derDecodeTLV(child.value, 0);
        const errChildren = derDecodeChildren(errSeq.value);
        const details: RDCleanPathErrorDetails = { errorCode: 1 };
        for (const ec of errChildren) {
          const ecTag = ec.tag & 0x1f;
          const val = derDecodeInteger(derDecodeTLV(ec.value, 0).value);
          if (ecTag === 0) details.errorCode = val;
          else if (ecTag === 1) details.httpStatusCode = val;
          else if (ecTag === 2) details.wsaErrorCode = val;
          else if (ecTag === 3) details.tlsAlertCode = val;
        }
        error = details;
        break;
      }
      case 6:
        x224Response = Buffer.from(derDecodeTLV(child.value, 0).value);
        break;
      case 7: {
        const seq = derDecodeTLV(child.value, 0);
        certChain = derDecodeChildren(seq.value).map((c) => Buffer.from(c.value));
        break;
      }
      case 9:
        serverAddr = derDecodeTLV(child.value, 0).value.toString("utf8");
        break;
    }
  }

  return { version, error, x224Response, certChain, serverAddr };
}

/* -------------------------------------------------------------------------- */
/* Destination Parsing & Error Mapping                                        */
/* -------------------------------------------------------------------------- */

export function parseRdpDestination(destination: string): {
  host: string;
  port: number;
} {
  const trimmed = destination.trim();
  if (!trimmed) {
    throw new Error("Empty RDP destination");
  }

  if (trimmed.startsWith("[")) {
    const bracketEnd = trimmed.indexOf("]");
    if (bracketEnd === -1) {
      throw new Error(`Invalid IPv6 RDP destination: ${destination}`);
    }
    const host = trimmed.slice(1, bracketEnd);
    const rest = trimmed.slice(bracketEnd + 1);
    const port = rest.startsWith(":") ? Number.parseInt(rest.slice(1), 10) : 3389;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid RDP port in destination: ${destination}`);
    }
    return { host, port };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: trimmed, port: 3389 };
  }
  const host = trimmed.slice(0, lastColon);
  const port = Number.parseInt(trimmed.slice(lastColon + 1), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid RDP destination: ${destination}`);
  }
  return { host, port };
}

export function mapErrorToRDCleanPathDetails(err: unknown): RDCleanPathErrorDetails {
  if (err instanceof RDCleanPathHandshakeError) {
    return err.details;
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code || "";
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("blocked") || msg.includes("BLOCK_PRIVATE_NETWORKS")) {
    return { errorCode: 1, httpStatusCode: 403, wsaErrorCode: 10013 };
  }
  if (code === "ECONNREFUSED" || msg.includes("ECONNREFUSED")) {
    return { errorCode: 1, httpStatusCode: 502, wsaErrorCode: 10061 };
  }
  if (code === "ETIMEDOUT" || msg.includes("timed out") || msg.includes("ETIMEDOUT")) {
    return { errorCode: 1, httpStatusCode: 504, wsaErrorCode: 10060 };
  }
  if (code === "EHOSTUNREACH" || msg.includes("EHOSTUNREACH")) {
    return { errorCode: 1, httpStatusCode: 502, wsaErrorCode: 10065 };
  }
  if (code === "ENETUNREACH" || code === "ENOTFOUND" || msg.includes("ENOTFOUND")) {
    return { errorCode: 1, httpStatusCode: 502, wsaErrorCode: 10051 };
  }
  if (
    msg.includes("certificate") ||
    msg.includes("CERT_") ||
    msg.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") ||
    msg.includes("DEPTH_ZERO_SELF_SIGNED_CERT")
  ) {
    return { errorCode: 1, httpStatusCode: 502, tlsAlertCode: 48 };
  }
  if (msg.includes("TLS") || msg.includes("SSL")) {
    return { errorCode: 1, httpStatusCode: 502, tlsAlertCode: 40 };
  }
  return { errorCode: 1, httpStatusCode: 502 };
}

/* -------------------------------------------------------------------------- */
/* TCP + X.224 + TLS Handshake                                                */
/* -------------------------------------------------------------------------- */

function extractCertChain(peerCert: tls.DetailedPeerCertificate): Buffer[] {
  const certs: Buffer[] = [];
  if (!peerCert || !peerCert.raw) return certs;

  const seen = new Set<string>();
  let current: tls.DetailedPeerCertificate | undefined = peerCert;
  while (current && current.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString("hex");
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    certs.push(Buffer.from(current.raw));
    if (current.issuerCertificate && current.issuerCertificate !== current) {
      current = current.issuerCertificate;
    } else {
      break;
    }
  }
  return certs;
}

export interface RDCleanPathHandshakeResult {
  host: string;
  port: number;
  serverAddr: string;
  x224Response: Buffer;
  certChain: Buffer[];
  tlsSocket: tls.TLSSocket | null;
}

export async function performRDCleanPathHandshake(
  destination: string,
  x224Request: Buffer,
  options: { ignoreCert?: boolean; timeoutMs?: number } = {}
): Promise<RDCleanPathHandshakeResult> {
  const { host, port } = parseRdpDestination(destination);
  await validateTargetHost(host, port);

  const ignoreCert = options.ignoreCert !== false;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const serverAddr = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;

  return new Promise<RDCleanPathHandshakeResult>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const tcpSocket = net.createConnection({ host, port });
    tcpSocket.setNoDelay(true);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      tcpSocket.destroy();
      reject(
        new RDCleanPathHandshakeError(
          `Timed out connecting to RDP server ${serverAddr} after ${timeoutMs}ms`,
          { errorCode: 1, httpStatusCode: 504, wsaErrorCode: 10060 }
        )
      );
    }, timeoutMs);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tcpSocket.destroy();
      reject(err);
    };

    tcpSocket.once("connect", () => {
      tcpSocket.write(x224Request, (writeErr) => {
        if (writeErr) {
          fail(writeErr);
        }
      });
    });

    tcpSocket.once("error", (err) => {
      fail(err);
    });

    const onTcpCloseBeforeUpgrade = () => {
      fail(new Error(`RDP server ${serverAddr} closed connection before X.224 confirm`));
    };
    tcpSocket.once("close", onTcpCloseBeforeUpgrade);

    const onTcpData = (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes < 4) return;

      const combined = Buffer.concat(chunks, totalBytes);
      if (combined[0] !== 0x03) {
        fail(
          new RDCleanPathHandshakeError(
            `Unexpected non-TPKT response byte 0x${combined[0].toString(16)} from ${serverAddr}`,
            { errorCode: 2, httpStatusCode: 502 }
          )
        );
        return;
      }

      const tpktLen = combined.readUInt16BE(2);
      if (tpktLen < 7 || tpktLen > 8192) {
        fail(
          new RDCleanPathHandshakeError(
            `Invalid X.224 TPKT length ${tpktLen} from ${serverAddr}`,
            { errorCode: 2, httpStatusCode: 502 }
          )
        );
        return;
      }
      if (combined.length < tpktLen) return;

      tcpSocket.removeListener("data", onTcpData);
      tcpSocket.removeListener("close", onTcpCloseBeforeUpgrade);
      tcpSocket.removeAllListeners("error");

      const x224Response = Buffer.from(combined.subarray(0, tpktLen));
      const remainder = combined.subarray(tpktLen);
      if (remainder.length > 0) {
        tcpSocket.unshift(remainder);
      }

      // Inspect X.224 Connection Confirm negotiation result before upgrading to TLS.
      if (x224Response.length >= 19) {
        const negType = x224Response[11];
        if (negType === TYPE_RDP_NEG_FAILURE) {
          settled = true;
          clearTimeout(timer);
          tcpSocket.destroy();
          resolve({
            host,
            port,
            serverAddr,
            x224Response,
            certChain: [],
            tlsSocket: null,
          });
          return;
        }
        if (negType === TYPE_RDP_NEG_RSP) {
          const selectedProto = x224Response.readUInt32LE(15);
          if (selectedProto === 0) {
            fail(
              new RDCleanPathHandshakeError(
                `RDP server ${serverAddr} selected legacy unencrypted Standard RDP (no TLS/NLA). Enable TLS or CredSSP (NLA) on the remote desktop server.`,
                { errorCode: 2, httpStatusCode: 502 }
              )
            );
            return;
          }
        }
      } else {
        // No RDP_NEG_RSP extension -> server only speaks legacy Standard RDP without TLS.
        fail(
          new RDCleanPathHandshakeError(
            `RDP server ${serverAddr} did not negotiate TLS or CredSSP/NLA.`,
            { errorCode: 2, httpStatusCode: 502 }
          )
        );
        return;
      }

      const tlsSocket = tls.connect(
        {
          socket: tcpSocket,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: !ignoreCert,
        },
        () => {
          if (settled) {
            tlsSocket.destroy();
            return;
          }
          settled = true;
          clearTimeout(timer);
          tcpSocket.setKeepAlive(true, 15_000);
          const peerCert = tlsSocket.getPeerCertificate(true);
          const certChain = extractCertChain(peerCert);
          resolve({
            host,
            port,
            serverAddr,
            x224Response,
            certChain,
            tlsSocket,
          });
        }
      );

      tlsSocket.once("error", (tlsErr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tlsSocket.destroy();
        reject(tlsErr);
      });
    };

    tcpSocket.on("data", onTcpData);
  });
}

/* -------------------------------------------------------------------------- */
/* WebSocket Handler (/ws/rdp-cleanpath)                                      */
/* -------------------------------------------------------------------------- */

export function handleRDCleanPathWebSocket(
  ws: WebSocket,
  options: { ignoreCert?: boolean } = {}
): void {
  let activeTls: tls.TLSSocket | null = null;
  let closed = false;
  const earlyFrames: Buffer[] = [];
  let handshakeDone = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (activeTls && !activeTls.destroyed) {
      activeTls.destroy();
    }
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };

  let firstMessageSeen = false;
  ws.on("message", async (rawData) => {
    const buf = Buffer.isBuffer(rawData)
      ? rawData
      : Array.isArray(rawData)
        ? Buffer.concat(rawData)
        : Buffer.from(rawData as ArrayBuffer);

    if (!firstMessageSeen) {
      firstMessageSeen = true;
      try {
        const req = parseRDCleanPathRequest(buf);
        const hs = await performRDCleanPathHandshake(
          req.destination,
          req.x224ConnectionRequest,
          { ignoreCert: options.ignoreCert }
        );
        if (closed) {
          hs.tlsSocket?.destroy();
          return;
        }

        const responsePdu = buildRDCleanPathResponse({
          serverAddr: hs.serverAddr,
          x224Response: hs.x224Response,
          certChain: hs.certChain,
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(responsePdu);
        }

        if (!hs.tlsSocket) {
          // Server returned TYPE_RDP_NEG_FAILURE; let client read the response PDU then close.
          setTimeout(cleanup, 100);
          return;
        }

        activeTls = hs.tlsSocket;
        handshakeDone = true;

        activeTls.on("data", (chunk: Buffer) => {
          if (ws.readyState === ws.OPEN) {
            try {
              ws.send(chunk);
            } catch {
              cleanup();
            }
          }
        });
        activeTls.on("end", cleanup);
        activeTls.on("close", cleanup);
        activeTls.on("error", cleanup);

        while (earlyFrames.length > 0) {
          const queued = earlyFrames.shift()!;
          if (!activeTls.destroyed) {
            activeTls.write(queued);
          }
        }
      } catch (err) {
        try {
          if (ws.readyState === ws.OPEN) {
            ws.send(buildRDCleanPathError(mapErrorToRDCleanPathDetails(err)));
          }
        } catch {
          // ignore
        }
        setTimeout(cleanup, 50);
      }
      return;
    }

    if (!handshakeDone || !activeTls) {
      earlyFrames.push(buf);
      return;
    }
    if (!activeTls.destroyed) {
      activeTls.write(buf);
    }
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

/* -------------------------------------------------------------------------- */
/* Binary Frame Stream Codec (Serverless HTTP Transport)                      */
/* -------------------------------------------------------------------------- */

export function encodeRdpStreamFrame(payload: Uint8Array): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)]);
}

export class RdpFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.byteLength === 0) return [];
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.buffer =
      this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);

    const frames: Buffer[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const frameLen = this.buffer.readUInt32BE(offset);
      if (frameLen > MAX_RDP_FRAME_BYTES) {
        throw new Error(`RDP stream frame exceeds safety limit (${frameLen} bytes)`);
      }
      if (this.buffer.length - offset < 4 + frameLen) {
        break;
      }
      frames.push(Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + frameLen)));
      offset += 4 + frameLen;
    }

    if (offset > 0) {
      this.buffer =
        offset === this.buffer.length
          ? Buffer.alloc(0)
          : Buffer.from(this.buffer.subarray(offset));
    }
    return frames;
  }
}

/* -------------------------------------------------------------------------- */
/* Split-Stream Input Relay (Safari / Firefox / HTTP/1.1 Fallback)            */
/* -------------------------------------------------------------------------- */

interface ActiveRdpHttpTunnel {
  sessionId: string;
  username: string;
  nextSeq: number;
  pendingBySeq: Map<number, Buffer[]>;
  writeFrames: (frames: Buffer[]) => void;
  close: () => void;
}

const GLOBAL_TUNNELS_KEY = "__SUSHI_RDP_HTTP_TUNNELS__";

function getTunnelRegistry(): Map<string, ActiveRdpHttpTunnel> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_TUNNELS_KEY]) {
    g[GLOBAL_TUNNELS_KEY] = new Map<string, ActiveRdpHttpTunnel>();
  }
  return g[GLOBAL_TUNNELS_KEY] as Map<string, ActiveRdpHttpTunnel>;
}

export function isValidRdpSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(sessionId);
}

function applyOrderedTunnelFrames(
  tunnel: ActiveRdpHttpTunnel,
  seq: number,
  frames: Buffer[]
): void {
  if (seq < tunnel.nextSeq) {
    // Duplicate retry of an already-applied batch; ignore idempotently.
    return;
  }
  tunnel.pendingBySeq.set(seq, frames);
  while (tunnel.pendingBySeq.has(tunnel.nextSeq)) {
    const batch = tunnel.pendingBySeq.get(tunnel.nextSeq)!;
    tunnel.pendingBySeq.delete(tunnel.nextSeq);
    tunnel.nextSeq += 1;
    tunnel.writeFrames(batch);
  }
}

/* Optional Turso or Redis cross-instance relay for multi-lambda Vercel Split-Stream */
interface RelayTursoConfig {
  httpUrl: string;
  token: string;
}

interface RelayRedisConfig {
  url: string;
  token: string;
}

let relayTableEnsuredFor = "";

function getRelayTursoConfig(): RelayTursoConfig | null {
  const rawUrl = (
    process.env.SUSHI_TURSO_DATABASE_URL ||
    process.env.TURSO_DATABASE_URL ||
    ""
  ).trim();
  const token = (
    process.env.SUSHI_TURSO_AUTH_TOKEN ||
    process.env.TURSO_AUTH_TOKEN ||
    ""
  ).trim();
  if (!rawUrl || !token) return null;
  const httpUrl = rawUrl
    .replace(/^libsql:\/\//i, "https://")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/+$/, "");
  return { httpUrl, token };
}

function getRelayRedisConfig(): RelayRedisConfig | null {
  const candidates = [
    [process.env.SUSHI_REDIS_REST_URL, process.env.SUSHI_REDIS_REST_TOKEN],
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
  ];
  for (const [rawUrl, rawToken] of candidates) {
    const url = (rawUrl || "").trim().replace(/\/+$/, "");
    const token = (rawToken || "").trim();
    if (url && token) return { url, token };
  }
  return null;
}

async function execRelayRedisPipeline(
  cfg: RelayRedisConfig,
  commands: Array<Array<string | number>>
): Promise<Array<{ result?: unknown; error?: string }>> {
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`RDP Redis relay HTTP ${res.status}`);
  }
  return (await res.json()) as Array<{ result?: unknown; error?: string }>;
}

type RelayTursoRow = Array<{ value?: unknown }>;

async function execRelayTurso(
  cfg: RelayTursoConfig,
  stmts: Array<{ sql: string; args: Array<{ type: "text" | "integer"; value: string }> }>
): Promise<RelayTursoRow[][]> {
  const key = crypto.createHash("sha256").update(cfg.httpUrl).digest("hex");
  const requests: Array<Record<string, unknown>> = [];
  if (relayTableEnsuredFor !== key) {
    requests.push({
      type: "execute",
      stmt: {
        sql:
          "CREATE TABLE IF NOT EXISTS sushi_rdp_relay_v1 (" +
          "session_id TEXT NOT NULL, " +
          "seq INTEGER NOT NULL, " +
          "username TEXT NOT NULL, " +
          "payload TEXT NOT NULL, " +
          "created_at INTEGER NOT NULL, " +
          "PRIMARY KEY (session_id, seq))",
        args: [],
        named_args: [],
        want_rows: false,
      },
    });
  }
  for (const s of stmts) {
    requests.push({
      type: "execute",
      stmt: {
        sql: s.sql,
        args: s.args,
        named_args: [],
        want_rows: s.sql.trimStart().toUpperCase().startsWith("SELECT"),
      },
    });
  }
  requests.push({ type: "close" });

  const res = await fetch(`${cfg.httpUrl}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`RDP relay storage HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    results?: Array<{
      type: string;
      response?: { result?: { rows?: Array<Array<{ value?: unknown }>> } };
      error?: { message?: string };
    }>;
  };
  relayTableEnsuredFor = key;
  const rowsPerStmt: RelayTursoRow[][] = [];
  for (const r of data.results || []) {
    if (r.type === "error") {
      throw new Error(r.error?.message || "RDP relay SQL error");
    }
    if (r.response?.result?.rows) {
      rowsPerStmt.push(r.response.result.rows);
    }
  }
  return rowsPerStmt;
}

export function registerRdpHttpTunnel(params: {
  sessionId: string;
  username: string;
  writeFrames: (frames: Buffer[]) => void;
  close: () => void;
}): { dispose: () => void } {
  const registry = getTunnelRegistry();
  const tunnel: ActiveRdpHttpTunnel = {
    sessionId: params.sessionId,
    username: params.username,
    nextSeq: 0,
    pendingBySeq: new Map(),
    writeFrames: params.writeFrames,
    close: params.close,
  };
  registry.set(params.sessionId, tunnel);

  // Only poll shared storage on Vercel Serverless when Split-Stream mode is used, so
  // cross-instance input frames still arrive if Fluid Compute routes to a second lambda.
  const tursoCfg = process.env.VERCEL === "1" ? getRelayTursoConfig() : null;
  const redisCfg =
    process.env.VERCEL === "1" && !tursoCfg ? getRelayRedisConfig() : null;
  const redisListKey = `sushi:rdp:relay:${params.sessionId}`;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  if (tursoCfg) {
    pollTimer = setInterval(async () => {
      if (polling || !registry.has(params.sessionId)) return;
      polling = true;
      try {
        const resultSets = await execRelayTurso(tursoCfg, [
          {
            sql: "SELECT seq, payload FROM sushi_rdp_relay_v1 WHERE session_id = ? AND username = ? AND seq >= ? ORDER BY seq ASC LIMIT 32",
            args: [
              { type: "text", value: params.sessionId },
              { type: "text", value: params.username },
              { type: "integer", value: String(tunnel.nextSeq) },
            ],
          },
        ]);
        const rows = resultSets[0] || [];
        if (rows.length > 0) {
          let maxSeq = tunnel.nextSeq - 1;
          for (const row of rows) {
            const seq = Number(row[0]?.value ?? -1);
            const rawPayload = String(row[1]?.value ?? "[]");
            if (!Number.isInteger(seq) || seq < 0) continue;
            const b64List = JSON.parse(rawPayload) as string[];
            const buffers = b64List.map((b64) => Buffer.from(b64, "base64"));
            applyOrderedTunnelFrames(tunnel, seq, buffers);
            if (seq > maxSeq) maxSeq = seq;
          }
          if (maxSeq >= 0) {
            await execRelayTurso(tursoCfg, [
              {
                sql: "DELETE FROM sushi_rdp_relay_v1 WHERE session_id = ? AND seq <= ?",
                args: [
                  { type: "text", value: params.sessionId },
                  { type: "integer", value: String(maxSeq) },
                ],
              },
            ]);
          }
        }
      } catch {
        // Ignore transient poll errors; next tick will retry.
      } finally {
        polling = false;
      }
    }, 80);
  } else if (redisCfg) {
    pollTimer = setInterval(async () => {
      if (polling || !registry.has(params.sessionId)) return;
      polling = true;
      try {
        const res = await execRelayRedisPipeline(redisCfg, [
          ["LRANGE", redisListKey, 0, 63],
        ]);
        const items = Array.isArray(res[0]?.result)
          ? (res[0]!.result as string[])
          : [];
        if (items.length > 0) {
          for (const raw of items) {
            const parsed = JSON.parse(raw) as {
              seq: number;
              username: string;
              frames: string[];
            };
            if (parsed.username !== params.username) continue;
            const buffers = parsed.frames.map((b64) => Buffer.from(b64, "base64"));
            applyOrderedTunnelFrames(tunnel, parsed.seq, buffers);
          }
          await execRelayRedisPipeline(redisCfg, [
            ["LTRIM", redisListKey, items.length, -1],
          ]);
        }
      } catch {
        // Ignore transient poll errors; next tick will retry.
      } finally {
        polling = false;
      }
    }, 80);
  }

  return {
    dispose: () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      registry.delete(params.sessionId);
      if (tursoCfg) {
        void execRelayTurso(tursoCfg, [
          {
            sql: "DELETE FROM sushi_rdp_relay_v1 WHERE session_id = ? OR created_at < ?",
            args: [
              { type: "text", value: params.sessionId },
              { type: "integer", value: String(Date.now() - 10 * 60 * 1000) },
            ],
          },
        ]).catch(() => {});
      } else if (redisCfg) {
        void execRelayRedisPipeline(redisCfg, [["DEL", redisListKey]]).catch(
          () => {}
        );
      }
    },
  };
}

export async function deliverRdpHttpInput(params: {
  sessionId: string;
  username: string;
  seq: number;
  framesBase64: string[];
}): Promise<{ ok: boolean; mode: "memory" | "relay"; error?: string }> {
  const local = getTunnelRegistry().get(params.sessionId);
  if (local) {
    if (local.username !== params.username) {
      return { ok: false, mode: "memory", error: "Session user mismatch" };
    }
    const buffers = params.framesBase64.map((b64) => Buffer.from(b64, "base64"));
    applyOrderedTunnelFrames(local, params.seq, buffers);
    return { ok: true, mode: "memory" };
  }

  const tursoCfg = getRelayTursoConfig();
  if (tursoCfg) {
    await execRelayTurso(tursoCfg, [
      {
        sql:
          "INSERT OR IGNORE INTO sushi_rdp_relay_v1 (session_id, seq, username, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        args: [
          { type: "text", value: params.sessionId },
          { type: "integer", value: String(params.seq) },
          { type: "text", value: params.username },
          { type: "text", value: JSON.stringify(params.framesBase64) },
          { type: "integer", value: String(Date.now()) },
        ],
      },
    ]);
    return { ok: true, mode: "relay" };
  }

  const redisCfg = getRelayRedisConfig();
  if (redisCfg) {
    const redisListKey = `sushi:rdp:relay:${params.sessionId}`;
    await execRelayRedisPipeline(redisCfg, [
      [
        "RPUSH",
        redisListKey,
        JSON.stringify({
          seq: params.seq,
          username: params.username,
          frames: params.framesBase64,
        }),
      ],
      ["EXPIRE", redisListKey, 120],
    ]);
    return { ok: true, mode: "relay" };
  }

  return {
    ok: false,
    mode: "memory",
    error: "Active RDP stream session not found (session may have closed).",
  };
}
