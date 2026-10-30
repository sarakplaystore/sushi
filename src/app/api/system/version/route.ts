import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build identifier of the deployment answering this request.
 *
 * The value is inlined into this bundle at build time, so after a deployment an
 * already-open tab (compiled against the previous build) sees a different id and can
 * offer a reload instead of quietly running stale UI — which is exactly what made an
 * old "press Ctrl+C and add -y" hint linger after the fix shipped.
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      buildId: process.env.NEXT_PUBLIC_SUSHI_BUILD_ID || "dev",
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
