import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyLineInput,
  choosePromptParts,
  clearPromptRegion,
  emptyLineEditorState,
  promptTextFor,
  pushHistory,
  redrawToText,
  visibleWidth,
  type LineEditorState,
} from "../src/lib/client/line-editor";

console.log("==> Testing the serverless shell line editor (arrow keys, Home/End, Delete)...");

/** Feeds keys, returning the final state plus every action that fell out. */
function feed(history: string[], keys: string[], start?: LineEditorState) {
  let state = start ?? emptyLineEditorState();
  const actions: string[] = [];
  for (const key of keys) {
    const outcome = applyLineInput(state, key, history);
    state = outcome.state;
    for (const action of outcome.actions) {
      actions.push(action.kind === "submit" ? `submit:${action.line}` : action.kind);
    }
  }
  return { state, actions };
}

// ---- ← → move the caret (the reported bug: they did nothing) --------------------
assert.deepEqual(feed([], ["a", "b", "c"]).state.line, "abc");
assert.deepEqual(feed([], ["a", "b", "c"]).state.cursor, 3);

const left = feed([], ["a", "b", "c", "\x1b[D"]);
assert.equal(left.state.cursor, 2, "← moves the caret left");
assert.equal(left.state.line, "abc", "← does not change the text");
const leftTwice = feed([], ["a", "b", "c", "\x1b[D", "\x1b[D", "\x1b[D", "\x1b[D"]);
assert.equal(leftTwice.state.cursor, 0, "← stops at the start of the line");

const right = feed([], ["a", "b", "\x1b[D", "\x1b[D", "\x1b[C"]);
assert.equal(right.state.cursor, 1, "→ moves the caret right");
const rightPastEnd = feed([], ["a", "\x1b[C", "\x1b[C"]);
assert.equal(rightPastEnd.state.cursor, 1, "→ stops at the end of the line");

// Application (SS3) arrows must behave like CSI arrows — these used to be dropped
// and the trailing letter typed into the command (`OB` → "B", `[B: not found`).
for (const [csi, ss3] of [
  ["\x1b[A", "\x1bOA"],
  ["\x1b[B", "\x1bOB"],
  ["\x1b[C", "\x1bOC"],
  ["\x1b[D", "\x1bOD"],
]) {
  const a = feed(["echo hi"], ["\x1b[D".repeat(3), csi]);
  const b = feed(["echo hi"], ["\x1b[D".repeat(3), ss3]);
  assert.deepEqual(b.state, a.state, `SS3 ${JSON.stringify(ss3)} matches CSI ${JSON.stringify(csi)}`);
}
const ss3NoLeak = feed([], ["\x1bOD", "\x1bOC"]);
assert.equal(ss3NoLeak.state.line, "", "SS3 arrows never leak letters into the line");

// ---- typing in the middle of the line ------------------------------------------
const middle = feed([], ["a", "c", "\x1b[D", "b"]);
assert.equal(middle.state.line, "abc", "text is inserted at the caret");
assert.equal(middle.state.cursor, 2);

// ---- Home / End / Ctrl+A / Ctrl+E ---------------------------------------------
for (const home of ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~", "\x01"]) {
  assert.equal(feed([], ["a", "b", "c", home]).state.cursor, 0, `${JSON.stringify(home)} = Home`);
}
for (const end of ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~", "\x05"]) {
  assert.equal(
    feed([], ["a", "b", "c", "\x1b[H", end]).state.cursor,
    3,
    `${JSON.stringify(end)} = End`
  );
}

// ---- Backspace and Delete ------------------------------------------------------
assert.equal(feed([], ["a", "b", "c", "\x7f"]).state.line, "ab", "Backspace removes before the caret");
// Caret sits between characters: after one ← in "abc" it is before "c".
assert.equal(feed([], ["a", "b", "c", "\x1b[D", "\x1b[3~"]).state.line, "ab", "Delete removes the char under the caret");
const delMiddle = feed([], ["a", "b", "c", "\x1b[D", "\x1b[D", "\x1b[3~"]);
assert.equal(delMiddle.state.line, "ac", "Delete removes the middle character");
assert.equal(delMiddle.state.cursor, 1, "Delete keeps the caret in place");
assert.equal(feed([], ["a", "\x1b[H", "\x7f"]).state.line, "a", "Backspace at column 0 does nothing");
assert.equal(feed([], ["a", "\x1b[C", "\x1b[3~"]).state.line, "a", "Delete at end does nothing");

