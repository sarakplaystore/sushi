/**
 * Parsing helpers for Sushi's Serverless SSH shell (used on Vercel, where every
 * command is a separate exec and no keystrokes can be forwarded).
 *
 * The shell emulates the interactive things people actually type: `sudo su` /
 * `sudo -i` switch the session to root (each following command runs through sudo),
 * a bare `sudo <command>` is elevated, and `exit` leaves root mode. Anything that
 * genuinely needs a terminal (vim, top, tmux, a bare REPL ...) is reported clearly
 * instead of hanging.
 */

/** Full-screen TUIs that can never work without a live, keystroke-forwarding PTY. */
const FULLSCREEN_PROGRAMS = new Set([
  "vim", "vi", "nvim", "view", "vimdiff", "nano", "pico", "emacs", "joe", "micro",
  "mcedit", "ne", "less", "more", "most", "top", "htop", "btop", "atop", "iotop",
  "iftop", "nload", "nethogs", "glances", "ctop", "nvtop", "tmux", "screen", "byobu",
  "mc", "ranger", "nnn", "vifm", "ncdu", "tig", "lazygit", "lazydocker", "k9s",
  "nmtui", "alsamixer", "cfdisk", "mutt", "neomutt", "irssi", "weechat", "w3m",
  "lynx", "watch", "visudo", "vipw", "vigr", "sudoedit",
]);

/** Shells / REPLs that only become interactive when started without arguments. */
const BARE_INTERACTIVE_PROGRAMS = new Set([
  "bash", "sh", "zsh", "fish", "dash", "ksh", "python", "python3", "ipython", "node",
  "irb", "php", "mysql", "mariadb", "psql", "redis-cli", "mongo", "mongosh",
  "sqlite3", "ssh", "telnet", "ftp", "sftp", "su",
]);

/** Programs that log in as root when run bare (handled by the elevation parser). */
const ROOT_SHELLS = new Set(["su", "bash", "sh", "zsh", "fish", "dash", "ksh"]);

const COMMAND_WRAPPERS = new Set(["sudo", "doas", "exec", "nohup", "time", "command", "env"]);
const SUDO_FLAGS_WITH_VALUE = new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D"]);

export type ElevationCommand =
  /** `sudo su`, `sudo -i`, `sudo bash` ... → switch the session to root. */
  | { kind: "enter-root" }
  /** `exit` / `logout` → leave root mode (or close the session when not root). */
  | { kind: "leave-root" }
  /** Bare `su` → needs the root account password, which Sushi cannot collect safely. */
  | { kind: "su-needs-root-password" }
  /** `sudo <command>` → run that command elevated. */
  | { kind: "sudo"; command: string; asUser: string };

/**
 * Classifies an interactive shell builtin typed into the serverless shell.
 * Returns null for ordinary commands (which are simply executed).
 */
export function parseElevationCommand(input: string): ElevationCommand | null {
  const command = input.trim().replace(/[;\s]+$/, "");
  if (!command) return null;
  if (command === "exit" || command === "logout") return { kind: "leave-root" };
  if (/^!/.test(command)) return null; // `sudo !!` needs the real shell's history

  const words = command.split(/\s+/);
  const isSudo = words[0] === "sudo";
  const args = isSudo ? words.slice(1) : words;

  // ---- root shells: su / sudo su / sudo -i / sudo bash --------------------
  if (!isSudo && args[0] === "su") {
    const target = args.slice(1).find((w) => !w.startsWith("-"));
    if (!target || target === "root") return { kind: "su-needs-root-password" };
    return null; // switching to another user needs that account's password
  }

  if (isSudo) {
    // Collect sudo options, remembering `-u <user>`
    let asUser = "root";
    let index = 0;
    const wantsShellFlags = new Set<string>();
    while (index < args.length && args[index].startsWith("-")) {
      const flag = args[index];
      if (flag === "-u" || flag === "--user") {
        asUser = args[index + 1] || "root";
        index += 2;
        continue;
      }
      if (flag.startsWith("--user=")) {
        asUser = flag.slice("--user=".length);
        index += 1;
        continue;
      }
      if (flag === "--") {
        index += 1;
        break;
      }
      if (
        flag === "--login" ||
        flag === "--shell" ||
        flag === "-i" ||
        flag === "-s" ||
        /^-[A-Za-z]*[is][A-Za-z]*$/.test(flag)
      ) {
        wantsShellFlags.add(flag);
      } else if (SUDO_FLAGS_WITH_VALUE.has(flag)) {
        index += 2;
        continue;
      }
      index += 1;
    }

    const target = args[index];
    const rest = args.slice(index + 1);
    const targetBare = (target || "").replace(/^-{1,2}\w*$/, "");

    if (!target) {
      // `sudo -i`, `sudo -s`, `sudo` → just asks for a password; nothing to elevate
      return wantsShellFlags.size > 0 ? { kind: "enter-root" } : null;
    }
    if (target === "su") {
      const suTarget = rest.find((w) => !w.startsWith("-"));
      if (!suTarget || suTarget === "root") return { kind: "enter-root" };
      return null;
    }
    if (ROOT_SHELLS.has(targetBare) && rest.every((w) => w.startsWith("-"))) {
      return { kind: "enter-root" };
    }
    if (wantsShellFlags.size > 0 && !target) return { kind: "enter-root" };
    if (target.startsWith("-")) return null; // e.g. sudo -l, sudo -v, sudo -k
    return { kind: "sudo", command: [target, ...rest].join(" "), asUser };
  }

  return null;
}

