/**
 * Client side of the "Translate" action (selected terminal text, RDP clipboard
 * panel). All calls go through Sushi's own `/api/translate` route, so no
 * translation API keys or third-party calls happen in the browser.
 */

export interface TranslateTarget {
  code: string;
  label: string;
}

/** Target languages offered in the translate panel. The first entry is default. */
export const TRANSLATE_TARGETS: TranslateTarget[] = [
  { code: "zh-CN", label: "中文 · Chinese (Simplified)" },
  { code: "zh-TW", label: "繁體中文 · Chinese (Traditional)" },
  { code: "en", label: "English" },
  { code: "km", label: "ខ្មែរ · Khmer" },
  { code: "ja", label: "日本語 · Japanese" },
  { code: "ko", label: "한국어 · Korean" },
  { code: "vi", label: "Tiếng Việt · Vietnamese" },
  { code: "th", label: "ไทย · Thai" },
  { code: "fr", label: "Français · French" },
  { code: "de", label: "Deutsch · German" },
  { code: "es", label: "Español · Spanish" },
  { code: "pt", label: "Português · Portuguese" },
  { code: "ru", label: "Русский · Russian" },
  { code: "ar", label: "العربية · Arabic" },
];

export const DEFAULT_TRANSLATE_TARGET = "zh-CN";

const STORAGE_KEY = "sushi.translateTarget";

/** Remembered target language; falls back to the default outside the browser. */
export function getStoredTranslateTarget(): string {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_TRANSLATE_TARGET;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && TRANSLATE_TARGETS.some((t) => t.code === stored)) return stored;
  } catch {
    // private mode etc. — just use the default
  }
  return DEFAULT_TRANSLATE_TARGET;
}

export function storeTranslateTarget(code: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // ignore
  }
}

export interface TranslateResponse {
  translated: string;
  detectedSource?: string;
  provider: string;
}

/** Translates `text` into `target` via `/api/translate`. Throws on failure. */
export async function translateText(
  text: string,
  target: string,
  source = "auto"
): Promise<TranslateResponse> {
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target, source }),
  });
  const data = (await res.json().catch(() => null)) as
    | ({ ok: true } & TranslateResponse)
    | { ok: false; error?: string }
    | null;
  if (!res.ok || !data || data.ok !== true) {
    throw new Error(
      (data && "error" in data && data.error) || `Translation failed (HTTP ${res.status}).`
    );
  }
  return {
    translated: String(data.translated ?? ""),
    detectedSource: data.detectedSource,
    provider: data.provider,
  };
}
