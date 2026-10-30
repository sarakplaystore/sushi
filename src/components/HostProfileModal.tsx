"use client";

import React, { useState, useEffect } from "react";
import {
  X,
  Terminal,
  FolderKanban,
  Monitor,
  KeyRound,
  Lock,
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Play,
  ShieldCheck,
} from "lucide-react";
import type {
  AuthMethod,
  HostProfile,
  ProtocolType,
  RdpProbeResult,
  RdpSecurityMode,
  SshTestResult,
  WhitelistedSshKey,
} from "@/types/connection";
import { resolveProfileWithKeychain } from "@/lib/client/crypto-vault";
import {
  type GatewaySettings,
  getAuthHeaders,
  resolveGatewayHttpBase,
} from "@/lib/client/gateway";
import { randomUUID } from "@/lib/client/web-crypto";

interface HostProfileModalProps {
  isOpen: boolean;
  initialProfile?: Partial<HostProfile> | null;
  /** Overrides the header (e.g. "Open via RDP" when launched from a session). */
  title?: string;
  subtitle?: string;
  gatewaySettings: GatewaySettings;
  sshKeys?: WhitelistedSshKey[];
  enforceKeyWhitelist?: boolean;
  onAddWhitelistedKey?: (key: WhitelistedSshKey) => Promise<void>;
  onClose: () => void;
  onSave: (profile: HostProfile, connectAfterSave?: boolean) => void;
  onQuickConnectOnly?: (profile: HostProfile) => void;
}

const ACCENT_COLORS = [
  "#34d399", // Emerald
  "#38bdf8", // Cyan
  "#ff6b57", // Salmon Coral
  "#fbbf24", // Amber
  "#a78bfa", // Violet
  "#f472b6", // Pink
];

