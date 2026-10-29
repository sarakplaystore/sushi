"use client";

import React, { useState } from "react";
import {
  X,
  Shield,
  Download,
  Upload,
  Lock,
  Unlock,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import type { EncryptedVaultEnvelope } from "@/lib/client/crypto-vault";

interface VaultSecurityModalProps {
  isOpen: boolean;
  vaultMode: "device" | "passphrase";
  serverVaultEnabled: boolean;
  hostCount: number;
  onClose: () => void;
  onSetPassphrase: (passphrase: string | null) => Promise<void>;
  onLockNow: () => void;
  onExportEnvelope: () => EncryptedVaultEnvelope | null;
  onImportEnvelope: (envelope: EncryptedVaultEnvelope, passphrase?: string) => Promise<void>;
}

export function VaultSecurityModal({
  isOpen,
  vaultMode,
  serverVaultEnabled,
  hostCount,
  onClose,
  onSetPassphrase,
  onLockNow,
  onExportEnvelope,
  onImportEnvelope,
}: VaultSecurityModalProps) {
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [importPass, setImportPass] = useState("");
  const [pendingImport, setPendingImport] = useState<EncryptedVaultEnvelope | null>(
    null
  );
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleApplyPassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    if (!newPass || newPass.length < 6) {
      setStatus({ ok: false, msg: "Master passphrase must be at least 6 characters." });
      return;
    }
    if (newPass !== confirmPass) {
      setStatus({ ok: false, msg: "Passphrases do not match." });
      return;
    }
    setSaving(true);
    try {
      await onSetPassphrase(newPass);
      setNewPass("");
      setConfirmPass("");
      setStatus({
        ok: true,
        msg: "Vault re-encrypted with PBKDF2-SHA256 + AES-256-GCM master passphrase.",
      });
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Failed to update vault encryption.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSwitchToDeviceKey = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await onSetPassphrase(null);
      setStatus({
        ok: true,
        msg: "Switched to automatic device-bound AES-256-GCM encryption.",
      });
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Failed to switch mode.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    const env = onExportEnvelope();
    if (!env) {
      setStatus({ ok: false, msg: "Vault is empty; save a host first." });
      return;
    }
    const blob = new Blob([JSON.stringify(env, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sushi-vault-${new Date().toISOString().slice(0, 10)}.enc.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus({ ok: true, msg: "Encrypted vault backup downloaded." });
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as EncryptedVaultEnvelope;
      if (!parsed.ciphertext || !parsed.iv) {
        throw new Error("Invalid encrypted vault file.");
      }
      if (parsed.mode === "passphrase") {
        setPendingImport(parsed);
        setStatus({
          ok: true,
          msg: "Enter the backup's master passphrase below to decrypt and import.",
        });
      } else {
        await onImportEnvelope(parsed);
        setStatus({ ok: true, msg: "Vault backup imported!" });
      }
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Failed to import vault file.",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Shield className="h-4 w-4 text-emerald-400" />
            <h2 className="text-base font-semibold text-white">
              AES-256-GCM Credential Vault
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="rounded-xl border border-white/8 bg-[#141923] p-3.5 text-xs text-slate-300">
            <div className="flex items-center justify-between">
              <span>
                Protection Mode:{" "}
                <strong className="text-white">
                  {vaultMode === "passphrase"
                    ? "Master Passphrase (PBKDF2)"
                    : "Device Key (AES-256-GCM)"}
                </strong>
              </span>
              <span className="font-mono-code text-slate-400">{hostCount} hosts</span>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-400">
              VPS Encrypted File Sync:{" "}
              <span className={serverVaultEnabled ? "text-emerald-400" : "text-slate-500"}>
                {serverVaultEnabled
                  ? "Enabled (/data/vault.enc.json)"
                  : "Browser Local Vault (Serverless mode)"}
              </span>
            </div>
          </div>

          {status && (
            <div
              className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-xs ${
                status.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-200"
              }`}
            >
              {status.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              )}
              <span>{status.msg}</span>
            </div>
          )}

          {/* Set Master Passphrase */}
          <form
            onSubmit={handleApplyPassphrase}
            className="space-y-3 rounded-xl border border-white/8 bg-[#131722] p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                {vaultMode === "passphrase"
                  ? "Change Master Passphrase"
                  : "Enable Master Passphrase Lock"}
              </span>
              {vaultMode === "passphrase" && (
                <button
                  type="button"
                  onClick={() => {
                    onLockNow();
                    onClose();
                  }}
                  className="flex items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25"
                >
                  <Lock className="h-3 w-3" />
                  Lock Vault Now
                </button>
              )}
            </div>
            <input
              type="password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="New master passphrase (min 6 chars)"
              className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-white/25"
            />
            <input
              type="password"
              value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
              placeholder="Confirm master passphrase"
              className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-white/25"
            />
            <div className="flex items-center justify-between pt-1">
              {vaultMode === "passphrase" ? (
                <button
                  type="button"
                  onClick={handleSwitchToDeviceKey}
                  disabled={saving}
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"
                >
                  <Unlock className="h-3.5 w-3.5" />
                  Remove Passphrase Lock
                </button>
              ) : (
                <span className="text-[11px] text-slate-500">
                  Recommended before exporting portable backups
                </span>
              )}
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                Apply Passphrase
              </button>
            </div>
          </form>

          {/* Backup Export & Import */}
          <div className="space-y-3 rounded-xl border border-white/8 bg-[#131722] p-4">
            <div className="text-xs font-semibold text-white">
              Portable Encrypted Backup
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={handleExport}
                className="flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
              >
                <Download className="h-3.5 w-3.5" />
                Export Encrypted JSON
              </button>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10">
                <Upload className="h-3.5 w-3.5" />
                Import Encrypted JSON
                <input
                  type="file"
                  accept=".json"
                  onChange={handleImportFile}
                  className="hidden"
                />
              </label>
            </div>

            {pendingImport && (
              <div className="mt-2 flex items-center gap-2 pt-2">
                <input
                  type="password"
                  value={importPass}
                  onChange={(e) => setImportPass(e.target.value)}
                  placeholder="Enter backup master passphrase"
                  className="flex-1 rounded-xl border border-white/10 bg-[#0b0e14] px-3 py-1.5 text-xs text-white outline-none"
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await onImportEnvelope(pendingImport, importPass);
                      setPendingImport(null);
                      setImportPass("");
                      setStatus({ ok: true, msg: "Encrypted vault imported!" });
                    } catch (err) {
                      setStatus({
                        ok: false,
                        msg:
                          err instanceof Error ? err.message : "Wrong backup passphrase.",
                      });
                    }
                  }}
                  className="rounded-xl bg-[#ff6b57] px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Unlock Backup
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
