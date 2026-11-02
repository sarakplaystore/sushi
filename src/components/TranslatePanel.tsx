import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, Languages, Loader2, X } from "lucide-react";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import {
  TRANSLATE_TARGETS,
  getStoredTranslateTarget,
  storeTranslateTarget,
  translateText,
} from "@/lib/client/translate";

export interface TranslatePanelProps {
  /** Text to translate. The panel re-translates whenever this changes. */
  text: string;
  onClose: () => void;
  className?: string;
}

/**
 * Shared "Translate" panel: pick a target language, see the translation, copy it.
 * Used above the SSH terminal (for the current xterm selection) and inside the
 * RDP clipboard-sync popover. Translates through Sushi's own `/api/translate`.
 */
export function TranslatePanel({ text, onClose, className = "" }: TranslatePanelProps) {
  const [target, setTarget] = useState<string>(() => getStoredTranslateTarget());
  const [translated, setTranslated] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Guards against out-of-order responses when the target changes quickly. */
  const seqRef = useRef(0);

  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setCopied(false);
    storeTranslateTarget(target);
    translateText(trimmed, target)
      .then((result) => {
        if (seqRef.current !== seq) return;
        setTranslated(result.translated);
        setLoading(false);
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : "Translation failed.");
        setLoading(false);
      });
  }, [text, target]);

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-200">
          <Languages className="h-3.5 w-3.5 text-sky-400" />
          Translate
        </span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          title="Target language"
          className="rounded-md border border-white/10 bg-[#090b10] px-1.5 py-1 text-[11px] text-slate-200 outline-none hover:bg-white/5"
        >
          {TRANSLATE_TARGETS.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="min-w-0 flex-1 truncate font-mono-code text-[11px] text-slate-500">
          {text.trim().slice(0, 120)}
        </span>
        <button
          type="button"
          disabled={!translated || loading}
          onClick={() => {
            void copyTextToClipboard(translated).then((ok) => {
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            });
          }}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/10 disabled:opacity-40"
          title="Copy the translation"
        >
          <Copy className="h-3 w-3" />
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 transition hover:text-white"
          title="Close the translation"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
          Translating…
        </div>
      )}
      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-rose-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && translated && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-[#090b10] p-2 text-xs leading-relaxed text-white">
          {translated}
        </div>
      )}
    </div>
  );
}
