import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SFTP_SERVER_CANDIDATES,
  SFTP_SUDO_PROBE_SCRIPT,
  buildElevatedSftpCommand,
  buildSftpElevationScript,
  buildSftpServerProbeScript,
  describeElevationFailure,
  parseSftpServerProbe,
  parseSudoProbe,
} from "../src/lib/server/sftp-elevation";
import { shellQuote } from "../src/lib/server/ssh-client";

console.log("==> Testing 'auto sudo su' for SFTP (root file access through sudo)...");

// ---- sudo capability probe ------------------------------------------------------
assert.deepEqual(parseSudoProbe("SUSHI_SUDO_OK\n"), { status: "ok" });
assert.deepEqual(parseSudoProbe("SUSHI_SUDO_NEEDS_PASSWORD\n"), { status: "needs-password" });
assert.equal(parseSudoProbe("SUSHI_SUDO_MISSING\n").status, "missing");
// A broken sudo (present but unusable) must not be reported as "needs a password".
assert.equal(parseSudoProbe("", "sudo: /etc/sudoers is mode 0640").status, "missing");
assert.equal(parseSudoProbe("noise").status, "missing");

// The probe is what decides "just do it" vs "ask for a password", so it must never
// claim root works when it does not: `sudo -n true` is the only success signal.
assert.ok(SFTP_SUDO_PROBE_SCRIPT.includes("sudo -n true"));
assert.ok(/SUSHI_SUDO_MISSING/.test(SFTP_SUDO_PROBE_SCRIPT));
assert.ok(/SUSHI_SUDO_NEEDS_PASSWORD/.test(SFTP_SUDO_PROBE_SCRIPT));

// ---- sftp-server binary discovery ----------------------------------------------
assert.equal(parseSftpServerProbe("/usr/lib/openssh/sftp-server\n"), "/usr/lib/openssh/sftp-server");
assert.equal(parseSftpServerProbe("/usr/libexec/openssh/internal-sftp\n"), "/usr/libexec/openssh/internal-sftp");
// Only absolute, whitespace-free, sftp-ish paths may be trusted: this output comes
// from the remote host and is embedded into a shell command.
assert.equal(parseSftpServerProbe("/etc/passwd"), null);
assert.equal(parseSftpServerProbe("sftp-server"), null);
assert.equal(parseSftpServerProbe("/usr/bin/sftp-server extra"), null);
assert.equal(parseSftpServerProbe("/usr/bin/rm"), null);
assert.equal(parseSftpServerProbe(""), null);

const probeScript = buildSftpServerProbeScript();
for (const candidate of SFTP_SERVER_CANDIDATES) {
  assert.ok(probeScript.includes(shellQuote(candidate)), `probe covers ${candidate}`);
}
assert.ok(probeScript.includes("sshd -T"), "falls back to sshd's configured subsystem");
assert.ok(probeScript.trimEnd().endsWith("exit 1"), "probe exits non-zero when nothing is found");
// /sbin is often not in PATH for non-root logins; the probe must not rely on PATH.
assert.ok(!/^\s*command -v sftp-server/m.test(probeScript));

// ---- the command that becomes the SFTP server ----------------------------------
const pwless = buildSftpElevationScript("/usr/lib/openssh/sftp-server");
assert.ok(pwless.includes("sudo -n"), "passwordless elevation never prompts");
assert.ok(pwless.includes('-- "/usr/lib/openssh/sftp-server"'), "binary is quoted");
assert.ok(pwless.includes("-u 0002"), "new files are group-writable like a sudo su shell");
// stdout is the SFTP channel: a redirect there corrupts every packet.
assert.ok(!/>\s*&?1|2>&1/.test(pwless), "nothing is redirected into stdout");

// `internal-sftp` rejects sftp-server's flags, so the umask flag is only set on
// the standalone binary — decided at runtime, because the path is resolved there.
const internal = buildSftpElevationScript("/usr/libexec/openssh/internal-sftp");
assert.ok(internal.includes("*internal-sftp) __sushi_flags=\"\""), "internal-sftp gets no flags");
assert.ok(internal.includes("__sushi_flags='-u 0002'"), "standalone binary gets the umask flag");

const withPw = buildSftpElevationScript("/usr/lib/openssh/sftp-server", { password: "p@ss w0rd" });
assert.ok(withPw.includes("sudo -A"), "a password is answered through askpass (stdin stays SFTP)");
assert.ok(!withPw.includes("sudo -S"), "password must never be piped into sudo's stdin");
assert.ok(!/-p ''/.test(withPw), "askpass needs no prompt suppression trick");
assert.ok(withPw.includes("SUDO_ASKPASS"), "askpass helper is wired up");
assert.ok(withPw.includes("rm -f -- \"$0\""), "the helper deletes itself after one use");
assert.ok(withPw.includes(shellQuote("p@ss w0rd")), "the password is shell-quoted");
assert.ok(!withPw.includes("p@ss w0rd\n"), "the password is not written unquoted into the script");

