import type { Client, ClientChannel, SFTPWrapper } from "ssh2";
import { shellQuote } from "./ssh-client";

/**
 * "Auto sudo su" for SFTP.
 *
 * SFTP is spoken by `sftp-server`, which sshd starts **as the logged-in user** —
 * the protocol itself has no notion of privilege. The standard way to get root
 * over SFTP is to stop asking sshd for the SFTP subsystem and start the same
 * `sftp-server` binary ourselves through `sudo` on an exec channel. It keeps
 * speaking SFTP on stdin/stdout, so the whole file browser (list, read, write,
 * mkdir, rename, chmod, delete…) then runs as root, exactly like a shell where
 * you typed `sudo su`.
 *
 * The pieces that make this work, and the sharp edges handled here:
 *
 *  - ssh2 has no public API for "adopt this exec channel as an SFTP session", so
 *    the channel is handed to ssh2's own SFTP implementation by re-registering it
 *    in the client's channel table (see `adoptSftpChannel`). That keeps ssh2's
 *    window/backpressure and packet parser intact instead of re-implementing them.
 *  - The binary lives in different places (Debian/Ubuntu vs RHEL vs Arch) and is
 *    called `sftp-server` or `internal-sftp`; candidates plus `sshd -T` are probed.
 *  - `sudo` may need a password. `sudo -n` fails fast and the caller asks for one;
 *    with a password the remote side uses `sudo -A` (askpass) so stdin stays the
 *    SFTP channel — piping the password into stdin would feed sftp-server from the
 *    pipe instead of the browser.
 */

/** SFTP binaries, in the order they are probed on the remote host. */
export const SFTP_SERVER_CANDIDATES = [
  "/usr/lib/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/libexec/sftp-server",
  "/usr/lib64/openssh/sftp-server",
  "/usr/lib64/misc/sftp-server",
  "/usr/local/libexec/sftp-server",
  "/usr/local/lib/openssh/sftp-server",
  "/usr/lib/openssh/internal-sftp",
  "/usr/lib/ssh/internal-sftp",
  "/usr/libexec/openssh/internal-sftp",
  "/usr/libexec/internal-sftp",
  "/usr/lib64/openssh/internal-sftp",
  "/usr/local/libexec/internal-sftp",
  "/usr/lib/openssh/sftp-server-real",
] as const;

/**
 * Shell script that prints the SFTP server binary to use (one absolute path),
 * and nothing else. Runs as the login user without sudo: it only looks.
 */
export function buildSftpServerProbeScript(): string {
  const candidates = SFTP_SERVER_CANDIDATES.map((p) => shellQuote(p)).join(" ");
  return [
    "for p in " + candidates + "; do",
    '  [ -x "$p" ] && { echo "$p"; exit 0; }',
    "done",
    "# Fall back to sshd's own configuration (needs root; ignored when unavailable).",
    "if command -v sshd >/dev/null 2>&1; then",
    "  p=$(sshd -T 2>/dev/null | awk '$1==\"subsystem\" && $2==\"sftp\" { $1=\"\"; $2=\"\"; sub(/^[ \\t]+/, \"\"); print; exit }')",
    '  if [ -n "$p" ]; then',
    '    case "$p" in',
    '      internal-sftp) for q in /usr/lib/openssh/internal-sftp /usr/libexec/openssh/internal-sftp /usr/lib/ssh/internal-sftp; do [ -x "$q" ] && { echo "$q"; exit 0; }; done ;;',
    '      /*) [ -x "$p" ] && { echo "$p"; exit 0; } ;;',
    "    esac",
    "  fi",
    "fi",
    "exit 1",
  ].join("\n");
}

/**
 * Picks the first usable path out of the probe output. The output comes from the
 * remote host, so only absolute, whitespace-free `…sftp…` paths are accepted.
 */
export function parseSftpServerProbe(output: string): string | null {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^\/[A-Za-z0-9/._+-]+$/.test(line)) continue;
    if (!/(?:sftp-server|internal-sftp)$/.test(line)) continue;
    return line;
  }
  return null;
}

/**
 * Probe run once per connection: which sudo flavour is available?
 *
 * `-n true` answers the only question that matters up front — does root work
 * without a password (root login, NOPASSWD, or an active sudo timestamp)? — and
 * `-v -n` tells "needs a password" apart from "not allowed to run sudo at all".
 */
export const SFTP_SUDO_PROBE_SCRIPT = [
  "if ! command -v sudo >/dev/null 2>&1; then echo SUSHI_SUDO_MISSING; exit 0; fi",
  "if sudo -n true 2>/dev/null; then echo SUSHI_SUDO_OK; exit 0; fi",
  "echo SUSHI_SUDO_NEEDS_PASSWORD",
].join("\n");

