import { NextRequest, NextResponse } from "next/server";
import type { SystemCapabilities } from "@/types/connection";
import { checkGuacdAvailable, getGuacdConfig } from "@/lib/server/guacd-bridge";
import { getCorsHeaders } from "@/lib/server/security";
import { isServerVaultEnabled } from "@/lib/server/vault-store";
import { getStateStoreKind } from "@/lib/server/state-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

export async function GET(req: NextRequest) {
  const isVercel = process.env.VERCEL === "1";
  const isGatewayOnly = process.env.GATEWAY_ONLY === "true";
  const wsActive = Boolean(
    (globalThis as Record<string, unknown>).__SUSHI_WS_ACTIVE__
  );

  const guacdCfg = getGuacdConfig();
  const guacdOk = wsActive ? await checkGuacdAvailable(350) : false;

  const capabilities: SystemCapabilities = {
    mode: isVercel ? "vercel" : isGatewayOnly ? "gateway" : "vps",
    websocketSsh: wsActive,
    // Which SSH transport the UI should prefer. On Vercel (no persistent
    // process to accept WebSocket upgrades) this is "serverless" — SSH still
    // works fully via HTTP streaming exec; "websocket" means a native PTY
    // (vim/tmux/resize) is available on this host.
    sshTransport: wsActive ? "websocket" : "serverless",
    serverlessSshExec: true,
    serverlessSftp: true,
    rdpGuacd: guacdOk,
    rdpCleanPath: true,
    rdpProbe: true,
    // Sharing holds one SSH channel open for many browsers, which only a persistent
    // WebSocket gateway can do — Vercel serverless has nowhere to keep it.
    sharedSsh: wsActive,
    shareAccountTickets: wsActive,
    serverVault: isServerVaultEnabled(),
    storageBackend: getStateStoreKind(),
    requiresGatewayToken: Boolean(process.env.SUSHI_GATEWAY_TOKEN?.trim()),
    guacdHost: `${guacdCfg.host}:${guacdCfg.port}`,
    nodeVersion: process.version,
    region: process.env.VERCEL_REGION || undefined,
  };

  return NextResponse.json(capabilities, {
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}
