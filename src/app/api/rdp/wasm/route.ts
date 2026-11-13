import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";

export const runtime = "nodejs";

let cachedWasm: Buffer | null = null;

async function loadIronRdpWasm(): Promise<Buffer> {
  if (cachedWasm) return cachedWasm;
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
      cachedWasm = await fs.readFile(candidate);
      return cachedWasm;
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
    const bytes = await loadIronRdpWasm();
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/wasm",
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
