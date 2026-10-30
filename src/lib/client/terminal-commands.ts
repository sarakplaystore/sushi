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
