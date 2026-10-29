import net from "node:net";
import tls from "node:tls";
import type { RdpProbeResult } from "@/types/connection";
import { validateTargetHost } from "./security";

const PROTOCOL_RDP = 0x00000000;
const PROTOCOL_SSL = 0x00000001;
const PROTOCOL_HYBRID = 0x00000002;
const PROTOCOL_RDSTLS = 0x00000004;
const PROTOCOL_HYBRID_EX = 0x00000008;

const FAILURE_CODES: Record<number, string> = {
  0x00000001: "SSL_REQUIRED_BY_SERVER",
  0x00000002: "SSL_NOT_ALLOWED_BY_SERVER",
  0x00000003: "SSL_CERT_NOT_ON_SERVER",
  0x00000004: "INCONSISTENT_FLAGS",
  0x00000005: "HYBRID_REQUIRED_BY_SERVER",
  0x00000006: "SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER",
};

function buildX224ConnectionRequest(requestedProtocols: number): Buffer {
  // 4-byte TPKT + 7-byte X.224 CR + 8-byte RDP_NEG_REQ = 19 bytes
  const buf = Buffer.alloc(19);
  // TPKT Header
  buf[0] = 0x03; // Version 3
  buf[1] = 0x00; // Reserved
  buf.writeUInt16BE(19, 2); // Packet length

  // X.224 Connection Request
  buf[4] = 14; // Length indicator (19 - 5)
  buf[5] = 0xe0; // Connection Request PDU
  buf.writeUInt16BE(0, 6); // DST-REF
  buf.writeUInt16BE(0, 8); // SRC-REF
  buf[10] = 0x00; // Class 0

  // RDP_NEG_REQ
  buf[11] = 0x01; // TYPE_RDP_NEG_REQ
  buf[12] = 0x00; // Flags
  buf.writeUInt16LE(8, 13); // RDP_NEG_REQ length
  buf.writeUInt32LE(requestedProtocols, 15);

  return buf;
}

function describeProtocol(proto: number): string {
  if (proto === PROTOCOL_RDP) return "Standard RDP Security";
  const parts: string[] = [];
  if (proto & PROTOCOL_HYBRID) parts.push("NLA / CredSSP (HYBRID)");
  if (proto & PROTOCOL_HYBRID_EX) parts.push("NLA Extended (HYBRID_EX)");
  if (proto & PROTOCOL_SSL) parts.push("TLS Security (SSL)");
  if (proto & PROTOCOL_RDSTLS) parts.push("RDSTLS");
  return parts.join(" + ") || `Protocol 0x${proto.toString(16)}`;
}

