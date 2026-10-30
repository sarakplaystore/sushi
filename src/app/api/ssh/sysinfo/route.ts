import { NextRequest, NextResponse } from "next/server";
import type { ConnectionCredentials } from "@/types/connection";
import { fetchSshSystemInfo } from "@/lib/server/ssh-client";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Describes the machine behind an SSH connection: distro + version
 * (`Ubuntu 24.04.1 LTS`) and, where it can be recognised, the cloud provider
 * (`Oracle Cloud`, `AWS EC2`, `Hetzner Cloud`, `KVM VPS`, …).
 *
 * The terminal calls this right after connecting so the header can answer
 * "which Ubuntu is this?" without the user having to run `lsb_release -a`.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let body: { credentials?: ConnectionCredentials };
  try {
    body = (await req.json()) as { credentials?: ConnectionCredentials };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400, headers: cors }
    );
  }

  const creds = body?.credentials;
  if (!creds?.host || !creds?.username) {
    return NextResponse.json(
      { ok: false, error: "SSH host and username are required." },
      { status: 400, headers: cors }
    );
  }

  const info = await fetchSshSystemInfo(creds);
  if (!info) {
    return NextResponse.json(
      { ok: false, error: "Could not read the remote system information." },
      { status: 502, headers: cors }
    );
  }

  return NextResponse.json({ ok: true, info }, { headers: cors });
}