// A password containing quotes/backslashes must survive the generated heredoc and
// end up in the helper as a single quoted word.
const nasty = `a'b"c\\d $HOME \`id\``;
const nastyScript = buildSftpElevationScript("/usr/lib/openssh/sftp-server", { password: nasty });
assert.ok(nastyScript.includes(shellQuote(nasty)), "hostile password is fully quoted");
assert.ok(!nastyScript.includes("SUSHI_ASKPASS_EOF\n" + nasty), "password cannot escape the heredoc");

// A non-root sudo target gets `-u`.
const asUser = buildSftpElevationScript("/usr/lib/openssh/sftp-server", { user: "deploy" });
assert.ok(asUser.includes("-u 'deploy'"), "sudo -u for non-root elevation targets");

// ---- full command ---------------------------------------------------------------
const full = buildElevatedSftpCommand();
assert.ok(full.startsWith("__sushi_server=$(for p in "), "resolves the binary first");
assert.ok(full.includes('if [ -z "$__sushi_server" ]'), "gives up with a message when missing");
assert.ok(full.includes("exit 127"), "exit code distinguishes a missing binary");
assert.ok(full.includes(">&2"), "diagnostics go to stderr only");
assert.equal((full.match(/exec /g) || []).length, 1, "exactly one exec (no doubled 'exec exec')");
assert.ok(!full.includes("2>&1"), "no stdout pollution in the full command");

const fullPw = buildElevatedSftpCommand({ password: "secret" });
assert.ok(fullPw.includes("sudo -A"), "full command with password uses askpass");
assert.ok(!fullPw.includes("2>&1"), "full command with password stays clean on stdout");

// ---- failure messages -----------------------------------------------------------
assert.match(
  describeElevationFailure("Sorry, user bob is not in the sudoers file."),
  /not allowed to run sudo/
);
assert.match(describeElevationFailure("sudo: a password is required"), /needs a password/);
assert.match(describeElevationFailure("sudo: no tty present and no askpass program specified"), /needs a password/);
assert.match(describeElevationFailure("", "Sorry, try again."), /Incorrect sudo password/);
assert.match(describeElevationFailure("", "sudo: sftp-server: command not found"), /SFTP server binary/);
// Binary SFTP chatter must never be shown as an error message.
const noisy = describeElevationFailure("\u0000\u0001\u0003garbage\u0000");
assert.ok(!/[\u0000-\u0008]/.test(noisy), "control bytes are stripped from the message");
// A concrete cause is passed through so the user can act on it.
assert.match(describeElevationFailure("", "sudo: unable to resolve host web1"), /unable to resolve host web1/);

// ---- the routes/UI actually use it ---------------------------------------------
const repoRoot = resolve(import.meta.dirname, "..");
const sshClient = readFileSync(resolve(repoRoot, "src/lib/server/ssh-client.ts"), "utf8");
assert.ok(sshClient.includes("withSftpAccess"), "ssh-client exposes the elevated session helper");
assert.ok(sshClient.includes("buildElevatedSftpCommand"), "ssh-client builds the elevated command");
assert.ok(sshClient.includes("parseSudoProbe"), "ssh-client checks sudo before elevating");
// Elevation must degrade, never fail the file browser.
assert.ok(/elevationError/.test(sshClient), "ssh-client reports why elevation failed");
assert.ok(
  sshClient.includes("await openPlainSftp(session.client)"),
  "falls back to sshd's own SFTP subsystem"
);

const listRoute = readFileSync(resolve(repoRoot, "src/app/api/sftp/list/route.ts"), "utf8");
assert.ok(listRoute.includes("sftpListDirectory"), "list route uses the shared helper");

const browser = readFileSync(resolve(repoRoot, "src/components/SftpBrowserSession.tsx"), "utf8");
assert.ok(browser.includes("sftpElevate"), "the file browser sends the elevation flag");
assert.ok(browser.includes("toggleElevation"), "the file browser has a root-mode toggle");
assert.ok(browser.includes("submitSudoPassword"), "the file browser can supply a sudo password");
assert.ok(!/localStorage|sessionStorage/.test(browser.split("sudoPassword")[1] || ""), "sudo password is not persisted");
assert.ok(browser.includes("data.elevated"), "the browser trusts the server's elevated flag");

const modal = readFileSync(resolve(repoRoot, "src/components/HostProfileModal.tsx"), "utf8");
assert.ok(modal.includes("sftpElevated"), "the host dialog can save root mode on the host");

const types = readFileSync(resolve(repoRoot, "src/types/connection.ts"), "utf8");
assert.ok(types.includes("sftpElevated?"), "HostProfile carries the per-host preference");
assert.ok(types.includes("sftpElevate?"), "ConnectionCredentials carries the per-request flag");

console.log("Auto sudo su SFTP tests passed.");
