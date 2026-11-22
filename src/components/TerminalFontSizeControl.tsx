"use client";

import type { Dispatch, SetStateAction } from "react";
import { Minus, Plus } from "lucide-react";

export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = 4;
export const MAX_TERMINAL_FONT_SIZE = 40;

/** Per-terminal text size; changing it must not replace the PTY connection. */
export function TerminalFontSizeControl({
  size, setSize,
}: {
  size: number;
  setSize: Dispatch<SetStateAction<number>>;
}) {
  return (
    <div role="group" className="flex items-center rounded-lg border border-white/10 bg-white/5" aria-label="Terminal font size">
      <button
        type="button"
        onClick={() => setSize((value) => Math.max(MIN_TERMINAL_FONT_SIZE, value - 1))}
        disabled={size <= MIN_TERMINAL_FONT_SIZE}
        className="p-1.5 text-slate-300 hover:text-white disabled:opacity-40"
        title="Decrease font size"
        aria-label="Decrease font size"
      >
        <Minus className="h-3 w-3" />
      </button>
      <span className="font-mono-code px-1 text-[11px] text-slate-300" aria-live="polite">{size}</span>
      <button
        type="button"
        onClick={() => setSize((value) => Math.min(MAX_TERMINAL_FONT_SIZE, value + 1))}
        disabled={size >= MAX_TERMINAL_FONT_SIZE}
        className="p-1.5 text-slate-300 hover:text-white disabled:opacity-40"
        title="Increase font size"
        aria-label="Increase font size"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}