/**
 * Returns the program name when `command` would start an interactive full-screen
 * program (vim, top, less, a bare REPL ...) that serverless SSH cannot drive.
 */
export function detectInteractiveProgram(command: string): string | null {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (
      words.length > 0 &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || COMMAND_WRAPPERS.has(words[0]))
    ) {
      const wrapper = words.shift();
      if (wrapper === "sudo" || wrapper === "doas") {
        while (words.length > 0 && words[0].startsWith("-")) {
          const flag = words.shift() as string;
          if (SUDO_FLAGS_WITH_VALUE.has(flag)) words.shift();
        }
      }
    }
    if (words.length === 0) continue;
    const program = (words[0].replace(/^\\/, "").split("/").pop() || "").toLowerCase();
    const args = words.slice(1);
    if (program === "top" && args.some((a) => /^-\w*b/.test(a))) continue; // batch mode
    if (FULLSCREEN_PROGRAMS.has(program)) return program;
    if (program === "crontab" && args.includes("-e")) return "crontab -e";
    if (program === "systemctl" && args[0] === "edit") return "systemctl edit";
    if (BARE_INTERACTIVE_PROGRAMS.has(program) && args.length === 0) {
      // su / sudo su are handled by the elevation parser before we get here
      return program;
    }
  }
  return null;
}

/** sudo writing "a password is required" (we always try `-n` first). */
export const SUDO_NEEDS_PASSWORD_RE =
  /a password is required|no tty present|a terminal is required|sudo:.*password/i;

/** sudo after a wrong password. */
export const SUDO_WRONG_PASSWORD_RE =
  /incorrect password attempt|sorry, try again|authentication failure/i;

export const PASSWORD_PROMPT_RE = /(?:password|passphrase|passcode)[^\r\n]{0,60}:\s*$/i;
export const CONFIRM_PROMPT_RE = /\[(?:Y\/n|y\/N|yes\/no|Y\/N)\]\s*\??\s*$/;

// ---------------------------------------------------------------------------
// Full-screen terminal menus (whiptail / dialog / debconf / ncurses)
// ---------------------------------------------------------------------------

/**
 * Raw terminal keys. Menus only ever see key presses — there is no line to type —
 * which is exactly why a plain `[Y/n]` answer bar cannot drive one.
 */
export const MENU_KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
  enter: "\r",
  space: " ",
  escape: "\x1b",
  backspace: "\x7f",
} as const;

export interface FullscreenMenuItem {
  label: string;
  /** `(*)` / `[X]` in the box. */
  selected: boolean;
  kind: "radio" | "check";
}

export interface FullscreenMenu {
  /** Title from `┤ Configuring lightdm ├` ("" when the box has none). */
  title: string;
  /** Body lines of the box, without the border and the labels. */
  message: string;
  kind: "select" | "checklist" | "confirm" | "box";
  items: FullscreenMenuItem[];
  /** `<Ok>` → "Ok". Left to right, which is also the Tab order. */
  buttons: string[];
}

const DEFAULT_BUTTONS = ["Ok", "Cancel"];