export type SudoProbeResult =
  /** `sudo` works right now without a password. */
  | { status: "ok" }
  /** `sudo` exists but wants a password. */
  | { status: "needs-password" }
  /** No `sudo` binary at all (or a broken one). */
  | { status: "missing"; detail?: string };

export function parseSudoProbe(output: string, stderr = ""): SudoProbeResult {
  if (/SUSHI_SUDO_OK/.test(output)) return { status: "ok" };
  if (/SUSHI_SUDO_MISSING/.test(output)) return { status: "missing", detail: stderr.trim() || undefined };
  if (/SUSHI_SUDO_NEEDS_PASSWORD/.test(output)) return { status: "needs-password" };
  const detail = (stderr || output).trim().split(/\r?\n/).filter(Boolean).pop();
  return { status: "missing", detail };
}

export interface SftpElevationOptions {
  /** Run as this user (default root). */
  user?: string;
  /** sudo password, when the server asks for one. */
  password?: string;
  /** umask for new files (default 0002, like a normal `sudo su` shell). */
  umask?: string;
}

/**
 * The remote command that becomes the SFTP server.
 *
 * Two details are load-bearing:
 *
 *  - **Nothing may be written to stdout.** stdout *is* the SFTP channel: one stray
 *    byte ("sudo: a password is required", a shell error) desynchronises the packet
 *    parser and every later request dies with "Packet length … exceeds max length".
 *    All diagnostics therefore go to stderr.
 *  - **The password must not travel over stdin.** `sudo -S` reads the password
 *    from stdin, and sudo's child inherits that same stdin — sftp-server would then
 *    read a pipe instead of the browser's SFTP traffic. A password is answered by
 *    sudo's askpass helper instead: a 0700 script in `/tmp` that prints it once and
 *    deletes itself.
 */
export function buildSftpElevationScript(
  serverPathExpr: string,
  options: SftpElevationOptions = {}
): string {
  const user = (options.user || "root").trim() || "root";
  const userFlag = user === "root" ? "" : ` -u ${shellQuote(user)}`;
  const umask = options.umask || "0002";
  // The standalone binary takes `-u <umask>`; `internal-sftp` takes no flags.
  const flagSetup = [
    "__sushi_flags='-u " + umask + "'",
    `case "${serverPathExpr}" in *internal-sftp) __sushi_flags="" ;; esac`,
  ];
  if (!options.password) {
    // `-n`: never prompt. When a password is needed sudo exits at once with
    // "sudo: a password is required" on stderr, and the route reports that
    // instead of the channel hanging on a prompt nobody is reading.
    return [
      ...flagSetup,
      `exec sudo -n${userFlag} -- "${serverPathExpr}" $__sushi_flags`,
    ].join("\n");
  }

  const pw = shellQuote(options.password);
  // `printf 'printf "%s\\n" <pw>'` would print the password *unquoted* (spaces
  // split the argument, quotes get eaten), so the helper is written with a quoted
  // heredoc instead: the shell expands the password once, and the generated script
  // only ever does `printf "%s\\n" "<password>"` with literal quoting.
  return [
    "umask 077",
    "__sushi_ask=/tmp/.sushi-askpass-$$",
    // The helper prints the password and deletes itself first, so it cannot
    // outlive a single sudo call. Mode 0700, owned by the login user.
    "cat > \"$__sushi_ask\" <<'SUSHI_ASKPASS_EOF' || exit 1",
    "#!/bin/sh",
    'rm -f -- "$0"',
    // The heredoc is quoted, so this line lands in the helper verbatim.
    "printf '%s\\n' " + pw,
    "SUSHI_ASKPASS_EOF",
    'chmod 700 "$__sushi_ask" || exit 1',
    ...flagSetup,
    'SUDO_ASKPASS="$__sushi_ask" exec sudo -A' +
      userFlag +
      ' -- "' +
      serverPathExpr +
      '" $__sushi_flags',
  ].join("\n");
}

/**
 * Full remote command for an elevated SFTP session: locate the sftp-server binary,
 * then hand the channel to it through sudo. Nothing is printed to stdout.
 */
export function buildElevatedSftpCommand(options: SftpElevationOptions = {}): string {
  const candidates = SFTP_SERVER_CANDIDATES.map((p) => shellQuote(p)).join(" ");
  return [
    `__sushi_server=$(for p in ${candidates}; do [ -x "$p" ] && { echo "$p"; break; }; done)`,
    'if [ -z "$__sushi_server" ]; then echo "Sushi: no sftp-server binary found on this host." >&2; exit 127; fi',
    buildSftpElevationScript("$__sushi_server", options),
  ].join("\n");
}

