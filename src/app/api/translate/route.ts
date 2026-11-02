import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders, verifyRequestAccess } from "@/lib/server/security";
import {
  MAX_TRANSLATE_TEXT,
  isValidTargetTag,
  translateTextServer,
} from "@/lib/server/translate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Translation calls are quick, but a slow provider must not hold the worker.
export const maxDuration = 30;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req.headers.get("origin")),
  });
}

/**
 * POST { text, target, source? } → { ok, translated, detectedSource?, provider }
 *
 * Powers the "Translate" action on selected terminal text and the RDP clipboard
 * panel. Authenticated like every other Sushi API. `target` is a BCP-47 tag
 * (`zh-CN`, `en`, …); the actual provider is chosen server-side (see
 * `src/lib/server/translate.ts`), so no translation API keys live in the browser.
 */
export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyRequestAccess(req.headers);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let body: { text?: unknown; target?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400, headers: cors });
  }

  const text = typeof body.text === "string" ? body.text : "";
  const target = typeof body.target === "string" ? body.target.trim() : "";
  const source = typeof body.source === "string" ? body.source.trim() : "auto";

  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "Text to translate is required." }, { status: 400, headers: cors });
  }
  if (text.length > MAX_TRANSLATE_TEXT) {
    return NextResponse.json(
      { ok: false, error: `Text is too long to translate (max ${MAX_TRANSLATE_TEXT} characters).` },
      { status: 400, headers: cors }
    );
  }
  if (!isValidTargetTag(target)) {
    return NextResponse.json(
      { ok: false, error: 'target must be a language tag like "zh-CN" or "en".' },
      { status: 400, headers: cors }
    );
  }
  if (source !== "auto" && !isValidTargetTag(source)) {
    return NextResponse.json(
      { ok: false, error: 'source must be "auto" or a language tag like "en".' },
      { status: 400, headers: cors }
    );
  }

  try {
    const result = await translateTextServer(text, target, source);
    return NextResponse.json(
      { ok: true, text, target, source, ...result },
      { headers: cors }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Translation failed." },
      { status: 502, headers: cors }
    );
  }
}
