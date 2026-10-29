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
  KeyRound,
  Upload,
  Download,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { AuthStatusResponse } from "@/types/auth";
import {
  addStoredAuthorizedKeyCertificate,
  addStoredPasskeyCertificate,
  getStoredAdminProfileCert,
  getStoredAuthorizedKeyCertificates,
  getStoredPasskeyCertificates,
  setStoredAdminProfileCert,
  setStoredSessionToken,
} from "@/lib/client/auth-storage";
import { isInsecureBrowserContext } from "@/lib/client/web-crypto";

const PASSKEY_HTTPS_REQUIRED =
  "Passkeys need HTTPS: browsers disable WebAuthn on plain-HTTP pages like this one. Sign in with your password or whitelisted private key, or serve Sushi over HTTPS (Caddy / Nginx) to use passkeys.";

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

function downloadTextFile(filename: string, content: string) {
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

export function AuthGateScreen({
  authStatus,
  onAuthenticated,
}: AuthGateScreenProps) {
  const [loginMethod, setLoginMethod] = useState<"password" | "privateKey">(
    "password"
  );

  // Setup & Password Login fields
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Setup optional Key Whitelist controls
  const [generateMasterKey, setGenerateMasterKey] = useState(false);
  const [initialPublicKeys, setInitialPublicKeys] = useState("");
  const [showInitialKeyInput, setShowInitialKeyInput] = useState(false);

  // Private Key Login fields
  const [loginPrivateKey, setLoginPrivateKey] = useState("");
  const [loginKeyPassphrase, setLoginKeyPassphrase] = useState("");
  const [uploadedKeyFilename, setUploadedKeyFilename] = useState<string | null>(
    null
  );

  const [submitting, setSubmitting] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webAuthnSupported, setWebAuthnSupported] = useState(false);
  const [inCrossOriginIframe, setInCrossOriginIframe] = useState(false);

  // Post-setup step (Passkey enrollment + generated Master Private Key download)
  const [justBootstrappedUser, setJustBootstrappedUser] = useState<
    string | null
  >(null);
  const [generatedMasterPrivKey, setGeneratedMasterPrivKey] = useState<
    string | null
  >(null);
  const [generatedMasterFp, setGeneratedMasterFp] = useState<string | null>(
    null
  );
  const [downloadedMasterKey, setDownloadedMasterKey] = useState(false);

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
          generateMasterKey,
          initialPublicKeys: showInitialKeyInput
            ? initialPublicKeys.trim()
            : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to create admin account.");
      }

      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }
      if (data.adminProfileCert) {
        setStoredAdminProfileCert(data.adminProfileCert);
      }
      if (Array.isArray(data.signedKeyCertificates)) {
        for (const item of data.signedKeyCertificates) {
          if (item?.fingerprint && item?.cert) {
            addStoredAuthorizedKeyCertificate(item.fingerprint, item.cert);
          }
        }
      }

      if (data.generatedPrivateKey) {
        setGeneratedMasterPrivKey(data.generatedPrivateKey);
        setGeneratedMasterFp(data.generatedKeyFingerprint || null);
      }

      if (
        data.generatedPrivateKey ||
        (webAuthnSupported && !inCrossOriginIframe)
      ) {
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
      if (isInsecureBrowserContext()) {
        throw new Error(PASSKEY_HTTPS_REQUIRED);
      }
      const { startRegistration } = await import("@simplewebauthn/browser");
      const existingCerts = getStoredPasskeyCertificates().map((c) => c.cert);
      const adminCert = getStoredAdminProfileCert();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (adminCert) headers["X-Sushi-Admin-Cert"] = adminCert;

      const optRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
          step: "options",
          signedCertificates: existingCerts,
        }),
      });
      const optData = await optRes.json();
      if (!optRes.ok || !optData.ok) {
        throw new Error(optData.error || "Could not start Passkey setup.");
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

      if (verData.record?.id && verData.signedCertificate) {
        addStoredPasskeyCertificate(verData.record.id, verData.signedCertificate);
      }
      onAuthenticated(justBootstrappedUser);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Passkey enrollment cancelled or failed."
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
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminCert ? { "X-Sushi-Admin-Cert": adminCert } : {}),
        },
        body: JSON.stringify({
          username: username.trim(),
          password,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Invalid credentials.");
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

  const handlePrivateKeyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!loginPrivateKey.trim()) {
      setError("Upload or paste your whitelisted SSH/PEM private key.");
      return;
    }

    setSubmitting(true);
    try {
      const adminCert = getStoredAdminProfileCert();
      const keyCerts = getStoredAuthorizedKeyCertificates().map((c) => c.cert);

      const res = await fetch("/api/auth/key-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminCert ? { "X-Sushi-Admin-Cert": adminCert } : {}),
        },
        body: JSON.stringify({
          privateKey: loginPrivateKey,
          passphrase: loginKeyPassphrase || undefined,
          adminProfileCert: adminCert || undefined,
          signedKeyCertificates: keyCerts,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Private key authentication failed.");
      }
      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }
      onAuthenticated(data.username);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Private key sign-in failed."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setLoginPrivateKey(text.trim());
    setUploadedKeyFilename(file.name);
    setError(null);
  };

  const handlePasskeyLogin = async () => {
    setPasskeyBusy(true);
    setError(null);

    try {
      if (isInsecureBrowserContext()) {
        throw new Error(PASSKEY_HTTPS_REQUIRED);
      }
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const certs = getStoredPasskeyCertificates().map((c) => c.cert);
      const adminCert = getStoredAdminProfileCert();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (adminCert) headers["X-Sushi-Admin-Cert"] = adminCert;

      const optRes = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers,
        body: JSON.stringify({
          step: "options",
          signedCertificates: certs,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const optData = await optRes.json();
      if (!optRes.ok || !optData.ok) {
        throw new Error(
          optData.error || "Unable to start Passkey authentication."
        );
      }

      const assertion = await startAuthentication({
        optionsJSON: optData.options,
      });

      const verRes = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers,
        body: JSON.stringify({
          step: "verify",
          challengeToken: optData.challengeToken,
          signedCertificates: certs,
          adminProfileCert: adminCert || undefined,
          assertion,
        }),
      });
      const verData = await verRes.json();
      if (!verRes.ok || !verData.ok) {
        throw new Error(verData.error || "Passkey authentication failed.");
      }

      if (verData.sessionToken) {
        setStoredSessionToken(verData.sessionToken);
      }
      if (verData.credentialId && verData.updatedCertificate) {
        addStoredPasskeyCertificate(
          verData.credentialId,
          verData.updatedCertificate
        );
      }

      onAuthenticated(verData.username);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Passkey authentication failed.";
      if (/NotAllowedError|cancelled|canceled|aborted/i.test(msg)) {
        setError(
          inCrossOriginIframe
            ? "Browser blocked Passkey prompt inside embedded iframe. Open Sushi in a full browser tab to use Passkey, or sign in with Password / Private Key."
            : "Passkey prompt was dismissed or timed out."
        );
      } else {
        setError(msg);
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  // Post-bootstrap step: Download generated Master Key and/or Enroll Passkey
  if (justBootstrappedUser) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <div className="w-full max-w-md space-y-5 rounded-2xl border border-white/10 bg-[#0f131b] p-7 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white">
                Admin Account Ready ({justBootstrappedUser})
              </h1>
              <p className="text-xs text-slate-400">
                Save your login key or add a WebAuthn Passkey before entering.
              </p>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {generatedMasterPrivKey && (
            <div className="space-y-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/8 p-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                  <KeyRound className="h-3.5 w-3.5" />
                  Whitelisted Master Login Key (Ed25519)
                </span>
                {downloadedMasterKey && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Saved
                  </span>
                )}
              </div>
              {generatedMasterFp && (
                <p className="break-all font-mono-code text-[11px] text-slate-300">
                  {generatedMasterFp}
                </p>
              )}
              <p className="text-[11px] text-slate-400">
                Download this private key now — its public key is whitelisted so
                you can sign in using this `.key` file anytime.
              </p>
              <button
                type="button"
                onClick={() => {
                  downloadTextFile(
                    `sushi-${justBootstrappedUser}-ed25519.key`,
                    generatedMasterPrivKey
                  );
                  setDownloadedMasterKey(true);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500/20 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/30"
              >
                <Download className="h-3.5 w-3.5" />
                Download Private Key (.key)
              </button>
            </div>
          )}

          <div className="space-y-2.5 pt-1">
            {webAuthnSupported && !inCrossOriginIframe && (
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
            )}
            <button
              type="button"
              onClick={() => onAuthenticated(justBootstrappedUser)}
              className="w-full rounded-xl border border-white/12 bg-white/5 py-2.5 text-xs font-semibold text-white transition hover:bg-white/10"
            >
              Enter Sushi Workspace →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // First-Run Interactive Setup (Works identically on BOTH VPS and Vercel!)
  if (!authStatus.initialized) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <form
          onSubmit={handleBootstrapSubmit}
          className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-[#0f131b] p-7 shadow-2xl"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff6b57] to-[#e14b37] text-white shadow-lg shadow-[#ff6b57]/25">
              <Terminal className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white">
                Create Sushi Admin Account
              </h1>
              <p className="text-xs text-slate-400">
                Protect SSH, SFTP &amp; RDP with Password, Passkey, and
                Whitelisted Private Keys
              </p>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Admin Username
            </label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full rounded-xl border border-white/10 bg-[#151a24] py-2.5 pl-10 pr-3.5 text-sm text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Admin Password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full rounded-xl border border-white/10 bg-[#151a24] py-2.5 pl-10 pr-10 text-sm text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Confirm Password
            </label>
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
            />
          </div>

          {/* Optional Whitelisted SSH Key Enrollment right at setup */}
          <div className="space-y-2.5 rounded-xl border border-white/8 bg-[#131823] p-3.5">
            <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-200">
              <input
                type="checkbox"
                checked={generateMasterKey}
                onChange={(e) => setGenerateMasterKey(e.target.checked)}
                className="mt-0.5 rounded border-white/20 bg-[#151a24] text-[#ff6b57]"
              />
              <span>
                <span className="font-medium text-white">
                  Generate &amp; whitelist an Ed25519 Private Key
                </span>
                <span className="block text-[11px] text-slate-400">
                  Downloads a `.key` file you can use to sign in without typing
                  passwords.
                </span>
              </span>
            </label>

            <div>
              <button
                type="button"
                onClick={() => setShowInitialKeyInput((v) => !v)}
                className="flex items-center gap-1 text-[11px] font-medium text-[#ff8d7e] hover:underline"
              >
                <Sparkles className="h-3 w-3" />
                {showInitialKeyInput
                  ? "Hide custom SSH public key input"
                  : "Or whitelist your existing ssh-ed25519 / ssh-rsa public key"}
              </button>
              {showInitialKeyInput && (
                <textarea
                  rows={2}
                  value={initialPublicKeys}
                  onChange={(e) => setInitialPublicKeys(e.target.value)}
                  placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@laptop"
                  className="mt-2 w-full rounded-lg border border-white/10 bg-[#0d1118] p-2.5 font-mono-code text-[11px] text-slate-200 placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                />
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#ff6b57] py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/25 transition hover:bg-[#ff7f6e] disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Create Admin Account &amp; Continue
          </button>
        </form>
      </div>
    );
  }

  // Standard Sign-In View (Password | Whitelisted Private Key | Passkey)
  const localCertCount = getStoredPasskeyCertificates().length;
  const totalPasskeys = Math.max(authStatus.passkeyCount, localCertCount);
  const localAuthKeyCount = getStoredAuthorizedKeyCertificates().length;
  const totalWhitelistedKeys = Math.max(
    authStatus.authorizedKeyCount || 0,
    localAuthKeyCount
  );

  return (
    <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
      <div className="w-full max-w-md space-y-5 rounded-2xl border border-white/10 bg-[#0f131b] p-7 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff6b57] to-[#e14b37] text-white shadow-lg shadow-[#ff6b57]/25">
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">
              Sign in to Sushi
            </h1>
            <p className="text-xs text-slate-400">
              SSH, SFTP &amp; RDP Remote Workspace
            </p>
          </div>
        </div>

        {/* Method Tabs: Password vs Whitelisted Private Key */}
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-white/8 bg-[#131823] p-1">
          <button
            type="button"
            onClick={() => {
              setLoginMethod("password");
              setError(null);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              loginMethod === "password"
                ? "bg-[#ff6b57] text-white shadow"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <Lock className="h-3.5 w-3.5" />
            Password
          </button>
          <button
            type="button"
            onClick={() => {
              setLoginMethod("privateKey");
              setError(null);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              loginMethod === "privateKey"
                ? "bg-[#ff6b57] text-white shadow"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Private Key
            {totalWhitelistedKeys > 0 && (
              <span className="rounded-full bg-black/25 px-1.5 py-0.2 text-[10px]">
                {totalWhitelistedKeys}
              </span>
            )}
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {webAuthnSupported && (
          <>
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={passkeyBusy || submitting}
              className={`flex w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-semibold transition disabled:opacity-50 ${
                totalPasskeys > 0
                  ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-200 hover:bg-emerald-500/20"
                  : "border-white/12 bg-white/5 text-slate-200 hover:bg-white/10"
              }`}
            >
              {passkeyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Fingerprint className="h-4 w-4 text-[#ff6b57]" />
              )}
              Sign in with Passkey
              {totalPasskeys > 0 && (
                <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px]">
                  {totalPasskeys}
                </span>
              )}
            </button>

            <div className="relative flex items-center py-0.5">
              <div className="flex-grow border-t border-white/8" />
              <span className="mx-3 shrink text-[11px] uppercase tracking-wider text-slate-500">
                or {loginMethod === "password" ? "password" : "whitelisted key"}
              </span>
              <div className="flex-grow border-t border-white/8" />
            </div>
          </>
        )}

        {loginMethod === "password" ? (
          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Username
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-[#151a24] py-2.5 pl-10 pr-3.5 text-sm text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="w-full rounded-xl border border-white/10 bg-[#151a24] py-2.5 pl-10 pr-10 text-sm text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || passkeyBusy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#ff6b57] py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/25 transition hover:bg-[#ff7f6e] disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign In
            </button>
          </form>
        ) : (
          <form onSubmit={handlePrivateKeyLogin} className="space-y-3.5">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-slate-300">
                  Whitelisted SSH / PEM Private Key
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200 transition hover:bg-white/10">
                  <Upload className="h-3 w-3 text-[#ff6b57]" />
                  {uploadedKeyFilename ? uploadedKeyFilename : "Upload .key / .pem"}
                  <input
                    type="file"
                    accept=".pem,.key,.pub,.txt,*"
                    onChange={handleKeyFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
              <textarea
                rows={4}
                value={loginPrivateKey}
                onChange={(e) => setLoginPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                className="w-full rounded-xl border border-white/10 bg-[#151a24] p-3 font-mono-code text-[11px] text-slate-200 placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">
                Key Passphrase{" "}
                <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                type="password"
                value={loginKeyPassphrase}
                onChange={(e) => setLoginKeyPassphrase(e.target.value)}
                placeholder="Leave blank if unencrypted"
                className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-[#ff6b57] focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={submitting || passkeyBusy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#ff6b57] py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/25 transition hover:bg-[#ff7f6e] disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Verify Signature &amp; Sign In
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
