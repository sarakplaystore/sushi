import dns from "node:dns/promises";
import net from "node:net";
import type { IncomingMessage } from "node:http";

const METADATA_IPS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

function isPrivateIp(ip: string): boolean {
  if (METADATA_IPS.has(ip.toLowerCase())) {
    return true;
  }
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fe80:")) return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  }
  return false;
}

export async function validateTargetHost(host: string, port: number): Promise<void> {
  if (!host || typeof host !== "string") {
    throw new Error("Host is required.");
  }
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 255 || /[\s/\\]/.test(trimmed)) {
    throw new Error("Invalid hostname or IP address.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }

  const lower = trimmed.toLowerCase();
  if (
    METADATA_IPS.has(lower) ||
    lower === "metadata.google.internal" ||
    lower === "instance-data"
  ) {
    throw new Error("Connections to cloud metadata endpoints are blocked.");
  }

  const blockPrivate = process.env.BLOCK_PRIVATE_NETWORKS === "true";

  if (net.isIP(trimmed)) {
    if (METADATA_IPS.has(lower)) {
      throw new Error("Connections to cloud metadata endpoints are blocked.");
    }
    if (blockPrivate && isPrivateIp(trimmed)) {
      throw new Error("Connections to private/loopback networks are disabled by BLOCK_PRIVATE_NETWORKS.");
    }
    return;
  }

  try {
    const records = await dns.lookup(trimmed, { all: true });
    for (const rec of records) {
      if (METADATA_IPS.has(rec.address.toLowerCase())) {
        throw new Error("Resolved address points to a blocked cloud metadata endpoint.");
      }
      if (blockPrivate && isPrivateIp(rec.address)) {
        throw new Error("Resolved address points to a private/loopback network disabled by BLOCK_PRIVATE_NETWORKS.");
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("blocked")) {
      throw err;
    }
    if (err instanceof Error && err.message.includes("BLOCK_PRIVATE_NETWORKS")) {
      throw err;
    }
    // Allow connection attempt to surface a clear socket/DNS error downstream
  }
}

export function verifyGatewayTokenFromHeaders(
  headers: Headers | IncomingMessage["headers"],
  queryToken?: string | null
): { ok: boolean; error?: string } {
  const configuredToken = process.env.SUSHI_GATEWAY_TOKEN?.trim();
  if (!configuredToken) {
    return { ok: true };
  }

  let provided = queryToken?.trim() || "";
  if (!provided) {
    if (headers instanceof Headers) {
      provided =
        headers.get("x-sushi-token")?.trim() ||
        headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
        "";
    } else {
      const rawHeader = headers["x-sushi-token"] || headers["authorization"];
      const val = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      provided = (val || "").replace(/^Bearer\s+/i, "").trim();
    }
  }

  if (!provided || provided !== configuredToken) {
    return {
      ok: false,
      error: "Unauthorized: valid SUSHI_GATEWAY_TOKEN required.",
    };
  }
  return { ok: true };
}

export function getCorsHeaders(origin?: string | null): Record<string, string> {
  const allowedOrigin = process.env.ALLOWED_ORIGIN?.trim() || origin || "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Sushi-Token",
    "Access-Control-Max-Age": "86400",
  };
}