export async function probeRdpServer(
  host: string,
  port = 3389,
  timeoutMs = 8000
): Promise<RdpProbeResult> {
  await validateTargetHost(host, port);

  const trimmedHost = host.trim();
  const startedAt = Date.now();

  return new Promise<RdpProbeResult>((resolve) => {
    let settled = false;
    const socket = new net.Socket();

    const finish = (result: RdpProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on("timeout", () => {
      finish({
        ok: false,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        host: trimmedHost,
        port,
        supportedProtocols: [],
        nlaRequired: false,
        tlsSupported: false,
        error: `Connection to ${trimmedHost}:${port} timed out after ${Math.round(timeoutMs / 1000)}s.`,
      });
    });

    socket.on("error", (err) => {
      finish({
        ok: false,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        host: trimmedHost,
        port,
        supportedProtocols: [],
        nlaRequired: false,
        tlsSupported: false,
        error: err.message || `Unable to reach ${trimmedHost}:${port}.`,
      });
    });

    let recvBuf = Buffer.alloc(0);

    socket.on("connect", () => {
      const req = buildX224ConnectionRequest(
        PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX
      );
      socket.write(req);
    });

    socket.on("data", (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      if (recvBuf.length < 11) {
        return;
      }

      const latencyMs = Date.now() - startedAt;

      // Verify TPKT version 3 & X.224 Connection Confirm (0xD0)
      if (recvBuf[0] !== 0x03 || (recvBuf[5] & 0xf0) !== 0xd0) {
        finish({
          ok: false,
          reachable: true,
          latencyMs,
          host: trimmedHost,
          port,
          supportedProtocols: [],
          nlaRequired: false,
          tlsSupported: false,
          error: "Port is open, but response is not a valid X.224 RDP handshake.",
        });
        return;
      }

      const tpktLen = recvBuf.readUInt16BE(2);
      if (recvBuf.length < tpktLen && recvBuf.length < 19) {
        return;
      }

      let negType = 0;
      let selectedProto = PROTOCOL_RDP;
      let failureCode: string | undefined;

      if (recvBuf.length >= 19) {
        negType = recvBuf[11];
        const codeOrProto = recvBuf.readUInt32LE(15);
        if (negType === 0x02) {
          // TYPE_RDP_NEG_RSP
          selectedProto = codeOrProto;
        } else if (negType === 0x03) {
          // TYPE_RDP_NEG_FAILURE
          failureCode = FAILURE_CODES[codeOrProto] || `0x${codeOrProto.toString(16)}`;
        }
      }

      const supportedProtocols: string[] = [];
      const nlaRequired = Boolean(
        selectedProto & (PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX) ||
          failureCode === "HYBRID_REQUIRED_BY_SERVER"
      );
      const tlsSupported = Boolean(
        selectedProto & (PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX)
      );

      if (selectedProto & (PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX)) {
        supportedProtocols.push("NLA (CredSSP)");
      }
      if (selectedProto & PROTOCOL_SSL || tlsSupported) {
        supportedProtocols.push("TLS");
      }
      if (negType === 0 || selectedProto === PROTOCOL_RDP) {
        if (!failureCode) {
          supportedProtocols.push("Standard RDP");
        }
      }

      // Remove data listener before optional TLS upgrade
      socket.removeAllListeners("data");

      if (tlsSupported && !failureCode) {
        try {
          const tlsSocket = tls.connect(
            {
              socket,
              servername: net.isIP(trimmedHost) ? undefined : trimmedHost,
              rejectUnauthorized: false,
            },
            () => {
              const cert = tlsSocket.getPeerCertificate();
              const certInfo =
                cert && Object.keys(cert).length > 0
                  ? {
                      subjectCN:
                        (typeof cert.subject?.CN === "string"
                          ? cert.subject.CN
                          : Array.isArray(cert.subject?.CN)
                            ? cert.subject.CN[0]
                            : undefined) || undefined,
                      issuerCN:
                        (typeof cert.issuer?.CN === "string"
                          ? cert.issuer.CN
                          : Array.isArray(cert.issuer?.CN)
                            ? cert.issuer.CN[0]
                            : undefined) || undefined,
                      validFrom: cert.valid_from || undefined,
                      validTo: cert.valid_to || undefined,
                      fingerprint256: cert.fingerprint256 || undefined,
                    }
                  : undefined;

              tlsSocket.destroy();
              finish({
                ok: true,
                reachable: true,
                latencyMs,
                host: trimmedHost,
                port,
                negotiatedProtocol: describeProtocol(selectedProto),
                supportedProtocols,
                nlaRequired,
                tlsSupported: true,
                certificate: certInfo,
              });
            }
          );

          tlsSocket.setTimeout(4000, () => {
            tlsSocket.destroy();
            finish({
              ok: true,
              reachable: true,
              latencyMs,
              host: trimmedHost,
              port,
              negotiatedProtocol: describeProtocol(selectedProto),
              supportedProtocols,
              nlaRequired,
              tlsSupported: true,
            });
          });

          tlsSocket.on("error", () => {
            tlsSocket.destroy();
            finish({
              ok: true,
              reachable: true,
              latencyMs,
              host: trimmedHost,
              port,
              negotiatedProtocol: describeProtocol(selectedProto),
              supportedProtocols,
              nlaRequired,
              tlsSupported: true,
            });
          });
          return;
        } catch {
          // Fall back to non-TLS result below
        }
      }

      finish({
        ok: !failureCode || failureCode === "SSL_NOT_ALLOWED_BY_SERVER",
        reachable: true,
        latencyMs,
        host: trimmedHost,
        port,
        negotiatedProtocol: failureCode
          ? `Negotiation notice: ${failureCode}`
          : describeProtocol(selectedProto),
        supportedProtocols:
          failureCode === "SSL_NOT_ALLOWED_BY_SERVER"
            ? ["Standard RDP"]
            : supportedProtocols,
        nlaRequired,
        tlsSupported,
        failureCode,
      });
    });

    socket.connect(port, trimmedHost);
  });
}
