import { loadEnvConfig } from "@next/env";
import { getEffectiveAuthConfig } from "../src/lib/server/auth";
import { getStateStoreKind, initializeEmptyFirestore, readStateRecord } from "../src/lib/server/state-store";
import { readStoredVault } from "../src/lib/server/vault-store";

// Run this offline with exactly the same source storage/namespace settings as
// the existing deployment and the new Firestore settings in the environment.
loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceArg = args.find((arg) => arg.startsWith("--source="));
  const source = sourceArg?.slice("--source=".length);
  const apply = args.includes("--apply");
  const stopped = args.includes("--writers-stopped");
  if ((source !== "disk" && source !== "redis") ||
      args.some((arg) => arg !== sourceArg && arg !== "--apply" && arg !== "--writers-stopped")) {
    throw new Error("Usage: npm run migrate:firestore -- --source=disk|redis [--apply --writers-stopped]");
  }
  if (apply && !stopped) {
    throw new Error("Stop every Sushi writer first, then pass --writers-stopped with --apply. Read the migration instructions before proceeding.");
  }
  if (process.env.SUSHI_STORAGE_BACKEND?.trim().toLowerCase() !== "firestore") {
    throw new Error("Set SUSHI_STORAGE_BACKEND=firestore and the destination Firestore settings before running migration.");
  }

  process.env.SUSHI_STORAGE_BACKEND = source;
  if (getStateStoreKind() !== source) throw new Error("The requested source storage is not configured.");
  // Existing parser validation fails closed on damaged account/vault data.
  await getEffectiveAuthConfig();
  const auth = await readStateRecord("auth");
  const sourceVault = await readStoredVault();
  const vault = sourceVault?.raw ?? null;
  if (auth === null && vault === null) throw new Error("The source has no persistent account or encrypted vault to copy.");
  if (await readStateRecord("auth") !== auth || await readStateRecord("vault") !== vault) {
    throw new Error("The source changed during the check. Stop all writers and try again.");
  }

  process.env.SUSHI_STORAGE_BACKEND = "firestore";
  if (await readStateRecord("auth") !== null || await readStateRecord("vault") !== null) {
    throw new Error("The destination Firestore namespace is not empty. Nothing was overwritten.");
  }
  console.log(`Source ${source}: account ${auth === null ? "not present" : "present"}, encrypted vault ${vault === null ? "not present" : "present"}. Destination Firestore namespace is empty.`);
  if (!apply) {
    console.log("Dry run only. Stop all writers and rerun with --apply --writers-stopped to copy both records atomically.");
    return;
  }
  if (!await initializeEmptyFirestore(auth, vault)) {
    throw new Error("The destination changed during migration. Nothing was overwritten; check the destination before retrying.");
  }
  const copiedAuth = await readStateRecord("auth");
  const copiedVault = await readStateRecord("vault");
  if (copiedAuth !== auth || copiedVault !== vault) {
    throw new Error("Could not verify the destination. Keep the original data and inspect Firestore before enabling writes.");
  }
  process.env.SUSHI_STORAGE_BACKEND = source;
  if (await readStateRecord("auth") !== auth || await readStateRecord("vault") !== vault) {
    throw new Error("The source changed during migration. The destination may contain an older snapshot; keep both stores and do not enable writes until resolved.");
  }
  console.log("Copied and verified. Original storage was not modified. Keep it and your portable backup until the Firestore deployment is verified on another device.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Migration could not be completed. Keep the source data and check the destination before retrying.");
  process.exitCode = 1;
});
