/**
 * The line editor behind Sushi's serverless shell (Vercel / no live PTY).
 *
 * In that mode there is no remote readline: every keystroke is handled here, in
 * the browser, and a whole line is sent when Enter is pressed. That only feels
 * like a shell if the keys people actually use work — so this module implements
 * the editing keys of a real readline, cursor included:
 *
 *   ← →        move the caret
 *   Home End   start / end of line (CSI H/F, SS3 H/F, Ctrl+A/E)
 *   Delete     delete the character under the caret
 *   Backspace  delete the character before the caret
 *   ↑ ↓        history (CSI A/B *and* the application-mode SS3 forms ESC O A/B)
 *   Ctrl+U/K/W kill line / kill to end / kill previous word
 *   Alt+B/F    move by word (and Ctrl+← / Ctrl+→)
 *   Ctrl+L     clear the screen (the caller redraws)
 *   Ctrl+C     interrupt
 *
 * Everything is a pure function of (state, input) so the behaviour is unit
 * tested without a browser, and so bracketed paste arrives as literal text
 * instead of being interpreted as key presses.
 */

/** Escape sequences a terminal can send for the editing keys. */
const CSI_ARROW_UP = "\x1b[A";
const CSI_ARROW_DOWN = "\x1b[B";
const CSI_ARROW_RIGHT = "\x1b[C";
const CSI_ARROW_LEFT = "\x1b[D";
const SS3_ARROW_UP = "\x1bOA";
const SS3_ARROW_DOWN = "\x1bOB";
const SS3_ARROW_RIGHT = "\x1bOC";
const SS3_ARROW_LEFT = "\x1bOD";

export interface LineEditorState {
  /** The text on the current line, without the prompt. */
  line: string;
  /** Caret position, 0 … line.length. */
  cursor: number;
  /** Where we are in history: -1 = editing a fresh line. */
  historyIndex: number;
  /** Text preserved from the half-typed line while browsing history. */
  draft: string;
  /**
   * True when the previous chunk ended with a CR. A CRLF can be split across two
   * `onData` events; without this the LF would submit an empty second command.
   */
  pendingCarriageReturn?: boolean;
}

export type LineEditorAction =
  /** The visible line changed: erase what is on screen and draw it again. */
  | { kind: "redraw" }
  /** Enter: run `line` (already recorded in history by the caller). */
  | { kind: "submit"; line: string }
  /** Ctrl+C. */
  | { kind: "interrupt" }
  /** Ctrl+L. */
  | { kind: "clear-screen" }
  /** Ctrl+D on an empty line / `exit` — the caller decides what closing means. */
  | { kind: "eof" };

export interface LineEditorOutcome {
  state: LineEditorState;
  actions: LineEditorAction[];
}

export function emptyLineEditorState(): LineEditorState {
  return { line: "", cursor: 0, historyIndex: -1, draft: "", pendingCarriageReturn: false };
}

/** Longest line we keep in the buffer (protects the terminal from a paste bomb). */
export const MAX_LINE_LENGTH = 8_192;

/** How many lines of history the editor keeps. */
export const MAX_HISTORY = 500;

function clampCursor(cursor: number, line: string): number {
  return Math.max(0, Math.min(cursor, line.length));
}

/** Inserts `text` at the caret, ignoring control characters and newlines. */
function insertText(state: LineEditorState, text: string): LineEditorState {
  const printable = text.replace(/[\x00-\x1f\x7f]/g, "");
  return insertPrintable(state, printable);
}

/**
 * Inserts already-filtered text at the caret. Used by paste, where a pasted
 * escape sequence is literal text the user meant to paste (nobody pastes a live
 * arrow key), so it is kept rather than stripped as a control character.
 */
function insertPrintable(state: LineEditorState, printable: string): LineEditorState {
  if (!printable) return state;
  const room = MAX_LINE_LENGTH - state.line.length;
  if (room <= 0) return state;
  const insert = printable.slice(0, room);
  return {
    ...state,
    line: state.line.slice(0, state.cursor) + insert + state.line.slice(state.cursor),
    cursor: state.cursor + insert.length,
  };
}

function moveTo(state: LineEditorState, cursor: number): LineEditorState {
  const next = clampCursor(cursor, state.line);
  return next === state.cursor ? state : { ...state, cursor: next };
}

/** Index of the start of the word before `cursor` (readline Alt+B / Ctrl+W). */
function previousWordStart(line: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(line[i - 1])) i -= 1;
  while (i > 0 && !/\s/.test(line[i - 1])) i -= 1;
  return i;
}

/** Index of the end of the word after `cursor` (readline Alt+F / Ctrl+→). */
function nextWordEnd(line: string, cursor: number): number {
  let i = cursor;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  while (i < line.length && !/\s/.test(line[i])) i += 1;
  return i;
}

/**
 * Reads one complete escape sequence starting at `start`.
 * Returns null when the sequence is incomplete (more bytes are still coming).
 */
