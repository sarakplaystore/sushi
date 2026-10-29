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
} from "lucide-react";
import type { PublicPasskeySummary } from "@/types/auth";
import {
  addStoredPasskeyCertificate,
  getStoredPasskeyCertificates,
  removeStoredPasskeyCertificate,
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

export function AccountPasskeysModal({
  isOpen,
  username,
  runtimeMode,
  gatewaySettings,
  onClose,
  onUsernameUpdated,
  onSignedOut,
}: AccountPasskeysModalProps) {
  const [passkeys, setPasskeys] = useState<PublicPasskeySummary[]>([]);
  const [canEditDisk, setCanEditDisk] = useState(false);
  const [passkeysEnvJson, setPasskeysEnvJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState(defaultPasskeyLabel);

  // Password / username update form
  const [nextUsername, setNextUsername] = useState(username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingCreds, setSavingCreds] = useState(false);

  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [inIframe, setInIframe] = useState(false);

  const fetchAccountDetails = useCallback(async () => {
    setLoading(true);
    try {
      const certs = getStoredPasskeyCertificates().map((c) => c.cert);
      const res = await fetch("/api/auth/account", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({ signedCertificates: certs }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setPasskeys(data.passkeys || []);
        setCanEditDisk(Boolean(data.canEditCredentialsOnDisk));
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
      if (!browserSupportsWebAuthn()) {
        throw new Error(
          "WebAuthn Passkeys are not supported in this browser or non-HTTPS context."
        );
      }

      const certs = getStoredPasskeyCertificates().map((c) => c.cert);
      const optRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          step: "options",
          signedCertificates: certs,
        }),
      });
      const optData = await optRes.json();
      if (!optRes.ok || !optData.ok) {
        throw new Error(optData.error || "Failed to generate Passkey options.");
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
        throw new Error(verData.error || "Passkey registration failed.");
      }

      if (verData.passkey?.id && verData.signedCertificate) {
        addStoredPasskeyCertificate(verData.passkey.id, verData.signedCertificate);
      }

      setStatus({
        ok: true,
        msg: `Registered Passkey "${verData.passkey.label}".`,
      });
      await fetchAccountDetails();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Passkey registration failed.";
      setStatus({
        ok: false,
        msg:
          /NotAllowedError/i.test(msg) && inIframe
            ? "Passkey registration requires opening Sushi in a top-level browser tab (outside embedded iframe)."
            : msg,
      });
    } finally {
      setRegistering(false);
    }
  };

  const handleRevokePasskey = async (id: string, label: string) => {
    setStatus(null);
    try {
      removeStoredPasskeyCertificate(id);
      await fetch("/api/auth/account", {
        method: "DELETE",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({ credentialId: id }),
      });
      setStatus({ ok: true, msg: `Revoked Passkey "${label}".` });
      await fetchAccountDetails();
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Failed to revoke passkey.",
      });
    }
  };

  const handleUpdateCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setSavingCreds(true);
    try {
      const res = await fetch("/api/auth/account", {
        method: "PUT",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          currentPassword,
          newUsername: nextUsername.trim(),
          newPassword: newPassword || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to update account.");
      }
      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }
      setCurrentPassword("");
      setNewPassword("");
      onUsernameUpdated(data.username);
      setStatus({ ok: true, msg: "Admin credentials updated." });
    } catch (err) {
      setStatus({
        ok: false,
        msg: err instanceof Error ? err.message : "Update failed.",
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
            <Fingerprint className="h-4 w-4 text-[#ff6b57]" />
            <h2 className="text-base font-semibold text-white">
              Account &amp; Passkey Protection ({username})
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSignOut}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
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

          {/* Register Passkey Section */}
          <div className="space-y-3.5 rounded-xl border border-white/8 bg-[#131722] p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-white">
                  WebAuthn / FIDO2 Passkeys
                </h3>
                <p className="text-[11px] text-slate-400">
                  Biometric Touch ID, Face ID, Windows Hello, or hardware security
                  keys
                </p>
              </div>
              {inIframe && (
                <a
                  href={typeof window !== "undefined" ? window.location.href : "/"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg bg-white/6 px-2.5 py-1 text-[11px] text-slate-300 hover:text-white"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open Full Tab
                </a>
              )}
            </div>

            <form
              onSubmit={handleRegisterPasskey}
              className="flex flex-col gap-2 sm:flex-row"
            >
              <input
                type="text"
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                placeholder="Passkey label (e.g. MacBook Pro Touch ID)"
                className="flex-1 rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-[#ff6b57]"
              />
              <button
                type="submit"
                disabled={registering}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e] disabled:opacity-50"
              >
                {registering ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Register Passkey
              </button>
            </form>

            {/* Registered Passkeys List */}
            {loading ? (
              <div className="py-4 text-center text-xs text-slate-400">
                Loading Passkeys...
              </div>
            ) : passkeys.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/8 bg-[#0b0e14]/60 p-3.5 text-center text-xs text-slate-500">
                No Passkeys enrolled yet. Register one above for 1-tap biometric
                sign-in.
              </div>
            ) : (
              <div className="space-y-2 pt-1">
                {passkeys.map((pk) => (
                  <div
                    key={pk.id}
                    className="flex items-center justify-between rounded-xl border border-white/8 bg-[#0b0e14] px-3.5 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Fingerprint className="h-4 w-4 shrink-0 text-emerald-400" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-medium text-white">
                            {pk.label}
                          </span>
                          <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-slate-300">
                            {pk.backedUp ? "Synced" : "Hardware"}
                          </span>
                        </div>
                        <div className="font-mono-code truncate text-[10px] text-slate-500">
                          Added {new Date(pk.createdAt).toLocaleDateString()} • ID:{" "}
                          {pk.id.slice(0, 14)}…
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleRevokePasskey(pk.id, pk.label)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                      title="Revoke Passkey"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Stateless Vercel Cross-Browser Passkey Env Helper */}
            {runtimeMode === "vercel" && passkeys.length > 0 && passkeysEnvJson && (
              <div className="rounded-lg border border-white/8 bg-[#090b10] p-3 text-[11px] text-slate-400">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Passkey works immediately in this browser via HMAC-signed
                    certificate. Copy <code className="text-slate-200">SUSHI_PASSKEYS_JSON</code>{" "}
                    to Vercel Env Vars to share across other devices:
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(passkeysEnvJson);
                      setCopiedEnv(true);
                      setTimeout(() => setCopiedEnv(false), 1800);
                    }}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-white/8 px-2 py-1 text-slate-200 hover:bg-white/14"
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

          {/* Update Username & Password (VPS Disk Account) */}
          {canEditDisk ? (
            <form
              onSubmit={handleUpdateCredentials}
              className="space-y-3 rounded-xl border border-white/8 bg-[#131722] p-4"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <KeyRound className="h-3.5 w-3.5 text-sky-400" />
                Update Username &amp; Password
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] text-slate-400">
                    Username
                  </label>
                  <input
                    type="text"
                    value={nextUsername}
                    onChange={(e) => setNextUsername(e.target.value)}
                    required
                    className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3 py-1.5 text-xs text-white outline-none focus:border-white/25"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-400">
                    Current Password *
                  </label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                    placeholder="Required to confirm changes"
                    className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3 py-1.5 text-xs text-white outline-none focus:border-white/25"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-slate-400">
                  New Password (leave blank to keep current password)
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3 py-1.5 text-xs text-white outline-none focus:border-white/25"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={savingCreds}
                  className="rounded-xl bg-white/12 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-white/18 disabled:opacity-50"
                >
                  Save Credentials
                </button>
              </div>
            </form>
          ) : (
            <div className="rounded-xl border border-white/8 bg-[#131722] p-3.5 text-xs text-slate-400">
              Username &amp; password are set via{" "}
              <code className="font-mono-code text-slate-200">
                SUSHI_AUTH_USERNAME
              </code>{" "}
              and{" "}
              <code className="font-mono-code text-slate-200">
                SUSHI_AUTH_PASSWORD
              </code>{" "}
              environment variables.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
