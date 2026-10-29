import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { withSftp } from "@/lib/server/ssh-client";
import { getCorsHeaders, verifyGatewayTokenFromHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = verifyGatewayTokenFromHeaders(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  try {
    const formData = await req.formData();
    const rawCreds = formData.get("credentials");
    const remoteDir = String(formData.get("remoteDir") || "/");

    if (!rawCreds || typeof rawCreds !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing SFTP credentials in upload form." },
        { status: 400, headers: cors }
      );
    }

    const credentials = JSON.parse(rawCreds) as ConnectionCredentials;
    const files = formData.getAll("files").filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No files selected for upload." },
        { status: 400, headers: cors }
      );
    }

    const uploaded: Array<{ name: string; path: string; size: number }> = [];

    await withSftp(credentials, async (sftp) => {
      for (const file of files) {
        const cleanName = path.posix.basename(file.name.replace(/\\/g, "/"));
        const targetPath = path.posix.join(remoteDir, cleanName);
        const arrayBuf = await file.arrayBuffer();
        const buf = Buffer.from(arrayBuf);

        await new Promise<void>((resolve, reject) => {
          const ws = sftp.createWriteStream(targetPath);
          ws.on("error", (err: Error) => reject(err));
          ws.on("close", () => resolve());
          ws.end(buf);
        });

        uploaded.push({
          name: cleanName,
          path: targetPath,
          size: buf.length,
        });
      }
    });

    return NextResponse.json({ ok: true, uploaded }, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to upload files via SFTP.",
      },
      { status: 422, headers: cors }
    );
  }
}