export function readEscapeSequence(input: string, start: number): { sequence: string; next: number } | null {
  if (input[start] !== "\x1b") return null;
  const second = input[start + 1];
  if (second === undefined) return null;

  // CSI: ESC [ <params> <intermediates> <final 0x40–0x7e>
  if (second === "[") {
    let i = start + 2;
    while (i < input.length && /[0-9;:<=>?]/.test(input[i])) i += 1;
    while (i < input.length && /[ -/]/.test(input[i])) i += 1;
    if (i >= input.length) return null;
    const final = input[i];
    if (!/[@-~]/.test(final)) return null;
    return { sequence: input.slice(start, i + 1), next: i + 1 };
  }

  // SS3: ESC O <final> (application cursor keys)
  if (second === "O") {
    if (input[start + 2] === undefined) return null;
    return { sequence: input.slice(start, start + 3), next: start + 3 };
  }

  // OSC: ESC ] … BEL or ST — consumed so pasted titles never leak into the line.
  if (second === "]") {
    let i = start + 2;
    while (i < input.length) {
      if (input[i] === "\x07") return { sequence: input.slice(start, i + 1), next: i + 1 };
      if (input[i] === "\x1b" && input[i + 1] === "\\") {
        return { sequence: input.slice(start, i + 2), next: i + 2 };
      }
      i += 1;
    }
    return null;
  }

  // Alt + key, or a bare ESC.
  return { sequence: input.slice(start, start + 2), next: start + 2 };
}

/**
 * Applies one chunk of terminal input to the line buffer.
 *
 * `history` is read (and appended to on submit) by reference, so the caller keeps
 * owning it — that is what makes ↑ survive multiple commands.
 */
