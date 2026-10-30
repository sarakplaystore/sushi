/**
 * Where a downloaded archive goes.
 *
 * Chromium's File System Access API lets Sushi write the archive straight to disk as
 * it streams in, so a 2 GB folder download never has to be held in the tab's memory
 * (which is what a `Blob` + `<a download>` would do). Browsers without it — Safari,
 * Firefox, older Chromium — get the classic in-memory path instead.
 *
 * The picker must be opened inside the click that starts the download: browsers only
 * allow it while the user gesture is still active. So this runs *before* the archive
 * request is made, and a dismissed dialog costs nothing (no bytes transferred).
 */

export type ArchiveSink =
  | {
      kind: "stream";
      write: (chunk: Uint8Array) => Promise<void>;
      close: () => Promise<void>;
      abort: () => Promise<void>;
    }
  | { kind: "memory" }
  | { kind: "cancelled" };

interface FilePickerWindow {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Uint8Array) => Promise<void>;
      close: () => Promise<void>;
      abort: () => Promise<void>;
    }>;
  }>;
}

/** True when the browser can write a download straight to a chosen file. */
export function canSaveStreamToDisk(): boolean {
  if (typeof window === "undefined") return false;
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") return false;
  return window.isSecureContext !== false;
}

/**
 * Asks the browser where to save `suggestedName` and returns the sink to use.
 *
 * - no picker / insecure context → `{ kind: "memory" }` (caller keeps a Blob)
 * - user dismissed the dialog    → `{ kind: "cancelled" }` (caller must not download)
 * - picker failed for any reason → `{ kind: "memory" }` (never lose the download)
 */
export async function openArchiveSink(suggestedName: string): Promise<ArchiveSink> {
  if (!canSaveStreamToDisk()) return { kind: "memory" };
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (!picker) return { kind: "memory" };

  try {
    const handle = await picker.call(window, {
      suggestedName,
      types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
    });
    const writable = await handle.createWritable();
    return {
      kind: "stream",
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return { kind: "cancelled" };
    // A blocked/unsupported picker must never cost the user their download.
    return { kind: "memory" };
  }
}
