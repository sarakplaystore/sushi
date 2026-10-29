"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Terminal,
  FolderKanban,
  Monitor,
  Plus,
  Search,
  Shield,
  Radio,
  Pencil,
  Trash2,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowRight,
  Lock,
  Sparkles,
  Server,
  Cloud,
  CheckCircle2,
  Fingerprint,
  Loader2,
  ArrowLeftRight,
  KeyRound,
  AlertCircle,
} from "lucide-react";
import type { AuthStatusResponse } from "@/types/auth";
import type {
  CommandSnippet,
  HostProfile,
  ProtocolType,
  SessionTab,
  SystemCapabilities,
  WhitelistedSshKey,
} from "@/types/connection";
import {
  DEFAULT_SNIPPETS,
  type EncryptedVaultEnvelope,
  clearDeviceKey,
  decryptVaultEnvelope,
  encryptVaultData,
  loadLocalEnvelope,
  resolveProfileWithKeychain,
  saveLocalEnvelope,
} from "@/lib/client/crypto-vault";
import {
  type GatewaySettings,
  getAuthHeaders,
  loadGatewaySettings,
  parseQuickConnectInput,
  resolveGatewayHttpBase,
  saveGatewaySettings,
} from "@/lib/client/gateway";
import { HostProfileModal } from "./HostProfileModal";
import { GatewaySetupModal } from "./GatewaySetupModal";
import { VaultSecurityModal, type VaultModalTab } from "./VaultSecurityModal";
import { AuthGateScreen } from "./AuthGateScreen";
import { AccountPasskeysModal } from "./AccountPasskeysModal";
import { SshTerminalSession } from "./SshTerminalSession";
import { SftpBrowserSession } from "./SftpBrowserSession";
import { RdpDesktopSession } from "./RdpDesktopSession";
import {
  getStoredAdminProfileCert,
  getStoredAuthorizedKeyCertificates,
  getStoredPasskeyCertificates,
} from "@/lib/client/auth-storage";

