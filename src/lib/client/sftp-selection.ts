import type { SftpEntry } from "@/types/connection";

/**
 * Selection model for the SFTP file list.
 *
 * Pure functions only: the browser keeps `string[]` of paths in state, and these
 * work out what a click means. Keeping it out of the component is what makes the
 * select-all / deselect-all edge cases testable — the bug this replaces was
 * exactly there: stale paths from a previous directory stayed in the list, so the
 * header checkbox and the "N selected" bar disagreed with the rows on screen.
 */

/** Drops anything that is not one of the entries currently on screen. */
export function pruneSelection(
  selected: readonly string[],
  entries: readonly SftpEntry[]
): string[] {
  if (selected.length === 0) return selected as string[];
  const present = new Set(entries.map((entry) => entry.path));
  const next = selected.filter((path) => present.has(path));
  return next.length === selected.length ? (selected as string[]) : next;
}

/** Plain click: this row only. */
export function selectOnly(path: string): string[] {
  return [path];
}

/** ⌘/Ctrl-click (and the row checkbox): flip one row. */
export function toggleSelection(
  selected: readonly string[],
  path: string
): string[] {
  return selected.includes(path)
    ? selected.filter((candidate) => candidate !== path)
    : [...selected, path];
}

/**
 * Shift-click: select the run between `anchor` and `path` (inclusive) in the order
 * the rows are displayed.
 *
 * The anchor is the last row clicked without Shift, so a second Shift-click
 * re-aims the run instead of extending it from wherever the pointer went first.
 * A missing anchor means "just this row".
 */
export function selectRange(
  entries: readonly SftpEntry[],
  anchor: string | null,
  path: string
): string[] {
  const paths = entries.map((entry) => entry.path);
  const to = paths.indexOf(path);
  if (to === -1) return [path];
  const from = anchor === null ? -1 : paths.indexOf(anchor);
  if (from === -1) return [path];
  const [low, high] = from <= to ? [from, to] : [to, from];
  return paths.slice(low, high + 1);
}

/**
 * What the header checkbox does.
 *
 * Select-all covers exactly the rows the user can see (search filter and dotfiles
 * respected). Deselect-all clears exactly those same rows and **leaves rows
 * outside the filter selected** — clearing invisible rows would silently drop a
 * selection the user cannot see. Because `allVisible` is true only when every
 * visible row is selected, unchecking the last visible row clears the bar.
 */
export function toggleSelectAll(
  selected: readonly string[],
  visible: readonly SftpEntry[]
): string[] {
  if (visible.length === 0) return selected as string[];
  const visiblePaths = visible.map((entry) => entry.path);
  const allVisibleSelected = visiblePaths.every((path) => selected.includes(path));
  if (allVisibleSelected) {
    const visibleSet = new Set(visiblePaths);
    return selected.filter((path) => !visibleSet.has(path));
  }
  const next = new Set(selected);
  for (const path of visiblePaths) next.add(path);
  // Display order keeps the count stable and the array free of duplicates.
  return [...next];
}

export interface SelectionSummary {
  /** Rows selected that are on screen right now — what the bar reports. */
  count: number;
  folderCount: number;
  /** Bytes of selected files (folders count as 0, they are zipped on demand). */
  bytes: number;
  /** Every visible row is selected (header checkbox is checked). */
  allVisible: boolean;
  /** Some but not all visible rows are selected (header checkbox is mixed). */
  someVisible: boolean;
  /** The selection covers more rows than the screen shows. */
  includesHidden: boolean;
}

/**
 * Counts and checkbox states for the selection bar.
 *
 * Everything is derived from the entries that actually exist in `entries`, so a
 * stale path (deleted file, directory left behind) can never inflate the count.
 */
export function summariseSelection(
  selected: readonly string[],
  entries: readonly SftpEntry[],
  visible: readonly SftpEntry[]
): SelectionSummary {
  const selectedSet = new Set(selected);
  const selectedEntries = entries.filter((entry) => selectedSet.has(entry.path));
  const visiblePaths = visible.map((entry) => entry.path);
  const visibleSelected = visiblePaths.filter((path) => selectedSet.has(path));

  return {
    count: selectedEntries.length,
    folderCount: selectedEntries.filter((entry) => entry.type === "directory").length,
    bytes: selectedEntries.reduce(
      (sum, entry) => sum + (entry.type === "directory" ? 0 : entry.size),
      0
    ),
    allVisible: visiblePaths.length > 0 && visibleSelected.length === visiblePaths.length,
    someVisible: visibleSelected.length > 0,
    includesHidden: selectedEntries.length > visibleSelected.length,
  };
}
