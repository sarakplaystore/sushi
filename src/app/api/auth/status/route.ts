import { NextRequest, NextResponse } from "next/server";
import {
  getEffectiveAuthConfig,
  mergePasskeySummaries,
  verifyAdminSession,
  verifySignedPasskeyCertificates,
} from "@/lib/server/auth";
import { getCorsHeaders } from "@/lib/server/security";
import { getStateStoreKind, StorageConfigurationError } from "@/lib/server/state-store";
import type { AuthRuntimeMode, AuthStorageProblem } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

function runtimeMode(): AuthRuntimeMode {
  return process.env.VERCEL === "1" ? "vercel" : process.env.GATEWAY_ONLY === "true" ? "gateway" : "vps";
}

function statusHeaders(req: NextRequest) {
  return { ...getCorsHeaders(req.headers.get("origin")), "Cache-Control": "private, no-store" };
}

// Only fixed, explicitly reviewed errors may be returned to an unauthenticated
// browser. Unexpected SDK/network errors can contain connection details.
const safeStatusErrors = new Set([
  "Persistent account data is corrupt; setup is disabled until it is restored.",
  "Persistent account data is invalid; setup is disabled until it is restored.",
  "The existing browser account cannot be migrated without its password profile.",
  "Could not read persistent Sushi data; the existing account and vault have not been reset.",
  "Shared storage is unavailable. Try again before creating or changing an account.",
  "Shared storage is unavailable or rejected its credentials.",
  "Shared storage returned an invalid response.",
  "Shared storage could not complete the request.",
  "Shared storage returned invalid Sushi data.",
  "Turso storage is unavailable. Try again before creating or changing an account.",
  "Turso storage is unavailable or rejected its credentials.",
  "Turso storage returned an invalid response.",
  "Turso storage could not complete the request.",
  "Turso storage returned invalid Sushi data.",
  "Firestore storage data for the account or encrypted vault is incomplete or invalid; it has not been replaced.",
  "Firestore storage is unavailable or the request could not be confirmed. Check its server configuration and refresh before retrying.",
]);

function statusErrorResponse(req: NextRequest, error: unknown) {
  let configError = error instanceof StorageConfigurationError ? error : null;
  let backend: AuthStorageProblem["backend"] = configError?.backend ?? null;
  if (!configError) {
    try {
      const kind = getStateStoreKind();
      backend = kind === "none" ? null : kind;
    } catch (cause) {
      if (cause instanceof StorageConfigurationError) {
        configError = cause;
        backend = cause.backend;
      }
    }
  }

  const storageProblem: AuthStorageProblem = {
    mode: runtimeMode(),
    reason: configError ? "configuration" : "unavailable",
    backend,
  };
  const message = configError?.message ||
    (error instanceof Error && safeStatusErrors.has(error.message) ? error.message :
      "Sushi could not check the account. Existing account and vault data were not reset.");

  return NextResponse.json({ ok: false, error: message, storageProblem }, {
    status: 503, headers: statusHeaders(req),
  });
}

async function buildStatusResponse(
  req: NextRequest,
  signedCertificates?: string[],
  adminProfileCert?: string
) {
  const cfg = await getEffectiveAuthConfig(req.headers, adminProfileCert);
  const authCheck = await verifyAdminSession(req.headers);

  const certPasskeys = cfg.initialized
    ? verifySignedPasskeyCertificates(
        signedCertificates,
        cfg.username,
        cfg.authSecret
      )
    : [];
  const mergedPasskeys = mergePasskeySummaries(cfg.serverPasskeys, certPasskeys);

  return NextResponse.json(
    {
      ok: true,
      authenticated: authCheck.ok,
      initialized: cfg.initialized,
      canBootstrapOnDisk: cfg.canBootstrapOnDisk,
      canBootstrapInteractive: cfg.canBootstrapInteractive,
      envConfigured: cfg.envConfigured,
      mode: runtimeMode(),
      storage: getStateStoreKind(),
      username: authCheck.ok ? authCheck.username || cfg.username : undefined,
      passkeyCount: mergedPasskeys.length,
    },
    { headers: statusHeaders(req) }
  );
}

export async function GET(req: NextRequest) {
  try {
    return await buildStatusResponse(req);
  } catch (error) {
    return statusErrorResponse(req, error);
  }
}

export async function POST(req: NextRequest) {
  let certs: string[] | undefined;
  let adminProfileCert: string | undefined;
  try {
    const body = (await req.json()) as {
      signedCertificates?: string[];
      adminProfileCert?: string;
    };
    certs = body?.signedCertificates;
    adminProfileCert = body?.adminProfileCert;
  } catch {
    // ignore empty body
  }
  try {
    return await buildStatusResponse(req, certs, adminProfileCert);
  } catch (error) {
    return statusErrorResponse(req, error);
  }
}