export function applyLineInput(
  initial: LineEditorState,
  input: string,
  history: string[]
): LineEditorOutcome {
  const actions: LineEditorAction[] = [];
  let state = initial;

  // Bracket-paste markers (ESC[200~ … ESC[201~) frame literal text: strip the
  // markers and insert the body, so a pasted `\x1b[A` is text, not an arrow.
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";

  const historyUp = () => {
    if (history.length === 0) return;
    if (state.historyIndex === -1) {
      // Leave the half-typed line where it was, so ↓ can come back to it.
      state = { ...state, draft: state.line };
    }
    const next =
      state.historyIndex === -1
        ? history.length - 1
        : Math.max(0, state.historyIndex - 1);
    state = { ...state, historyIndex: next, line: history[next], cursor: history[next].length };
  };

  const historyDown = () => {
    if (state.historyIndex === -1) return;
    if (state.historyIndex >= history.length - 1) {
      state = {
        ...state,
        historyIndex: -1,
        line: state.draft,
        cursor: state.draft.length,
      };
      return;
    }
    const next = state.historyIndex + 1;
    state = { ...state, historyIndex: next, line: history[next], cursor: history[next].length };
  };

  const applySequence = (sequence: string): LineEditorAction[] => {
    const produced: LineEditorAction[] = [];
    switch (sequence) {
      case CSI_ARROW_UP:
      case SS3_ARROW_UP:
        historyUp();
        produced.push({ kind: "redraw" });
        return produced;
      case CSI_ARROW_DOWN:
      case SS3_ARROW_DOWN:
        historyDown();
        produced.push({ kind: "redraw" });
        return produced;
      case CSI_ARROW_LEFT:
      case SS3_ARROW_LEFT:
        state = moveTo(state, state.cursor - 1);
        produced.push({ kind: "redraw" });
        return produced;
      case CSI_ARROW_RIGHT:
      case SS3_ARROW_RIGHT:
        state = moveTo(state, state.cursor + 1);
        produced.push({ kind: "redraw" });
        return produced;
      case "\x1b[H":
      case "\x1bOH":
      case "\x1b[1~":
      case "\x1b[7~":
        state = moveTo(state, 0);
        produced.push({ kind: "redraw" });
        return produced;
      case "\x1b[F":
      case "\x1bOF":
      case "\x1b[4~":
      case "\x1b[8~":
        state = moveTo(state, state.line.length);
        produced.push({ kind: "redraw" });
        return produced;
      case "\x1b[3~": {
        // Delete: remove the character under the caret.
        if (state.cursor < state.line.length) {
          state = {
            ...state,
            line: state.line.slice(0, state.cursor) + state.line.slice(state.cursor + 1),
          };
        }
        produced.push({ kind: "redraw" });
        return produced;
      }
      case "\x1b[1;5D":
      case "\x1b[5D":
        state = moveTo(state, previousWordStart(state.line, state.cursor));
        produced.push({ kind: "redraw" });
        return produced;
      case "\x1b[1;5C":
      case "\x1b[5C":
        state = moveTo(state, nextWordEnd(state.line, state.cursor));
        produced.push({ kind: "redraw" });
        return produced;
      case "\x1b[200~":
      case "\x1b[201~":
        return produced;
      case "\x1bb":
      case "\x1bB":
        state = moveTo(state, previousWordStart(state.line, state.cursor));
        produced.push({ kind: "redraw" });
        return produced;
      case "\x1bf":
      case "\x1bF":
        state = moveTo(state, nextWordEnd(state.line, state.cursor));
        produced.push({ kind: "redraw" });
        return produced;
      default:
        // Unknown escape: swallow it. It must never be typed as text.
        produced.push({ kind: "redraw" });
        return produced;
    }
  };

  let index = 0;
  while (index < input.length) {
    const ch = input[index];

    // ---- bracketed paste: insert the body literally -------------------------
    if (input.startsWith(PASTE_START, index)) {
      const end = input.indexOf(PASTE_END, index + PASTE_START.length);
      const body = end === -1 ? input.slice(index + PASTE_START.length) : input.slice(index + PASTE_START.length, end);
      const pasted = insertPrintable(state, body.replace(/\r\n?/g, " "));
      state = { ...pasted };
      actions.push({ kind: "redraw" });
      index = end === -1 ? input.length : end + PASTE_END.length;
      continue;
    }

    // ---- escape sequences ---------------------------------------------------
    if (ch === "\x1b") {
      const parsed = readEscapeSequence(input, index);
      if (!parsed) {
        // Incomplete sequence: stop here, the rest arrives in the next chunk.
        break;
      }
      index = parsed.next;
      const produced = applySequence(parsed.sequence);
      // A redraw already queued for this keystroke covers previous edits too.
      actions.push(...produced);
      continue;
    }

    // ---- control keys -------------------------------------------------------
    // The second half of a CRLF that arrived in the previous chunk.
    if (ch === "\n" && state.pendingCarriageReturn) {
      state = { ...state, pendingCarriageReturn: false };
      index += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      const wasCarriageReturn = ch === "\r";
      state = { ...state, pendingCarriageReturn: false };
      index += 1;
      // A pasted CRLF must not submit twice.
      if (ch === "\r" && input[index] === "\n") index += 1;
      const submitted = state.line;
      state = {
        ...state,
        line: "",
        cursor: 0,
        historyIndex: -1,
        draft: "",
        pendingCarriageReturn: wasCarriageReturn && index >= input.length,
      };
      actions.push({ kind: "submit", line: submitted });
      // Swallow the rest of a CRLF (or a pasted run of newlines) in this chunk.
      while (index < input.length && (input[index] === "\r" || input[index] === "\n")) {
        index += 1;
      }
      continue;
    }

    switch (ch) {
      case "\x7f":
      case "\b": {
        if (state.cursor > 0) {
          state = {
            ...state,
            line: state.line.slice(0, state.cursor - 1) + state.line.slice(state.cursor),
            cursor: state.cursor - 1,
          };
        }
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      }
      case "\x03": // Ctrl+C
        actions.push({ kind: "interrupt" });
        index += 1;
        continue;
      case "\x04": // Ctrl+D
        if (state.line.length === 0) {
          actions.push({ kind: "eof" });
          index += 1;
          continue;
        }
        break;
      case "\x01": // Ctrl+A
        state = moveTo(state, 0);
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      case "\x05": // Ctrl+E
        state = moveTo(state, state.line.length);
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      case "\x02": // Ctrl+B
        state = moveTo(state, state.cursor - 1);
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      case "\x06": // Ctrl+F
        state = moveTo(state, state.cursor + 1);
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      case "\x0b": // Ctrl+K — kill to end of line
        state = { ...state, line: state.line.slice(0, state.cursor) };
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      case "\x15": // Ctrl+U — kill the whole line
        state = { ...state, line: "", cursor: 0 };
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      case "\x17": { // Ctrl+W — kill previous word
        const start = previousWordStart(state.line, state.cursor);
        state = {
          ...state,
          line: state.line.slice(0, start) + state.line.slice(state.cursor),
          cursor: start,
        };
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      }
      case "\x0c": // Ctrl+L
        actions.push({ kind: "clear-screen" });
        index += 1;
        continue;
      case "\t": {
        // Tab is a literal tab: the remote shell's completion cannot run here.
        state = insertText(state, "\t");
        actions.push({ kind: "redraw" });
        index += 1;
        continue;
      }
      default:
        break;
    }

    // ---- printable text -----------------------------------------------------
    if (ch >= " " || ch === "\t") {
      const next = insertText(state, ch);
      if (next !== state) {
        state = next;
        actions.push({ kind: "redraw" });
      }
      index += 1;
      continue;
    }

    // Any other control byte is not text: swallow it rather than corrupt the line.
    index += 1;
  }

  return { state, actions };
}

/**
 * What the terminal must do to draw `state` again, given the prompt.
 *
 * Returns the escape sequence that returns the caret to the prompt column, then
 * redraws prompt + line and puts the cursor back where it belongs.
 */
export function redrawToText(promptText: string, state: LineEditorState): string {
  const tail = state.line.length - state.cursor;
  return `\r${promptText}${state.line}\x1b[0K${tail > 0 ? `\x1b[${tail}D` : ""}`;
}

/** Records a submitted command in the (bounded) history list. */
export function pushHistory(history: string[], command: string): void {
  const entry = command.replace(/[\r\n]+$/, "");
  if (!entry.trim()) return;
  if (history[history.length - 1] === entry) return; // no immediate duplicates
  history.push(entry);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}
