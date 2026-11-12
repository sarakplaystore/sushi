"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  X,
  Fingerprint,
  Plus,
  Trash2,
  LogOut,
  Lock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import type { PublicPasskeySummary } from "@/types/auth";
import {
  addStoredPasskeyCertificate,
  getStoredAdminProfileCert,
  getStoredPasskeyCertificates,
  removeStoredPasskeyCertificate,
  setStoredAdminProfileCert,
  setStoredSessionToken,
} from "@/lib/client/auth-storage";
import { type GatewaySettings, getAuthHeaders } from "@/lib/client/gateway";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { isInsecureBrowserContext } from "@/lib/client/web-crypto";

interface AccountPasskeysModalProps {
  isOpen: boolean;
  username: string;
  runtimeMode?: "vps" | "vercel" | "gateway";
  gatewaySettings: GatewaySettings;
  onClose: () => void;
  onUsernameUpdated: (nextUsername: string) => void;
  onPreparePasswordChange: (currentPassword: string) => Promise<boolean>;
  onFinishPasswordChange: (newPassword: string) => Promise<void>;
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

export function AccountPasskeysModal({
  isOpen,
  username,
  runtimeMode,
  gatewaySettings,
  onClose,
  onUsernameUpdated,
  onPreparePasswordChange,
  onFinishPasswordChange,
  onSignedOut,
}: AccountPasskeysModalProps) {
  const [activeTab, setActiveTab] = useState<"passkeys" | "password">(
    "passkeys"
  );

  const [passkeys, setPasskeys] = useState<PublicPasskeySummary[]>([]);
  const [canEditCredentials, setCanEditCredentials] = useState(true);
  const [passkeysEnvJson, setPasskeysEnvJson] = useState("");
  const [loading, setLoading] = useState(false);

  // Passkey enrollment
  const [registering, setRegistering] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState(defaultPasskeyLabel);

  // Password / username update form
  const [nextUsername, setNextUsername] = useState(username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingCreds, setSavingCreds] = useState(false);

  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(
    null
  );
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [inIframe, setInIframe] = useState(false);

  const fetchAccountDetails = useCallback(async () => {
    setLoading(true);
    try {
      const certs = getStoredPasskeyCertificates().map((c) => c.cert);
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/account", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          signedCertificates: certs,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setPasskeys(data.passkeys || []);
        setCanEditCredentials(Boolean(data.canEditCredentials));
        setPasskeysEnvJson(data.passkeysEnvJson || "");
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

  const handleRegisterPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setRegistering(true);
    try {
      const { browserSupportsWebAuthn, startRegistration } = await import(
        "@simplewebauthn/browser"
      );
      if (isInsecureBrowserContext()) {
        throw new Error(
          "Passkeys need HTTPS: browsers disable WebAuthn on plain-HTTP pages. Serve Sushi over HTTPS (Caddy / Nginx) or open it via http://localhost to register a passkey."
        );
      }
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
    if (newPassword && newPassword.length < 6) {
      setStatus({ ok: false, msg: "New password must be at least 6 characters." });
      return;
    }
    if (nextUsername.trim().length < 2 || nextUsername.trim().length > 64) {
      setStatus({ ok: false, msg: "Username must be between 2 and 64 characters." });
      return;
    }

    setSavingCreds(true);
    let preparedVault = false;
    let accountUpdated = false;
    try {
      // Keep an independently decryptable copy under the old password until
      // the account update succeeds. Every stage is revision-checked.
      if (newPassword) preparedVault = await onPreparePasswordChange(currentPassword);
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
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to update credentials.");
      accountUpdated = true;
      if (data.sessionToken) setStoredSessionToken(data.sessionToken);
      if (data.adminProfileCert) setStoredAdminProfileCert(data.adminProfileCert);
      onUsernameUpdated(data.username);
      if (preparedVault) await onFinishPasswordChange(newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setStatus({ ok: true, msg: "Admin credentials updated." });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Failed to update account.";
      const recovery = preparedVault
        ? accountUpdated
          ? " The account password changed, but the vault update could not be confirmed. It may still need your previous password to unlock; then enable account sync with the new one."
          : " The vault remains encrypted with your previous password. If the account update could not be confirmed, try signing in with both passwords, then enable account sync again."
        : "";
      setStatus({ ok: false, msg: reason + recovery });
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
    <div className="modal-safe-area fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Fingerprint className="h-4 w-4 shrink-0 text-[#ff6b57]" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white">
                Account &amp; Passkeys
              </h2>
              <p className="text-[11px] text-slate-400">
                Signed in as{" "}
                <strong className="text-slate-200">{username}</strong>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Section Tabs */}
        <div className="flex gap-1 border-b border-white/8 bg-[#0b0e14] px-4 pt-2.5 sm:px-6">
          <button
            type="button"
            onClick={() => {
              setActiveTab("passkeys");
              setStatus(null);
            }}
            className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition ${
              activeTab === "passkeys"
                ? "border-[#ff6b57] text-white"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Fingerprint className="h-3.5 w-3.5" />
            Passkeys ({passkeys.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("password");
              setStatus(null);
            }}
            className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition ${
              activeTab === "password"
                ? "border-[#ff6b57] text-white"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Lock className="h-3.5 w-3.5" />
            Password
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {status && (
            <div
              className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
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

          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading account
              security...
            </div>
          )}

          {/* TAB 1: WEBAUTHN PASSKEYS */}
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
                          void copyTextToClipboard(passkeysEnvJson);
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

          {/* TAB 2: ADMIN PASSWORD UPDATE */}
          {activeTab === "password" && (
            <div className="space-y-4">
              {canEditCredentials ? (
                <form onSubmit={handleUpdateCredentials} className="space-y-3">
                  <p className="text-[11px] text-slate-400">When changing your password, keep the previous one until the encrypted vault has been updated. If a connection fails, it may be needed to recover your saved connections.</p>
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
