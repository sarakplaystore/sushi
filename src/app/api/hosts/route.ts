import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/server/security";
import { verifyAdminSession } from "@/lib/server/auth";
import { isServerVaultEnabled, readStoredVault } from "@/lib/server/vault-store";
import { buildUnifiedInventory, unifiedInventoryFromProfiles } from "@/lib/server/unified-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/hosts` — **one URL for every SSH / SFTP / RDP host you have saved.**
 *
 * Each machine + account appears once (`id`, `accessUrl`, `protocols`, `links` with the
 * SSH / SFTP / RDP address of every way in), instead of one row per saved profile in
 * three different lists.
 *
 * The vault is end-to-end encrypted, so the honest default is an *index*:
 * `encrypted: true` and every entry redacted (`host #1`) but still complete
 * structurally — id, protocols, ports, profile counts, access URLs. Open `/hosts` in
 * Sushi (or unlock the vault) to see names and connect.
 *
 * Deployments that keep a clear-text inventory on purpose can opt in with
 * `SUSHI_HOSTS_INVENTORY` = a JSON document (or a file path) of the shape
 * `{ "hosts": [ { …HostProfile } ] }`; its entries are merged the same way and
 * returned with `encrypted: false`. Nothing is ever decrypted server-side.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req.headers.get("origin")) });
}

interface ClearTextInventory {
  hosts?: unknown[];
}

/** Reads `SUSHI_HOSTS_INVENTORY` (inline JSON or a file path). Null when unset/invalid. */
async function readClearTextInventory(): Promise<unknown[] | null> {
  const raw = process.env.SUSHI_HOSTS_INVENTORY?.trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith("{") || raw.startsWith("[")
      ? raw
      : await (await import("node:fs/promises")).readFile(raw, "utf8");
    const parsed = JSON.parse(text) as ClearTextInventory | unknown[];
    const hosts = Array.isArray(parsed) ? parsed : parsed?.hosts;
    return Array.isArray(hosts) ? hosts : null;
  } catch {
    // A broken inventory must not take the endpoint down; fall back to the index.
    return null;
  }
}

/** Keeps only entries that look like a HostProfile (never trust env JSON blindly). */
function asProfiles(raw: unknown[]): Parameters<typeof unifiedInventoryFromProfiles>[0] {
  return raw.filter((entry): entry is Parameters<typeof unifiedInventoryFromProfiles>[0][number] => {
    if (!entry || typeof entry !== "object") return false;
    const data = entry as Record<string, unknown>;
    return (
      typeof data.host === "string" &&
      Boolean(data.host) &&
      typeof data.username === "string" &&
      Boolean(data.username) &&
      (data.protocol === "ssh" || data.protocol === "sftp" || data.protocol === "rdp")
    );
  }).map((entry) => ({
    ...entry,
    // Force a usable shape; the inventory is a view, not a place to invent profiles.
    id: String(entry.id || `${entry.protocol}:${entry.username}@${entry.host}`),
    name: String(entry.name || `${entry.username}@${entry.host}`),
    port: Number(entry.port) || (entry.protocol === "rdp" ? 3389 : 22),
    authMethod: entry.authMethod === "privateKey" ? "privateKey" : "password",
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 20).map(String) : [],
    createdAt: Number(entry.createdAt) || 0,
    updatedAt: Number(entry.updatedAt) || 0,
  }));
}

export async function GET(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get("origin"));
  try {
    const auth = await verifyAdminSession(req.headers);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: 401, headers: cors });
    }

    // 1. An explicitly clear-text inventory, when the operator configured one.
    const clear = await readClearTextInventory();
    if (clear) {
      const profiles = asProfiles(clear);
      const inventory = unifiedInventoryFromProfiles(profiles, {
        resolve: true,
        encrypted: false,
        source: "vault",
      });
      return NextResponse.json(inventory, {
        headers: { ...cors, "Cache-Control": "no-store" },
      });
    }

    // 2. Otherwise describe the encrypted vault: one entry per machine, redacted.
    if (!isServerVaultEnabled()) {
      // Device-key vaults (or none yet) are only reachable from the browser that
      // holds the key: the index is empty but the shape is complete.
      const empty = buildUnifiedInventory([], {
        resolve: false,
        encrypted: true,
        source: "vault",
      });
      return NextResponse.json(
        {
          ...empty,
          hint: "This Sushi has no shared vault: the connection list lives in the browser that created it. Open /hosts in Sushi to see and connect to your hosts.",
        },
        { headers: { ...cors, "Cache-Control": "no-store" } }
      );
    }

    const stored = await readStoredVault();
    // The envelope cannot be opened here (that is the point of the vault); its mode
    // and revision are still useful to a client, and the count of hosts is not known
    // until a browser unlocks it.
    const envelope = stored?.envelope;
    const inventory = buildUnifiedInventory([], {
      resolve: false,
      encrypted: Boolean(envelope),
      source: "server-vault",
    });
    return NextResponse.json(
      {
        ...inventory,
        vault: {
          enabled: true,
          mode: envelope?.mode ?? null,
          keySource: envelope?.keySource ?? null,
          revision: stored?.revision ?? null,
          updatedAt: envelope?.updatedAt ?? null,
        },
      },
      { headers: { ...cors, "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not read the host inventory.",
      },
      { status: 503, headers: cors }
    );
  }
}
