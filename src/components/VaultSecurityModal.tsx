"use client";

import React, { useEffect, useState } from "react";
import {
  X,
  Shield,
  Download,
  Upload,
  Lock,
  Unlock,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  ArrowLeftRight,
  Plus,
  Trash2,
  Copy,
  Check,
  Loader2,
  FileJson,
  Sparkles,
} from "lucide-react";
import type { HostProfile, WhitelistedSshKey } from "@/types/connection";
import type { EncryptedVaultEnvelope } from "@/lib/client/crypto-vault";
import {
  exportToTermixFile,
  importFromTermixContent,
  type TermixImportSummary,
} from "@/lib/client/termix-porter";
import { type GatewaySettings, getAuthHeaders } from "@/lib/client/gateway";

export type VaultModalTab = "termix" | "keys" | "security";

interface VaultSecurityModalProps {
  isOpen: boolean;
  initialTab?: VaultModalTab;
  vaultMode: "device" | "passphrase";
  serverVaultEnabled: boolean;
  hosts: HostProfile[];
  sshKeys: WhitelistedSshKey[];
  enforceKeyWhitelist: boolean;
  gatewaySettings: GatewaySettings;
  onClose: () => void;
  onSetPassphrase: (passphrase: string | null) => Promise<void>;
  onLockNow: () => void;
  onExportEnvelope: () => EncryptedVaultEnvelope | null;
  onImportEnvelope: (
    envelope: EncryptedVaultEnvelope,
    passphrase?: string
  ) => Promise<void>;
  onUpdateKeychain: (
    nextKeys: WhitelistedSshKey[],
    nextEnforceWhitelist: boolean
  ) => Promise<void>;
  onApplyTermixImport: (
    importedHosts: HostProfile[],
    importedKeys: WhitelistedSshKey[],
    replaceExisting: boolean
  ) => Promise<void>;
}

