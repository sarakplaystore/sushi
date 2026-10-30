import { PassThrough, Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import {
  DEFAULT_SFTP_ZIP_LIMITS,
  SftpZipLimitError,
  collectRemoteTree,
  writeZipFromTree,
} from "@/lib/server/sftp-zip";

/**
 * Vercel functions are capped at 60 s (see vercel.json), and this route keeps the
 * function alive for as long as the archive streams. Capping the archive far below
 * the theoretical 2 GB means an oversized folder fails with a readable message
 * instead of handing the user a truncated .zip.
 */
const ARCHIVE_LIMITS = {
  ...DEFAULT_SFTP_ZIP_LIMITS,
  maxTotalBytes:
    process.env.VERCEL === "1" ? 300 * 1024 * 1024 : DEFAULT_SFTP_ZIP_LIMITS.maxTotalBytes,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * POST /api/sftp/download-zip
 * Streams a remote folder as a .zip archive.
 *
 * The tree is collected first (metadata only) so oversized folders fail with a
 * readable JSON error before the response starts; the archive itself is then
 * streamed file by file over SFTP, never buffered in memory.
 */
export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let body: { credentials?: ConnectionCredentials; path?: string };
  try {
    body = (await req.json()) as {
      credentials?: ConnectionCredentials;
      path?: string;
    };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400, headers: cors }
    );
  }

  if (!body?.credentials || !body?.path) {
    return NextResponse.json(
      { ok: false, error: "Missing credentials or remote folder path." },
      { status: 400, headers: cors }
    );
  }

  let tree;
  try {
    tree = await collectRemoteTree(body.credentials, body.path, ARCHIVE_LIMITS);
  } catch (err) {
    if (err instanceof SftpZipLimitError) {
      return NextResponse.json(
        {
          ok: false,
          error: err.message,
          code: err.code,
          limit: err.limit,
          context: err.context,
        },
        { status: 413, headers: cors }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error ? err.message : "Failed to read the remote folder.",
      },
      { status: 422, headers: cors }
    );
  }

  const archiveName = `${tree.rootName}.zip`;
  const passthrough = new PassThrough({ highWaterMark: 1024 * 1024 });
  let finished = false;

  const abortArchive = () => {
    if (finished) return;
    finished = true;
    try {
      passthrough.destroy();
    } catch {
      // already destroyed
    }
  };

  req.signal.addEventListener("abort", abortArchive, { once: true });

  void (async () => {
    try {
      await writeZipFromTree(body.credentials!, tree, passthrough);
    } catch (err) {
      // Headers are already sent, so the only way to signal failure is to break
      // the stream — the browser then reports an interrupted download.
      passthrough.destroy(
        err instanceof Error ? err : new Error("Archive streaming failed.")
      );
      return;
    } finally {
      finished = true;
      req.signal.removeEventListener("abort", abortArchive);
    }
    passthrough.end();
  })();

  const stream = Readable.toWeb(passthrough) as unknown as ReadableStream<Uint8Array>;

  return new NextResponse(stream, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(archiveName),
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Sushi-Archive-Name": encodeURIComponent(archiveName),
      "X-Sushi-File-Count": String(tree.fileCount),
      "X-Sushi-Directory-Count": String(tree.directoryCount),
      "X-Sushi-Total-Bytes": String(tree.totalBytes),
      "X-Sushi-Skipped-Symlinks": String(tree.skippedSymlinks),
      "X-Sushi-Root": encodeURIComponent(tree.rootPath),
    },
  });
}
