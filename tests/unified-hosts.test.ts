import assert from "node:assert/strict";
import type { HostProfile } from "../src/types/connection";
import {
  accessLinks,
  filterUnifiedHosts,
  filterUnifiedHostsByProtocol,
  findUnifiedHost,
  groupUnifiedHosts,
  hostAccessUrl,
  mergeHosts,
  openableProtocols,
  parseHostDeepLink,
  resolveHostDeepLink,
  unifiedHostId,
  unifiedHostKey,
  unifiedHostProfileCount,
} from "../src/lib/client/unified-hosts";
import {
  applyIdentityChange,
  describeProtocols,
  removeMachine,
  sameMachine,
  siblingsOf,
} from "../src/lib/client/host-consistency";
import {
  buildUnifiedInventory,
  unifiedInventoryFromProfiles,
} from "../src/lib/server/unified-inventory";

console.log("==> Testing unified host merge (one URL for every SSH / SFTP / RDP host)...");

const mergedAfter = mergeHosts;

const base = {
  host: "203.0.113.10",
  port: 22,
  username: "root",
  authMethod: "password" as const,
  createdAt: 1,
  updatedAt: 1,
};

const sshHost: HostProfile = { ...base, id: "p-ssh", name: "prod-web", protocol: "ssh", group: "Prod", tags: ["web"], accentColor: "#34d399" };
const sftpHost: HostProfile = { ...base, id: "p-sftp", name: "prod-web files", protocol: "sftp", initialPath: "/var/www" };
const rdpHost: HostProfile = { ...base, id: "p-rdp", name: "prod-web (RDP)", protocol: "rdp", port: 3389, domain: "CORP" };
const otherUser: HostProfile = { ...base, id: "p-other", name: "prod-web deploy", protocol: "ssh", username: "deploy" };
const otherBox: HostProfile = { ...base, id: "p-box2", name: "db", protocol: "ssh", host: "198.51.100.7" };

// ---- identity ------------------------------------------------------------------
assert.equal(unifiedHostKey(sshHost), "203.0.113.10|root");
assert.equal(unifiedHostKey({ ...sshHost, host: " 203.0.113.10 ", username: "ROOT" }), "203.0.113.10|root");
assert.equal(
  unifiedHostKey({ ...sshHost, host: "203.0.113.10", username: "root" }),
  unifiedHostKey(sftpHost),
  "protocol is not part of the machine identity"
);
assert.equal(unifiedHostId(sshHost), "unified-203.0.113.10-root");
assert.match(unifiedHostId({ ...sshHost, host: "My Server!", username: "a b" }), /^unified-my-server-/);

// ---- merging -------------------------------------------------------------------
const merged = mergeHosts([sshHost, sftpHost, rdpHost, otherUser, otherBox]);
assert.equal(merged.length, 3, "three machines: root@web, deploy@web, root@db");

const web = findUnifiedHost(merged, sshHost);
assert.ok(web, "the SSH profile resolves to the merged entry");
assert.equal(web!.protocols.ssh?.id, "p-ssh");
assert.equal(web!.protocols.sftp?.id, "p-sftp");
assert.equal(web!.protocols.rdp?.id, "p-rdp");
assert.equal(web!.name, "prod-web", "the SSH profile names the machine");
assert.equal(web!.accentColor, "#34d399");
assert.equal(web!.group, "Prod");
assert.deepEqual(web!.available, ["ssh", "sftp", "rdp"]);
assert.deepEqual(web!.ports, { ssh: 22, sftp: 22, rdp: 3389 }, "each protocol keeps its port");
assert.equal(unifiedHostProfileCount(web!), 3);
assert.equal(web!.primary.id, "p-ssh", "SSH is the profile edits/deletes act on");

// Same rule for any of the merged profiles: one machine, one entry.
for (const profile of [sftpHost, rdpHost]) {
  assert.equal(findUnifiedHost(merged, profile)?.id, web!.id, `${profile.protocol} maps to the same entry`);
}

