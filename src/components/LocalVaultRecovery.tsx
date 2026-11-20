"use client";

import React, { useState } from "react";
import { readPortableBackup, replaceLocalVaultFromBackup } from "@/lib/client/local-vault-recovery";
import { MAX_IMPORT_FILE_BYTES } from "@/lib/client/ssh-import-files";

/** Restore a portable backup without first having to open the old browser vault. */
export function LocalVaultRecovery({
  expected,
  willSyncToServer,
  onRestored,
}: {
  expected: string | null;
  willSyncToServer: boolean;
  onRestored: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const restore = async () => {
    if (!file || !passphrase) {
      setError("Choose a portable backup and enter its passphrase.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error("The backup exceeds the 50 MB import limit.");
      // Verify the backup before touching the old vault, then require a deliberate
      // confirmation and a compare-and-swap in case another tab has changed it.
      const plain = await readPortableBackup(await file.text(), passphrase);
      const confirmation = "Restore this backup and replace this browser's current vault? Download the current encrypted copy first if you need to keep it." +
        (willSyncToServer ? " Sushi will then save an encrypted copy to the empty server vault." : "");
      if (!window.confirm(confirmation)) return;
      await replaceLocalVaultFromBackup(plain, expected);
      setPassphrase("");
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore the backup. No vault was replaced.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
      <p className="font-semibold text-slate-200">Restore a portable backup</p>
      <p className="text-slate-400">
        This replaces the browser vault. {willSyncToServer && "An encrypted copy will also be saved to the empty server vault."} Download the existing copy first if needed. Portable backups do not include passkeys or workspace history.
      </p>
      <label className="block text-slate-300">
        Backup file
        <input type="file" accept=".json,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="mt-1 block w-full text-slate-400" />
      </label>
      <label className="block text-slate-300">
        Backup passphrase
        <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-lg border border-white/10 bg-[#151a24] px-3 py-2 text-white" />
      </label>
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      <button type="button" onClick={() => void restore()} disabled={busy} className="rounded-lg border border-white/15 px-3 py-2 font-semibold text-slate-100 disabled:opacity-50">
        {busy ? "Restoring…" : "Restore backup"}
      </button>
    </div>
  );
}