export function HostProfileModal({
  isOpen,
  initialProfile,
  title,
  subtitle,
  gatewaySettings,
  sshKeys = [],
  enforceKeyWhitelist = false,
  onAddWhitelistedKey,
  onClose,
  onSave,
  onQuickConnectOnly,
}: HostProfileModalProps) {
  const [protocol, setProtocol] = useState<ProtocolType>("ssh");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(22);
  const [username, setUsername] = useState("root");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [sshKeyId, setSshKeyId] = useState<string>("");
  const [whitelistingInline, setWhitelistingInline] = useState(false);
  const [domain, setDomain] = useState("");
  const [rdpSecurity, setRdpSecurity] = useState<RdpSecurityMode>("any");
  const [ignoreCert, setIgnoreCert] = useState(true);
  const [rdpWidth, setRdpWidth] = useState(1280);
  const [rdpHeight, setRdpHeight] = useState(720);
  const [initialPath, setInitialPath] = useState("");
  const [group, setGroup] = useState("Production");
  const [accentColor, setAccentColor] = useState("#34d399");
  const [notes, setNotes] = useState("");

  const [testing, setTesting] = useState(false);
  const [sshTestResult, setSshTestResult] = useState<SshTestResult | null>(null);
  const [rdpProbeResult, setRdpProbeResult] = useState<RdpProbeResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const proto = initialProfile?.protocol || "ssh";
    setProtocol(proto);
    setName(initialProfile?.name || "");
    setHost(initialProfile?.host || "");
    setPort(initialProfile?.port || (proto === "rdp" ? 3389 : 22));
    setUsername(
      initialProfile?.username || (proto === "rdp" ? "Administrator" : "root")
    );
    setAuthMethod(initialProfile?.authMethod || "password");
    setPassword(initialProfile?.password || "");
    setPrivateKey(initialProfile?.privateKey || "");
    setPassphrase(initialProfile?.passphrase || "");
    setSshKeyId(initialProfile?.sshKeyId || "");
    setDomain(initialProfile?.domain || "");
    setRdpSecurity(initialProfile?.rdpSecurity || "any");
    setIgnoreCert(initialProfile?.ignoreCert !== false);
    setRdpWidth(initialProfile?.rdpWidth || 1280);
    setRdpHeight(initialProfile?.rdpHeight || 720);
    setInitialPath(initialProfile?.initialPath || "");
    setGroup(initialProfile?.group || "Production");
    setAccentColor(
      initialProfile?.accentColor ||
        (proto === "rdp" ? "#ff6b57" : proto === "sftp" ? "#38bdf8" : "#34d399")
    );
    setNotes(initialProfile?.notes || "");
    setSshTestResult(null);
    setRdpProbeResult(null);
    setFormError(null);
  }, [isOpen, initialProfile]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleProtocolSwitch = (nextProto: ProtocolType) => {
    setProtocol(nextProto);
    setSshTestResult(null);
    setRdpProbeResult(null);
    if (nextProto === "rdp" && (port === 22 || !port)) {
      setPort(3389);
      if (username === "root") setUsername("Administrator");
      setAccentColor("#ff6b57");
    } else if (nextProto !== "rdp" && port === 3389) {
      setPort(22);
      if (username === "Administrator") setUsername("root");
      setAccentColor(nextProto === "sftp" ? "#38bdf8" : "#34d399");
    } else if (nextProto === "sftp") {
      setAccentColor("#38bdf8");
    } else if (nextProto === "ssh") {
      setAccentColor("#34d399");
    }
  };

  const handleKeyFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPrivateKey(text.trim());
    setAuthMethod("privateKey");
  };

  const buildProfile = (): HostProfile | null => {
    if (!host.trim()) {
      setFormError("Hostname or IP address is required.");
      return null;
    }
    if (!username.trim()) {
      setFormError("Username is required.");
      return null;
    }
    const numericPort = Number(port || (protocol === "rdp" ? 3389 : 22));
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      setFormError("Port must be between 1 and 65535.");
      return null;
    }

    const now = Date.now();
    const selectedWhitelisted =
      authMethod === "privateKey" && sshKeyId
        ? sshKeys.find((k) => k.id === sshKeyId)
        : undefined;

    if (
      protocol !== "rdp" &&
      authMethod === "privateKey" &&
      enforceKeyWhitelist &&
      !selectedWhitelisted
    ) {
      setFormError(
        "Private Key Whitelist is enforced: select an approved Vault SSH key or click 'Add to Whitelist' first."
      );
      return null;
    }

    return {
      id: initialProfile?.id || randomUUID(),
      name: name.trim() || `${username.trim()}@${host.trim()}`,
      protocol,
      host: host.trim(),
      port: numericPort,
      username: username.trim(),
      authMethod,
      password,
      sshKeyId:
        authMethod === "privateKey" && selectedWhitelisted
          ? selectedWhitelisted.id
          : undefined,
      privateKey:
        authMethod === "privateKey"
          ? selectedWhitelisted?.privateKey ?? privateKey
          : undefined,
      passphrase:
        authMethod === "privateKey"
          ? selectedWhitelisted?.passphrase ?? passphrase
          : undefined,
      domain: protocol === "rdp" ? domain.trim() : undefined,
      rdpSecurity: protocol === "rdp" ? rdpSecurity : undefined,
      ignoreCert: protocol === "rdp" ? ignoreCert : undefined,
      rdpWidth: protocol === "rdp" ? rdpWidth : undefined,
      rdpHeight: protocol === "rdp" ? rdpHeight : undefined,
      initialPath: protocol === "sftp" ? initialPath.trim() : undefined,
      group: group.trim() || "Servers",
      accentColor,
      notes: notes.trim() || undefined,
      createdAt: initialProfile?.createdAt || now,
      updatedAt: now,
    };
  };

  const handleTestConnection = async () => {
    setFormError(null);
    setSshTestResult(null);
    setRdpProbeResult(null);

    if (!host.trim()) {
      setFormError("Enter a host or IP first to test connectivity.");
      return;
    }

    setTesting(true);
    try {
      const apiBase = resolveGatewayHttpBase(gatewaySettings.gatewayUrl);
      if (protocol === "rdp") {
        // Always prefer local /api/rdp/probe if remote gateway only exposes WS
        const res = await fetch("/api/rdp/probe", {
          method: "POST",
          headers: getAuthHeaders(gatewaySettings),
          body: JSON.stringify({
            host: host.trim(),
            port: Number(port || 3389),
          }),
        });
        const data = (await res.json()) as RdpProbeResult;
        setRdpProbeResult(data);
      } else {
        // Test SSH/SFTP via local serverless/node endpoint (fallback to gateway if needed)
        const draftProfile = buildProfile();
        if (!draftProfile) {
          setTesting(false);
          return;
        }
        const resolved = resolveProfileWithKeychain(
          draftProfile,
          sshKeys,
          enforceKeyWhitelist
        );
        if (!resolved.ok) {
          setFormError(resolved.error);
          setTesting(false);
          return;
        }
        const testCreds = {
          host: resolved.profile.host,
          port: resolved.profile.port,
          username: resolved.profile.username,
          authMethod: resolved.profile.authMethod,
          password: resolved.profile.password,
          privateKey: resolved.profile.privateKey,
          passphrase: resolved.profile.passphrase,
        };

        const endpoint = apiBase ? `${apiBase}/api/ssh/test` : "/api/ssh/test";
        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: "POST",
            headers: getAuthHeaders(gatewaySettings),
            body: JSON.stringify({ credentials: testCreds }),
          });
          if (res.status === 404 && apiBase) {
            res = await fetch("/api/ssh/test", {
              method: "POST",
              headers: getAuthHeaders(gatewaySettings),
              body: JSON.stringify({ credentials: testCreds }),
            });
          }
        } catch {
          res = await fetch("/api/ssh/test", {
            method: "POST",
            headers: getAuthHeaders(gatewaySettings),
            body: JSON.stringify({ credentials: testCreds }),
          });
        }

        const data = (await res.json()) as SshTestResult;
        setSshTestResult(data);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Test request failed.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div className="flex items-center gap-3">
            <span
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: accentColor }}
            />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white">
                {title ||
                  (initialProfile?.id
                    ? "Edit Host Profile"
                    : "New Remote Connection")}
              </h2>
              {subtitle && (
                <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-slate-400">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Protocol selector */}
          <div className="grid grid-cols-3 gap-2.5">
            {(
              [
                {
                  id: "ssh",
                  label: "SSH Terminal",
                  sub: "Interactive PTY / Exec",
                  icon: Terminal,
                  color: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
                },
                {
                  id: "sftp",
                  label: "SFTP Files",
                  sub: "Explorer & Editor",
                  icon: FolderKanban,
                  color: "border-sky-500/50 bg-sky-500/10 text-sky-300",
                },
                {
                  id: "rdp",
                  label: "RDP Desktop",
                  sub: "Windows / xrdp GUI",
                  icon: Monitor,
                  color: "border-[#ff6b57]/50 bg-[#ff6b57]/10 text-[#ff8b7b]",
                },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = protocol === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleProtocolSwitch(item.id)}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                    active
                      ? item.color
                      : "border-white/8 bg-[#151a24] text-slate-400 hover:border-white/15 hover:text-slate-200"
                  }`}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium leading-tight">{item.label}</div>
                    <div className="truncate text-[11px] opacity-75">{item.sub}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {formError && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {/* Label & Group */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Display Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. prod-api-tokyo-01"
                className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none transition focus:border-white/25"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Folder / Group
              </label>
              <input
                type="text"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="Production"
                className="w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none transition focus:border-white/25"
              />
            </div>
          </div>

          {/* Host, Port, Username */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
            <div className="sm:col-span-6">
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Hostname or IP Address *
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="203.0.113.42 or server.example.com"
                className="font-mono-code w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none transition focus:border-white/25"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Port *
              </label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="font-mono-code w-full rounded-xl border border-white/10 bg-[#151a24] px-3 py-2 text-sm text-white outline-none transition focus:border-white/25"
              />
            </div>
            <div className="sm:col-span-4">
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Username *
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={protocol === "rdp" ? "Administrator" : "root"}
                className="font-mono-code w-full rounded-xl border border-white/10 bg-[#151a24] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none transition focus:border-white/25"
              />
            </div>
          </div>

          {/* Authentication */}
          {protocol !== "rdp" ? (
            <div className="space-y-3 rounded-xl border border-white/8 bg-[#131722] p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">
                  Authentication Method
                </span>
                <div className="flex rounded-lg bg-[#0b0e14] p-0.5">
                  <button
                    type="button"
                    onClick={() => setAuthMethod("password")}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
                      authMethod === "password"
                        ? "bg-white/12 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <Lock className="h-3.5 w-3.5" />
                    Password
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMethod("privateKey")}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
                      authMethod === "privateKey"
                        ? "bg-white/12 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    SSH Private Key
                  </button>
                </div>
              </div>

              {authMethod === "password" ? (
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter SSH password"
                    className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25"
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      Whitelisted SSH Keychain
                    </label>
                    <select
                      value={sshKeyId}
                      onChange={(e) => setSshKeyId(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-xs text-white outline-none focus:border-white/25"
                    >
                      <option value="">
                        {enforceKeyWhitelist
                          ? "— Select an approved Whitelisted SSH Key —"
                          : "— Custom inline private key —"}
                      </option>
                      {sshKeys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name}
                          {k.fingerprint ? ` (${k.fingerprint.slice(0, 22)}…)` : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!sshKeyId && (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-xs text-slate-400">
                          PEM / OpenSSH Private Key (Ed25519, RSA, ECDSA)
                        </label>
                        <div className="flex items-center gap-1.5">
                          {privateKey.trim() && onAddWhitelistedKey && (
                            <button
                              type="button"
                              disabled={whitelistingInline}
                              onClick={async () => {
                                setFormError(null);
                                setWhitelistingInline(true);
                                try {
                                  const keyLabel =
                                    name.trim() ||
                                    `${username.trim() || "ssh"}@${host.trim() || "server"}`;
                                  const res = await fetch("/api/ssh/key-inspect", {
                                    method: "POST",
                                    headers: getAuthHeaders(gatewaySettings),
                                    body: JSON.stringify({
                                      action: "inspect",
                                      privateKey: privateKey.trim(),
                                      passphrase: passphrase || undefined,
                                      label: keyLabel,
                                    }),
                                  });
                                  const data = await res.json();
                                  if (!res.ok || !data.ok) {
                                    throw new Error(
                                      data.error || "Invalid private key."
                                    );
                                  }
                                  const newKey: WhitelistedSshKey = {
                                    id: randomUUID(),
                                    name: keyLabel,
                                    privateKey: privateKey.trim(),
                                    passphrase: passphrase || undefined,
                                    publicKey: data.publicKeyOpenSSH,
                                    keyType: data.keyType,
                                    fingerprint: data.fingerprint,
                                    createdAt: Date.now(),
                                  };
                                  await onAddWhitelistedKey(newKey);
                                  setSshKeyId(newKey.id);
                                } catch (err) {
                                  setFormError(
                                    err instanceof Error
                                      ? err.message
                                      : "Could not whitelist key."
                                  );
                                } finally {
                                  setWhitelistingInline(false);
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                              Add to Whitelist
                            </button>
                          )}
                          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/10">
                            <Upload className="h-3.5 w-3.5" />
                            Import Key File
                            <input
                              type="file"
                              onChange={handleKeyFileUpload}
                              className="hidden"
                            />
                          </label>
                        </div>
                      </div>
                      <textarea
                        rows={4}
                        value={privateKey}
                        onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                        className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] p-3 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-white/25"
                      />
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">
                          Key Passphrase (optional)
                        </label>
                        <input
                          type="password"
                          value={passphrase}
                          onChange={(e) => setPassphrase(e.target.value)}
                          placeholder="Leave empty if unencrypted"
                          className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}

              {protocol === "sftp" && (
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Initial Remote Path (optional)
                  </label>
                  <input
                    type="text"
                    value={initialPath}
                    onChange={(e) => setInitialPath(e.target.value)}
                    placeholder="/var/www or leave empty for home directory"
                    className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 rounded-xl border border-white/8 bg-[#131722] p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">RDP Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Windows / xrdp password"
                    className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Windows Domain (optional)
                  </label>
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="WORKGROUP or CORP"
                    className="font-mono-code w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3.5 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Security Mode</label>
                  <select
                    value={rdpSecurity}
                    onChange={(e) => setRdpSecurity(e.target.value as RdpSecurityMode)}
                    className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                  >
                    <option value="any">Auto Negotiate (Any)</option>
                    <option value="nla">NLA (CredSSP)</option>
                    <option value="tls">TLS Encryption</option>
                    <option value="rdp">Standard RDP</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Resolution</label>
                  <select
                    value={`${rdpWidth}x${rdpHeight}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split("x").map(Number);
                      setRdpWidth(w);
                      setRdpHeight(h);
                    }}
                    className="w-full rounded-xl border border-white/10 bg-[#0b0e14] px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                  >
                    <option value="1920x1080">1920 × 1080 (FHD)</option>
                    <option value="1600x900">1600 × 900 (HD+)</option>
                    <option value="1280x720">1280 × 720 (HD)</option>
                    <option value="1024x768">1024 × 768 (XGA)</option>
                  </select>
                </div>
                <div className="flex items-end pb-1.5">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={ignoreCert}
                      onChange={(e) => setIgnoreCert(e.target.checked)}
                      className="h-4 w-4 rounded border-white/20 bg-[#0b0e14] accent-[#ff6b57]"
                    />
                    Ignore self-signed TLS cert
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Accent Color & Notes */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Badge Accent:</span>
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setAccentColor(c)}
                  className={`h-5 w-5 rounded-full transition ${
                    accentColor === c ? "ring-2 ring-white ring-offset-2 ring-offset-[#0f131b]" : ""
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing}
              className="flex items-center gap-2 rounded-xl border border-white/12 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              )}
              {protocol === "rdp" ? "Probe RDP Handshake" : "Test SSH Auth"}
            </button>
          </div>

          {/* Test Results */}
          {sshTestResult && (
            <div
              className={`rounded-xl border p-3.5 text-xs ${
                sshTestResult.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-200"
              }`}
            >
              <div className="flex items-center justify-between font-medium">
                <span className="flex items-center gap-1.5">
                  {sshTestResult.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-400" />
                  )}
                  {sshTestResult.ok
                    ? "SSH Authenticated Successfully"
                    : "SSH Connection Failed"}
                </span>
                <span className="font-mono-code opacity-80">
                  {sshTestResult.latencyMs} ms
                </span>
              </div>
              {sshTestResult.ok ? (
                <div className="mt-2 space-y-1 text-[11px] text-emerald-100/80">
                  {sshTestResult.fingerprint && (
                    <div className="font-mono-code truncate">
                      Host Key: {sshTestResult.fingerprint}
                    </div>
                  )}
                  {sshTestResult.systemInfo?.os && (
                    <div>
                      Remote OS: {sshTestResult.systemInfo.os}{" "}
                      {sshTestResult.systemInfo.kernel
                        ? `(${sshTestResult.systemInfo.kernel})`
                        : ""}
                    </div>
                  )}
                  {sshTestResult.systemInfo?.provider && (
                    <div>
                      Hosted on: {sshTestResult.systemInfo.provider}
                      {sshTestResult.systemInfo.providerId
                        ? ` (${sshTestResult.systemInfo.providerId})`
                        : ""}
                    </div>
                  )}
                  {(sshTestResult.systemInfo?.cpu ||
                    sshTestResult.systemInfo?.memoryMb ||
                    sshTestResult.systemInfo?.arch) && (
                    <div>
                      Machine:{" "}
                      {[
                        sshTestResult.systemInfo?.arch,
                        sshTestResult.systemInfo?.cpu
                          ? `${sshTestResult.systemInfo.cpu} vCPU`
                          : "",
                        sshTestResult.systemInfo?.memoryMb
                          ? `${Math.round(sshTestResult.systemInfo.memoryMb / 1024)} GB RAM`
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-1.5 text-rose-200/90">{sshTestResult.error}</div>
              )}
            </div>
          )}

          {rdpProbeResult && (
            <div
              className={`rounded-xl border p-3.5 text-xs ${
                rdpProbeResult.reachable
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-200"
              }`}
            >
              <div className="flex items-center justify-between font-medium">
                <span className="flex items-center gap-1.5">
                  {rdpProbeResult.reachable ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-400" />
                  )}
                  {rdpProbeResult.reachable
                    ? `RDP X.224 Handshake Verified (${rdpProbeResult.negotiatedProtocol})`
                    : "RDP Endpoint Unreachable"}
                </span>
                <span className="font-mono-code opacity-80">
                  {rdpProbeResult.latencyMs} ms
                </span>
              </div>
              {rdpProbeResult.certificate?.subjectCN && (
                <div className="font-mono-code mt-1.5 truncate text-[11px] opacity-85">
                  TLS Cert CN: {rdpProbeResult.certificate.subjectCN} •{" "}
                  {rdpProbeResult.certificate.fingerprint256}
                </div>
              )}
              {rdpProbeResult.error && (
                <div className="mt-1.5 text-rose-200/90">{rdpProbeResult.error}</div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 bg-[#0b0e14] px-6 py-4">
          {onQuickConnectOnly && !initialProfile?.id ? (
            <button
              type="button"
              onClick={() => {
                const p = buildProfile();
                if (p) onQuickConnectOnly(p);
              }}
              className="rounded-xl border border-white/10 px-3.5 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/5 hover:text-white"
            >
              Connect Ephemeral (Don&apos;t Save)
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const p = buildProfile();
                if (p) onSave(p, false);
              }}
              className="rounded-xl border border-white/15 bg-white/8 px-4 py-2 text-xs font-medium text-white transition hover:bg-white/14"
            >
              Save to Vault
            </button>
            <button
              type="button"
              onClick={() => {
                const p = buildProfile();
                if (p) onSave(p, true);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/20 transition hover:bg-[#ff7f6e]"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Save &amp; Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