// ---- history: ↑ ↓ with both CSI and SS3 ---------------------------------------
const history = ["ls -la", "cd /tmp", "pwd"];
const up = feed(history, ["\x1b[A"]);
assert.equal(up.state.line, "pwd", "↑ recalls the most recent command");
assert.equal(up.state.cursor, 3, "the caret lands at the end of the recalled line");
assert.equal(feed(history, ["\x1b[A", "\x1b[A"]).state.line, "cd /tmp", "↑↑ goes further back");
assert.equal(feed(history, ["\x1b[A", "\x1b[A", "\x1b[A"]).state.line, "ls -la");
assert.equal(feed(history, ["\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A"]).state.line, "ls -la", "↑ stops at the oldest");

// ↑↑ lands on "cd /tmp" (index 1); ↓ moves forward to the newer "pwd" (index 2).
const down = feed(history, ["\x1b[A", "\x1b[A", "\x1b[B"]);
assert.equal(down.state.line, "pwd", "↓ walks forward again");
const backToDraft = feed(history, ["echo", "\x1b[A", "\x1b[B"]);
assert.equal(backToDraft.state.line, "echo", "↓ past the newest entry restores the half-typed line");

// SS3 history keys (what some terminals send for the arrow keys)
assert.equal(feed(history, ["\x1bOA"]).state.line, "pwd", "SS3 ↑ recalls history");
assert.equal(feed(history, ["\x1bOA", "\x1bOB"]).state.line, "", "SS3 ↓ returns to the empty line");

// ---- submitting ----------------------------------------------------------------
const submitted = feed([], ["l", "s", "\r"]);
assert.deepEqual(submitted.actions, ["redraw", "redraw", "submit:ls"]);
assert.equal(submitted.state.line, "", "Enter clears the line");
assert.equal(submitted.state.cursor, 0);
assert.equal(submitted.state.historyIndex, -1, "Enter resets the history browse position");

// A CRLF split across two onData chunks must still submit exactly once.
const crlf = feed([], ["h", "i", "\r", "\n"]);
assert.deepEqual(
  crlf.actions.filter((a) => a.startsWith("submit")),
  ["submit:hi"],
  "a CRLF split across chunks submits once, not twice"
);
const sameChunk = feed([], ["h", "i", "\r\n"]);
assert.deepEqual(
  sameChunk.actions.filter((a) => a.startsWith("submit")),
  ["submit:hi"],
  "a CRLF in one chunk submits once"
);

// ---- readline control keys ------------------------------------------------------
assert.equal(feed([], ["o", "n", "e", " ", "t", "w", "o", "\x17"]).state.line, "one ", "Ctrl+W kills the previous word");
assert.equal(feed([], ["a", "b", "c", "\x1b[D", "\x0b"]).state.line, "ab", "Ctrl+K kills to the end");
assert.equal(feed([], ["a", "b", "c", "\x15"]).state.line, "", "Ctrl+U kills the line");
assert.equal(feed([], ["a", "b", "c", "\x1b[H", "\x1b[F"]).state.cursor, 3, "Home/End round-trip");

const wordKeys = feed([], ["one two three", "\x1bb"]);
assert.equal(wordKeys.state.cursor, 8, "Alt+B moves back one word");
assert.equal(feed([], ["one two", "\x1b[H", "\x1bf"]).state.cursor, 3, "Alt+F moves forward one word");
assert.equal(feed([], ["one two", "\x1b[1;5D"]).state.cursor, 4, "Ctrl+← moves back one word");
assert.equal(feed([], ["one two", "\x1b[H", "\x1b[1;5C"]).state.cursor, 3, "Ctrl+→ moves forward one word");