// An SSH-only machine is still openable as SFTP *and* RDP (same login, 22 / 3389).
const db = findUnifiedHost(merged, otherBox)!;
assert.deepEqual(db.available, ["ssh", "sftp"], "SSH implies the SFTP action");
assert.deepEqual(openableProtocols(db), ["ssh", "sftp", "rdp"], "a desktop can always be derived");
assert.equal(db.protocols.sftp, undefined, "…but no SFTP profile is invented");
assert.equal(db.protocols.rdp, undefined, "…and no RDP profile is invented");

// RDP-only machines are RDP only: no shell is advertised without a login.
const rdpOnly = mergeHosts([{ ...rdpHost, host: "10.0.0.9", id: "rdp-only" }]);
assert.deepEqual(rdpOnly[0].available, ["rdp"]);
assert.deepEqual(openableProtocols(rdpOnly[0]), ["rdp"]);

// A profile saved twice for the same protocol keeps the first (vault order wins).
const dupes = mergeHosts([sshHost, { ...sshHost, id: "p-ssh-2", name: "prod-web copy" }]);
assert.equal(dupes.length, 1);
assert.equal(dupes[0].protocols.ssh?.id, "p-ssh", "the first SSH profile is the canonical one");
assert.equal(unifiedHostProfileCount(dupes[0]), 1);

// Groups + sorting: by folder, then name.
const grouped = groupUnifiedHosts(merged);
assert.deepEqual(Object.keys(grouped).sort(), ["Prod", "Servers"]);
assert.deepEqual(grouped.Servers.map((h) => h.name), ["db", "prod-web deploy"]);
assert.deepEqual(groupUnifiedHosts([]), {});

// ---- search + protocol filter ---------------------------------------------------
assert.equal(filterUnifiedHosts(merged, "").length, 3);
assert.deepEqual(filterUnifiedHosts(merged, "web").map((h) => h.host), ["203.0.113.10", "203.0.113.10"]);
assert.equal(filterUnifiedHosts(merged, "deploy").length, 1);
assert.equal(filterUnifiedHosts(merged, "WEB").length, 2, "search is case-insensitive");
assert.equal(filterUnifiedHosts(merged, "Prod").length, 2, "folders are searchable");
assert.equal(filterUnifiedHosts(merged, "nothing-here").length, 0);

assert.equal(filterUnifiedHostsByProtocol(merged, "all").length, 3);
assert.equal(
  filterUnifiedHostsByProtocol(merged, "rdp").length,
  1,
  "only machines with a saved RDP profile match the RDP filter"
);
assert.equal(
  filterUnifiedHostsByProtocol(merged, "sftp").length,
  3,
  "SSH hosts also answer the SFTP filter (same login)"
);

// ---- links ----------------------------------------------------------------------
const links = accessLinks(web!);
assert.equal(links.ssh, "ssh://root@203.0.113.10:22");
assert.equal(links.sftp, "sftp://root@203.0.113.10:22");
assert.equal(links.rdp, "rdp://root@203.0.113.10:3389");
assert.ok(!JSON.stringify(links).includes("password"), "links never carry credentials");
assert.equal(accessLinks(rdpOnly[0]).ssh, undefined, "no SSH link for an RDP-only machine");

const url = hostAccessUrl(web!);
assert.equal(url, "/hosts?host=unified-203.0.113.10-root");
assert.equal(hostAccessUrl(web!, "rdp"), "/hosts?host=unified-203.0.113.10-root&protocol=rdp");
assert.equal(hostAccessUrl(web!, "ssh", "https://sushi.example.com/"), "https://sushi.example.com/hosts?host=unified-203.0.113.10-root&protocol=ssh");

// ---- deep links -----------------------------------------------------------------
assert.deepEqual(parseHostDeepLink("?host=unified-203.0.113.10-root"), {
  hostId: "unified-203.0.113.10-root",
  protocol: null,
});
assert.deepEqual(parseHostDeepLink("host=abc&protocol=SFTP"), { hostId: "abc", protocol: "sftp" });
assert.deepEqual(parseHostDeepLink("?host=abc&protocol=banana"), { hostId: "abc", protocol: null });
assert.equal(parseHostDeepLink("?protocol=ssh"), null, "a link without a host is not a deep link");
assert.equal(parseHostDeepLink(""), null);

