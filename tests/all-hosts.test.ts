import assert from "node:assert/strict";
import fs from "node:fs";
import type { HostProfile } from "../src/types/connection";
import { mergeHosts } from "../src/lib/client/unified-hosts";
import {
  allHostsStatus,
  buildAllHostsView,
  hostWorkspaceUrl,
  hostsCountLine,
  protocolSummary,
  resolveWorkspaceDeepLink,
  workspaceDeepLinkFromSearch,
} from "../src/lib/client/all-hosts";
import { NextRequest } from "next/server";
import { GET as hostsApiGet } from "../src/app/api/hosts/route";
import { GET as hostsPageGet } from "../src/app/hosts/route";
import { createSessionToken, getEffectiveAuthConfig } from "../src/lib/server/auth";

console.log("==> Testing the All-hosts page (/hosts): real list, honest redirect, one URL per machine...");

const read = (path: string) => fs.readFileSync(path, "utf8");

const profile = (over: Partial<HostProfile>): HostProfile => ({
  id: over.id || `${over.protocol}-${over.host}`,
  name: over.name || `${over.username}@${over.host}`,
  host: "203.0.113.10",
  port: 22,
  username: "root",
  authMethod: "password",
  protocol: "ssh",
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

// --- 1. The page lists real machines, one row per machine + account -----------------
{
  const profiles: HostProfile[] = [
    profile({ id: "a-ssh", name: "prod web", protocol: "ssh", host: "203.0.113.10", port: 22, group: "Prod", tags: ["web"] }),
    profile({ id: "a-rdp", name: "prod web (desktop)", protocol: "rdp", host: "203.0.113.10", port: 3389, group: "Prod" }),
    profile({ id: "b-sftp", name: "db box", protocol: "sftp", host: "198.51.100.7", port: 2222, username: "deploy", group: "Data" }),
    profile({ id: "c-ssh", name: "solo", protocol: "ssh", host: "192.0.2.9", port: 22, username: "ops", group: "" }),
  ];
  const unified = mergeHosts(profiles);
  const view = buildAllHostsView(unified);

  assert.equal(view.totalCount, 3, "three machines from four profiles");
  assert.equal(view.profileCount, 4, "every saved profile is counted");
  // Every way in is openable (SSH and SFTP share a login, RDP is derived), so the
  // filter counts machines reachable by that protocol, not saved profile types.
  assert.deepEqual(view.byProtocol, { ssh: 3, sftp: 3, rdp: 3 }, "per-protocol counts use openable ways in");

  assert.deepEqual(view.groups.map((group) => group.group), ["Data", "Prod", "Servers"], "folders sort, empty folder becomes Servers");

  const prod = view.groups.flatMap((group) => group.rows).find((row) => row.entry.host === "203.0.113.10")!;
  assert.equal(prod.entry.name, "prod web", "the merged machine keeps its SSH name");
  assert.deepEqual(prod.protocols, ["ssh", "sftp", "rdp"], "an SSH + RDP machine offers all three ways in");
  assert.equal(prod.summary, "SSH :22 · SFTP :22 · RDP :3389", "the row shows every port");
  assert.deepEqual(prod.links, {
    ssh: "ssh://root@203.0.113.10:22",
    sftp: "sftp://root@203.0.113.10:22",
    rdp: "rdp://root@203.0.113.10:3389",
  });
  // SSH and SFTP share a login; the SFTP profile saved port 2222, the derived SSH
  // way in keeps the SSH default (22) — the summary reports what each way uses.
  assert.equal(
    protocolSummary(unified.find((entry) => entry.id.includes("198.51.100.7"))!),
    "SSH :22 · SFTP :2222 · RDP :3389"
  );
}

// --- 2. Search and the protocol filter work on the merged rows ----------------------
{
  const unified = mergeHosts([
    profile({ id: "a", name: "prod web", protocol: "ssh", host: "203.0.113.10", group: "Prod", tags: ["nginx"] }),
    profile({ id: "b", name: "db box", protocol: "sftp", host: "198.51.100.7", username: "deploy", group: "Data" }),
  ]);

  assert.equal(buildAllHostsView(unified, { search: "prod" }).visibleCount, 1);
  assert.equal(buildAllHostsView(unified, { search: "PROD" }).visibleCount, 1, "search is case-insensitive");
  assert.equal(buildAllHostsView(unified, { search: "deploy" }).visibleCount, 1, "search matches the account");
  assert.equal(buildAllHostsView(unified, { search: "nginx" }).visibleCount, 1, "search matches tags");
  assert.equal(buildAllHostsView(unified, { search: "data" }).visibleCount, 1, "search matches the folder");
  assert.equal(
    buildAllHostsView(unified, { search: "ssh://deploy@198.51.100.7:22" }).visibleCount,
    1,
    "pasting an access link from a runbook finds the machine"
  );
  assert.equal(buildAllHostsView(unified, { search: "nothing-like-this" }).visibleCount, 0);

  // The filter is about ways in, not about which profile type was saved.
  const sftpHost = mergeHosts([profile({ id: "s", protocol: "sftp", host: "198.51.100.7", username: "deploy" })]);
  assert.equal(buildAllHostsView(sftpHost, { protocol: "ssh" }).visibleCount, 1, "SFTP-saved host appears under SSH");
  assert.equal(buildAllHostsView(sftpHost, { protocol: "rdp" }).visibleCount, 1, "and under RDP (derived companion)");
  assert.equal(buildAllHostsView(unified, { protocol: "sftp" }).visibleCount, 2, "every merged machine is reachable by SFTP");
  assert.equal(buildAllHostsView(unified, { search: "prod", protocol: "sftp" }).visibleCount, 1, "search and filter combine");
}

// --- 3. The one URL per machine, and the in-app view URL ---------------------------
{
  const [entry] = mergeHosts([profile({ name: "prod", host: "203.0.113.10" })]);
  assert.equal(hostWorkspaceUrl(entry), "/?host=unified-203.0.113.10-root", "no credentials, stable id");
  assert.equal(
    hostWorkspaceUrl(entry, "rdp"),
    "/?host=unified-203.0.113.10-root&protocol=rdp",
    "a protocol pins the way in"
  );

  assert.equal(workspaceDeepLinkFromSearch(""), null, "a plain /hosts visit carries no link");
  assert.equal(workspaceDeepLinkFromSearch("?view=hosts"), null);
  const link = workspaceDeepLinkFromSearch("?host=unified-203.0.113.10-root&protocol=sftp")!;
  assert.equal(link.workspacePath, "/?host=unified-203.0.113.10-root&protocol=sftp");
  const resolved = resolveWorkspaceDeepLink(link, mergeHosts([profile({})]));
  assert.equal(resolved.entry?.host, "203.0.113.10", "the link resolves to the saved machine");
  const handTyped = resolveWorkspaceDeepLink(workspaceDeepLinkFromSearch("?host=root@203.0.113.10")!, mergeHosts([profile({})]));
  assert.equal(handTyped.entry?.host, "203.0.113.10", "user@host links still work");
  const missing = resolveWorkspaceDeepLink(workspaceDeepLinkFromSearch("?host=gone")!, mergeHosts([profile({})]));
  assert.equal(missing.entry, undefined, "an unknown host resolves to nothing (and is reported)");
}

// --- 4. Loading vs empty vs ready, and the count line ------------------------------
{
  assert.equal(allHostsStatus({ vaultReady: false, hostCount: 0 }), "loading", "never claim empty before the vault opens");
  assert.equal(allHostsStatus({ vaultReady: true, hostCount: 0 }), "empty");
  assert.equal(allHostsStatus({ vaultReady: true, hostCount: 2 }), "ready");

  const unified = mergeHosts([
    profile({ id: "a", protocol: "ssh", host: "203.0.113.10" }),
    profile({ id: "b", protocol: "rdp", host: "203.0.113.10", port: 3389 }),
    profile({ id: "c", protocol: "sftp", host: "198.51.100.7", username: "deploy" }),
  ]);
  assert.equal(
    hostsCountLine(buildAllHostsView(unified)),
    "2 hosts · 3 profiles · SSH 2 · SFTP 2 · RDP 2",
    "the header counts machines, profiles and ways in"
  );
  const single = mergeHosts([profile({})]);
  assert.equal(hostsCountLine(buildAllHostsView(single)), "1 host · 1 profile · SSH 1 · SFTP 1 · RDP 1");
}

// --- 5. Wiring: the workspace renders the list, not an empty page ------------------
{
  const workspace = read("src/components/SushiWorkspace.tsx");
  assert.match(workspace, /import \{ AllHostsPage \}/, "the workspace imports the page");
  assert.match(workspace, /<AllHostsPage[\s\S]{0,400}hosts=\{unifiedHosts\}/, "it passes the merged vault hosts");
  assert.match(workspace, /params\.get\("view"\) !== "hosts"/, "it recognises /?view=hosts");
  assert.match(
    workspace,
    /window\.history\.replaceState\(null, "", `\$\{window\.location\.pathname\}\?view=hosts`\)/,
    "entering the view gives it a real, reloadable URL"
  );
  assert.match(workspace, /leaveAllHostsViewRef\.current\(\)/, "a one-machine link leaves the list and opens its tab");
  assert.match(
    workspace,
    /allHostsView\.enabled\s*\n?\s*\? "hidden"/,
    "the launchpad is not rendered underneath the list"
  );

  const page = read("src/components/AllHostsPage.tsx");
  assert.match(page, /Opening your vault to read host names/, "loading copy is honest");
  assert.match(page, /No saved hosts yet/, "empty state is distinguishable from loading");
  assert.match(page, /onCopy\(link, entry\.id\)/, "every row can copy its one link");

  const route = read("src/app/hosts/route.ts");
  assert.match(route, /readClearTextInventory/, "the page uses the same inventory as the API");
  assert.match(route, /target\.searchParams\.set\("view", "hosts"\)/, "without an inventory it redirects into the app view");
  assert.ok(!/hosts: auth\.ok \? \[\] : undefined/.test(route), "it never reports a fabricated empty host list");
}

// --- 6. The route: real inventory when readable, redirect when encrypted ----------
//
// Route handlers are called directly. Two harnesses are supported: a live server's
// data directory (`DATA_DIR`) with a real session token, and the process-env account
// the e2e suite uses (`SUSHI_AUTH_USERNAME` / `_PASSWORD` / `_SECRET`).
async function routeChecks() {
  const hasEnvAccount = Boolean(process.env.SUSHI_AUTH_USERNAME && process.env.SUSHI_AUTH_SECRET);
  if (hasEnvAccount) {
    process.env.SUSHI_AUTH_USERNAME = process.env.SUSHI_AUTH_USERNAME || "sushiadmin";
    process.env.SUSHI_AUTH_PASSWORD = process.env.SUSHI_AUTH_PASSWORD || "correct-horse-battery";
    process.env.SUSHI_AUTH_SECRET =
      process.env.SUSHI_AUTH_SECRET ||
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  }

  const cfg = await getEffectiveAuthConfig();
  const token =
    process.env.SUSHI_TEST_SESSION ||
    (cfg.initialized ? createSessionToken(cfg.username, cfg.authSecret, cfg.sessionVersion) : "");
  const authed = new Headers({ "x-sushi-session": token });
  const hasSession = Boolean(token) && cfg.initialized;

  // A clear-text inventory is rendered as a real table — names, addresses, links.
  process.env.SUSHI_HOSTS_INVENTORY = JSON.stringify({
    hosts: [
      { id: "a", name: "prod web", protocol: "ssh", host: "203.0.113.10", port: 22, username: "root", group: "Prod" },
      { id: "b", name: "prod web (rdp)", protocol: "rdp", host: "203.0.113.10", port: 3389, username: "root", group: "Prod" },
    ],
  });
  try {
    const api = await hostsApiGet(new NextRequest("http://localhost/api/hosts", { headers: authed }));
    if (!hasSession) {
      assert.equal(api.status, 401, "the inventory needs the normal Sushi session");
    } else {
      assert.equal(api.status, 200);
      const json = (await api.json()) as { counts: { hosts: number; profiles: number } };
      assert.equal(json.counts.hosts, 1, "the API merges the clear-text inventory into one machine");
      assert.equal(json.counts.profiles, 2);
    }

    const page = await hostsPageGet(new NextRequest("http://localhost/hosts", { headers: authed }));
    if (hasSession) {
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") || "", /text\/html/);
      const html = await page.text();
      assert.match(html, /prod web/, "the page prints the real machines");
      assert.match(html, /ssh:\/\/root@203\.0\.113\.10:22/, "with their addresses");
      assert.match(html, /Every saved machine/, "and a real host table");
    } else {
      // Signed out, the inventory is not readable either: sign in through the app.
      assert.equal(page.status, 307);
    }
  } finally {
    delete process.env.SUSHI_HOSTS_INVENTORY;
  }

  // No inventory: /hosts redirects into the workspace view instead of printing an
  // empty table — and the one-machine link survives the redirect.
  const redirect = await hostsPageGet(
    new NextRequest("http://localhost/hosts?host=unified-203.0.113.10-root&protocol=rdp", { headers: authed })
  );
  assert.equal(redirect.status, 307, "an encrypted vault sends the browser to the app view");
  const location = redirect.headers.get("location") || "";
  assert.match(location, /^\/\?view=hosts/, "the app view is /?view=hosts");
  assert.match(location, /host=unified-203\.0\.113\.10-root/, "the one-machine link survives the redirect");
  assert.match(location, /protocol=rdp/);

  // The JSON flavour never fabricates an empty list either.
  const json = await hostsPageGet(
    new NextRequest("http://localhost/hosts?format=json", { headers: authed })
  );
  if (!hasSession) {
    assert.equal(json.status, 401);
  } else {
    assert.equal(json.status, 200);
    const body = (await json.json()) as { hosts: unknown; encrypted: boolean; list: string };
    assert.equal(body.hosts, null, "encrypted vaults report no readable hosts, not zero hosts");
    assert.equal(body.encrypted, true);
    assert.equal(body.list, "/?view=hosts", "and point at the real in-app list");
  }

  console.log(
    hasSession
      ? "    route checks: signed-in (real inventory + redirect)"
      : "    route checks: signed-out (401 + redirect)"
  );
}

routeChecks()
  .then(() => {
    console.log("ALL HOSTS PAGE TESTS PASSED!");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