const ctrlC = feed([], ["a", "b", "\x03"]);
assert.ok(ctrlC.actions.includes("interrupt"), "Ctrl+C interrupts");
const ctrlL = feed([], ["\x0c"]);
assert.ok(ctrlL.actions.includes("clear-screen"), "Ctrl+L clears the screen");
assert.ok(feed([], ["\x04"]).actions.includes("eof"), "Ctrl+D on an empty line is EOF");
assert.ok(!feed([], ["x", "\x04"]).actions.includes("eof"), "Ctrl+D with text does not close the shell");

// ---- escape sequences must never become text -----------------------------------
// This is the exact class of bug behind "[B[B[A: not found".
for (const sequence of ["\x1b[Z", "\x1b[5~", "\x1b[6~", "\x1b[1;2A", "\x1bOP", "\x1b[11~", "\x1b[2J"]) {
  const result = feed([], [sequence]);
  assert.equal(result.state.line, "", `${JSON.stringify(sequence)} is swallowed, not typed`);
  assert.equal(result.state.cursor, 0);
}
// Incomplete sequences wait for the next chunk instead of being half-typed.
const partial = applyLineInput(emptyLineEditorState(), "\x1b[", []);
assert.equal(partial.state.line, "", "an incomplete CSI creates no text");

// ---- bracketed paste -----------------------------------------------------------
const pasted = feed([], ["\x1b[200~npm install\x1b[201~"]);
assert.equal(pasted.state.line, "npm install", "a bracketed paste becomes text");
const pastedMultiline = feed([], ["\x1b[200~a\r\nb\x1b[201~"]);
assert.equal(pastedMultiline.state.line, "a b", "newlines in a paste become spaces");
const pastedArrow = feed([], ["\x1b[200~\x1b[A\x1b[201~"]);
assert.equal(pastedArrow.state.line, "\x1b[A", "an arrow sequence pasted as text stays text");

// ---- redraw / history helpers --------------------------------------------------
const redraw = redrawToText("$ ", { line: "abc", cursor: 1, historyIndex: -1, draft: "" });
assert.equal(redraw, "\r$ abc\x1b[0K\x1b[2D", "redraw returns to the prompt, draws, and restores the caret");
assert.equal(
  redrawToText("$ ", { line: "abc", cursor: 3, historyIndex: -1, draft: "" }),
  "\r$ abc\x1b[0K",
  "caret at end needs no cursor movement"
);

const store: string[] = [];
pushHistory(store, "ls");
pushHistory(store, "ls");
pushHistory(store, "  ");
pushHistory(store, "pwd");
assert.deepEqual(store, ["ls", "pwd"], "history skips duplicates and blanks");
for (let i = 0; i < 800; i += 1) pushHistory(store, `cmd ${i}`);
assert.equal(store.length, 500, "history is bounded");

// ---- wrapped prompts: pending-wrap redraw --------------------------------------
// A prompt + line that exactly fills the last row leaves the cursor on a fresh row
// (pending wrap). `\r` would then go to column 0 of the *next* row and smear the
// line, so the redraw starts from a clean line instead.
const exact = redrawToText("$ ", { line: "x".repeat(8), cursor: 8, historyIndex: -1, draft: "" }, 10);
assert.ok(exact.startsWith("\r\n"), "a full row redraws on a fresh line");
assert.ok(exact.includes("\x1b[0K"), "the new row is cleared first");
// The normal case is untouched: a short line still redraws in place.
assert.equal(
  redrawToText("$ ", { line: "abc", cursor: 3, historyIndex: -1, draft: "" }, 80),
  "\r$ abc\x1b[0K",
  "a line that fits redraws in place"
);
// Without a known width the old behaviour is kept (no guessing).
assert.equal(
  redrawToText("$ ", { line: "abc", cursor: 3, historyIndex: -1, draft: "" }),
  "\r$ abc\x1b[0K"
);