assert.equal(resolveHostDeepLink(merged, "unified-203.0.113.10-root")?.id, web!.id, "resolved by id");
assert.equal(resolveHostDeepLink(merged, "root@203.0.113.10")?.id, web!.id, "resolved by user@host");
assert.equal(resolveHostDeepLink(merged, "198.51.100.7")?.id, db.id, "resolved by host");
assert.equal(resolveHostDeepLink(merged, "nobody@203.0.113.10"), undefined);
assert.equal(resolveHostDeepLink(merged, "unified-nope"), undefined);

// ---- the single API document ----------------------------------------------------
const resolved = unifiedInventoryFromProfiles([sshHost, sftpHost, rdpHost, otherUser, otherBox], {
  resolve: true,
  encrypted: false,
  source: "vault",
});
assert.equal(resolved.ok, true);
assert.equal(resolved.self, "/api/hosts");
assert.equal(resolved.page, "/hosts");
assert.equal(resolved.counts.hosts, 3);
assert.equal(resolved.counts.profiles, 5, "five saved profiles, three machines");
// Counted over `links`, i.e. including the derived actions: every SSH/SFTP machine can
// also be reached as a desktop, and its SFTP action exists without a saved profile.
assert.deepEqual(resolved.counts.byProtocol, { ssh: 3, sftp: 3, rdp: 3 });
const apiWeb = resolved.hosts.find((host) => host.id === web!.id)!;
assert.equal(apiWeb.name, "prod-web");
assert.equal(apiWeb.host, "203.0.113.10");
assert.equal(apiWeb.accessUrl, "/hosts?host=unified-203.0.113.10-root");
assert.deepEqual(apiWeb.protocols, ["ssh", "sftp", "rdp"]);
assert.deepEqual(
  apiWeb.links.map((link) => [link.protocol, link.url, link.kind]),
  [
    ["ssh", "ssh://root@203.0.113.10:22", "saved"],
    ["sftp", "sftp://root@203.0.113.10:22", "saved"],
    ["rdp", "rdp://root@203.0.113.10:3389", "saved"],
  ]
);
const apiDb = resolved.hosts.find((host) => host.id === db.id)!;
assert.deepEqual(
  apiDb.links.map((link) => [link.protocol, link.kind]),
  [
    ["ssh", "saved"],
    ["sftp", "derived"],
    ["rdp", "derived"],
  ],
  "derived links are labelled, not hidden"
);

// Encrypted vault: complete shape, no leaked names — and still one entry per machine.
const redacted = buildUnifiedInventory(merged, { resolve: false, encrypted: true, source: "server-vault" });
assert.equal(redacted.encrypted, true);
assert.equal(redacted.hosts.length, 3);
assert.equal(redacted.counts.profiles, 5);
assert.ok(
  redacted.hosts.every((host) => !host.name?.includes("prod-web") && !host.links.some((link) => link.url)),
  "no host names or URLs leak while the vault is locked"
);
assert.deepEqual(
  redacted.hosts.map((host) => host.host),
  ["host #1", "host #2", "host #3"],
  "entries stay identifiable without revealing anything"
);
assert.match(redacted.hint, /encrypted/i);

// Empty vault: valid document, zero counts.
const empty = buildUnifiedInventory([], { resolve: false, encrypted: true, source: "vault" });
assert.deepEqual(empty.counts, { hosts: 0, profiles: 0, byProtocol: { ssh: 0, sftp: 0, rdp: 0 } });
assert.deepEqual(empty.hosts, []);


