import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunStatusScript,
  createKeyChannelPath,
  createRunLogPath,
  isRunLogPath,
  parseRunStatusOutput,
  stripTerminalControl,
  tailPreview,
} from "../src/lib/server/exec-script";
import { hostHistoryKey } from "../src/lib/client/session-resume";

console.log("==> Testing resumable runs (survive a closed tab) + recently connected history...");

// ---------------------------------------------------------------------------------
// The server-side probe: one round trip answers "still running?" and tails the log
// ---------------------------------------------------------------------------------
{
  const keyChannel = createKeyChannelPath();
  const script = buildRunStatusScript({ keyChannel, runLog: createRunLogPath() });
  assert.match(script, /-p '\/tmp\/\.sushi-keys-[0-9a-f]+'/);
  assert.match(script, /tail -c 49152/);
  assert.ok(!/\bsudo\b/.test(script), "the status probe must not need root");
  assert.ok(!/\brm\b/.test(script), "the status probe must never delete anything");
  assert.ok(!/\bmkfifo\b/.test(script), "the status probe must not create a FIFO");

  // Paths the client could try to smuggle in are not executed at all.
  const hostile = buildRunStatusScript({
    keyChannel: "/tmp/.sushi-keys-aaaaaaaa; rm -rf /",
    runLog: "/etc/passwd",
  });
  assert.ok(!hostile.includes("rm -rf"), "invalid FIFO paths are never interpolated");
  assert.ok(!hostile.includes("/etc/passwd"), "invalid log paths are never interpolated");
  assert.match(hostile, /SUSHI_RUN_DEAD/);
  assert.match(hostile, /SUSHI_LOG_BYTES=-1/);

  // A real run, locally: a live FIFO + a log that the probe tails. Both live under
  // the exact prefixes the exec route hands out (the probe only accepts those).
  const dir = mkdtempSync(join(tmpdir(), "sushi-run-"));
  const log = createRunLogPath();
  const fifo = createKeyChannelPath();
  try {
    writeFileSync(log, "line one\n\u001b[32mline two\u001b[0m\nlast line\n");
    execFileSync("/usr/bin/env", ["mkfifo", fifo]);

    const aliveResult = execFileSync(
      "/bin/sh",
      ["-c", buildRunStatusScript({ keyChannel: fifo, runLog: log })],
      { encoding: "utf8", timeout: 20000 }
    );
    const alive = parseRunStatusOutput(aliveResult);
    assert.equal(alive.alive, true, "an existing FIFO means the command is still running");
    assert.equal(alive.exists, true);
    assert.ok(alive.logBytes > 0);
    assert.ok(alive.output.includes("last line"), "the log tail is returned");
    assert.deepEqual(tailPreview(alive.output).slice(-1), ["last line"]);

    rmSync(fifo);
    const deadResult = execFileSync(
      "/bin/sh",
      ["-c", buildRunStatusScript({ keyChannel: fifo, runLog: log })],
      { encoding: "utf8", timeout: 20000 }
    );
    const dead = parseRunStatusOutput(deadResult);
    assert.equal(dead.alive, false, "the FIFO is gone once the command ended");
    assert.ok(
      dead.output.includes("last line"),
      "the log survives the command, so output can still be read"
    );
  } finally {
    for (const path of [log, fifo]) rmSync(path, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }

  // Only the script's first line is trusted, so a log that contains the marker word
  // cannot pretend the command is still alive.
  const spoofed = parseRunStatusOutput(
    ["SUSHI_RUN_DEAD", "SUSHI_LOG_BYTES=12", "SUSHI_RUN_ALIVE"].join("\n")
  );
  assert.equal(spoofed.alive, false, "the answer is read from the first line only");
  assert.equal(parseRunStatusOutput("").alive, false);
  assert.equal(parseRunStatusOutput("  \nSUSHI_RUN_ALIVE\nSUSHI_LOG_BYTES=-1").alive, true);

  const noLog = parseRunStatusOutput("SUSHI_RUN_ALIVE\nSUSHI_LOG_BYTES=-1\n");
  assert.equal(noLog.alive, true);
  assert.equal(noLog.exists, false);
  assert.equal(noLog.output, "");

  // Run logs are validated by shape before they are ever used in a shell.
  assert.equal(isRunLogPath("/tmp/.sushi-run-0123456789abcdef01.log"), true);
  assert.equal(isRunLogPath("/tmp/.sushi-run-../../../etc/passwd.log"), false);
  assert.equal(existsSync("/tmp/definitely-not-a-sushi-run.log"), false);

  // The tail budget is clamped (a client cannot ask for a 1 GB read).
  assert.match(buildRunStatusScript({ runLog: createRunLogPath(), tailBytes: 10 ** 9 }), /tail -c 262144/);
  assert.match(buildRunStatusScript({ runLog: createRunLogPath(), tailBytes: 1 }), /tail -c 1024/);
}

// ---------------------------------------------------------------------------------
// Plain-text preview: the resume prompt shows words, not escape codes
// ---------------------------------------------------------------------------------
{
  const transcript = [
    "\u001b]0;root@box: ~\u0007",
    "\u001b[1;32mroot@box\u001b[0m:\u001b[1;34m~\u001b[0m# apt install docker.io",
    "Reading package lists... Done",
    "\u001b[2K\rBuilding dependency tree... 50%\rBuilding dependency tree... 100%",
    "\u001b[?2004h",
    "",
    "  ",
  ].join("\n");
  const clean = stripTerminalControl(transcript);
  assert.ok(!clean.includes("\u001b"), "no escape sequences remain");
  assert.ok(!clean.includes("\u0007"), "no BEL remains");
  assert.ok(clean.includes("root@box:~# apt install docker.io"));
  assert.ok(clean.includes("Reading package lists... Done"));
  // `\r` progress redraws become separate lines so nothing is lost or glued together.
  assert.ok(clean.includes("Building dependency tree... 100%"));

  const preview = tailPreview(transcript, 3);
  assert.ok(preview.length <= 3);
  assert.equal(preview[preview.length - 1], "Building dependency tree... 100%");
  assert.ok(preview.every((line) => line.trim() === line && line.length > 0));
  assert.deepEqual(tailPreview(""), []);
  const long = tailPreview("x".repeat(400), 1, 40)[0];
  assert.equal(long.length, 40, "long lines are truncated with an ellipsis");
  assert.ok(long.endsWith("…"));
}

// ---------------------------------------------------------------------------------
// Host history key: one entry per account, case-insensitive host
// ---------------------------------------------------------------------------------
{
  const a = hostHistoryKey({ protocol: "ssh", host: "Box.Example.com", port: 22, username: "root" });
  const b = hostHistoryKey({ host: "box.example.com", port: 22, username: "root" });
  assert.equal(a, b, "the same host written differently is one history entry");
  const otherUser = hostHistoryKey({ host: "box.example.com", port: 22, username: "deploy" });
  assert.notEqual(a, otherUser, "two accounts on one box are two entries");
  const otherPort = hostHistoryKey({ host: "box.example.com", port: 2222, username: "root" });
  assert.notEqual(a, otherPort, "the port is part of the identity");
  assert.equal(a, "ssh|root|box.example.com|22");
}

console.log("Resumable run + recent host tests passed.");

// ---------------------------------------------------------------------------------
// Client history: runs survive a reload, hosts are remembered, "go back?" is asked
// ---------------------------------------------------------------------------------
{
  // Node has no localStorage: install a tiny in-memory one before importing.
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  } as Storage;

  const resume = require("../src/lib/client/session-resume") as typeof import("../src/lib/client/session-resume");
  const host: import("../src/types/connection").HostProfile = {
    id: "host-1",
    name: "prod-web",
    protocol: "ssh",
    host: "203.0.113.10",
    port: 22,
    username: "ubuntu",
    authMethod: "password",
    // Secrets must never be written to localStorage.
    password: "hunter2",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    passphrase: "key-pass",
    createdAt: 1,
    updatedAt: 1,
  };

  const now = 1_760_000_000_000;
  assert.deepEqual(resume.loadResumableRuns(now), [], "no history on a fresh browser");

  // A no-timeout run that has not finished: it must survive a reload.
  const run = {
    id: "run-abc",
    profile: host,
    command: "apt-get install -y docker.io",
    cwd: "/root",
    runLog: "/tmp/.sushi-run-0123456789abcdef.log",
    keyChannel: "/tmp/.sushi-keys-0123456789abcdef",
    detached: true,
    running: true,
    startedAt: now - 4 * 60_000,
    updatedAt: now - 60_000,
  };
  resume.upsertResumableRun(run, now - 60_000);
  const reloaded = resume.loadResumableRuns(now);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].command, run.command);
  assert.equal(reloaded[0].runLog, run.runLog);
  assert.equal(reloaded[0].keyChannel, run.keyChannel);
  assert.equal(reloaded[0].running, true);
  assert.equal(reloaded[0].profile.password, undefined, "passwords are never stored");
  assert.equal(reloaded[0].profile.privateKey, undefined, "keys are never stored");
  assert.equal(reloaded[0].profile.passphrase, undefined, "key passphrases are never stored");

  const raw = store.get(resume.RESUMABLE_RUNS_KEY) || "";
  assert.ok(!raw.includes("hunter2"), "no password in localStorage");
  assert.ok(!raw.includes("BEGIN OPENSSH"), "no private key in localStorage");

  // The run ends: the same id is updated, not duplicated, and the start time stays.
  const finished = resume.upsertResumableRun({ ...reloaded[0], running: false, exitCode: 0 }, now);
  assert.equal(finished.length, 1, "updating a run keeps one entry");
  assert.equal(finished[0].running, false);
  assert.equal(finished[0].exitCode, 0);
  assert.equal(finished[0].startedAt, run.startedAt, "start time is preserved");
  assert.ok(finished[0].updatedAt > reloaded[0].updatedAt);

  // "Go back?" is only offered while the command is still running.
  assert.equal(resume.buildResumePrompt(finished, { now }), null, "a finished run is not offered");
  resume.upsertResumableRun({ ...reloaded[0], running: true }, now);
  const prompt = resume.buildResumePrompt(resume.loadResumableRuns(now), { now });
  assert.ok(prompt, "a running command is offered after a reload");
  assert.equal(prompt?.run.id, "run-abc");
  assert.equal(prompt?.survivesTab, true, "no-timeout + FIFO means it outlives the tab");
  assert.match(prompt!.body, /apt-get install -y docker\.io/);
  assert.match(prompt!.body, /ubuntu@203\.0\.113\.10/);
  assert.equal(prompt!.acceptLabel, "Go back to the session");

  // Long command lines are shortened in the message, not stored truncated.
  const longRun = {
    ...reloaded[0],
    id: "run-long",
    command: `docker build -t app:latest ${"-f Dockerfile.prod ".repeat(10)}.`,
  };
  resume.upsertResumableRun(longRun, now);
  const longPrompt = resume.buildResumePrompt(resume.loadResumableRuns(now), { now });
  assert.equal(longPrompt?.run.id, "run-long", "newest run wins");
  assert.ok(longPrompt!.body.length < 260, "the prompt stays readable");
  assert.ok(longPrompt!.body.includes("…"));
  assert.equal(
    resume.loadResumableRuns(now).find((item) => item.id === "run-long")?.command,
    longRun.command,
    "the stored command is complete"
  );

  // A very old run is pruned instead of being offered forever.
  const later = now + 1000 * 60 * 60 * 24 * 8;
  assert.deepEqual(resume.loadResumableRuns(later), [], "runs older than a week are dropped");

  // ---- recently connected hosts ------------------------------------------------
  resume.recordRecentHost(host, { isSaved: true, now });
  resume.recordRecentHost(
    { ...host, id: "host-2", host: "198.51.100.7", username: "deploy", name: "staging" },
    { isSaved: true, now: now + 1000 }
  );
  let recent = resume.loadRecentHosts(now + 2000);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].name, "staging", "newest first");
  assert.equal(recent[0].username, "deploy");

  // Opening the same host again bumps it to the top instead of duplicating it.
  resume.recordRecentHost(host, { isSaved: true, now: now + 3000 });
  recent = resume.loadRecentHosts(now + 4000);
  assert.equal(recent.length, 2, "one entry per host + account");
  assert.equal(recent[0].name, "prod-web");
  assert.equal(recent[0].connects, 2);
  assert.equal(recent[0].profile.password, undefined, "history never stores credentials");

  // An ad-hoc connection (not in the vault) is marked as such.
  resume.recordRecentHost(
    { ...host, id: "ad-hoc", host: "192.0.2.44", name: "192.0.2.44" },
    { isSaved: false, now: now + 5000 }
  );
  recent = resume.loadRecentHosts(now + 6000);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].profileId, null, "ad-hoc hosts have no vault id");

  // Forgetting one host leaves the others alone.
  resume.removeRecentHost(recent[0].key, now + 7000);
  recent = resume.loadRecentHosts(now + 8000);
  assert.equal(recent.length, 2);
  assert.ok(!recent.some((entry) => entry.host === "192.0.2.44"));

  // Removing a run drops it from the resume list, and clearing wipes the store.
  resume.removeResumableRun("run-long", now);
  assert.deepEqual(
    resume.loadResumableRuns(now).map((item) => item.id),
    ["run-abc"]
  );
  resume.clearResumableRuns();
  resume.clearRecentHosts();
  assert.deepEqual(resume.loadResumableRuns(now), []);
  assert.deepEqual(resume.loadRecentHosts(now), []);

  // Malformed storage never breaks the workspace.
  store.set(resume.RESUMABLE_RUNS_KEY, "{not json");
  assert.deepEqual(resume.loadResumableRuns(now), []);
  store.set(resume.RESUMABLE_RUNS_KEY, JSON.stringify([{ id: "x" }, 42, null]));
  assert.deepEqual(resume.loadResumableRuns(now), []);
  store.set(resume.RECENT_HOSTS_KEY, JSON.stringify([{ profile: { host: "" } }]));
  assert.deepEqual(resume.loadRecentHosts(now), []);

  // Durations shown next to a run read naturally.
  assert.equal(resume.formatRunDuration(0), "0s");
  assert.equal(resume.formatRunDuration(42_000), "42s");
  assert.equal(resume.formatRunDuration(252_000), "4m 12s");
  assert.equal(resume.formatRunDuration(7_500_000), "2h 05m");
  assert.equal(resume.formatRunDuration(273_600_000), "3d 4h");
  assert.equal(
    resume.describeRunState({ ...reloaded[0], running: true }, now),
    "running · 4m"
  );
  assert.equal(
    resume.describeRunState({ ...reloaded[0], running: false, exitCode: 2 }, now),
    "finished · exit 2"
  );
  assert.equal(
    resume.describeRunState({ ...reloaded[0], running: false, exitCode: 0 }, now),
    "finished · exit 0"
  );

  console.log("Resumable run history (localStorage) tests passed.");
}