export function SushiWorkspace() {
  // Authentication & Passkey Gate state
  const [authChecking, setAuthChecking] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authUsername, setAuthUsername] = useState<string>("admin");
  const [accountModalOpen, setAccountModalOpen] = useState(false);

  // Capabilities & Gateway settings
  const [localCaps, setLocalCaps] = useState<SystemCapabilities | null>(null);
  const [remoteCaps, setRemoteCaps] = useState<SystemCapabilities | null>(null);
  const [gatewaySettings, setGatewaySettings] = useState<GatewaySettings>({
    gatewayUrl: "",
    gatewayToken: "",
  });

  // Vault state
  const [vaultReady, setVaultReady] = useState(false);
  const [vaultLocked, setVaultLocked] = useState(false);
  const [vaultMode, setVaultMode] = useState<"device" | "passphrase">("device");
  const [activePassphrase, setActivePassphrase] = useState<string | null>(null);
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [pendingEnvelope, setPendingEnvelope] =
    useState<EncryptedVaultEnvelope | null>(null);

  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [snippets, setSnippets] = useState<CommandSnippet[]>(DEFAULT_SNIPPETS);
  const [sshKeys, setSshKeys] = useState<WhitelistedSshKey[]>([]);
  const [enforceKeyWhitelist, setEnforceKeyWhitelist] = useState(false);
  const [whitelistBannerError, setWhitelistBannerError] = useState<string | null>(
    null
  );

  // Navigation & Tabs
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [protocolFilter, setProtocolFilter] = useState<"all" | ProtocolType>("all");
  const [hostSearch, setHostSearch] = useState("");
  const [quickConnectInput, setQuickConnectInput] = useState("");

  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("launchpad");

  // Modals
  const [hostModalOpen, setHostModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] =
    useState<Partial<HostProfile> | null>(null);
  const [gatewayModalOpen, setGatewayModalOpen] = useState(false);
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [vaultModalTab, setVaultModalTab] =
    useState<VaultModalTab>("security");

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Keyboard shortcut Cmd/Ctrl + K to focus host search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // Avoid stealing from active SSH/RDP sessions unless on launchpad
        if (activeTabId === "launchpad") {
          e.preventDefault();
          searchInputRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabId]);

  const refreshAuthStatus = useCallback(async () => {
    const gw = loadGatewaySettings();
    try {
      const certs = getStoredPasskeyCertificates().map((c) => c.cert);
      const keyCerts = getStoredAuthorizedKeyCertificates().map((c) => c.cert);
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/status", {
        method: "POST",
        headers: getAuthHeaders(gw),
        body: JSON.stringify({
          signedCertificates: certs,
          signedKeyCertificates: keyCerts,
          adminProfileCert: adminCert || undefined,
        }),
      });
      if (res.ok) {
        const statusData = (await res.json()) as AuthStatusResponse;
        setAuthStatus(statusData);
        if (statusData.username) {
          setAuthUsername(statusData.username);
        }
        return statusData;
      }
    } catch {
      // ignore
    } finally {
      setAuthChecking(false);
    }
    return null;
  }, []);

  const bootAuthenticatedWorkspace = useCallback(async () => {
    const gw = loadGatewaySettings();
    setGatewaySettings(gw);

    let fetchedLocalCaps: SystemCapabilities | null = null;
    try {
      const res = await fetch("/api/system/capabilities", {
        headers: getAuthHeaders(gw),
      });
      if (res.ok) {
        fetchedLocalCaps = (await res.json()) as SystemCapabilities;
        setLocalCaps(fetchedLocalCaps);
      }
    } catch {
      // ignore
    }

    if (gw.gatewayUrl) {
      try {
        const httpBase = resolveGatewayHttpBase(gw.gatewayUrl);
        const rRes = await fetch(`${httpBase}/api/system/capabilities`, {
          headers: getAuthHeaders(gw),
        });
        if (rRes.ok) {
          setRemoteCaps((await rRes.json()) as SystemCapabilities);
        }
      } catch {
        // ignore
      }
    }

    // Load local encrypted vault, or fallback to VPS /api/vault if local is empty
    let envelope = loadLocalEnvelope();
    if (!envelope && fetchedLocalCaps?.serverVault) {
      try {
        const vRes = await fetch("/api/vault", {
          headers: getAuthHeaders(gw),
        });
        if (vRes.ok) {
          const vData = await vRes.json();
          if (vData?.envelope?.ciphertext) {
            envelope = vData.envelope as EncryptedVaultEnvelope;
            saveLocalEnvelope(envelope);
          }
        }
      } catch {
        // ignore
      }
    }

    if (!envelope) {
      setVaultMode("device");
      setVaultReady(true);
      return;
    }

    setVaultMode(envelope.mode);
    if (envelope.mode === "passphrase") {
      setPendingEnvelope(envelope);
      setVaultLocked(true);
      setVaultReady(true);
    } else {
      try {
        const plain = await decryptVaultEnvelope(envelope);
        setHosts(plain.hosts);
        setSnippets(plain.snippets);
        setSshKeys(plain.sshKeys || []);
        setEnforceKeyWhitelist(Boolean(plain.enforceKeyWhitelist));
      } catch {
        setHosts([]);
      }
      setVaultReady(true);
    }
  }, []);

  // Boot auth check + workspace
  useEffect(() => {
    async function init() {
      const statusData = await refreshAuthStatus();
      if (statusData?.authenticated) {
        await bootAuthenticatedWorkspace();
      }
    }
    void init();
  }, [refreshAuthStatus, bootAuthenticatedWorkspace]);

  const persistVault = useCallback(
    async (
      nextHosts: HostProfile[],
      nextSnippets: CommandSnippet[],
      passphraseOverride?: string | null,
      explicitMode?: "device" | "passphrase",
      nextSshKeys?: WhitelistedSshKey[],
      nextEnforceWhitelist?: boolean
    ) => {
      const targetMode = explicitMode ?? vaultMode;
      const passToUse =
        targetMode === "passphrase"
          ? passphraseOverride ?? activePassphrase
          : null;

      const envelope = await encryptVaultData(
        {
          version: 1,
          hosts: nextHosts,
          snippets: nextSnippets,
          sshKeys: nextSshKeys ?? sshKeys,
          enforceKeyWhitelist: nextEnforceWhitelist ?? enforceKeyWhitelist,
        },
        passToUse
      );
      saveLocalEnvelope(envelope);
      setPendingEnvelope(envelope);

      if (localCaps?.serverVault) {
        try {
          await fetch("/api/vault", {
            method: "POST",
            headers: getAuthHeaders(gatewaySettings),
            body: JSON.stringify({ envelope }),
          });
        } catch {
          // non-fatal sync error
        }
      }
    },
    [
      activePassphrase,
      enforceKeyWhitelist,
      gatewaySettings,
      localCaps?.serverVault,
      sshKeys,
      vaultMode,
    ]
  );

  const openSessionTab = useCallback(
    (
      profile: HostProfile,
      overrideProtocol?: ProtocolType,
      overrideInitialPath?: string
    ) => {
      const proto = overrideProtocol || profile.protocol;
      const resolved = resolveProfileWithKeychain(
        { ...profile, protocol: proto },
        sshKeys,
        enforceKeyWhitelist
      );
      if (!resolved.ok) {
        setWhitelistBannerError(resolved.error);
        setActiveTabId("launchpad");
        return;
      }
      setWhitelistBannerError(null);

      const tabId = `tab-${crypto.randomUUID()}`;
      const newTab: SessionTab = {
        id: tabId,
        title: `${profile.name}`,
        protocol: proto,
        profile: resolved.profile,
        initialPath: overrideInitialPath ?? profile.initialPath,
        createdAt: Date.now(),
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
    },
    [enforceKeyWhitelist, sshKeys]
  );

  const closeSessionTab = (tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        if (next.length === 0) {
          setActiveTabId("launchpad");
        } else {
          const fallback = next[Math.max(0, idx - 1)];
          setActiveTabId(fallback.id);
        }
      }
      return next;
    });
  };

  const handleSaveHostProfile = async (
    profile: HostProfile,
    connectAfterSave?: boolean
  ) => {
    const nextHosts = hosts.some((h) => h.id === profile.id)
      ? hosts.map((h) => (h.id === profile.id ? profile : h))
      : [profile, ...hosts];
    setHosts(nextHosts);
    await persistVault(nextHosts, snippets);
    setHostModalOpen(false);
    setEditingProfile(null);
    if (connectAfterSave) {
      openSessionTab(profile);
    }
  };

  const handleDeleteHost = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextHosts = hosts.filter((h) => h.id !== id);
    setHosts(nextHosts);
    await persistVault(nextHosts, snippets);
  };

  const handleQuickConnectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseQuickConnectInput(quickConnectInput);
    if (!parsed) {
      setEditingProfile({ protocol: "ssh" });
      setHostModalOpen(true);
      return;
    }
    setEditingProfile({
      name: `${parsed.username}@${parsed.host}`,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      initialPath: parsed.initialPath,
    });
    setHostModalOpen(true);
    setQuickConnectInput("");
  };

  const handleUnlockVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingEnvelope) return;
    setUnlockError(null);
    try {
      const plain = await decryptVaultEnvelope(pendingEnvelope, unlockInput);
      setHosts(plain.hosts);
      setSnippets(plain.snippets);
      setSshKeys(plain.sshKeys || []);
      setEnforceKeyWhitelist(Boolean(plain.enforceKeyWhitelist));
      setActivePassphrase(unlockInput);
      setUnlockInput("");
      setVaultLocked(false);
    } catch (err) {
      setUnlockError(
        err instanceof Error ? err.message : "Incorrect master passphrase."
      );
    }
  };

  const effectiveWsSsh = Boolean(
    remoteCaps ? remoteCaps.websocketSsh : localCaps?.websocketSsh
  );
  const effectiveRdpGuacd = Boolean(
    remoteCaps ? remoteCaps.rdpGuacd : localCaps?.rdpGuacd
  );

  const filteredHosts = hosts.filter((h) => {
    if (protocolFilter !== "all" && h.protocol !== protocolFilter) return false;
    if (hostSearch.trim()) {
      const q = hostSearch.toLowerCase();
      return (
        h.name.toLowerCase().includes(q) ||
        h.host.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q) ||
        (h.group || "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Group hosts by folder
  const groupedHosts = filteredHosts.reduce<Record<string, HostProfile[]>>(
    (acc, h) => {
      const key = h.group || "Servers";
      if (!acc[key]) acc[key] = [];
      acc[key].push(h);
      return acc;
    },
    {}
  );

  // Authentication & Passkey Gate
  if (authChecking) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#090b10]">
        <Loader2 className="h-6 w-6 animate-spin text-[#ff6b57]" />
      </div>
    );
  }

  if (!authStatus?.authenticated) {
    return (
      <AuthGateScreen
        authStatus={
          authStatus || {
            ok: true,
            authenticated: false,
            initialized: false,
            canBootstrapOnDisk: true,
            canBootstrapInteractive: true,
            mode: "vps",
            passkeyCount: 0,
            authorizedKeyCount: 0,
            envConfigured: false,
          }
        }
        onAuthenticated={async (loggedInUser) => {
          setAuthUsername(loggedInUser);
          await refreshAuthStatus();
          await bootAuthenticatedWorkspace();
        }}
        onRefreshStatus={async () => {
          const s = await refreshAuthStatus();
          if (s?.authenticated) {
            await bootAuthenticatedWorkspace();
          }
        }}
      />
    );
  }

  // Vault Unlock Gate
  if (vaultReady && vaultLocked) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <form
          onSubmit={handleUnlockVault}
          className="w-full max-w-md space-y-5 rounded-2xl border border-white/10 bg-[#0f131b] p-7 shadow-2xl"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#ff6b57]/15 text-[#ff6b57]">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white">
                Unlock Sushi Vault
              </h1>
              <p className="text-xs text-slate-400">
                AES-256-GCM Master Passphrase Protection
              </p>
            </div>
          </div>

          {unlockError && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-300">
              {unlockError}
            </div>
          )}

          <input
            type="password"
            value={unlockInput}
            onChange={(e) => setUnlockInput(e.target.value)}
            placeholder="Enter master passphrase..."
            autoFocus
            className="w-full rounded-xl border border-white/12 bg-[#090b10] px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-[#ff6b57]"
          />

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Reset local encrypted vault? Unbacked-up saved hosts in this browser will be cleared."
                  )
                ) {
                  localStorage.removeItem("sushi_encrypted_vault_v1");
                  clearDeviceKey();
                  setHosts([]);
                  setVaultMode("device");
                  setVaultLocked(false);
                }
              }}
              className="text-xs text-slate-500 hover:text-rose-400"
            >
              Reset Local Vault
            </button>
            <button
              type="submit"
              className="rounded-xl bg-[#ff6b57] px-5 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e]"
            >
              Unlock Workspace
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#090b10] text-slate-100">
      {/* Left Collapsible Host Sidebar */}
      {sidebarOpen && (
        <aside className="flex h-full w-68 shrink-0 flex-col border-r border-white/8 bg-[#0d1118]">
          {/* Brand Header */}
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3.5">
            <button
              type="button"
              onClick={() => setActiveTabId("launchpad")}
              className="flex items-center gap-2.5 text-left"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff6b57] to-[#e14935] text-white shadow-md shadow-[#ff6b57]/20">
                <Terminal className="h-4 w-4 stroke-[2.5]" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-bold tracking-tight text-white">
                    SUSHI
                  </span>
                  <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-300">
                    {gatewaySettings.gatewayUrl
                      ? "Hybrid GW"
                      : localCaps?.mode || "Node"}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">
                  SSH • SFTP • RDP
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          {/* Search + New Host */}
          <div className="space-y-2.5 p-3">
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={hostSearch}
                  onChange={(e) => setHostSearch(e.target.value)}
                  placeholder="Search hosts (⌘K)"
                  className="w-full rounded-xl border border-white/8 bg-[#090b10] py-1.5 pl-8 pr-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-white/20"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingProfile(null);
                  setHostModalOpen(true);
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#ff6b57] text-white transition hover:bg-[#ff7f6e]"
                title="Add new remote host"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>

            {/* Protocol Filter Pills */}
            <div className="grid grid-cols-4 gap-1 rounded-xl bg-[#090b10] p-1 text-[11px]">
              {(["all", "ssh", "sftp", "rdp"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProtocolFilter(p)}
                  className={`rounded-lg py-1 font-medium uppercase transition ${
                    protocolFilter === p
                      ? "bg-white/12 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Saved Hosts List */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-1">
            {filteredHosts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-4 text-center">
                <p className="text-xs font-medium text-slate-300">
                  {hosts.length === 0 ? "No Saved Hosts Yet" : "No Matching Hosts"}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Add an SSH, SFTP, or RDP server to store it in your AES-256 vault.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setEditingProfile(null);
                    setHostModalOpen(true);
                  }}
                  className="mt-3 inline-flex items-center gap-1 rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/14"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Connection
                </button>
              </div>
            ) : (
              Object.entries(groupedHosts).map(([groupName, groupItems]) => (
                <div key={groupName} className="space-y-1">
                  <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {groupName}
                  </div>
                  {groupItems.map((h) => {
                    const ProtoIcon =
                      h.protocol === "rdp"
                        ? Monitor
                        : h.protocol === "sftp"
                          ? FolderKanban
                          : Terminal;
                    return (
                      <div
                        key={h.id}
                        onClick={() => openSessionTab(h)}
                        className="group flex cursor-pointer items-center justify-between rounded-xl px-2.5 py-2 transition hover:bg-white/[0.06]"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]"
                            style={{
                              color: h.accentColor || "#34d399",
                            }}
                          >
                            <ProtoIcon className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-slate-100">
                              {h.name}
                            </div>
                            <div className="font-mono-code truncate text-[10px] text-slate-500">
                              {h.username}@{h.host}:{h.port}
                            </div>
                          </div>
                        </div>

                        <div className="hidden items-center gap-0.5 group-hover:flex">
                          {h.protocol !== "rdp" && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openSessionTab(
                                  h,
                                  h.protocol === "ssh" ? "sftp" : "ssh"
                                );
                              }}
                              className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-sky-300"
                              title={
                                h.protocol === "ssh"
                                  ? "Open as SFTP"
                                  : "Open as SSH"
                              }
                            >
                              {h.protocol === "ssh" ? (
                                <FolderKanban className="h-3 w-3" />
                              ) : (
                                <Terminal className="h-3 w-3" />
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingProfile(h);
                              setHostModalOpen(true);
                            }}
                            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                            title="Edit host"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => void handleDeleteHost(h.id, e)}
                            className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-400"
                            title="Delete host"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Sidebar Bottom Controls */}
          <div className="space-y-1.5 border-t border-white/8 p-3">
            <button
              type="button"
              onClick={() => setAccountModalOpen(true)}
              className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-[#131823] px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-white/18 hover:bg-white/8"
            >
              <span className="flex min-w-0 items-center gap-2 truncate">
                <Fingerprint className="h-3.5 w-3.5 shrink-0 text-[#ff6b57]" />
                <span className="truncate">{authUsername}</span>
              </span>
              <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-slate-400">
                Passkeys
              </span>
            </button>

            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setVaultModalTab("termix");
                  setVaultModalOpen(true);
                }}
                className="flex items-center justify-center gap-1 rounded-xl border border-white/8 bg-[#131823] px-2 py-2 text-[11px] font-medium text-slate-200 transition hover:border-white/18 hover:bg-white/8"
                title="Import a Termix SQLite database or JSON export, or export to Termix"
              >
                <ArrowLeftRight className="h-3.5 w-3.5 text-[#ff6b57]" />
                Termix
              </button>
              <button
                type="button"
                onClick={() => {
                  setVaultModalTab("keys");
                  setVaultModalOpen(true);
                }}
                className="flex items-center justify-center gap-1 rounded-xl border border-white/8 bg-[#131823] px-2 py-2 text-[11px] font-medium text-slate-200 transition hover:border-white/18 hover:bg-white/8"
                title="Whitelisted SSH Keys & Vault"
              >
                <KeyRound className="h-3.5 w-3.5 text-emerald-400" />
                Keys
              </button>
              <button
                type="button"
                onClick={() => setGatewayModalOpen(true)}
                className="flex items-center justify-center gap-1 rounded-xl border border-white/8 bg-[#131823] px-2 py-2 text-[11px] font-medium text-slate-200 transition hover:border-white/18 hover:bg-white/8"
              >
                <Radio className="h-3.5 w-3.5 text-sky-400" />
                Gateway
              </button>
            </div>
          </div>
        </aside>
      )}

      {/* Right Main Workspace */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Multi-Tab Bar */}
        <header className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/8 bg-[#0c1017] px-2">
          {!sidebarOpen && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="mr-1 rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
              title="Open sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}

          {/* Launchpad Tab */}
          <button
            type="button"
            onClick={() => setActiveTabId("launchpad")}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeTabId === "launchpad"
                ? "bg-[#171d2b] text-white shadow-xs"
                : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 text-[#ff6b57]" />
            Launchpad
          </button>

          {/* Active Session Tabs */}
          {tabs.map((tab) => {
            const active = activeTabId === tab.id;
            const Icon =
              tab.protocol === "rdp"
                ? Monitor
                : tab.protocol === "sftp"
                  ? FolderKanban
                  : Terminal;
            const iconColor =
              tab.protocol === "rdp"
                ? "text-[#ff6b57]"
                : tab.protocol === "sftp"
                  ? "text-sky-400"
                  : "text-emerald-400";

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`group flex max-w-[220px] shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                  active
                    ? "border-white/12 bg-[#171d2b] text-white"
                    : "border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} />
                <span className="truncate font-medium">{tab.title}</span>
                <span className="font-mono-code text-[10px] uppercase opacity-60">
                  {tab.protocol}
                </span>
                <button
                  type="button"
                  onClick={(e) => closeSessionTab(tab.id, e)}
                  className="ml-0.5 rounded p-0.5 text-slate-500 hover:bg-white/10 hover:text-white"
                  aria-label={`Close ${tab.title}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => {
              setEditingProfile(null);
              setHostModalOpen(true);
            }}
            className="ml-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/6 hover:text-white"
            title="New Connection Tab"
          >
            <Plus className="h-4 w-4" />
          </button>
        </header>

        {/* Workspace Stage */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Launchpad Home View */}
          <div
            className={
              activeTabId === "launchpad"
                ? "h-full w-full overflow-y-auto p-6 sm:p-8"
                : "hidden"
            }
          >
            <div className="mx-auto max-w-5xl space-y-8">
              {whitelistBannerError && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                  <span className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                    {whitelistBannerError}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setWhitelistBannerError(null);
                      setVaultModalTab("keys");
                      setVaultModalOpen(true);
                    }}
                    className="shrink-0 rounded-lg bg-rose-500/20 px-3 py-1 font-semibold text-rose-100 hover:bg-rose-500/30"
                  >
                    Open Key Whitelist
                  </button>
                </div>
              )}

              {/* Hero & Quick Connect Command Bar */}
              <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#131824] to-[#0e121b] p-6 shadow-xl sm:p-7">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
                      Sushi Remote Workspace
                    </h1>
                    <p className="mt-1 text-xs text-slate-400 sm:text-sm">
                      Unified SSH terminal, SFTP file manager &amp; editor, and HTML5
                      RDP client — built for VPS self-hosting and Vercel.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setVaultModalTab("termix");
                        setVaultModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                    >
                      <ArrowLeftRight className="h-3.5 w-3.5 text-[#ff6b57]" />
                      Termix Import / Export
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setVaultModalTab("keys");
                        setVaultModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                    >
                      <KeyRound className="h-3.5 w-3.5 text-emerald-400" />
                      SSH Key Whitelist ({sshKeys.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setAccountModalOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                    >
                      <Fingerprint className="h-3.5 w-3.5 text-[#ff6b57]" />
                      Account &amp; Login Keys
                    </button>
                    <button
                      type="button"
                      onClick={() => setGatewayModalOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                    >
                      {localCaps?.mode === "vercel" ? (
                        <Cloud className="h-3.5 w-3.5 text-sky-400" />
                      ) : (
                        <Server className="h-3.5 w-3.5 text-emerald-400" />
                      )}
                      {gatewaySettings.gatewayUrl
                        ? "VPS Gateway Linked"
                        : localCaps?.mode === "vercel"
                          ? "Vercel Serverless Mode"
                          : "VPS Self-Hosted Mode"}
                    </button>
                  </div>
                </div>

                {/* Smart Quick Connect Input */}
                <form
                  onSubmit={handleQuickConnectSubmit}
                  className="mt-5 flex flex-col gap-2.5 sm:flex-row"
                >
                  <div className="relative flex-1">
                    <Terminal className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-[#ff6b57]" />
                    <input
                      type="text"
                      value={quickConnectInput}
                      onChange={(e) => setQuickConnectInput(e.target.value)}
                      placeholder="Quick connect: ssh ubuntu@203.0.113.10 -p 2222  |  sftp://root@host/etc  |  rdp://Administrator@host:3389"
                      className="font-mono-code w-full rounded-xl border border-white/12 bg-[#090b10] py-2.5 pl-10 pr-4 text-xs text-white placeholder-slate-500 outline-none transition focus:border-[#ff6b57]"
                    />
                  </div>
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#ff6b57] px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/20 transition hover:bg-[#ff7f6e]"
                  >
                    Connect
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </form>

                {/* Live Capability Pills */}
                <div className="mt-4 flex flex-wrap items-center gap-2 pt-1 text-[11px]">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    {effectiveWsSsh
                      ? "SSH: Live WebSocket PTY"
                      : "SSH: Serverless PTY Stream"}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-sky-300">
                    <CheckCircle2 className="h-3 w-3" />
                    SFTP: Explorer + Remote Editor
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#ff6b57]/25 bg-[#ff6b57]/10 px-2.5 py-1 text-[#ff9587]">
                    <CheckCircle2 className="h-3 w-3" />
                    {effectiveRdpGuacd
                      ? "RDP: Live HTML5 Desktop (guacd)"
                      : "RDP: X.224/TLS Probe + .rdp / Gateway"}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                    <Shield className="h-3 w-3 text-emerald-400" />
                    Vault: AES-256-GCM
                  </span>
                </div>
              </div>

              {/* Protocol Quick-Create Cards or Saved Hosts Grid */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditingProfile({ protocol: "ssh" });
                    setHostModalOpen(true);
                  }}
                  className="group rounded-2xl border border-white/8 bg-[#111520] p-5 text-left transition hover:border-emerald-500/40 hover:bg-[#141a27]"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
                    <Terminal className="h-5 w-5" />
                  </div>
                  <h3 className="mt-3.5 text-sm font-semibold text-white">
                    New SSH Terminal
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">
                    Interactive xterm.js PTY shell with password &amp; Ed25519/RSA key
                    auth, snippets, and themes.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setEditingProfile({ protocol: "sftp" });
                    setHostModalOpen(true);
                  }}
                  className="group rounded-2xl border border-white/8 bg-[#111520] p-5 text-left transition hover:border-sky-500/40 hover:bg-[#141a27]"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400">
                    <FolderKanban className="h-5 w-5" />
                  </div>
                  <h3 className="mt-3.5 text-sm font-semibold text-white">
                    New SFTP File Manager
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">
                    Drag-and-drop uploads, streaming downloads, chmod matrix, and
                    in-browser code editor.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setEditingProfile({ protocol: "rdp" });
                    setHostModalOpen(true);
                  }}
                  className="group rounded-2xl border border-white/8 bg-[#111520] p-5 text-left transition hover:border-[#ff6b57]/40 hover:bg-[#141a27]"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#ff6b57]/15 text-[#ff6b57]">
                    <Monitor className="h-5 w-5" />
                  </div>
                  <h3 className="mt-3.5 text-sm font-semibold text-white">
                    New RDP Remote Desktop
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">
                    Windows &amp; Linux xrdp streaming via guacd, X.224/NLA probe,
                    clipboard sync, and .rdp export.
                  </p>
                </button>
              </div>

              {/* Saved Hosts Section */}
              {hosts.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-white">
                      Saved Connections ({hosts.length})
                    </h2>
                    <button
                      type="button"
                      onClick={() => setVaultModalOpen(true)}
                      className="text-xs text-slate-400 hover:text-white"
                    >
                      Backup / Lock Vault
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {hosts.map((h) => {
                      const Icon =
                        h.protocol === "rdp"
                          ? Monitor
                          : h.protocol === "sftp"
                            ? FolderKanban
                            : Terminal;
                      return (
                        <div
                          key={h.id}
                          className="flex flex-col justify-between rounded-2xl border border-white/8 bg-[#111520] p-4 transition hover:border-white/18"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-3">
                              <div
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.04]"
                                style={{ color: h.accentColor || "#34d399" }}
                              >
                                <Icon className="h-4 w-4" />
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-white">
                                  {h.name}
                                </div>
                                <div className="font-mono-code truncate text-xs text-slate-400">
                                  {h.username}@{h.host}:{h.port}
                                </div>
                              </div>
                            </div>
                            <span className="font-mono-code rounded-md bg-white/6 px-2 py-0.5 text-[10px] uppercase text-slate-300">
                              {h.protocol}
                            </span>
                          </div>

                          <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/6 pt-3">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => openSessionTab(h)}
                                className="rounded-lg bg-white/10 px-3 py-1 text-xs font-medium text-white transition hover:bg-white/18"
                              >
                                Connect
                              </button>
                              {h.protocol !== "rdp" && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    openSessionTab(
                                      h,
                                      h.protocol === "ssh" ? "sftp" : "ssh"
                                    )
                                  }
                                  className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-white/6 hover:text-white"
                                >
                                  {h.protocol === "ssh" ? "SFTP" : "SSH"}
                                </button>
                              )}
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingProfile(h);
                                  setHostModalOpen(true);
                                }}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/8 hover:text-white"
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => void handleDeleteHost(h.id, e)}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Mounted Protocol Session Views (stay alive across tab switches!) */}
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            return (
              <div
                key={tab.id}
                className={isActive ? "h-full w-full" : "hidden"}
              >
                {tab.protocol === "ssh" && (
                  <SshTerminalSession
                    profile={tab.profile}
                    isActive={isActive}
                    initialPath={tab.initialPath}
                    wsAvailable={effectiveWsSsh}
                    gatewaySettings={gatewaySettings}
                    snippets={snippets}
                    onOpenCompanionSftp={(cwd) =>
                      openSessionTab(tab.profile, "sftp", cwd)
                    }
                    onOpenGatewayModal={() => setGatewayModalOpen(true)}
                  />
                )}
                {tab.protocol === "sftp" && (
                  <SftpBrowserSession
                    profile={tab.profile}
                    initialPath={tab.initialPath}
                    gatewaySettings={gatewaySettings}
                    onOpenCompanionSsh={(cwd) =>
                      openSessionTab(tab.profile, "ssh", cwd)
                    }
                  />
                )}
                {tab.protocol === "rdp" && (
                  <RdpDesktopSession
                    profile={tab.profile}
                    isActive={isActive}
                    guacdAvailable={effectiveRdpGuacd}
                    gatewaySettings={gatewaySettings}
                    onOpenGatewayModal={() => setGatewayModalOpen(true)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </main>

      {/* Modals */}
      <HostProfileModal
        isOpen={hostModalOpen}
        initialProfile={editingProfile}
        gatewaySettings={gatewaySettings}
        sshKeys={sshKeys}
        enforceKeyWhitelist={enforceKeyWhitelist}
        onAddWhitelistedKey={async (newKey) => {
          const nextKeys = [...sshKeys, newKey];
          setSshKeys(nextKeys);
          await persistVault(
            hosts,
            snippets,
            undefined,
            undefined,
            nextKeys,
            enforceKeyWhitelist
          );
        }}
        onClose={() => {
          setHostModalOpen(false);
          setEditingProfile(null);
        }}
        onSave={(p, connectNow) => void handleSaveHostProfile(p, connectNow)}
        onQuickConnectOnly={(p) => {
          setHostModalOpen(false);
          setEditingProfile(null);
          openSessionTab(p);
        }}
      />

      <GatewaySetupModal
        isOpen={gatewayModalOpen}
        localCapabilities={localCaps}
        gatewaySettings={gatewaySettings}
        onClose={() => setGatewayModalOpen(false)}
        onSaveSettings={(nextSettings, nextRemoteCaps) => {
          saveGatewaySettings(nextSettings);
          setGatewaySettings(nextSettings);
          setRemoteCaps(nextRemoteCaps);
        }}
      />

      <VaultSecurityModal
        isOpen={vaultModalOpen}
        initialTab={vaultModalTab}
        vaultMode={vaultMode}
        serverVaultEnabled={Boolean(localCaps?.serverVault)}
        hosts={hosts}
        sshKeys={sshKeys}
        enforceKeyWhitelist={enforceKeyWhitelist}
        gatewaySettings={gatewaySettings}
        onClose={() => setVaultModalOpen(false)}
        onSetPassphrase={async (pass) => {
          if (pass) {
            clearDeviceKey();
            setVaultMode("passphrase");
            setActivePassphrase(pass);
            await persistVault(hosts, snippets, pass, "passphrase");
          } else {
            setVaultMode("device");
            setActivePassphrase(null);
            await persistVault(hosts, snippets, null, "device");
          }
        }}
        onLockNow={() => {
          setActivePassphrase(null);
          setVaultLocked(true);
        }}
        onExportEnvelope={() => loadLocalEnvelope()}
        onImportEnvelope={async (env, pass) => {
          const plain = await decryptVaultEnvelope(env, pass);
          const nextKeys = plain.sshKeys || [];
          const nextEnforce = Boolean(plain.enforceKeyWhitelist);
          setHosts(plain.hosts);
          setSnippets(plain.snippets);
          setSshKeys(nextKeys);
          setEnforceKeyWhitelist(nextEnforce);
          await persistVault(
            plain.hosts,
            plain.snippets,
            undefined,
            undefined,
            nextKeys,
            nextEnforce
          );
        }}
        onUpdateKeychain={async (nextKeys, nextEnforce) => {
          setSshKeys(nextKeys);
          setEnforceKeyWhitelist(nextEnforce);
          await persistVault(
            hosts,
            snippets,
            undefined,
            undefined,
            nextKeys,
            nextEnforce
          );
        }}
        onApplyTermixImport={async (
          importedHosts,
          importedKeys,
          replaceExisting,
          importedSnippets = []
        ) => {
          // 1. Merge SSH keys, re-pointing hosts at an existing keychain entry
          //    when the same key (text or fingerprint) is already whitelisted.
          const mergedKeys = [...sshKeys];
          const keyIdRemap = new Map<string, string>();
          let addedKeys = 0;
          for (const k of importedKeys) {
            const existing = mergedKeys.find(
              (ek) =>
                ek.privateKey.trim() === k.privateKey.trim() ||
                Boolean(k.fingerprint && ek.fingerprint === k.fingerprint)
            );
            if (existing) {
              if (existing.id !== k.id) keyIdRemap.set(k.id, existing.id);
            } else {
              mergedKeys.push(k);
              addedKeys++;
            }
          }

          // 2. Merge hosts, skipping exact duplicates of hosts already in Sushi
          const hostSignature = (h: HostProfile) =>
            [
              h.protocol,
              h.host.trim().toLowerCase(),
              h.port,
              h.username.trim().toLowerCase(),
              h.name.trim().toLowerCase(),
            ].join("|");
          const baseHosts = replaceExisting ? [] : hosts;
          const seen = new Set(baseHosts.map(hostSignature));
          const newHosts: HostProfile[] = [];
          let skippedHosts = 0;
          for (const h of importedHosts) {
            const sig = hostSignature(h);
            if (seen.has(sig)) {
              skippedHosts++;
              continue;
            }
            seen.add(sig);
            newHosts.push(
              h.sshKeyId && keyIdRemap.has(h.sshKeyId)
                ? { ...h, sshKeyId: keyIdRemap.get(h.sshKeyId) }
                : h
            );
          }
          const mergedHosts = [...newHosts, ...baseHosts];

          // 3. Merge command snippets (Termix SQLite `snippets` table)
          const mergedSnippets = [...snippets];
          let addedSnippets = 0;
          for (const s of importedSnippets) {
            if (
              !mergedSnippets.some(
                (es) => es.title === s.title && es.command === s.command
              )
            ) {
              mergedSnippets.push(s);
              addedSnippets++;
            }
          }

          setHosts(mergedHosts);
          setSshKeys(mergedKeys);
          setSnippets(mergedSnippets);
          await persistVault(
            mergedHosts,
            mergedSnippets,
            undefined,
            undefined,
            mergedKeys,
            enforceKeyWhitelist
          );
          return {
            addedHosts: newHosts.length,
            skippedHosts,
            addedKeys,
            addedSnippets,
          };
        }}
      />

      <AccountPasskeysModal
        isOpen={accountModalOpen}
        username={authUsername}
        runtimeMode={localCaps?.mode}
        gatewaySettings={gatewaySettings}
        onClose={() => {
          setAccountModalOpen(false);
          void refreshAuthStatus();
        }}
        onUsernameUpdated={(nextUser) => {
          setAuthUsername(nextUser);
          void refreshAuthStatus();
        }}
        onSignedOut={() => {
          setAccountModalOpen(false);
          setTabs([]);
          setActiveTabId("launchpad");
          setAuthStatus((prev) =>
            prev ? { ...prev, authenticated: false } : null
          );
        }}
      />
    </div>
  );
}
