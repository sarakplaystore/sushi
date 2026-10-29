"use client";

import React, { useState, useEffect } from "react";
import {
  Terminal,
  Fingerprint,
  Lock,
  User,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  ShieldCheck,
  ExternalLink,
  Copy,
  Check,
  ArrowRight,
} from "lucide-react";
import type { AuthStatusResponse } from "@/types/auth";
import {
  addStoredPasskeyCertificate,
  getStoredPasskeyCertificates,
  setStoredSessionToken,
} from "@/lib/client/auth-storage";

interface AuthGateScreenProps {
  authStatus: AuthStatusResponse;
  onAuthenticated: (username: string) => void;
  onRefreshStatus: () => Promise<void>;
}

function detectDevicePasskeyLabel(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac Touch ID / iCloud";
  if (/iPhone|iPad/i.test(ua)) return "iPhone / iPad Face ID";
  if (/Windows/i.test(ua)) return "Windows Hello";
  if (/Android/i.test(ua)) return "Android Passkey";
  if (/Linux/i.test(ua)) return "Linux Security Key";
  return "Passkey";
}

export function AuthGateScreen({
  authStatus,
  onAuthenticated,
  onRefreshStatus,
}: AuthGateScreenProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webAuthnSupported, setWebAuthnSupported] = useState(false);
  const [inCrossOriginIframe, setInCrossOriginIframe] = useState(false);

  // Post-setup optional passkey enrollment step
  const [justBootstrappedUser, setJustBootstrappedUser] = useState<string | null>(
    null
  );
  const [generatedSecret] = useState(() => {
    const arr = new Uint8Array(32);
    if (typeof crypto !== "undefined") crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  });
  const [copiedEnv, setCopiedEnv] = useState(false);

  useEffect(() => {
    let mounted = true;
    import("@simplewebauthn/browser")
      .then((mod) => {
        if (mounted) {
          setWebAuthnSupported(mod.browserSupportsWebAuthn());
        }
      })
      .catch(() => {
        // ignore
      });

    try {
      if (window.self !== window.top) {
        setInCrossOriginIframe(true);
      }
    } catch {
      setInCrossOriginIframe(true);
    }

    return () => {
      mounted = false;
    };
  }, []);

  const handleBootstrapSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (username.trim().length < 2) {
      setError("Username must be at least 2 characters.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Setup failed.");
      }

      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }

      if (webAuthnSupported && !inCrossOriginIframe) {
        setJustBootstrappedUser(data.username);
      } else {
        onAuthenticated(data.username);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickEnrollPasskeyAfterSetup = async () => {
    if (!justBootstrappedUser) return;
    setPasskeyBusy(true);
    setError(null);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const token = localStorage.getItem("sushi_session_token_v1") || "";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["X-Sushi-Session"] = token;

      const optRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
          step: "options",
          signedCertificates: getStoredPasskeyCertificates().map((c) => c.cert),
        }),
      });
      const optData = await optRes.json();
      if (!optRes.ok || !optData.ok) {
        throw new Error(optData.error || "Unable to start passkey registration.");
      }

      const attestation = await startRegistration({
        optionsJSON: optData.options,
      });

      const verRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
          step: "verify",
          challengeToken: optData.challengeToken,
          label: detectDevicePasskeyLabel(),
          attestation,
        }),
      });
      const verData = await verRes.json();
      if (!verRes.ok || !verData.ok) {
        throw new Error(verData.error || "Passkey verification failed.");
      }

      if (verData.passkey?.id && verData.signedCertificate) {
        addStoredPasskeyCertificate(verData.passkey.id, verData.signedCertificate);
      }

      onAuthenticated(justBootstrappedUser);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Passkey enrollment canceled or unsupported in this context."
      );
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Invalid username or password.");
      }
      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }
      onAuthenticated(data.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setError(null);
    setPasskeyBusy(true);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const certs = getStoredPasskeyCertificates().map((c) => c.cert);

      const optRes = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: "options",
          signedCertificates: certs,
        }),
      });
      const optData = await optRes.json();
      if (!optRes.ok || !optData.ok) {
        throw new Error(optData.error || "Cannot initiate Passkey sign-in.");
      }

      const assertion = await startAuthentication({
        optionsJSON: optData.options,
      });

      const verRes = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: "verify",
          signedCertificates: certs,
          challengeToken: optData.challengeToken,
          assertion,
        }),
      });
      const verData = await verRes.json();
      if (!verRes.ok || !verData.ok) {
        throw new Error(verData.error || "Passkey verification failed.");
      }

      if (verData.sessionToken) {
        setStoredSessionToken(verData.sessionToken);
      }
      onAuthenticated(verData.username);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Passkey authentication failed.";
      if (/NotAllowedError|cancelled|canceled|aborted/i.test(msg)) {
        setError(
          inCrossOriginIframe
            ? "Browser blocked Passkey prompt inside embedded iframe. Open Sushi in a full browser tab to use Passkey, or sign in with Username & Password."
            : "Passkey prompt was dismissed or timed out."
        );
      } else {
        setError(msg);
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  // Post-bootstrap optional Passkey enrollment view
  if (justBootstrappedUser) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <div className="w-full max-w-md space-y-5 rounded-2xl border border-white/10 bg-[#0f131b] p-7 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <Fingerprint className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white">
                Add a Passkey for {justBootstrappedUser}?
              </h1>
              <p className="text-xs text-slate-400">
                Sign in instantly next time with Touch ID, Face ID, Windows Hello,
                or a YubiKey.
              </p>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2.5 pt-1">
            <button
              type="button"
              onClick={handleQuickEnrollPasskeyAfterSetup}
              disabled={passkeyBusy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#ff6b57] py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/20 transition hover:bg-[#ff7f6e] disabled:opacity-50"
            >
              {passkeyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Fingerprint className="h-4 w-4" />
              )}
              Register Passkey Now
            </button>
            <button
              type="button"
              onClick={() => onAuthenticated(justBootstrappedUser)}
              className="w-full rounded-xl border border-white/10 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/5 hover:text-white"
            >
              Skip for now — Enter Workspace
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Stateless Vercel deployment without SUSHI_AUTH_USERNAME / SUSHI_AUTH_PASSWORD configured yet
  if (!authStatus.initialized && !authStatus.canBootstrapOnDisk) {
    const envTemplate = `SUSHI_AUTH_USERNAME=admin\nSUSHI_AUTH_PASSWORD=change-me-strong-password\nSUSHI_AUTH_SECRET=${generatedSecret}`;
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <div className="w-full max-w-lg space-y-5 rounded-2xl border border-white/10 bg-[#0f131b] p-7 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#ff6b57]/15 text-[#ff6b57]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white">
                Configure Admin Auth on Vercel
              </h1>
              <p className="text-xs text-slate-400">
                Sushi is locked fail-closed until admin credentials are set in
                Vercel Environment Variables.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-300">
              <span>Add to Vercel Project → Settings → Environment Variables:</span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(envTemplate);
                  setCopiedEnv(true);
                  setTimeout(() => setCopiedEnv(false), 1800);
                }}
                className="flex items-center gap-1 text-xs text-[#ff6b57] hover:underline"
              >
                {copiedEnv ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedEnv ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="font-mono-code overflow-x-auto rounded-xl border border-white/8 bg-[#090b10] p-3.5 text-[11px] leading-relaxed text-slate-200">
              {envTemplate}
            </pre>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Once deployed with these variables, sign in with your username &amp;
              password and enroll your <strong className="text-slate-200">Passkey</strong>{" "}
              inside <em>Account &amp; Passkeys</em>.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void onRefreshStatus()}
            className="w-full rounded-xl bg-white/10 py-2.5 text-xs font-semibold text-white transition hover:bg-white/16"
          >
            Re-check Configuration
          </button>
        </div>
      </div>
    );
  }

  const isFirstSetup = !authStatus.initialized && authStatus.canBootstrapOnDisk;

  return (
    <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-white/10 bg-[#0f131b] p-7 shadow-2xl">
        {/* Brand Header */}
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff6b57] to-[#e14935] text-white shadow-lg shadow-[#ff6b57]/25">
            <Terminal className="h-5 w-5 stroke-[2.5]" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              {isFirstSetup ? "Create Sushi Admin Account" : "Sign in to Sushi"}
            </h1>
            <p className="text-xs text-slate-400">
              {isFirstSetup
                ? "Protect SSH, SFTP & RDP access with Username, Password & Passkey"
                : "Protected SSH • SFTP • RDP Remote Workspace"}
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {/* Passkey One-Click Sign-In (when account is initialized & WebAuthn supported) */}
        {!isFirstSetup && webAuthnSupported && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={passkeyBusy || submitting}
              className={`flex w-full items-center justify-center gap-2.5 rounded-xl border py-2.5 text-xs font-semibold transition disabled:opacity-50 ${
                authStatus.passkeyCount > 0
                  ? "border-[#ff6b57]/60 bg-[#ff6b57] text-white shadow-lg shadow-[#ff6b57]/20 hover:bg-[#ff7f6e]"
                  : "border-white/12 bg-white/[0.06] text-slate-100 hover:bg-white/10"
              }`}
            >
              {passkeyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Fingerprint className="h-4 w-4" />
              )}
              Sign in with Passkey
              {authStatus.passkeyCount > 0 && (
                <span className="rounded-full bg-black/25 px-2 py-0.5 text-[10px]">
                  {authStatus.passkeyCount} active
                </span>
              )}
            </button>

            {inCrossOriginIframe && (
              <div className="flex justify-center">
                <a
                  href={typeof window !== "undefined" ? window.location.href : "/"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in full tab for browser Passkey dialog
                </a>
              </div>
            )}

            <div className="relative flex items-center py-1">
              <div className="flex-grow border-t border-white/8" />
              <span className="mx-3 shrink text-[10px] font-medium uppercase tracking-wider text-slate-500">
                or username &amp; password
              </span>
              <div className="flex-grow border-t border-white/8" />
            </div>
          </div>
        )}

        {/* Username + Password Form */}
        <form
          onSubmit={isFirstSetup ? handleBootstrapSubmit : handlePasswordLogin}
          className="space-y-4"
        >
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Username
            </label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3.5 top-2.5 h-4 w-4 text-slate-500" />
              <input
                type="text"
                autoComplete="username webauthn"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                required
                className="font-mono-code w-full rounded-xl border border-white/10 bg-[#090b10] py-2 pl-10 pr-3.5 text-sm text-white placeholder-slate-600 outline-none transition focus:border-[#ff6b57]"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-2.5 h-4 w-4 text-slate-500" />
              <input
                type={showPassword ? "text" : "password"}
                autoComplete={
                  isFirstSetup ? "new-password" : "current-password webauthn"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  isFirstSetup ? "Min 6 characters" : "Enter password"
                }
                required
                className="w-full rounded-xl border border-white/10 bg-[#090b10] py-2 pl-10 pr-10 text-sm text-white placeholder-slate-600 outline-none transition focus:border-[#ff6b57]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {isFirstSetup && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Confirm Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-2.5 h-4 w-4 text-slate-500" />
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  required
                  className="w-full rounded-xl border border-white/10 bg-[#090b10] py-2 pl-10 pr-3.5 text-sm text-white placeholder-slate-600 outline-none transition focus:border-[#ff6b57]"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || passkeyBusy}
            className={`flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-semibold text-white transition disabled:opacity-50 ${
              !isFirstSetup && authStatus.passkeyCount > 0 && webAuthnSupported
                ? "border border-white/14 bg-white/10 hover:bg-white/16"
                : "bg-[#ff6b57] shadow-lg shadow-[#ff6b57]/20 hover:bg-[#ff7f6e]"
            }`}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <span>
                  {isFirstSetup ? "Create Admin & Continue" : "Sign In"}
                </span>
                <ArrowRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
