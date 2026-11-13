import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";

export const runtime = "nodejs";

let cachedWasmRaw: Buffer | null = null;
let cachedWasmGzip: Buffer | null = null;

async function loadIronRdpWasm(): Promise<{ raw: Buffer; gzip: Buffer }> {
  if (cachedWasmRaw && cachedWasmGzip) {
    return { raw: cachedWasmRaw, gzip: cachedWasmGzip };
  }
  const relWasm = path.join("node_modules", "ironrdp-wasm", "pkg", "rdp_client_bg.wasm");
  const roots = new Set<string>([process.cwd()]);
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      roots.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Ignore import.meta.url resolution issues
  }

  let lastErr: unknown = null;
  for (const root of roots) {
    try {
      const candidate = path.join(/*turbopackIgnore: true*/ root, relWasm);
      const raw = await fs.readFile(candidate);
      const gzip = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED });
      cachedWasmRaw = raw;
      cachedWasmGzip = gzip;
      return { raw, gzip };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Failed to locate rdp_client_bg.wasm");
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function GET(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  try {
    const { raw, gzip } = await loadIronRdpWasm();
    const acceptEncoding = (req.headers.get("accept-encoding") || "").toLowerCase();

    // `rdp_client_bg.wasm` is ~5.13 MB raw, which exceeds AWS Lambda / Vercel's 4.5 MB
    // buffered function payload cap unless gzip-compressed (~1.7 MB) or streamed.
    if (acceptEncoding.includes("gzip")) {
      return new NextResponse(new Uint8Array(gzip), {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "application/wasm",
          "Content-Encoding": "gzip",
          Vary: "Accept-Encoding",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    const chunkSize = 64 * 1024;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= raw.length) {
          controller.close();
          return;
        }
        const end = Math.min(raw.length, offset + chunkSize);
        controller.enqueue(new Uint8Array(raw.buffer, raw.byteOffset + offset, end - offset));
        offset = end;
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/wasm",
        Vary: "Accept-Encoding",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to load IronRDP WebAssembly binary.",
      },
      { status: 500, headers: cors }
    );
  }
}
