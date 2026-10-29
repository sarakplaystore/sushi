import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import {
  formatPermissions,
  sftpChmodItem,
  sftpDeleteItem,
  sftpMakeDir,
  sftpReadBuffer,
  sftpRenameItem,
  sftpWriteBuffer,
} from "@/lib/server/ssh-client";
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

type SftpOperationPayload =
  | {
      action: "mkdir";
      credentials: ConnectionCredentials;
      path: string;
    }
  | {
      action: "rename";
      credentials: ConnectionCredentials;
      oldPath: string;
      newPath: string;
    }
  | {
      action: "delete";
      credentials: ConnectionCredentials;
      path: string;
    }
  | {
      action: "chmod";
      credentials: ConnectionCredentials;
      path: string;
      mode: string | number;
    }
  | {
      action: "readText";
      credentials: ConnectionCredentials;
      path: string;
    }
  | {
      action: "writeText";
      credentials: ConnectionCredentials;
      path: string;
      content: string;
    };

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = verifyGatewayTokenFromHeaders(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  try {
    const body = (await req.json()) as SftpOperationPayload;
    if (!body?.credentials || !body?.action) {
      return NextResponse.json(
        { ok: false, error: "Missing credentials or SFTP action." },
        { status: 400, headers: cors }
      );
    }

    switch (body.action) {
      case "mkdir": {
        await sftpMakeDir(body.credentials, body.path);
        return NextResponse.json({ ok: true }, { headers: cors });
      }
      case "rename": {
        await sftpRenameItem(body.credentials, body.oldPath, body.newPath);
        return NextResponse.json({ ok: true }, { headers: cors });
      }
      case "delete": {
        await sftpDeleteItem(body.credentials, body.path);
        return NextResponse.json({ ok: true }, { headers: cors });
      }
      case "chmod": {
        await sftpChmodItem(body.credentials, body.path, body.mode);
        return NextResponse.json({ ok: true }, { headers: cors });
      }
      case "readText": {
        const { buffer, stats } = await sftpReadBuffer(
          body.credentials,
          body.path,
          2 * 1024 * 1024
        );
        const perm = formatPermissions(stats.mode);
        return NextResponse.json(
          {
            ok: true,
            content: buffer.toString("utf8"),
            size: buffer.length,
            octal: perm.octal,
            permissions: perm.symbolic,
          },
          { headers: cors }
        );
      }
      case "writeText": {
        const buf = Buffer.from(body.content ?? "", "utf8");
        const res = await sftpWriteBuffer(body.credentials, body.path, buf);
        return NextResponse.json(
          { ok: true, bytesWritten: res.bytesWritten },
          { headers: cors }
        );
      }
      default:
        return NextResponse.json(
          { ok: false, error: "Unsupported SFTP action." },
          { status: 400, headers: cors }
        );
    }
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "SFTP operation failed.",
      },
      { status: 422, headers: cors }
    );
  }
}