/** ssh2 channel internals the SFTP session needs to adopt an existing channel. */
interface ChannelInternals {
  /** Local (client-side) channel id — the key in the client's channel table. */
  localId: number;
  /** Remote (server-side) channel id, used when sending packets. */
  remoteId: number;
  window: number;
  packetSize: number;
  stderr: ClientChannel["stderr"];
}

function readChannelInternals(stream: ClientChannel): ChannelInternals {
  const internals = stream as unknown as {
    incoming: { id: number; window: number; packetSize: number };
    outgoing: { id: number; window: number; packetSize: number };
    stderr: ClientChannel["stderr"];
  };
  if (!internals?.incoming || !internals?.outgoing) {
    throw new Error("ssh2 channel internals unavailable — cannot run SFTP through sudo.");
  }
  return {
    localId: internals.incoming.id,
    remoteId: internals.outgoing.id,
    window: internals.outgoing.window,
    packetSize: internals.outgoing.packetSize,
    stderr: internals.stderr,
  };
}

/**
 * Loads ssh2's own SFTP implementation.
 *
 * It is not exported from the package root (only the `SFTPWrapper` type is), and
 * there is no public way to adopt a channel that ssh2 did not create as SFTP. The
 * module path is stable across ssh2 1.x; if it ever moves, `openElevatedSftp`
 * falls back to a normal (unelevated) session instead of breaking the browser.
 */
function loadSftpImplementation(): {
  SFTP: new (client: Client, chanInfo: unknown, cfg?: object) => SFTPWrapper;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("ssh2/lib/protocol/SFTP.js") as {
      SFTP?: new (client: Client, chanInfo: unknown, cfg?: object) => SFTPWrapper;
    };
    return mod?.SFTP ? { SFTP: mod.SFTP } : null;
  } catch {
    return null;
  }
}

/**
 * Stops an adopted `ClientChannel`'s own stream bookkeeping.
 *
 * ssh2 pipes every session channel's data through a `Duplex` so `stream.write()`
 * works; the SFTP parser bypasses that and writes packet bytes directly to the
 * channel, so the duplex is not needed and is actively harmful: it is still
 * attached to the client and ending it (or letting it see the channel close)
 * ends the socket, tearing down every other channel on the connection.
 */
function detachChannelStream(stream: ClientChannel): void {
  const ch = stream as unknown as {
    _readableState?: { push: (chunk: unknown) => void };
    _writableState?: object;
    _write?: unknown;
    _final?: unknown;
    _read?: unknown;
    push?: unknown;
    on?: unknown;
    once?: unknown;
    emit?: unknown;
  };
  // Never called by the SFTP parser, but a stray end()/destroy() would otherwise
  // still reach ssh2's finish/close handlers.
  ch._readableState = undefined;
  ch._writableState = undefined;
  ch._write = undefined;
  ch._final = undefined;
  ch._read = undefined;
}

export interface ElevatedSftpSession {
  sftp: SFTPWrapper;
  /** sudo / sftp-server diagnostics collected from stderr (never sent to SFTP). */
  diagnostics: () => string;
  /** Closes the exec channel. */
  close: () => Promise<void>;
}

/**
 * Opens an SFTP session that runs as another user, over an exec channel.
 *
 * Returns `null` when ssh2's internals cannot be adopted — the caller then keeps
 * the ordinary, unelevated SFTP session instead of failing the whole file browser.
 */
