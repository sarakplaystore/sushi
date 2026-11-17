import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SftpEntry } from "../src/types/connection";
import {
  pruneSelection,
  selectOnly,
  selectRange,
  summariseSelection,
  toggleSelectAll,
  toggleSelection,
} from "../src/lib/client/sftp-selection";

console.log("==> Testing SFTP selection (select all / deselect all / counts)...");

function entry(name: string, type: SftpEntry["type"] = "file", size = 1000): SftpEntry {
  return {
    name,
    path: `/srv/${name}`,
    type,
    size,
    mode: 0o100644,
    permissions: "-rw-r--r--",
    octal: "0644",
    mtime: 0,
    atime: 0,
    uid: 0,
    gid: 0,
  };
}

const files = [entry("a.txt"), entry("b.txt"), entry("docs", "directory", 0)];

// ---- select all / deselect all round-trips --------------------------------------
let selected: string[] = [];
selected = toggleSelectAll(selected, files);
assert.deepEqual(selected.sort(), ["/srv/a.txt", "/srv/b.txt", "/srv/docs"]);
assert.equal(summariseSelection(selected, files, files).allVisible, true);
assert.equal(summariseSelection(selected, files, files).count, 3);

// Unchecking the header must clear EVERYTHING (the reported bug: it did not).
selected = toggleSelectAll(selected, files);
assert.deepEqual(selected, [], "deselect-all clears the whole selection");
const afterClear = summariseSelection(selected, files, files);
assert.equal(afterClear.count, 0, "count goes to zero");
assert.equal(afterClear.allVisible, false, "header checkbox unchecks");
assert.equal(afterClear.someVisible, false, "header checkbox is not mixed");

// From "all" or "none" the header is a true toggle; from a *partial* selection it
// fills first and then clears (what every file manager and mail client does).
for (const start of [[], ["/srv/a.txt", "/srv/b.txt", "/srv/docs"]]) {
  const once = toggleSelectAll(start, files);
  const twice = toggleSelectAll(once, files);
  assert.deepEqual(
    twice.slice().sort(),
    start.slice().sort(),
    `double toggle returns to ${start.length === 0 ? "nothing" : "everything"} selected`
  );
}
const partialOnce = toggleSelectAll(["/srv/a.txt"], files);
assert.equal(partialOnce.length, 3, "partial selection fills on the first click");
assert.deepEqual(toggleSelectAll(partialOnce, files), [], "and clears on the second");

// ---- stale paths can never inflate the count ------------------------------------
// A path that is no longer in the listing (deleted, or from the previous directory)
// must not be counted or make the header checkbox look wrong.
const stale = ["/srv/a.txt", "/old/gone.txt"];
const staleSummary = summariseSelection(stale, files, files);
assert.equal(staleSummary.count, 1, "deleted paths are not counted");
assert.equal(staleSummary.allVisible, false, "one visible row selected ≠ all selected");

assert.deepEqual(
  pruneSelection(stale, files),
  ["/srv/a.txt"],
  "pruning drops paths that are gone"
);
// Pruning must be a no-op (same array) when nothing is stale, to avoid re-renders.
const clean = ["/srv/a.txt"];
assert.equal(pruneSelection(clean, files), clean, "clean selections keep identity");

// ---- select all with a filter ---------------------------------------------------
// Only visible rows are selected; deselect-all then clears those and keeps the rest.
const visible = [files[0], files[1]]; // docs/ filtered out
let filtered = toggleSelectAll(["/srv/docs"], visible);
assert.deepEqual(filtered.slice().sort(), ["/srv/a.txt", "/srv/b.txt", "/srv/docs"]);
const filteredSummary = summariseSelection(filtered, files, visible);
assert.equal(filteredSummary.count, 3);
assert.equal(filteredSummary.allVisible, true, "all *visible* rows are selected");
assert.equal(filteredSummary.includesHidden, true, "the bar says rows are hidden");

filtered = toggleSelectAll(filtered, visible);
assert.deepEqual(filtered, ["/srv/docs"], "deselect-all keeps rows outside the filter");
assert.equal(
  summariseSelection(filtered, files, visible).count,
  1,
  "the hidden row is still counted"
);

// Empty directory: the header checkbox is a no-op, not a crash.
assert.deepEqual(toggleSelectAll([], []), []);
assert.deepEqual(toggleSelectAll(["/srv/a.txt"], []), ["/srv/a.txt"]);

// ---- single row operations ------------------------------------------------------
assert.deepEqual(toggleSelection([], "/srv/a.txt"), ["/srv/a.txt"]);
assert.deepEqual(toggleSelection(["/srv/a.txt"], "/srv/a.txt"), []);
assert.deepEqual(toggleSelection(["/srv/a.txt", "/srv/b.txt"], "/srv/a.txt"), ["/srv/b.txt"]);
// Toggling the same row twice is a round-trip.
assert.deepEqual(toggleSelection(toggleSelection([], "/x"), "/x"), []);
assert.deepEqual(selectOnly("/srv/a.txt"), ["/srv/a.txt"]);

// ---- shift-click ranges ---------------------------------------------------------
assert.deepEqual(selectRange(files, "/srv/a.txt", "/srv/docs"), [
  "/srv/a.txt",
  "/srv/b.txt",
  "/srv/docs",
]);
// Backwards ranges select the same run.
assert.deepEqual(selectRange(files, "/srv/docs", "/srv/a.txt"), [
  "/srv/a.txt",
  "/srv/b.txt",
  "/srv/docs",
]);
// A second shift-click re-aims from the same anchor instead of extending.
assert.deepEqual(selectRange(files, "/srv/b.txt", "/srv/a.txt"), ["/srv/a.txt", "/srv/b.txt"]);
// No anchor, or an anchor that no longer exists, means "just this row".
assert.deepEqual(selectRange(files, null, "/srv/b.txt"), ["/srv/b.txt"]);
assert.deepEqual(selectRange(files, "/gone", "/srv/b.txt"), ["/srv/b.txt"]);

// ---- summary details ------------------------------------------------------------
const mixed = summariseSelection(["/srv/a.txt", "/srv/docs"], files, files);
assert.equal(mixed.count, 2);
assert.equal(mixed.folderCount, 1, "folders are counted separately");
assert.equal(mixed.bytes, 1000, "folders contribute no bytes (they are zipped)");
assert.equal(mixed.allVisible, false);
assert.equal(mixed.someVisible, true, "the header checkbox is mixed");

// ---- wiring: the component actually uses all of this ---------------------------
const repoRoot = resolve(import.meta.dirname, "..");
const browser = readFileSync(resolve(repoRoot, "src/components/SftpBrowserSession.tsx"), "utf8");
assert.ok(browser.includes('from "@/lib/client/sftp-selection"'), "component imports the helper");
assert.ok(browser.includes("toggleSelectAll"), "header checkbox uses the pure helper");
assert.ok(browser.includes("pruneSelection"), "stale paths are pruned on refresh");
assert.ok(browser.includes("navigated"), "navigating away clears the selection");
assert.ok(
  browser.includes("setSelectedPaths([])"),
  "navigating to another directory drops paths from the old one"
);
// The old inline implementations must be gone, or the two can drift apart again.
assert.ok(
  !browser.includes("const visible = new Set(visibleEntries.map((e) => e.path));"),
  "old inline deselect-all is removed"
);

console.log("SFTP selection tests passed.");
