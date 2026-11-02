/**
 * Server-side text translation for the "Translate" action in the terminal and
 * clipboard panels (`/api/translate`).
 *
 * Two providers, no dependencies:
 *
 * 1. A self-hosted LibreTranslate-compatible endpoint when `SUSHI_TRANSLATE_URL`
 *    is set (optionally with `SUSHI_TRANSLATE_API_KEY`). Recommended for
 *    self-hosted Sushi: the text never leaves your infrastructure.
 * 2. Otherwise the keyless Google Translate `gtx` endpoint, which works from any
 *    VPS with outbound HTTPS and needs no API key.
 *
 * Both are plain HTTPS JSON calls with a timeout; `fetchImpl` is injectable so
 * the tests can exercise both parsers without network access.
 */

export interface TranslateResult {
  translated: string;
  /** Source language the provider detected (Google path only). */
  detectedSource?: string;
  /** Which provider answered, for the UI/debugging. */
  provider: "libretranslate" | "google-gtx";
}

export interface TranslateProviderOptions {
  /** LibreTranslate-compatible endpoint; defaults to env `SUSHI_TRANSLATE_URL`. */
  url?: string;
  /** Bearer token for the endpoint; defaults to env `SUSHI_TRANSLATE_API_KEY`. */
  apiKey?: string;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

export const DEFAULT_TRANSLATE_TIMEOUT_MS = 12_000;

/** Longest text we translate in one call (keeps prompts and payloads small). */
export const MAX_TRANSLATE_TEXT = 4000;

/**
 * BCP-47-ish language tag: `en`, `zh-CN`, `pt-BR`, `sr-Latn`, … Anything else
 * (including injection attempts) is rejected by the route before this runs.
 */
export const TARGET_TAG_RE = /^[a-z]{2,3}(?:-[A-Za-z][A-Za-z0-9]{0,7}){0,2}$/i;

export function isValidTargetTag(tag: string): boolean {
  return TARGET_TAG_RE.test(tag.trim());
}

function friendlyError(err: unknown): Error {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return new Error("The translation service timed out. Try again or shorten the text.");
    }
    return new Error(`Translation failed: ${err.message}`);
  }
  return new Error("Translation failed.");
}

async function translateViaLibreTranslate(
  text: string,
  target: string,
  source: string,
  url: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<TranslateResult> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ q: text, source: source || "auto", target, format: "text" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`the translation service answered HTTP ${res.status}`);
  }
  const data = (await res.json()) as { translatedText?: unknown };
  if (typeof data?.translatedText !== "string" || !data.translatedText) {
    throw new Error("the translation service returned no text");
  }
  return { translated: data.translatedText, provider: "libretranslate" };
}

async function translateViaGoogleGtx(
  text: string,
  target: string,
  source: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<TranslateResult> {
  const params = new URLSearchParams({
    client: "gtx",
    sl: source || "auto",
    tl: target,
    dt: "t",
    q: text,
  });
  const res = await fetchImpl(
    `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
    { signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!res.ok) {
    throw new Error(`the translation service answered HTTP ${res.status}`);
  }
  // Response shape: [[["translated","original",…], …], null, "detectedSource", …]
  const data = (await res.json()) as unknown;
  const segments = Array.isArray(data) && Array.isArray((data as unknown[])[0])
    ? ((data as unknown[])[0] as unknown[])
    : [];
  const translated = segments
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("");
  if (!translated) {
    throw new Error("the translation service returned no text");
  }
  const detected = Array.isArray(data) ? (data as unknown[])[2] : undefined;
  return {
    translated,
    detectedSource: typeof detected === "string" ? detected : undefined,
    provider: "google-gtx",
  };
}

/**
 * Translates `text` into `target` (auto-detecting the source unless given).
 * Prefers a self-hosted endpoint from the environment, falls back to the
 * keyless Google endpoint. Throws an Error with a user-presentable message.
 */
export async function translateTextServer(
  text: string,
  target: string,
  source = "auto",
  options: TranslateProviderOptions = {}
): Promise<TranslateResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS;
  const url = (options.url ?? process.env.SUSHI_TRANSLATE_URL?.trim()) || "";
  const apiKey = options.apiKey ?? process.env.SUSHI_TRANSLATE_API_KEY?.trim();
  try {
    if (url) {
      return await translateViaLibreTranslate(
        text,
        target,
        source,
        url,
        apiKey,
        fetchImpl,
        timeoutMs
      );
    }
    return await translateViaGoogleGtx(text, target, source, fetchImpl, timeoutMs);
  } catch (err) {
    throw friendlyError(err);
  }
}