function downloadJsonOrText(filename: string, content: string, mime = "application/json") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function VaultSecurityModal({
  isOpen,
  initialTab = "security",
  vaultMode,
  serverVaultEnabled,
  hosts,
  sshKeys,
  enforceKeyWhitelist,
  gatewaySettings,
  onClose,
  onSetPassphrase,
  onLockNow,
  onExportEnvelope,
  onImportEnvelope,
  onUpdateKeychain,
  onApplyTermixImport,
}: VaultSecurityModalProps) {
  const [activeTab, setActiveTab] = useState<VaultModalTab>(initialTab);

  // Security / Encryption state
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [importPass, setImportPass] = useState("");
  const [pendingImport, setPendingImport] =
    useState<EncryptedVaultEnvelope | null>(null);
  const [saving, setSaving] = useState(false);

  // SSH Key Whitelist state
  const [keyName, setKeyName] = useState("");
  const [keyPrivateText, setKeyPrivateText] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [addingKey, setAddingKey] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copiedPubKeyId, setCopiedPubKeyId] = useState<string | null>(null);

  // Termix Import / Export state
  const [termixPreview, setTermixPreview] =
    useState<TermixImportSummary | null>(null);
  const [termixFilename, setTermixFilename] = useState<string | null>(null);
  const [importingTermix, setImportingTermix] = useState(false);

  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(
    null
  );

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setStatus(null);
      setTermixPreview(null);
      setTermixFilename(null);
    }
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  // --- Security / Vault Handlers ---
  const handleApplyPassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    if (!newPass || newPass.length < 6) {
      setStatus({
        ok: false,
        msg: "Master passphrase must be at least 6 characters.",
      });
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
        msg:
          err instanceof Error
            ? err.message
            : "Failed to update vault encryption.",
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

  const handleExportSushiEnvelope = () => {
    const env = onExportEnvelope();
    if (!env) {
      setStatus({ ok: false, msg: "Vault is empty; save a host or key first." });
      return;
    }
    downloadJsonOrText(
      `sushi-vault-${new Date().toISOString().slice(0, 10)}.enc.json`,
      JSON.stringify(env, null, 2)
    );
    setStatus({ ok: true, msg: "Encrypted Sushi vault backup downloaded." });
  };

  const handleImportSushiEnvelopeFile = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as EncryptedVaultEnvelope;
      if (!parsed.ciphertext || !parsed.iv) {
        throw new Error(
          "Not an encrypted Sushi Vault (.enc.json). For Termix JSON files, use the Termix Import / Export tab."
        );
      }
      if (parsed.mode === "passphrase") {
        setPendingImport(parsed);
        setStatus({
          ok: true,
          msg: "Enter the backup's master passphrase below to decrypt and import.",
        });
      } else {
        await onImportEnvelope(parsed);
        setStatus({ ok: true, msg: "Sushi Vault backup imported!" });
      }
    } catch (err) {
      setStatus({
        ok: false,
        msg:
          err instanceof Error ? err.message : "Failed to import vault file.",
      });
    }
  };

  // --- SSH Key Whitelist Handlers ---
  const handleAddWhitelistedSshKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    if (!keyPrivateText.trim()) {
      setStatus({
        ok: false,
        msg: "Paste or upload an OpenSSH / PEM private key first.",
      });
      return;
    }

    setAddingKey(true);
    try {
      const cleanName = keyName.trim() || `SSH Key ${sshKeys.length + 1}`;
      const res = await fetch("/api/ssh/key-inspect", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          action: "inspect",
          privateKey: keyPrivateText.trim(),
          passphrase: keyPassphrase || undefined,
          label: cleanName,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Invalid SSH private key.");
      }

      if (sshKeys.some((k) => k.fingerprint === data.fingerprint)) {
        setStatus({
          ok: false,
          msg: `Key (${data.fingerprint}) is already in your SSH Key Whitelist.`,
        });
        return;
      }

      const nextKey: WhitelistedSshKey = {
        id: crypto.randomUUID(),
        name: cleanName,
        privateKey: keyPrivateText.trim(),
        passphrase: keyPassphrase || undefined,
        publicKey: data.publicKeyOpenSSH,
        keyType: data.keyType,
        fingerprint: data.fingerprint,
        createdAt: Date.now(),
      };

      await onUpdateKeychain([...sshKeys, nextKey], enforceKeyWhitelist);
      setKeyName("");
      setKeyPrivateText("");
      setKeyPassphrase("");
      setStatus({
        ok: true,
        msg: `Added "${cleanName}" (${data.fingerprint}) to Whitelisted SSH Keychain.`,
      });
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Failed to add SSH key.",
      });
    } finally {
      setAddingKey(false);
    }
  };

  const handleGenerateServerSshKey = async () => {
    setStatus(null);
    setGeneratingKey(true);
    try {
      const cleanName = keyName.trim() || `Ed25519 Key ${sshKeys.length + 1}`;
      const res = await fetch("/api/ssh/key-inspect", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          action: "generate",
          label: cleanName,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to generate SSH keypair.");
      }

      const nextKey: WhitelistedSshKey = {
        id: crypto.randomUUID(),
        name: cleanName,
        privateKey: data.privateKey,
        publicKey: data.publicKeyOpenSSH,
        keyType: data.keyType,
        fingerprint: data.fingerprint,
        createdAt: Date.now(),
      };

      await onUpdateKeychain([...sshKeys, nextKey], enforceKeyWhitelist);
      setKeyName("");
      setStatus({
        ok: true,
        msg: `Generated "${cleanName}" (${data.fingerprint}). Copy its public key below to add to ~/.ssh/authorized_keys on your servers!`,
      });
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Key generation failed.",
      });
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleRemoveWhitelistedKey = async (id: string) => {
    const next = sshKeys.filter((k) => k.id !== id);
    await onUpdateKeychain(next, enforceKeyWhitelist);
    setStatus({ ok: true, msg: "Removed SSH key from whitelist." });
  };

  const handleToggleEnforceWhitelist = async (checked: boolean) => {
    await onUpdateKeychain(sshKeys, checked);
    setStatus({
      ok: true,
      msg: checked
        ? "Strict Private Key Whitelist enabled — SSH/SFTP hosts can only use approved keys."
        : "Private Key Whitelist switched to permissive keychain mode.",
    });
  };

  // --- Termix Import / Export Handlers ---
  const handleSelectTermixFile = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    try {
      const raw = await file.text();
      const summary = importFromTermixContent(raw, sshKeys);
      setTermixPreview(summary);
      setTermixFilename(file.name);
    } catch (err) {
      setTermixPreview(null);
      setStatus({
        ok: false,
        msg:
          err instanceof Error
            ? err.message
            : "Could not parse Termix import file.",
      });
    }
    e.target.value = "";
  };

  const handleConfirmTermixImport = async (replaceExisting: boolean) => {
    if (!termixPreview) return;
    setImportingTermix(true);
    setStatus(null);
    try {
      await onApplyTermixImport(
        termixPreview.hosts,
        termixPreview.sshKeys,
        replaceExisting
      );
      setStatus({
        ok: true,
        msg: `Imported ${termixPreview.hosts.length} host(s)${
          termixPreview.sshKeys.length > 0
            ? ` and ${termixPreview.sshKeys.length} whitelisted SSH key(s)`
            : ""
        } from ${termixFilename || "Termix file"}!`,
      });
      setTermixPreview(null);
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Termix import failed.",
      });
    } finally {
      setImportingTermix(false);
    }
  };

  const handleExportTermix = (shareMode: boolean) => {
    if (hosts.length === 0 && sshKeys.length === 0) {
      setStatus({
        ok: false,
        msg: "Add at least one host or SSH key before exporting to Termix.",
      });
      return;
    }
    const payload = exportToTermixFile(hosts, sshKeys, { shareMode });
    const suffix = shareMode ? "share" : "full";
    const date = new Date().toISOString().slice(0, 10);
    downloadJsonOrText(
      `termix-hosts-${suffix}-${date}.json`,
      JSON.stringify(payload, null, 2)
    );
    setStatus({
      ok: true,
      msg: shareMode
        ? "Downloaded scrubbed Termix Share JSON (secrets omitted)."
        : `Exported ${hosts.length} host(s) & ${sshKeys.length} key(s) to Termix JSON!`,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Shield className="h-4 w-4 text-emerald-400" />
            <h2 className="text-base font-semibold text-white">
              Vault, SSH Key Whitelist &amp; Termix Sync
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal Tabs */}
        <div className="flex flex-wrap gap-1 border-b border-white/8 bg-[#121722] px-6 py-2">
          <button
            type="button"
            onClick={() => {
              setActiveTab("termix");
              setStatus(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "termix"
                ? "bg-[#ff6b57] text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Termix Import / Export
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("keys");
              setStatus(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "keys"
                ? "bg-[#ff6b57] text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            SSH Key Whitelist ({sshKeys.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("security");
              setStatus(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "security"
                ? "bg-[#ff6b57] text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Shield className="h-3.5 w-3.5" />
            Vault Encryption
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {status && (
            <div
              className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs ${
                status.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-200"
              }`}
            >
              {status.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              )}
              <span>{status.msg}</span>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 1: TERMIX IMPORT & EXPORT                                   */}
          {/* ============================================================== */}
          {activeTab === "termix" && (
            <div className="space-y-5">
              {/* Import from Termix */}
              <div className="rounded-xl border border-white/8 bg-[#141923] p-4 space-y-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold text-white">
                      Import from Termix File
                    </h3>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      Supports Termix Host Export (`.json`), Termix Share Export,
                      Termix v2.0 User Data Export, and OpenSSH `~/.ssh/config`.
                      Embedded SSH keys are automatically added to your Key
                      Whitelist.
                    </p>
                  </div>
                </div>

                <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-[#0d1118] px-4 py-6 text-center transition hover:border-[#ff6b57]/60 hover:bg-white/[0.02]">
                  <FileJson className="h-6 w-6 text-[#ff6b57]" />
                  <div className="text-xs font-semibold text-white">
                    Choose Termix `.json` or SSH `config` file
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Click to select a file from your computer
                  </div>
                  <input
                    type="file"
                    accept=".json,.txt,.cfg,.conf,*"
                    onChange={handleSelectTermixFile}
                    className="hidden"
                  />
                </label>

                {termixPreview && (
                  <div className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/8 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-emerald-200">
                        Ready to Import from{" "}
                        <span className="font-mono-code text-white">
                          {termixFilename}
                        </span>
                      </div>
                      <span className="rounded bg-white/10 px-2 py-0.5 font-mono-code text-[10px] text-slate-200">
                        {termixPreview.detectedFormat}
                      </span>
                    </div>

                    <div className="text-xs text-slate-300">
                      Detected{" "}
                      <strong className="text-white">
                        {termixPreview.hosts.length}
                      </strong>{" "}
                      host(s) and{" "}
                      <strong className="text-white">
                        {termixPreview.sshKeys.length}
                      </strong>{" "}
                      new SSH private key(s).
                    </div>

                    {termixPreview.warnings.length > 0 && (
                      <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
                        {termixPreview.warnings.map((w, idx) => (
                          <div key={idx}>• {w}</div>
                        ))}
                      </div>
                    )}

                    {termixPreview.hosts.length > 0 && (
                      <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg bg-black/30 p-2.5 text-[11px]">
                        {termixPreview.hosts.slice(0, 12).map((h) => (
                          <div
                            key={h.id}
                            className="flex items-center justify-between text-slate-300"
                          >
                            <span className="truncate font-medium text-white">
                              {h.name}
                            </span>
                            <span className="font-mono-code text-slate-400">
                              {h.protocol.toUpperCase()} · {h.username}@{h.host}:
                              {h.port}
                            </span>
                          </div>
                        ))}
                        {termixPreview.hosts.length > 12 && (
                          <div className="text-slate-500">
                            + {termixPreview.hosts.length - 12} more host(s)…
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        disabled={importingTermix}
                        onClick={() => handleConfirmTermixImport(false)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e] disabled:opacity-50"
                      >
                        {importingTermix && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        Merge into Sushi ({hosts.length + termixPreview.hosts.length}{" "}
                        total)
                      </button>
                      <button
                        type="button"
                        disabled={importingTermix}
                        onClick={() => handleConfirmTermixImport(true)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
                      >
                        Replace Existing Hosts
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Export to Termix */}
              <div className="rounded-xl border border-white/8 bg-[#141923] p-4 space-y-3">
                <div>
                  <h3 className="text-xs font-semibold text-white">
                    Export Sushi Hosts &amp; Keys to Termix File
                  </h3>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Generates a standard Termix JSON file (`hosts` + `credentials`)
                    that imports cleanly into Termix or another Sushi workspace.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => handleExportTermix(false)}
                    className="flex items-center justify-center gap-2 rounded-xl bg-[#ff6b57] px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/20 transition hover:bg-[#ff7f6e]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export Full Termix JSON (with Keys)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportTermix(true)}
                    className="flex items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/5 px-4 py-2.5 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                  >
                    <Download className="h-3.5 w-3.5 text-emerald-400" />
                    Export Share JSON (No Secrets)
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 2: WHITELISTED SSH PRIVATE KEYCHAIN                         */}
          {/* ============================================================== */}
          {activeTab === "keys" && (
            <div className="space-y-4">
              {/* Strict Enforcement Toggle */}
              <div className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-[#141923] p-3.5">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                    <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                    Enforce Whitelisted Private Keys Only
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    When enabled, SSH &amp; SFTP hosts can only connect using
                    approved private keys saved in this Vault Whitelist.
                  </p>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={enforceKeyWhitelist}
                    onChange={(e) =>
                      handleToggleEnforceWhitelist(e.target.checked)
                    }
                    className="peer sr-only"
                  />
                  <div className="h-5 w-9 rounded-full bg-white/15 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-emerald-500 peer-checked:after:translate-x-full" />
                </label>
              </div>

              {/* Add / Generate Whitelisted SSH Private Key */}
              <form
                onSubmit={handleAddWhitelistedSshKey}
                className="space-y-3 rounded-xl border border-white/8 bg-[#141923] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white">
                    Add or Generate Whitelisted SSH Key
                  </span>
                  <button
                    type="button"
                    onClick={handleGenerateServerSshKey}
                    disabled={generatingKey}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    {generatingKey ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    Generate New Ed25519 Keypair
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    placeholder="Key label (e.g. Prod Cluster Key)"
                    className="flex-1 rounded-xl border border-white/10 bg-[#0d1118] px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                  />
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10">
                    <Upload className="h-3.5 w-3.5 text-[#ff6b57]" />
                    Upload .pem / id_ed25519
                    <input
                      type="file"
                      accept=".pem,.key,.txt,*"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const text = await f.text();
                        setKeyPrivateText(text.trim());
                        if (!keyName) {
                          setKeyName(f.name.replace(/\.(pem|key)$/i, ""));
                        }
                      }}
                      className="hidden"
                    />
                  </label>
                </div>

                <textarea
                  rows={3}
                  value={keyPrivateText}
                  onChange={(e) => setKeyPrivateText(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                  className="w-full rounded-xl border border-white/10 bg-[#0d1118] p-2.5 font-mono-code text-[11px] text-slate-200 placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                />

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    value={keyPassphrase}
                    onChange={(e) => setKeyPassphrase(e.target.value)}
                    placeholder="Key passphrase (optional)"
                    className="flex-1 rounded-xl border border-white/10 bg-[#0d1118] px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={addingKey}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e] disabled:opacity-50"
                  >
                    {addingKey && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Add to Key Whitelist
                  </button>
                </div>
              </form>

              {/* Saved Whitelisted Keys List */}
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Approved SSH Keys in Vault ({sshKeys.length})
                </div>
                {sshKeys.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-center text-xs text-slate-500">
                    No whitelisted SSH private keys yet. Generate an Ed25519
                    keypair or import an existing `.pem` / `id_ed25519` key above.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sshKeys.map((k) => (
                      <div
                        key={k.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/8 bg-[#141923] px-3.5 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-xs font-medium text-white">
                            <span className="truncate">{k.name}</span>
                            {k.keyType && (
                              <span className="rounded bg-white/8 px-1.5 py-0.5 font-mono-code text-[10px] text-slate-300">
                                {k.keyType}
                              </span>
                            )}
                          </div>
                          {k.fingerprint && (
                            <div className="truncate font-mono-code text-[11px] text-slate-400">
                              {k.fingerprint}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {k.publicKey && (
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(k.publicKey!);
                                setCopiedPubKeyId(k.id);
                                setTimeout(() => setCopiedPubKeyId(null), 2000);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/10"
                              title="Copy OpenSSH public key for ~/.ssh/authorized_keys"
                            >
                              {copiedPubKeyId === k.id ? (
                                <Check className="h-3 w-3 text-emerald-400" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                              {copiedPubKeyId === k.id ? "Copied" : "Copy .pub"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              downloadJsonOrText(
                                `${k.name.toLowerCase().replace(/[^a-z0-9-_]+/g, "-") || "ssh"}-private.key`,
                                k.privateKey,
                                "application/x-pem-file"
                              )
                            }
                            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10"
                            title="Download private key"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveWhitelistedKey(k.id)}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-300"
                            title="Remove from whitelist"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 3: AES-256-GCM ENCRYPTION & ENCRYPTED BACKUP                */}
          {/* ============================================================== */}
          {activeTab === "security" && (
            <div className="space-y-5">
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
                  <span className="font-mono-code text-slate-400">
                    {hosts.length} hosts · {sshKeys.length} keys
                  </span>
                </div>
                <div className="mt-1.5 text-[11px] text-slate-400">
                  VPS Encrypted File Sync:{" "}
                  <span
                    className={
                      serverVaultEnabled ? "text-emerald-400" : "text-slate-500"
                    }
                  >
                    {serverVaultEnabled
                      ? "Enabled (/data/vault.enc.json)"
                      : "Browser Local Vault (Serverless mode)"}
                  </span>
                </div>
              </div>

              <form onSubmit={handleApplyPassphrase} className="space-y-3">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Set / Change Master Passphrase
                </label>
                <input
                  type="password"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  placeholder="New master passphrase (min 6 chars)"
                  className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                />
                <input
                  type="password"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  placeholder="Confirm master passphrase"
                  className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white hover:bg-[#ff7f6e]"
                  >
                    <Lock className="h-3.5 w-3.5" />
                    Encrypt with Master Passphrase
                  </button>
                  {vaultMode === "passphrase" && (
                    <>
                      <button
                        type="button"
                        onClick={onLockNow}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10"
                      >
                        Lock Vault Now
                      </button>
                      <button
                        type="button"
                        onClick={handleSwitchToDeviceKey}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-400 hover:text-white"
                      >
                        <Unlock className="h-3.5 w-3.5" />
                        Use Automatic Device Key
                      </button>
                    </>
                  )}
                </div>
              </form>

              <div className="space-y-2.5 border-t border-white/8 pt-4">
                <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Encrypted Sushi Backup (.enc.json)
                </span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleExportSushiEnvelope}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export Encrypted Vault
                  </button>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10">
                    <Upload className="h-3.5 w-3.5" />
                    Import Encrypted Vault
                    <input
                      type="file"
                      accept=".json"
                      onChange={handleImportSushiEnvelopeFile}
                      className="hidden"
                    />
                  </label>
                </div>

                {pendingImport && (
                  <div className="mt-3 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                    <input
                      type="password"
                      value={importPass}
                      onChange={(e) => setImportPass(e.target.value)}
                      placeholder="Enter backup master passphrase"
                      className="w-full rounded-lg border border-white/10 bg-[#0d1118] px-3 py-1.5 text-xs text-white focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await onImportEnvelope(pendingImport, importPass);
                          setPendingImport(null);
                          setImportPass("");
                          setStatus({
                            ok: true,
                            msg: "Encrypted backup unlocked & imported!",
                          });
                        } catch (err) {
                          setStatus({
                            ok: false,
                            msg:
                              err instanceof Error
                                ? err.message
                                : "Incorrect passphrase.",
                          });
                        }
                      }}
                      className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400"
                    >
                      Unlock &amp; Import Backup
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