export async function openElevatedSftp(
  client: Client,
  command: string,
  options: {
    timeoutMs?: number;
    debug?: (message: string) => void;
    /** Environment for the remote shell (the askpass password travels here). */
    env?: Record<string, string>;
  } = {}
): Promise<ElevatedSftpSession | null> {
  const impl = loadSftpImplementation();
  if (!impl) {
    options.debug?.("elevated SFTP unavailable: ssh2 SFTP implementation not found");
    return null;
  }

  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    client.exec(
      command,
      options.env ? { env: options.env as NodeJS.ProcessEnv } : {},
      (err, channel) => (err ? reject(err) : resolve(channel))
    );
  });

  let stderrText = "";
  const collect = (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
    if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
    options.debug?.(chunk.toString("utf8"));
  };
  stream.stderr.on("data", collect);

  let internals: ChannelInternals;
  try {
    internals = readChannelInternals(stream);
  } catch (err) {
    stream.close();
    throw err;
  }

  // Hand the exec channel's traffic to an SFTP parser. Registering the new
  // instance in the client's channel table is what routes CHANNEL_DATA /
  // WINDOW_ADJUST / EOF / CLOSE to it, so ssh2's flow control keeps working.
  const chanInfo = {
    type: "session",
    incoming: {
      id: internals.localId,
      window: internals.window,
      packetSize: internals.packetSize,
      state: "open",
    },
    outgoing: {
      id: internals.remoteId,
      window: internals.window,
      packetSize: internals.packetSize,
      state: "open",
    },
  };

  const sftp = new impl.SFTP(client, chanInfo, {
    debug: options.debug,
  }) as SFTPWrapper & { stderr: ClientChannel["stderr"]; _init: () => void };

  // sudo and sftp-server complain on stderr; keep it readable instead of the
  // no-op sink ssh2 installs by default, so failures can be explained.
  sftp.stderr = internals.stderr;

  const chanMgr = (client as unknown as {
    _chanMgr?: { update: (id: number, value: unknown) => void; get: (id: number) => unknown };
  })._chanMgr;
  if (!chanMgr || chanMgr.get(internals.localId) !== stream) {
    stream.close();
    throw new Error("ssh2 channel table unavailable — cannot run SFTP through sudo.");
  }
  chanMgr.update(internals.localId, sftp);

  // The Channel is now unreferenced by the client: its duplex machinery must stop
  // reacting to the channel's end/close events, or finishing the session (which
  // closes the channel) would end the socket underneath it and kill the whole
  // SSH connection — the next request would fail with "Not connected". Only the
  // `exit` / `close` events are wanted, and they are wired by the client itself.
  detachChannelStream(stream);

  const timeoutMs = options.timeoutMs ?? 15000;
  const init = await new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sftp.removeListener("ready", onReady);
      sftp.removeListener("error", onError);
      stream.removeListener("close", onClose);
      resolve(result);
    };
    const onReady = () => finish({ ok: true });
    const onError = (err: Error) => finish({ ok: false, error: err });
    const onClose = () =>
      finish({
        ok: false,
        error: new Error(stderrText.trim() || "The elevated SFTP channel closed before it started."),
      });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: new Error(
            stderrText.trim() ||
              "sudo did not start the SFTP server in time (wrong password, or sudo needs a terminal)."
          ),
        }),
      timeoutMs
    );
    sftp.once("ready", onReady);
    sftp.once("error", onError);
    stream.once("close", onClose);
    try {
      sftp._init();
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err : new Error(String(err)) });
    }
  });

  if (!init.ok) {
    stream.close();
    throw new Error(describeElevationFailure(init.error.message, stderrText));
  }

  return {
    sftp,
    diagnostics: () => stderrText,
    close: async () => {
      // Close the channel through the SFTP session (which sends CHANNEL_CLOSE on
      // the channel id and marks it closed) and wait for the server to answer.
      // Calling the abandoned Channel's own close()/destroy() here would end the
      // client's socket instead.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        stream.once("close", finish);
        try {
          sftp.end();
        } catch {
          finish();
        }
      });
    },
  };
}

/**
 * Turns sudo's own words into something the file browser can show. The raw text
 * is precise but written for a terminal ("sudo: a terminal is required…").
 */
export function describeElevationFailure(raw: string, stderr = ""): string {
  const probe = `${raw}\n${stderr}`;
  if (/not in the sudoers|may not run sudo|is not allowed to execute/i.test(probe)) {
    return "This user is not allowed to run sudo on the server, so SFTP cannot run as root. Ask an administrator to grant sudo (or connect as root with a key).";
  }
  if (/a password is required|no tty present|a terminal is required/i.test(probe)) {
    return "sudo needs a password on this server. Enter the sudo password to browse files as root.";
  }
  if (/incorrect password|Sorry, try again|authentication failure|no password was provided/i.test(probe)) {
    return "Incorrect sudo password — SFTP is still running as your login user.";
  }
  if (/no sftp-server binary|command not found|No such file or directory/i.test(probe)) {
    return "Could not find the SFTP server binary on this host, so SFTP cannot be elevated. Files are still browsable as your login user.";
  }
  for (const line of probe.split(/\r?\n/).map((l) => l.trim()).reverse()) {
    // SFTP protocol noise (binary) is not a useful message.
    if (!line || /[\x00-\x08\x0e-\x1f]/.test(line)) continue;
    return `Could not start SFTP as root: ${line}`;
  }
  return "Could not start SFTP as root.";
}
