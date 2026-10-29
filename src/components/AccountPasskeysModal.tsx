"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  X,
  Fingerprint,
  Plus,
  Trash2,
  LogOut,
  KeyRound,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  ExternalLink,
  Download,
  Upload,
  Sparkles,
} from "lucide-react";
import type { AuthorizedKeyRecord, PublicPasskeySummary } from "@/types/auth";
import {
  addStoredAuthorizedKeyCertificate,
  addStoredPasskeyCertificate,
  getStoredAdminProfileCert,
  getStoredAuthorizedKeyCertificates,
  getStoredPasskeyCertificates,
  removeStoredAuthorizedKeyCertificate,
  removeStoredPasskeyCertificate,
  setStoredAdminProfileCert,
  setStoredSessionToken,
} from "@/lib/client/auth-storage";
import { type GatewaySettings, getAuthHeaders } from "@/lib/client/gateway";

interface AccountPasskeysModalProps {
  isOpen: boolean;
  username: string;
  runtimeMode?: "vps" | "vercel" | "gateway";
  gatewaySettings: GatewaySettings;
  onClose: () => void;
  onUsernameUpdated: (nextUsername: string) => void;
  onSignedOut: () => void;
}

function defaultPasskeyLabel(): string {
  if (typeof navigator === "undefined") return "My Passkey";
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac Touch ID";
  if (/iPhone|iPad/i.test(ua)) return "iPhone / iPad Face ID";
  if (/Windows/i.test(ua)) return "Windows Hello";
  if (/Android/i.test(ua)) return "Android Passkey";
  return "Security Key / Passkey";
}

function downloadKeyFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/x-pem-file" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function AccountPasskeysModal({
  isOpen,
  username,
  runtimeMode,
  gatewaySettings,
  onClose,
  onUsernameUpdated,
  onSignedOut,
}: AccountPasskeysModalProps) {
  const [activeTab, setActiveTab] = useState<"keys" | "passkeys" | "password">(
    "keys"
  );

  const [passkeys, setPasskeys] = useState<PublicPasskeySummary[]>([]);
  const [authorizedKeys, setAuthorizedKeys] = useState<AuthorizedKeyRecord[]>(
    []
  );
  const [canEditCredentials, setCanEditCredentials] = useState(true);
  const [passkeysEnvJson, setPasskeysEnvJson] = useState("");
  const [authorizedKeysEnvBlock, setAuthorizedKeysEnvBlock] = useState("");
  const [loading, setLoading] = useState(false);

  // Passkey enrollment
  const [registering, setRegistering] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState(defaultPasskeyLabel);

  // Whitelisted Private/Public Key enrollment
  const [authKeyLabel, setAuthKeyLabel] = useState("Laptop SSH Key");
  const [authPublicKeyInput, setAuthPublicKeyInput] = useState("");
  const [addingAuthKey, setAddingAuthKey] = useState(false);
  const [generatingKeypair, setGeneratingKeypair] = useState(false);

  // Password / username update form
  const [nextUsername, setNextUsername] = useState(username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingCreds, setSavingCreds] = useState(false);

  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(
    null
  );
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [copiedAuthKeysEnv, setCopiedAuthKeysEnv] = useState(false);
  const [inIframe, setInIframe] = useState(false);

  const fetchAccountDetails = useCallback(async () => {
    setLoading(true);
    try {
      const certs = getStoredPasskeyCertificates().map((c) => c.cert);
      const keyCerts = getStoredAuthorizedKeyCertificates().map((c) => c.cert);
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/account", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          action: "list",
          signedCertificates: certs,
          signedKeyCertificates: keyCerts,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setPasskeys(data.passkeys || []);
        setAuthorizedKeys(data.authorizedKeys || []);
        setCanEditCredentials(Boolean(data.canEditCredentials));
        setPasskeysEnvJson(data.passkeysEnvJson || "");
        setAuthorizedKeysEnvBlock(data.authorizedKeysEnvBlock || "");
        setNextUsername(data.username || username);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [gatewaySettings, username]);

  useEffect(() => {
    if (!isOpen) return;
    setStatus(null);
    setCurrentPassword("");
    setNewPassword("");
    void fetchAccountDetails();
    try {
      setInIframe(window.self !== window.top);
    } catch {
      setInIframe(true);
    }
  }, [isOpen, fetchAccountDetails]);

  if (!isOpen) return null;

  const handleAddAuthorizedKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    if (!authPublicKeyInput.trim()) {
      setStatus({
        ok: false,
        msg: "Paste an OpenSSH public key (e.g. ssh-ed25519 AAAA...) or PEM key.",
      });
      return;
    }

    setAddingAuthKey(true);
    try {
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/account", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          action: "add_authorized_key",
          publicKey: authPublicKeyInput.trim(),
          label: authKeyLabel.trim() || "Authorized Key",
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to whitelist key.");
      }

      if (data.adminProfileCert) {
        setStoredAdminProfileCert(data.adminProfileCert);
      }
      if (data.record?.fingerprint && data.signedKeyCert) {
        addStoredAuthorizedKeyCertificate(
          data.record.fingerprint,
          data.signedKeyCert
        );
      }

      setAuthPublicKeyInput("");
      setStatus({
        ok: true,
        msg: `Whitelisted key (${data.record.fingerprint}). Holders of the matching private key can now sign in!`,
      });
      await fetchAccountDetails();
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Failed to whitelist key.",
      });
    } finally {
      setAddingAuthKey(false);
    }
  };

  const handleGenerateAndWhitelistKeypair = async () => {
    setStatus(null);
    setGeneratingKeypair(true);
    try {
      const adminCert = getStoredAdminProfileCert();
      const label = authKeyLabel.trim() || `${username}-login-key`;
      const res = await fetch("/api/auth/account", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          action: "generate_authorized_keypair",
          label,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to generate login keypair.");
      }

      if (data.adminProfileCert) {
        setStoredAdminProfileCert(data.adminProfileCert);
      }
      if (data.record?.fingerprint && data.signedKeyCert) {
        addStoredAuthorizedKeyCertificate(
          data.record.fingerprint,
          data.signedKeyCert
        );
      }

      if (data.privateKey) {
        const safeName = label
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, "-")
          .replace(/^-|-$/g, "");
        downloadKeyFile(`${safeName || "sushi-login"}-ed25519.key`, data.privateKey);
      }

      setStatus({
        ok: true,
        msg: `Generated & whitelisted Ed25519 key (${data.record.fingerprint}) and downloaded your private .key file!`,
      });
      await fetchAccountDetails();
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Key generation failed.",
      });
    } finally {
      setGeneratingKeypair(false);
    }
  };

  const handleRevokeAuthorizedKey = async (fingerprint: string) => {
    setStatus(null);
    removeStoredAuthorizedKeyCertificate(fingerprint);
    try {
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          authorizedKeyFingerprint: fingerprint,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (data?.adminProfileCert) {
        setStoredAdminProfileCert(data.adminProfileCert);
      }
      setStatus({ ok: true, msg: "Removed key from login whitelist." });
      await fetchAccountDetails();
    } catch {
      setStatus({ ok: false, msg: "Failed to remove whitelisted key." });
    }
  };

  const handleRegisterPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setRegistering(true);
    try {
      const { browserSupportsWebAuthn, startRegistration } = await import(
        "@simplewebauthn/browser"
      );
      if (!browserSupportsWebAuthn()) {
        throw new Error("WebAuthn Passkeys are not supported in this browser.");
      }

      const existingCerts = getStoredPasskeyCertificates().map((c) => c.cert);
      const optRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          step: "options",
          signedCertificates: existingCerts,
        }),
      });
      const optData = await optRes.json();
      if (!optRes.ok || !optData.ok) {
        throw new Error(optData.error || "Could not generate Passkey options.");
      }

      const attestation = await startRegistration({
        optionsJSON: optData.options,
      });

      const verRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          step: "verify",
          challengeToken: optData.challengeToken,
          label: newKeyLabel.trim() || defaultPasskeyLabel(),
          attestation,
        }),
      });
      const verData = await verRes.json();
      if (!verRes.ok || !verData.ok) {
        throw new Error(verData.error || "Passkey verification failed.");
      }

      if (verData.record?.id && verData.signedCertificate) {
        addStoredPasskeyCertificate(verData.record.id, verData.signedCertificate);
      }

      setStatus({
        ok: true,
        msg: `Passkey "${verData.record?.label || newKeyLabel}" registered!`,
      });
      await fetchAccountDetails();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Passkey registration failed.";
      setStatus({
        ok: false,
        msg: /NotAllowedError|cancelled|aborted/i.test(msg)
          ? inIframe
            ? "Browser blocked Passkey creation inside embedded preview iframe. Open Sushi in a full tab to enroll a Passkey."
            : "Passkey prompt was cancelled."
          : msg,
      });
    } finally {
      setRegistering(false);
    }
  };

  const handleRevokePasskey = async (id: string) => {
    setStatus(null);
    removeStoredPasskeyCertificate(id);
    try {
      await fetch("/api/auth/account", {
        method: "DELETE",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({ credentialId: id }),
      });
      setStatus({ ok: true, msg: "Passkey revoked." });
      await fetchAccountDetails();
    } catch {
      setStatus({ ok: false, msg: "Failed to revoke passkey." });
    }
  };

  const handleUpdateCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    if (!currentPassword) {
      setStatus({ ok: false, msg: "Enter your current password to confirm." });
      return;
    }

    setSavingCreds(true);
    try {
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/account", {
        method: "PUT",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          currentPassword,
          newUsername: nextUsername.trim(),
          newPassword: newPassword || undefined,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to update credentials.");
      }

      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }
      if (data.adminProfileCert) {
        setStoredAdminProfileCert(data.adminProfileCert);
      }
      setCurrentPassword("");
      setNewPassword("");
      onUsernameUpdated(data.username);
      setStatus({ ok: true, msg: "Admin credentials updated." });
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Failed to update account.",
      });
    } finally {
      setSavingCreds(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
      });
    } catch {
      // ignore
    }
    setStoredSessionToken(null);
    onSignedOut();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <KeyRound className="h-4 w-4 text-[#ff6b57]" />
            <div>
              <h2 className="text-base font-semibold text-white">
                Account, Key Whitelist &amp; Passkeys
              </h2>
              <p className="text-[11px] text-slate-400">
                Signed in as{" "}
                <strong className="text-slate-200">{username}</strong>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex gap-1 border-b border-white/8 bg-[#121722] px-6 py-2">
          <button
            type="button"
            onClick={() => setActiveTab("keys")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "keys"
                ? "bg-[#ff6b57] text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Private Key Whitelist ({authorizedKeys.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("passkeys")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "passkeys"
                ? "bg-[#ff6b57] text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Fingerprint className="h-3.5 w-3.5" />
            Passkeys ({passkeys.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("password")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "password"
                ? "bg-[#ff6b57] text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            Password
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

          {/* TAB 1: WHITELISTED LOGIN KEYS */}
          {activeTab === "keys" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-white/8 bg-[#141923] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-semibold text-white">
                      Add Whitelisted Login Key
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Only holders of a private key matching a whitelisted public
                      key below can sign in via Private Key mode.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateAndWhitelistKeypair}
                    disabled={generatingKeypair}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    {generatingKeypair ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    Generate &amp; Download .key
                  </button>
                </div>

                <form onSubmit={handleAddAuthorizedKey} className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <input
                      type="text"
                      value={authKeyLabel}
                      onChange={(e) => setAuthKeyLabel(e.target.value)}
                      placeholder="Key label (e.g. MacBook Pro Ed25519)"
                      className="flex-1 rounded-xl border border-white/10 bg-[#0d1118] px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                    />
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10">
                      <Upload className="h-3.5 w-3.5 text-[#ff6b57]" />
                      Load .pub / .pem
                      <input
                        type="file"
                        accept=".pub,.pem,.key,.txt,*"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const text = await f.text();
                          setAuthPublicKeyInput(text.trim());
                          if (!authKeyLabel || authKeyLabel === "Laptop SSH Key") {
                            setAuthKeyLabel(f.name.replace(/\.(pub|pem|key)$/i, ""));
                          }
                        }}
                        className="hidden"
                      />
                    </label>
                  </div>

                  <textarea
                    rows={3}
                    value={authPublicKeyInput}
                    onChange={(e) => setAuthPublicKeyInput(e.target.value)}
                    placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host"
                    className="w-full rounded-xl border border-white/10 bg-[#0d1118] p-2.5 font-mono-code text-[11px] text-slate-200 placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                  />

                  <button
                    type="submit"
                    disabled={addingAuthKey}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e] disabled:opacity-50"
                  >
                    {addingAuthKey ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    Whitelist Public Key
                  </button>
                </form>
              </div>

              <div className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Whitelisted Public Keys ({authorizedKeys.length})
                </span>
                {loading ? (
                  <div className="flex items-center justify-center py-6 text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : authorizedKeys.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-center text-xs text-slate-500">
                    No whitelisted keys yet. Click{" "}
                    <strong className="text-slate-300">
                      Generate &amp; Download .key
                    </strong>{" "}
                    or paste an `ssh-ed25519` / `ssh-rsa` public key above.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {authorizedKeys.map((k) => (
                      <div
                        key={k.fingerprint}
                        className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-[#141923] px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs font-medium text-white">
                            <span className="truncate">{k.label}</span>
                            <span className="rounded bg-white/8 px-1.5 py-0.5 font-mono-code text-[10px] text-slate-300">
                              {k.keyType}
                            </span>
                            {k.source === "env" && (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                                ENV
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono-code text-[11px] text-slate-400">
                            {k.fingerprint}
                          </div>
                        </div>
                        {k.source !== "env" && (
                          <button
                            type="button"
                            onClick={() => handleRevokeAuthorizedKey(k.fingerprint)}
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-500/15 hover:text-rose-300"
                            title="Remove from whitelist"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {authorizedKeys.length > 0 && (
                <div className="rounded-xl border border-white/8 bg-[#121722] p-3 text-[11px] text-slate-400">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                      Optional global env sync:{" "}
                      <code className="text-slate-200">SUSHI_AUTHORIZED_KEYS</code>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(authorizedKeysEnvBlock);
                        setCopiedAuthKeysEnv(true);
                        setTimeout(() => setCopiedAuthKeysEnv(false), 2000);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/10"
                    >
                      {copiedAuthKeysEnv ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copiedAuthKeysEnv ? "Copied" : "Copy authorized_keys"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: WEBAUTHN PASSKEYS */}
          {activeTab === "passkeys" && (
            <div className="space-y-4">
              {inIframe && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  <span>
                    Open Sushi in a top-level browser tab to enroll Touch ID /
                    Windows Hello Passkeys.
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      window.open(window.location.href, "_blank", "noopener")
                    }
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-500/20 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-500/30"
                  >
                    Open Tab <ExternalLink className="h-3 w-3" />
                  </button>
                </div>
              )}

              <form onSubmit={handleRegisterPasskey} className="flex gap-2">
                <input
                  type="text"
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder="Passkey label (e.g. MacBook Touch ID)"
                  className="flex-1 rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={registering}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff6b57] px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e] disabled:opacity-50"
                >
                  {registering ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  Add Passkey
                </button>
              </form>

              {passkeys.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">
                  No Passkeys enrolled yet. Add Touch ID, Face ID, Windows Hello,
                  or a YubiKey above.
                </div>
              ) : (
                <div className="space-y-2">
                  {passkeys.map((pk) => (
                    <div
                      key={pk.id}
                      className="flex items-center justify-between rounded-xl border border-white/8 bg-[#141923] px-3.5 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs font-medium text-white">
                          <span className="truncate">{pk.label}</span>
                          {pk.backedUp && (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                              Synced
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Added {new Date(pk.createdAt).toLocaleDateString()} · ID{" "}
                          <span className="font-mono-code">
                            {pk.id.slice(0, 12)}…
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRevokePasskey(pk.id)}
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-500/15 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {runtimeMode === "vercel" &&
                passkeys.length > 0 &&
                passkeysEnvJson && (
                  <div className="rounded-xl border border-white/8 bg-[#121722] p-3 text-[11px] text-slate-400">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        Cross-browser Vercel sync:{" "}
                        <code className="text-slate-200">SUSHI_PASSKEYS_JSON</code>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(passkeysEnvJson);
                          setCopiedEnv(true);
                          setTimeout(() => setCopiedEnv(false), 2000);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/10"
                      >
                        {copiedEnv ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        {copiedEnv ? "Copied" : "Copy JSON"}
                      </button>
                    </div>
                  </div>
                )}
            </div>
          )}

          {/* TAB 3: ADMIN PASSWORD UPDATE */}
          {activeTab === "password" && (
            <div className="space-y-4">
              {canEditCredentials ? (
                <form onSubmit={handleUpdateCredentials} className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      Admin Username
                    </label>
                    <input
                      type="text"
                      value={nextUsername}
                      onChange={(e) => setNextUsername(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-xs text-white focus:border-[#ff6b57] focus:outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs text-slate-400">
                        Current Password
                      </label>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Required to confirm"
                        className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-xs text-white focus:border-[#ff6b57] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-400">
                        New Password (optional)
                      </label>
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Min 6 characters"
                        className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-xs text-white focus:border-[#ff6b57] focus:outline-none"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={savingCreds}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/8 px-4 py-2 text-xs font-medium text-white transition hover:bg-white/14 disabled:opacity-50"
                  >
                    {savingCreds && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    Update Credentials
                  </button>
                </form>
              ) : (
                <div className="rounded-xl border border-white/8 bg-[#141923] p-4 text-xs text-slate-400">
                  Admin username &amp; password are set via{" "}
                  <code className="text-slate-200">SUSHI_AUTH_USERNAME</code> /{" "}
                  <code className="text-slate-200">SUSHI_AUTH_PASSWORD</code>{" "}
                  environment variables.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