function cleanLabel(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\u2500-\u257f|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recognises the box whiptail / debconf / ncurses draw on screen.
 *
 * Call it with the tail of the command's output: the *last* box wins, because a
 * redraw only repeats the same box while an earlier one is already answered.
 * Returns null for ordinary text, so it is safe to run on every chunk.
 */
export function detectFullscreenMenu(text: string): FullscreenMenu | null {
  if (!text) return null;
  const tail = text.slice(-8000);
  const start = tail.lastIndexOf("\u250c"); // ┄ box drawing "┌"
  const hasChrome =
    start !== -1 ||
    tail.includes("\u2514") || // └
    tail.includes("\u2524"); // ┤
  const scanned = start !== -1 ? tail.slice(start) : tail.slice(-3000);

  const buttons: string[] = [];
  for (const match of scanned.matchAll(/<\s*([A-Za-z][A-Za-z0-9 _-]{0,20}?)\s*>/g)) {
    const label = match[1].trim();
    if (label && !buttons.some((b) => b.toLowerCase() === label.toLowerCase())) {
      buttons.push(label);
    }
  }

  const items: FullscreenMenuItem[] = [];
  // `(*)` radio lists, `[*]` / `[X]` check lists (newt draws a selected checkbox as
  // `[*]`, the old dialog frontend uses `[X]`).
  for (const match of scanned.matchAll(/(\(\*\)|\( \)|\[\*\]|\[[Xx ]\])\s*([^\x1b\r\n]{1,80})/g)) {
    const marker = match[1];
    const label = cleanLabel(match[2]);
    if (!label) continue;
    items.push({
      label,
      selected: marker === "(*)" || marker === "[*]" || marker === "[X]" || marker === "[x]",
      kind: marker.startsWith("[") ? "check" : "radio",
    });
  }

  if (!hasChrome && buttons.length === 0 && items.length === 0) return null;
  if (buttons.length === 0 && items.length === 0) return null;

  const titleMatch = /[\u2524|]\s*([^\u251c|\r\n\x1b]{1,70}?)\s*[\u251c|]/.exec(scanned);
  const title = titleMatch ? cleanLabel(titleMatch[1]) : "";
  const message = cleanLabel(
    scanned
      .split(/\r?\n/)
      .filter((line) => /[\u2502|]/.test(line) && !/\(\*\)|\( \)|\[X\]|\[ \]|<\w/.test(line))
      .join(" ")
  ).slice(0, 400);

  const lowerButtons = buttons.map((b) => b.toLowerCase());
  const kind: FullscreenMenu["kind"] =
    items.length === 0
      ? lowerButtons.includes("yes") || lowerButtons.includes("no")
        ? "confirm"
        : "box"
      : items.some((item) => item.kind === "check")
        ? "checklist"
        : "select";

  return {
    title,
    message,
    kind,
    items,
    buttons: buttons.length > 0 ? buttons : DEFAULT_BUTTONS,
  };
}

/**
 * Keys that pick `index` in a whiptail/newt list.
 *
 * Newt starts on the entry that is already selected, so the arrows are relative to
 * that one; Space toggles it and Enter presses the default button (`<Ok>`).
 */
export function menuSelectKeys(menu: FullscreenMenu, index: number): string {
  if (index < 0 || index >= menu.items.length) return "";
  const current = Math.max(
    0,
    menu.items.findIndex((item) => item.selected)
  );
  const delta = index - current;
  let keys = delta >= 0 ? MENU_KEY.down.repeat(delta) : MENU_KEY.up.repeat(-delta);
  keys += MENU_KEY.space;
  keys += MENU_KEY.enter;
  return keys;
}

/** Keys that press one of the box's buttons (left to right = Tab order). */
export function menuButtonKeys(menu: FullscreenMenu, label: string): string {
  const index = menu.buttons.findIndex((b) => b.toLowerCase() === label.toLowerCase());
  if (index <= 0) return MENU_KEY.enter; // <Ok> / <Yes> is the default button
  return MENU_KEY.tab.repeat(index) + MENU_KEY.enter;
}

/**
 * Splits typed terminal input into printable/editing characters and escape
 * sequences (arrows, Home/End, function keys, Delete …).
 *
 * Without this, an arrow key pressed while a serverless command runs with no live
 * stdin used to fall through as the literal text "[B" — which the shell then tried
 * to execute ("[B[B[A: not found") — and a whiptail box could never be answered.
 */
export function splitTerminalInput(data: string): { text: string; sequences: string[] } {
  let text = "";
  const sequences: string[] = [];

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch !== "\x1b") {
      text += ch;
      continue;
    }
    const next = data[i + 1];
    if (next === "[") {
      // CSI: parameters/intermediate bytes, then one final byte in @-~
      let j = i + 2;
      while (j < data.length && /[0-9;:?<=>]/.test(data[j])) j += 1;
      while (j < data.length && /[ -/]/.test(data[j])) j += 1;
      if (j < data.length) {
        sequences.push(data.slice(i, j + 1));
        i = j;
      } else {
        sequences.push(data.slice(i));
        i = data.length;
      }
      continue;
    }
    if (next === "O") {
      // SS3: ESC O <final>
      if (i + 2 < data.length) {
        sequences.push(data.slice(i, i + 3));
        i += 2;
      } else {
        sequences.push(data.slice(i));
        i = data.length;
      }
      continue;
    }
    if (next === "]") {
      // OSC: terminated by BEL or ST
      let j = i + 2;
      while (j < data.length && data[j] !== "\x07" && !(data[j] === "\x1b" && data[j + 1] === "\\")) {
        j += 1;
      }
      const end = data[j] === "\x07" ? j + 1 : data[j] === "\x1b" ? j + 2 : data.length;
      sequences.push(data.slice(i, end));
      i = end - 1;
      continue;
    }
    // A lone ESC (or ESC + one character): Alt+key / menu escape
    if (next && /[a-zA-Z]/.test(next)) {
      sequences.push(data.slice(i, i + 2));
      i += 1;
    } else {
      sequences.push(data.slice(i, i + 1));
    }
  }

  return { text, sequences };
}