// ---- keeping a machine's data consistent on edit / delete -----------------------
{
  const vault = [sshHost, sftpHost, rdpHost, otherUser, otherBox];
  assert.deepEqual(
    siblingsOf(vault, sshHost).map((host) => host.protocol).sort(),
    ["rdp", "sftp"],
    "the SSH row knows its SFTP and RDP siblings"
  );
  assert.equal(sameMachine(sshHost, { ...sshHost, protocol: "rdp", port: 3389 }), true);

  // Editing the SSH entry's address moves the whole machine (no split entries).
  const moved = applyIdentityChange(vault, {
    ...sshHost,
    host: "203.0.113.77",
    username: "ubuntu",
  });
  assert.equal(Boolean(moved.conflict), false);
  assert.deepEqual(moved.moved.map((host) => host.protocol).sort(), ["rdp", "sftp"]);
  const after = mergedAfter(moved.hosts);
  assert.equal(after.length, 3, "still three machines, not four");
  const movedWeb = findUnifiedHost(after, { host: "203.0.113.77", username: "ubuntu" })!;
  assert.deepEqual(movedWeb.available, ["ssh", "sftp", "rdp"], "SSH + SFTP + RDP stayed together");
  assert.equal(movedWeb.protocols.rdp?.host, "203.0.113.77");
  assert.equal(movedWeb.protocols.sftp?.username, "ubuntu");
  assert.equal(
    findUnifiedHost(after, { host: "203.0.113.10", username: "root" }),
    undefined,
    "nothing is left behind at the old address"
  );
  assert.equal(
    findUnifiedHost(after, { host: "203.0.113.10", username: "deploy" })?.id,
    findUnifiedHost(merged, otherUser)?.id,
    "another account on the same box is untouched"
  );

  // Editing only the RDP port leaves identities alone (nothing to move).
  const portOnly = applyIdentityChange(vault, { ...rdpHost, port: 3390 });
  assert.deepEqual(portOnly.moved, []);
  assert.equal(portOnly.hosts.find((host) => host.id === "p-rdp")?.port, 3390);

  // Moving a machine onto an address another machine already uses is a conflict.
  const clash = applyIdentityChange(vault, { ...sshHost, host: "198.51.100.7" });
  assert.ok(clash.conflict, "the caller is told before two machines merge");
  assert.equal(clash.conflict?.id, "p-box2");
  const noMove = applyIdentityChange(vault, { ...sshHost, host: "198.51.100.7" }, { moveSiblings: false });
  assert.deepEqual(noMove.moved, [], "siblings can be left alone on request");

  // A new host is inserted; a duplicate of the same protocol at the same address is flagged.
  const added = applyIdentityChange(vault, { ...sshHost, id: "p-new", host: "192.0.2.50", name: "new" });
  assert.equal(added.hosts.length, 6);
  assert.equal(added.hosts[0].id, "p-new");
  const duplicate = applyIdentityChange(vault, { ...sshHost, id: "p-dup" });
  assert.equal(duplicate.conflict?.id, "p-ssh", "a second SSH profile for one machine is a conflict");
  const extraProtocol = applyIdentityChange(vault, {
    ...rdpHost,
    id: "p-rdp-2",
    host: otherBox.host,
    username: otherBox.username,
  });
  assert.equal(Boolean(extraProtocol.conflict), false, "a new protocol for a machine is normal");

  // "Delete this machine" removes every profile of it, and nothing else.
  const removed = removeMachine(vault, sshHost);
  assert.deepEqual(removed.removed.map((host) => host.id).sort(), ["p-rdp", "p-sftp", "p-ssh"]);
  assert.equal(removed.hosts.length, 2, "the other account and the other box survive");
  assert.deepEqual(removed.hosts.map((host) => host.id).sort(), ["p-box2", "p-other"]);
  assert.equal(describeProtocols(removed.removed), "SSH, SFTP and RDP");

  // Deleting one protocol only (the modal path) keeps the machine.
  const oneProtocol = removeMachine(vault, sshHost, { protocols: ["rdp"] });
  assert.deepEqual(oneProtocol.removed.map((host) => host.id), ["p-rdp"]);
  assert.equal(oneProtocol.hosts.length, 4);
  assert.equal(describeProtocols([sshHost]), "SSH");
  assert.equal(describeProtocols([]), "this connection");
}

console.log("Unified host merge + inventory + consistency tests passed.");
