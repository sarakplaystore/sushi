import assert from "node:assert/strict";
import {
  OS_COMMAND_SNIPPETS,
  OS_SNIPPET_CATEGORIES,
  detectOsFlavour,
  groupSnippetsByCategory,
  isOsSnippetCategory,
  isSnippetCategoryForHost,
  mergeOsCommandSnippets,
  osSnippetCategoryFor,
} from "../src/lib/client/os-commands";
import { DEFAULT_SNIPPETS } from "../src/lib/client/crypto-vault";

console.log("==> Testing OS command snippets (Ubuntu + other distros)...");

// ---- the built-in list -------------------------------------------------------
assert.ok(OS_COMMAND_SNIPPETS.length >= 20, "expected a full per-distro command set");
assert.equal(
  new Set(OS_COMMAND_SNIPPETS.map((s) => s.id)).size,
  OS_COMMAND_SNIPPETS.length,
  "snippet ids must be unique"
);

for (const snippet of OS_COMMAND_SNIPPETS) {
  assert.ok(snippet.title.trim(), `${snippet.id} needs a title`);
  assert.ok(snippet.command.trim(), `${snippet.id} needs a command`);
  assert.ok(snippet.description?.trim(), `${snippet.id} needs a description`);
  assert.ok(isOsSnippetCategory(snippet.category), `${snippet.id}: unknown category ${snippet.category}`);
  // These snippets are read-only: no installs, no deletion, no interactive editors.
  assert.doesNotMatch(snippet.command, /\bapt(-get)? (install|remove|purge)\b/);
  assert.doesNotMatch(snippet.command, /\b(dnf|yum|zypper|pacman|apk) (-S|install|add|remove)\b/);
  assert.doesNotMatch(snippet.command, /\bsudo\b/, "OS snippets must work as the login user");
  assert.doesNotMatch(snippet.command, /\brm -rf?\b/);
  assert.doesNotMatch(snippet.command, /\b(reboot|shutdown|mkfs)\b/);
  assert.ok(!snippet.command.includes("\n"), `${snippet.id} must stay a single line for the terminal`);
}

// Every flavour has at least two commands, so the popover group is never a stub.
const categoriesUsed = new Set(OS_COMMAND_SNIPPETS.map((s) => s.category));
for (const category of Object.values(OS_SNIPPET_CATEGORIES)) {
  assert.ok(categoriesUsed.has(category), `missing snippets for ${category}`);
  const count = OS_COMMAND_SNIPPETS.filter((s) => s.category === category).length;
  assert.ok(count >= 2, `${category} should have at least two commands, got ${count}`);
}

// Ubuntu/Debian/RHEL/Alpine really use their own release files.
const commandFor = (id: string) => OS_COMMAND_SNIPPETS.find((s) => s.id === id)?.command ?? "";
assert.match(commandFor("snip-os-ubuntu-lsb"), /lsb_release -a/);
assert.match(commandFor("snip-os-debian-release"), /\/etc\/debian_version/);
assert.match(commandFor("snip-os-rhel-release"), /\/etc\/redhat-release/);
assert.match(commandFor("snip-os-alpine-release"), /\/etc\/alpine-release/);
assert.match(commandFor("snip-os-release"), /\/etc\/os-release/);

// ---- what a fresh vault starts with ------------------------------------------
const defaultIds = new Set(DEFAULT_SNIPPETS.map((s) => s.id));
assert.ok(defaultIds.has("snip-sys-overview"), "existing defaults must stay");
for (const snippet of OS_COMMAND_SNIPPETS) {
  assert.ok(defaultIds.has(snippet.id), `${snippet.id} must be offered in a new vault`);
}

// ---- merging into an older vault --------------------------------------------
const legacy = DEFAULT_SNIPPETS.filter((s) => !isOsSnippetCategory(s.category));
const merged = mergeOsCommandSnippets(legacy);
assert.equal(merged.length, legacy.length + OS_COMMAND_SNIPPETS.length);
assert.equal(mergeOsCommandSnippets(merged), merged, "merging twice must be a no-op");
assert.ok(
  merged.some((s) => s.title.includes("Ubuntu")),
  "the Snippets popover should offer Ubuntu commands"
);

