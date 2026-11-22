import type { IncomingMessage, ServerResponse } from "node:http";
import { NextRequest } from "next/server";
import { verifyGatewayTokenHeaders } from "./auth";
import { getCorsHeaders } from "./security";

/**
 * The slim gateway has no Next build, but these bounded JSON protocol handlers
 * can be reused directly. They operate in the same process as its live PTYs and
 * are accessible only with the gateway key. Account/vault and streaming routes
 * deliberately remain on the frontend.
 */
const routes = {
  "/api/ssh/share": () => import("../../app/api/ssh/share/route"),
  "/api/ssh/test": () => import("../../app/api/ssh/test/route"),
  "/api/ssh/sysinfo": () => import("../../app/api/ssh/sysinfo/route"),
  "/api/ssh/exec/run": () => import("../../app/api/ssh/exec/run/route"),
  "/api/ssh/exec/stop": () => import("../../app/api/ssh/exec/stop/route"),
  "/api/rdp/probe": () => import("../../app/api/rdp/probe/route"),
} as const;

type RoutePath = keyof typeof routes;
const MAX_BODY_BYTES = 1024 * 1024;

export function isGatewayHttpRoute(path: string): path is RoutePath {
  return Object.prototype.hasOwnProperty.call(routes, path);
}

function reply(req: IncomingMessage, res: ServerResponse, status: number, error: string) {
  req.resume();
  res.writeHead(status, {
    ...getCorsHeaders(req.headers.origin),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  });
  res.end(JSON.stringify({ ok: false, error }));
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    if (!tooLarge) parts.push(chunk);
  }
  return tooLarge ? null : Buffer.concat(parts);
}

export async function handleGatewayHttpRoute(
  req: IncomingMessage, res: ServerResponse, url: URL
): Promise<void> {
  if (!isGatewayHttpRoute(url.pathname)) return reply(req, res, 404, "Unknown gateway route.");
  if (!process.env.SUSHI_GATEWAY_TOKEN?.trim()) {
    return reply(req, res, 503, "Configure SUSHI_GATEWAY_TOKEN on the gateway to manage protocol sessions.");
  }
  if (!verifyGatewayTokenHeaders(req.headers)) {
    return reply(req, res, 401, "A valid gateway token is required.");
  }

  const method = req.method || "GET";
  const allowed = url.pathname === "/api/ssh/share" ? ["GET", "DELETE", "PATCH"] : ["POST"];
  if (!allowed.includes(method)) return reply(req, res, 405, "Method not allowed.");
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) return reply(req, res, 413, "Request is too large.");

  try {
    const body = method === "POST" || method === "PATCH" ? await readBody(req) : undefined;
    if (body === null) return reply(req, res, 413, "Request is too large.");
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new NextRequest(`http://gateway.local${url.pathname}${url.search}`, {
      method, headers, ...(body ? { body: new Uint8Array(body) } : {}),
    });
    const module = await routes[url.pathname]();
    const handler = (module as unknown as Record<string, (req: NextRequest) => Promise<Response>>)[method];
    const result = await handler(request);
    const outgoing: Record<string, string> = {};
    result.headers.forEach((value, key) => { outgoing[key] = value; });
    outgoing["cache-control"] = "private, no-store";
    res.writeHead(result.status, outgoing);
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    if (!res.headersSent) reply(req, res, 500, "The gateway could not complete this request.");
    else res.end();
  }
}
