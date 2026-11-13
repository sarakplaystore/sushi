import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";

export const runtime = "nodejs";

let cachedWasm: Buffer | null = null;

async function loadIronRdpWasm(): Promise<Buffer> {
  if (cachedWasm) return cachedWasm;
  const wasmPath = path.join(
    process.cwd(),
    "node_modules",
    "ironrdp-wasm",
    "pkg",
    "rdp_client_bg.wasm"
  );
  cachedWasm = await fs.readFile(wasmPath);
  return cachedWasm;
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
