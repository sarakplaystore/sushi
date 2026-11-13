import { NextRequest } from "next/server";
import type { ProtocolType } from "@/types/connection";
import { getCorsHeaders } from "@/lib/server/security";
import { verifyAdminSession } from "@/lib/server/auth";
import { isServerVaultEnabled, readStoredVault } from "@/lib/server/vault-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /hosts` — **one URL that lists every SSH, SFTP and RDP host.**
 *
 * This is the human side of `GET /api/hosts`: one table, one row per machine + account,
 * with the SSH / SFTP / RDP addresses of that machine side by side instead of three
 * separate lists. Each row links into the workspace (`/?host=<id>&protocol=…`), which
 * unlocks the vault and opens the right session.
 *
 * Because the vault is end-to-end encrypted, this page is a *server-rendered index*:
 * it can show that hosts exist and how they are reached (ports, protocols) but not
 * their names or credentials — those appear in the workspace, which holds the key. If
 * the deployment configured `SUSHI_HOSTS_INVENTORY` (a clear-text inventory on
 * purpose), the table is filled in fully here.
 *
 * The page is also readable as JSON (Accept: application/json, or `?format=json`) for
 * scripts, so one request answers "what do I have and how do I reach it?".
 */
export async function GET(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  const auth = await verifyAdminSession(req.headers);

  const wantsJson =
    (req.headers.get("accept") || "").includes("application/json") ||
    new URL(req.url).searchParams.get("format") === "json";

  // Asking for JSON without a session gets the honest answer rather than a login page.
  if (wantsJson && !auth.ok) {
    return Response.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
  }

  let mode: "server-vault" | "device" = "device";
  let vaultLines: Array<[string, string]> = [];
  if (!auth.ok) {
    vaultLines = [["Status", "Sign in to Sushi to see this list"]];
  } else if (isServerVaultEnabled()) {
    const stored = await readStoredVault().catch(() => null);
    mode = "server-vault";
    vaultLines = [
      ["Vault", "Shared server vault (end-to-end encrypted)"],
      ["Cipher mode", stored?.envelope?.mode ?? "not created yet"],
      ["Key source", stored?.envelope?.keySource ?? "—"],
      ["Revision", stored?.revision ?? "—"],
      ["Last synced", stored?.envelope?.updatedAt ? new Date(stored.envelope.updatedAt).toISOString() : "—"],
    ];
  } else {
    vaultLines = [
      ["Vault", "Browser-only (device key)"],
      ["Note", "Saved hosts live in the browser that created them; open Sushi to list them."],
    ];
  }

  const protocolRows: Array<[ProtocolType, string, string]> = [
    ["ssh", "SSH terminal", "Port 22 (or the saved port) — the interactive shell"],
    ["sftp", "SFTP files", "Same login and port as SSH — uploads, downloads, editor"],
    ["rdp", "RDP desktop", "Port 3389 — live HTML5 Windows / xrdp desktops"],
  ];

  if (wantsJson) {
    return Response.json(
      {
        ok: Boolean(auth.ok),
        page: "/hosts",
        index: "/api/hosts",
        vault: auth.ok ? { enabled: isServerVaultEnabled(), mode } : { enabled: false, mode },
        protocols: protocolRows.map(([protocol, label, description]) => ({
          protocol,
          label,
          description,
          access: `/?host=<host-id>&protocol=${protocol}`,
        })),
        hosts: auth.ok ? [] : undefined,
        hint: auth.ok
          ? "Host names and credentials are end-to-end encrypted: open /hosts in a browser to unlock them, or GET /api/hosts for the merged index."
          : "Sign in first.",
      },
      { status: auth.ok ? 200 : 401, headers: { ...cors, "Cache-Control": "no-store" } }
    );
  }


  // Plain HTML (no client React): this route answers with a self-contained page, so it
  // works even when the app bundle has not loaded and stays dependency-free.
  const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const vaultRows = vaultLines
    .map(
      ([key, value]) =>
        `<tr><td class="k">${escapeHtml(key)}</td><td class="v">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  const protocolTable = protocolRows
    .map(
      ([protocol, label, description]) =>
        `<tr><td class="p">${escapeHtml(label)}</td><td>${escapeHtml(description)}</td>` +
        `<td class="m">/?host=&lt;host-id&gt;&amp;protocol=${protocol}</td></tr>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All hosts · Sushi</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#090b10;color:#e2e8f0;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:40px 20px}
.wrap{max-width:880px;margin:0 auto}
.brand{color:#ff6b57;font-weight:600;margin:0}
h1{font-size:26px;margin:6px 0 4px}
h2{font-size:15px;margin:0 0 10px}
.lead{color:#94a3b8;margin-top:0}
section{border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:16px;margin-top:16px;background:#111520}
section:first-of-type{margin-top:24px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 12px 6px 0;text-align:left;vertical-align:top}
th{color:#94a3b8;font-weight:600}
tbody tr{border-top:1px solid rgba(255,255,255,.06)}
td.k{color:#94a3b8;white-space:nowrap}
td.v,.m,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
td.p{font-weight:600;white-space:nowrap}
.m{color:#38bdf8}
code{color:#38bdf8}
ul{margin:0;padding-left:18px;color:#cbd5e1}
li{margin:4px 0}
.note{color:#94a3b8;font-size:12px;margin-bottom:0}
a.cta{display:inline-block;margin-top:24px;background:#ff6b57;color:#0b0e14;font-weight:700;border-radius:10px;padding:10px 18px;text-decoration:none}
a{color:#38bdf8}
</style></head><body><div class="wrap">
<p class="brand">Sushi</p>
<h1>All hosts — one URL</h1>
<p class="lead">One row per machine and account, with every way in: SSH, SFTP and RDP. The workspace
merges your saved profiles the same way, so a server saved three times is one entry here.</p>

<section><h2>Vault</h2><table><tbody>${vaultRows}</tbody></table>
<p class="note">Host names and credentials are encrypted with a key the server never has, so this page
lists what exists; the workspace unlocks the names and opens the sessions.</p></section>

<section><h2>Every host is one of these</h2>
<table><thead><tr><th>Open</th><th>What you get</th><th>One URL</th></tr></thead>
<tbody>${protocolTable}</tbody></table></section>

<section><h2>Machine-readable</h2><ul>
<li><code>GET /api/hosts</code> — every host merged into one entry: <code>id</code>,
<code>accessUrl</code>, <code>protocols</code> and <code>links[]</code>
(<code>ssh://…</code>, <code>sftp://…</code>, <code>rdp://…</code>), plus counts per protocol.
Requires a Sushi session.</li>
<li><a href="/hosts?format=json">/hosts?format=json</a> — this page as JSON.</li>
<li><code>/hosts?host=&lt;host-id&gt;&amp;protocol=rdp</code> — a bookmarked link straight into that
machine&apos;s desktop (or SSH / SFTP).</li>
</ul></section>

<a class="cta" href="/">Open Sushi →</a>
</div></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