// ---- grouping ---------------------------------------------------------------
const groups = groupSnippetsByCategory([
  { id: "a", title: "A", command: "a", category: "Diagnostics" },
  { id: "b", title: "B", command: "b", category: "OS · Ubuntu" },
  { id: "c", title: "C", command: "c", category: "Diagnostics" },
  { id: "d", title: "D", command: "d", category: "  " },
]);
assert.deepEqual(
  groups.map((g) => [g.category, g.snippets.map((s) => s.id)]),
  [
    ["Diagnostics", ["a", "c"]],
    ["OS · Ubuntu", ["b"]],
    ["Other", ["d"]],
  ],
  "categories keep first-seen order and blank categories fall back to Other"
);
assert.equal(groups[0].snippets[0].id, "a", "group members keep their order");
assert.equal(groupSnippetsByCategory([]).length, 0);

// ---- host detection ---------------------------------------------------------
const detected = (os: string, extra: Record<string, string> = {}) =>
  detectOsFlavour({ os, ...extra });

assert.equal(detected("Ubuntu 24.04.1 LTS"), "ubuntu");
assert.equal(detected("Debian 12"), "debian");
assert.equal(detected("Rocky Linux 9.4 (Blue Onyx)"), "rhel");
assert.equal(detected("AlmaLinux 9.4"), "rhel");
assert.equal(detected("Red Hat Enterprise Linux 9.4"), "rhel");
assert.equal(detected("CentOS Stream 9"), "rhel");
assert.equal(detected("Fedora Linux 40"), "fedora");
assert.equal(detected("Arch Linux"), "arch");
assert.equal(detected("Alpine Linux v3.20"), "alpine");
assert.equal(detected("openSUSE Leap 15.6"), "suse");
assert.equal(detected("SUSE Linux Enterprise Server 15 SP6"), "suse");
assert.equal(detected("Amazon Linux 2023"), "amazon");
// `distro` alone (no PRETTY_NAME) still identifies the family.
assert.equal(detectOsFlavour({ distro: "Ubuntu", version: "22.04" }), "ubuntu");
// Unknown, missing and non-Linux hosts stay null instead of guessing.
assert.equal(detected("macOS 15.1"), null);
assert.equal(detectOsFlavour({}), null);
assert.equal(detectOsFlavour(null), null);

assert.equal(osSnippetCategoryFor({ os: "Ubuntu 22.04.5 LTS" }), OS_SNIPPET_CATEGORIES.ubuntu);
assert.equal(osSnippetCategoryFor({ os: "FreeBSD 14.1" }), null);

assert.ok(
  isSnippetCategoryForHost(OS_SNIPPET_CATEGORIES.ubuntu, { os: "Ubuntu 24.04.1 LTS" }),
  "the Ubuntu group is the connected host's own group"
);
assert.ok(
  !isSnippetCategoryForHost(OS_SNIPPET_CATEGORIES.debian, { os: "Ubuntu 24.04.1 LTS" }),
  "only the matching family is flagged"
);
assert.ok(
  !isSnippetCategoryForHost(OS_SNIPPET_CATEGORIES.anyLinux, { os: "Ubuntu 24.04.1 LTS" }),
  "the portable probe is never flagged as host-specific"
);
assert.ok(
  !isSnippetCategoryForHost(OS_SNIPPET_CATEGORIES.ubuntu, null),
  "nothing is flagged before the probe answers"
);
assert.ok(
  !isSnippetCategoryForHost("Diagnostics", { os: "Ubuntu 24.04.1 LTS" }),
  "user categories are never flagged"
);

console.log(`OS command snippet tests passed (${OS_COMMAND_SNIPPETS.length} commands).`);