// ---- visible width (codes are not columns) --------------------------------------
assert.equal(visibleWidth("\x1b[1;32mubuntu@host\x1b[0m"), 11);
assert.equal(visibleWidth("$ "), 2);
assert.equal(visibleWidth("\x1b[1;31mroot\x1b[0m:\x1b[1;34m~\x1b[0m# "), 8);

// ---- prompt shortening for narrow panes -----------------------------------------
const long = { user: "ubuntu", host: "193.123.125.81", path: "/home/ubuntu", marker: "$ " };
const wide = choosePromptParts({ ...long, cols: 120 });
assert.deepEqual(wide, { user: true, host: true, path: true }, "a wide pane gets the full prompt");
assert.equal(promptTextFor(wide, long), "ubuntu@193.123.125.81:/home/ubuntu$ ");
// 20 columns of the pane are reserved for typing, so the path (16 columns) needs
// a pane of at least 36 columns to be shown.
assert.equal(
  promptTextFor(choosePromptParts({ ...long, cols: 33 }), long),
  "$ ",
  "below the path's width only the marker fits"
);
const narrow = choosePromptParts({ ...long, cols: 36 });
assert.equal(promptTextFor(narrow, long), "/home/ubuntu$ ", "a narrow pane keeps the path");
// Very narrow: the bare marker, so a command can still be typed.
const tiny = choosePromptParts({ ...long, cols: 12 });
assert.equal(promptTextFor(tiny, long), "$ ", "the narrowest pane keeps only the marker");
// Unknown width keeps everything — the prompt must not change mid-line.
assert.deepEqual(choosePromptParts({ ...long, cols: 0 }), { user: true, host: true, path: true });
assert.deepEqual(choosePromptParts({ ...long, cols: NaN }), { user: true, host: true, path: true });
// `user@path` (no host) is never produced: it reads like a typo.
for (let cols = 1; cols <= 140; cols += 1) {
  const parts = choosePromptParts({ ...long, cols });
  assert.ok(!(parts.user && !parts.host), `never user@path without host (cols=${cols})`);
}
// Monotonic: a wider pane never shows less than a narrower one.
let previous = 0;
for (let cols = 1; cols <= 140; cols += 1) {
  const parts = choosePromptParts({ ...long, cols });
  const shown = (parts.user ? 1 : 0) + (parts.host ? 1 : 0) + (parts.path ? 1 : 0);
  assert.ok(shown >= Math.min(previous, 3), `prompt never gets shorter when wider (cols=${cols})`);
  previous = shown;
}

// ---- clearing a prompt that spans rows ------------------------------------------
const short = clearPromptRegion("$ ", { line: "abc", cursor: 3, historyIndex: -1, draft: "" }, 80);
assert.equal(short, "\r\x1b[2K\r", "one row: erase in place");
const tall = clearPromptRegion(
  "ubuntu@193.123.125.81:/home/ubuntu$ ",
  { line: "ls", cursor: 2, historyIndex: -1, draft: "" },
  12
);
// 38 columns of text in a 12-column pane = 4 rows.
assert.ok(tall.includes("\x1b[3A"), "moves up over every row of the wrapped prompt");
assert.equal((tall.match(/\x1b\[2K/g) || []).length, 4, "each row is cleared");
assert.ok(tall.endsWith("\r"), "the cursor ends at column 0 of the first row");

// ---- the component actually uses this editor -----------------------------------
const session = readFileSync(resolve(process.cwd(), "src/components/SshTerminalSession.tsx"), "utf8");
assert.match(session, /from "@\/lib\/client\/line-editor"/, "the terminal imports the line editor");
assert.match(session, /applyLineInput\(/, "input goes through applyLineInput");
assert.match(session, /redrawToText\(/, "redraws come from redrawToText");
assert.match(session, /choosePromptParts\(/, "the prompt is fitted to the pane width");
assert.match(session, /clearPromptRegion\(/, "a wrapped prompt is repainted after a resize");
assert.ok(
  !/data\.slice\(i, i \+ 3\) === "\\x1b\[A"/.test(session),
  "the old hand-rolled up-arrow branch is gone"
);

console.log("Serverless shell line editor tests passed.");
