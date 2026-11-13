"use client";

import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  Terminal,
  FolderKanban,
  Monitor,
  Plus,
  Search,
  Shield,
  Radio,
  Pencil,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowRight,
  Sparkles,
  Server,
  Cloud,
  CheckCircle2,
  Fingerprint,
  Loader2,
  ArrowLeftRight,
  KeyRound,
  Settings,
  HardDriveDownload,
  RefreshCw,
  ChevronUp,
  AlertCircle,
  ShieldAlert,
  Clock,
  CirclePlay,
  RotateCcw,
  Infinity as InfinityIcon,
  Square,
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
  type VaultPlaintext,
  decryptVaultEnvelope,
  encryptVaultData,
  loadLocalEnvelope,
  mergeVaultPlaintexts,
  resolvePersistedTabProfile,
  resolveProfileWithKeychain,
} from "@/lib/client/crypto-vault";
import {
  type GatewaySettings,
  getAuthHeaders,
  loadGatewaySettings,
  parseQuickConnectInput,
  resolveGatewayHttpBase,
  saveGatewaySettings,
} from "@/lib/client/gateway";
import {
  cacheSyncedVault,
  cacheSyncedVaultIfUnchanged,
  fetchRemoteVault,
  getLocalSyncMetadata,
  sameVaultEnvelope,
  sameOptionalVaultEnvelope,
  saveLocalVaultIfUnchanged,
  saveRemoteVault,
  subscribeVaultChanges,
  verifyAccountPassword,
} from "@/lib/client/vault-sync";
import {
  type UnifiedHost,
  mergeHosts,
  openableProtocols,
  parseHostDeepLink,
  resolveHostDeepLink,
} from "@/lib/client/unified-hosts";
import {
  applyIdentityChange,
  describeProtocols,
  removeMachine,
  siblingsOf,
} from "@/lib/client/host-consistency";
import { HostNavList } from "./HostNavList";
import { useIsPhoneViewport, useMobileHome } from "@/lib/client/mobile-home";
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
  getStoredPasskeyCertificates,
  setStoredSessionToken,
} from "@/lib/client/auth-storage";
import { isInsecureBrowserContext, randomUUID } from "@/lib/client/web-crypto";
import {
  buildRdpCompanionDraft,
  buildRdpCompanionProfile,
  rdpCompanionTitle,
} from "@/lib/client/rdp-companion";
import { stopHostBackgroundProcesses } from "@/lib/client/run-status";
import {
  type PersistedSessionTab,
  type RecentHostEntry,
  type ResumePrompt,
  type ResumableRun,
  type SyncedWorkspaceState,
  buildResumePrompt,
  describeRunState,
  formatRunDuration,
  hostHistoryKey,
  loadRecentHosts,
  loadResumableRuns,
  matchRunningCommandForTab,
  mergeWorkspaceStates,
  readLocalWorkspaceState,
  recordClosedTab,
  recordRecentHost,
  removeRecentHost,
  removeResumableRun,
  resumableRunCandidates,
  savePersistedTabs,
  upsertResumableRun,
  writeLocalWorkspaceState,
} from "@/lib/client/session-resume";

function downloadEncryptedVault(envelope: EncryptedVaultEnvelope, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SushiWorkspace() {
  // Authentication & Passkey Gate state
  const [authChecking, setAuthChecking] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authUsername, setAuthUsername] = useState<string>("admin");
  const [accountModalOpen, setAccountModalOpen] = useState(false);

  // Capabilities & Gateway settings
  const [localCaps, setLocalCaps] = useState<SystemCapabilities | null>(null);
  const [remoteCaps, setRemoteCaps] = useState<SystemCapabilities | null>(null);
  const [gatewaySettings, setGatewaySettings] = useState<GatewaySettings>({
    gatewayUrl: "",
    gatewayToken: "",
  });

  // Vault state (automatically unlocked for authenticated sessions)
  const [vaultReady, setVaultReady] = useState(false);
  const [vaultMode, setVaultMode] = useState<"device" | "passphrase">("device");
  const [activePassphrase, setActivePassphrase] = useState<string | null>(null);
  const [vaultKeySource, setVaultKeySource] = useState<"account" | "independent" | "session">("independent");
  const [accountVaultOutdated, setAccountVaultOutdated] = useState(false);
  const [authMigrationNotice, setAuthMigrationNotice] = useState<string | null>(null);
  const [vaultBootError, setVaultBootError] = useState<string | null>(null);
  const [vaultRecoveryEnvelope, setVaultRecoveryEnvelope] = useState<EncryptedVaultEnvelope | null>(null);
  const [vaultSyncError, setVaultSyncError] = useState<string | null>(null);
  const [vaultConflict, setVaultConflict] = useState<EncryptedVaultEnvelope | null>(null);
  const [conflictBackupDownloaded, setConflictBackupDownloaded] = useState(false);
  const syncRevisionRef = useRef<string | null>(null);
  // Keys held only in memory while authenticated, never written to localStorage.
  const accountPasswordRef = useRef<string | null>(null);
  const sessionVaultKeyRef = useRef<string | null>(null);
  const bootSequenceRef = useRef(0);
  const bootLocalEnvelopeRef = useRef<EncryptedVaultEnvelope | null>(null);
  const emptyPasswordRotationRef = useRef(false);
  const vaultMutationVersionRef = useRef(0);
  const syncRefreshInFlightRef = useRef(false);
  const syncRefreshRequestedRef = useRef(false);
  const syncEligibleRef = useRef(false);
  const [pendingEnvelope, setPendingEnvelope] =
    useState<EncryptedVaultEnvelope | null>(null);
  const pendingEnvelopeRef = useRef<EncryptedVaultEnvelope | null>(null);
  const updatePendingEnvelope = useCallback((envelope: EncryptedVaultEnvelope | null) => {
    pendingEnvelopeRef.current = envelope;
    setPendingEnvelope(envelope);
  }, []);
  const [stoppingAllBg, setStoppingAllBg] = useState(false);
  const [bgStopNotice, setBgStopNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [snippets, setSnippets] = useState<CommandSnippet[]>(DEFAULT_SNIPPETS);
  const [sshKeys, setSshKeys] = useState<WhitelistedSshKey[]>([]);
  const [enforceKeyWhitelist, setEnforceKeyWhitelist] = useState(false);
  const [insecureHttp, setInsecureHttp] = useState(false);
  const [insecureNoticeDismissed, setInsecureNoticeDismissed] = useState(false);
  useEffect(() => {
    if (!isInsecureBrowserContext()) return;
    setInsecureHttp(true);
    try {
      setInsecureNoticeDismissed(
        sessionStorage.getItem("sushi_http_notice_dismissed") === "1"
      );
    } catch {
      // ignore storage errors
    }
  }, []);
  const [whitelistBannerError, setWhitelistBannerError] = useState<string | null>(
    null
  );

  // Navigation & Tabs
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  /** Phone layout: the host list is the home screen instead of the hero/launchpad. */
  const isPhoneLayout = useIsPhoneViewport() === true;
  const [mobileHome, setMobileHome] = useMobileHome();
  const [desktopHomeNoticeDismissed, setDesktopHomeNoticeDismissed] = useState(true);
  const [protocolFilter, setProtocolFilter] = useState<"all" | ProtocolType>("all");
  const [hostSearch, setHostSearch] = useState("");
  const [quickConnectInput, setQuickConnectInput] = useState("");

  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("launchpad");

  // ---------------------------------------------------------------------------
  // Cross-device & reload persistent workspace state (open tabs, runs, history)
  // ---------------------------------------------------------------------------
  const [recentHosts, setRecentHosts] = useState<RecentHostEntry[]>([]);
  const [resumableRuns, setResumableRuns] = useState<ResumableRun[]>([]);
  /** Run each open SSH tab should take over (keyed by tab id). */
  const [tabResumes, setTabResumes] = useState<Record<string, ResumableRun>>({});
  /** The "go back to the still-running command?" prompt (null = not shown). */
  const [resumePrompt, setResumePrompt] = useState<ResumePrompt | null>(null);
  /** Runs already offered once, so Dismiss is not undone by the next poll. */
  const dismissedResumeRef = useRef<Set<string>>(new Set());

  // Live refs so cross-device refreshes and serialized saves never read stale closures
  // or unmount running terminal/SFTP/RDP sessions.
  const vaultReadyRef = useRef(false);
  vaultReadyRef.current = vaultReady;
  const hostsRef = useRef<HostProfile[]>([]);
  hostsRef.current = hosts;
  const snippetsRef = useRef<CommandSnippet[]>(DEFAULT_SNIPPETS);
  snippetsRef.current = snippets;
  const sshKeysRef = useRef<WhitelistedSshKey[]>([]);
  sshKeysRef.current = sshKeys;
  const enforceKeyWhitelistRef = useRef(false);
  enforceKeyWhitelistRef.current = enforceKeyWhitelist;
  const tabsRef = useRef<SessionTab[]>([]);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef<string>("launchpad");
  activeTabIdRef.current = activeTabId;
  const activeTabUpdatedAtRef = useRef<number>(0);
  const tabUpdatedAtMapRef = useRef<Record<string, number>>({});
  const tabRunIdsRef = useRef<Record<string, string | null>>({});
  const tabsHydratedRef = useRef(false);
  const localClosedTabIdsRef = useRef<Set<string>>(new Set());
  const lastSyncedPlainRef = useRef<VaultPlaintext | null>(null);
  const vaultWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceSyncDirtyRef = useRef(false);
  const scheduleWorkspaceSyncRef = useRef<() => void>(() => {});

  // Modals
  const [hostModalOpen, setHostModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] =
    useState<Partial<HostProfile> | null>(null);
  // "rdp" = the dialog was opened from an RDP session's Credentials button, so
  // the header explains that saving creates a separate RDP host.
  const [hostModalIntent, setHostModalIntent] = useState<"rdp" | null>(null);
  const [gatewayModalOpen, setGatewayModalOpen] = useState(false);
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [vaultModalTab, setVaultModalTab] =
    useState<VaultModalTab>("security");
  const [vaultModalFocusBackup, setVaultModalFocusBackup] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Do not replace in-memory data while a form is being edited.
  syncEligibleRef.current = vaultReady && !hostModalOpen &&
    !vaultModalOpen && !accountModalOpen && !gatewayModalOpen;

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const settingsContainerRef = useRef<HTMLDivElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsFirstActionRef = useRef<HTMLButtonElement | null>(null);

  /** "You're on the mobile home screen" notice: remembered per browser. */
  useEffect(() => {
    try {
      setDesktopHomeNoticeDismissed(
        localStorage.getItem("sushi_mobile_home_notice_dismissed") === "1"
      );
    } catch {
      setDesktopHomeNoticeDismissed(false);
    }
  }, []);

  const dismissDesktopHomeNotice = useCallback(() => {
    setDesktopHomeNoticeDismissed(true);
    try {
      localStorage.setItem("sushi_mobile_home_notice_dismissed", "1");
    } catch {
      // best effort
    }
  }, []);

  const closeMobileNavigation = useCallback(() => {
    setSettingsOpen(false);
    setMobileSidebarOpen(false);
    window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setMobileSidebarOpen(false);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) setSettingsOpen(false);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const frame = window.requestAnimationFrame(() => settingsFirstActionRef.current?.focus());
    const handleOutside = (event: PointerEvent) => {
      if (!settingsContainerRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", handleOutside);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handleOutside);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    mobileMenuCloseRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileNavigation();
        return;
      }
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = Array.from(
        sidebarRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [mobileSidebarOpen, closeMobileNavigation]);

  // Keyboard shortcut Cmd/Ctrl + K to focus host search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // Avoid stealing from active SSH/RDP sessions unless on launchpad
        if (activeTabId === "launchpad") {
          e.preventDefault();
          if (window.innerWidth < 768) setMobileSidebarOpen(true);
          else setSidebarOpen(true);
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
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
      const adminCert = getStoredAdminProfileCert();
      const res = await fetch("/api/auth/status", {
        method: "POST",
        headers: getAuthHeaders(gw),
        body: JSON.stringify({
          signedCertificates: certs,
          adminProfileCert: adminCert || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Account storage is unavailable.");
      const statusData = data as AuthStatusResponse;
      setAuthStatus(statusData);
      setAuthError(null);
      if (statusData.username) setAuthUsername(statusData.username);
      return statusData;
    } catch (error) {
      setAuthStatus(null);
      setAuthError(error instanceof Error ? error.message : "Could not check account status.");
      return null;
    } finally {
      setAuthChecking(false);
    }
  }, []);

  const buildPersistedTabs = useCallback(
    (tabList: SessionTab[], hostList: HostProfile[]): PersistedSessionTab[] =>
      tabList.map((tab) => ({
        id: tab.id,
        title: tab.title,
        protocol: tab.protocol,
        profile: {
          ...tab.profile,
          password: undefined,
          privateKey: undefined,
          passphrase: undefined,
        },
        hostId: hostList.some((h) => h.id === tab.profile.id) ? tab.profile.id : null,
        initialPath: tab.initialPath,
        createdAt: tab.createdAt,
        updatedAt: tabUpdatedAtMapRef.current[tab.id] ?? tab.createdAt,
        runId: tabRunIdsRef.current[tab.id] ?? null,
      })),
    []
  );

  const buildCurrentWorkspaceState = useCallback(
    (
      overrideTabs?: SessionTab[],
      overrideActiveTabId?: string,
      overrideHosts?: HostProfile[]
    ): SyncedWorkspaceState => {
      const localState = readLocalWorkspaceState();
      if (!tabsHydratedRef.current && overrideTabs === undefined) {
        return localState;
      }
      const effectiveTabs = overrideTabs ?? tabsRef.current;
      const effectiveActive = overrideActiveTabId ?? activeTabIdRef.current;
      const effectiveHosts = overrideHosts ?? hostsRef.current;
      const persistedTabs = buildPersistedTabs(effectiveTabs, effectiveHosts);
      const validActive =
        effectiveActive === "launchpad" || persistedTabs.some((t) => t.id === effectiveActive)
          ? effectiveActive
          : "launchpad";
      return {
        ...localState,
        openTabs: persistedTabs,
        activeTabId: validActive,
        activeTabUpdatedAt: activeTabUpdatedAtRef.current,
      };
    },
    [buildPersistedTabs]
  );

  const persistTabsLocally = useCallback(
    (nextTabs: SessionTab[], nextActiveTabId: string, bumpActiveTs = false) => {
      tabsRef.current = nextTabs;
      activeTabIdRef.current = nextActiveTabId;
      if (bumpActiveTs) {
        activeTabUpdatedAtRef.current = Date.now();
      }
      if (!tabsHydratedRef.current) return;
      savePersistedTabs(
        buildPersistedTabs(nextTabs, hostsRef.current),
        nextActiveTabId,
        activeTabUpdatedAtRef.current
      );
    },
    [buildPersistedTabs]
  );

  const applyPlainVault = useCallback((plain: VaultPlaintext) => {
    const nextKeys = plain.sshKeys || [];
    const nextEnforce = Boolean(plain.enforceKeyWhitelist);
    hostsRef.current = plain.hosts;
    snippetsRef.current = plain.snippets;
    sshKeysRef.current = nextKeys;
    enforceKeyWhitelistRef.current = nextEnforce;
    setHosts(plain.hosts);
    setSnippets(plain.snippets);
    setSshKeys(nextKeys);
    setEnforceKeyWhitelist(nextEnforce);

    const localWs = buildCurrentWorkspaceState(
      tabsHydratedRef.current ? tabsRef.current : undefined,
      tabsHydratedRef.current ? activeTabIdRef.current : undefined,
      plain.hosts
    );
    const mergedWs = mergeWorkspaceStates(localWs, plain.workspace);
    writeLocalWorkspaceState(mergedWs);
    setRecentHosts(mergedWs.recentHosts);
    setResumableRuns(mergedWs.resumableRuns);
    lastSyncedPlainRef.current = {
      version: 1,
      hosts: plain.hosts,
      snippets: plain.snippets,
      sshKeys: nextKeys,
      enforceKeyWhitelist: nextEnforce,
      workspace: mergedWs,
    };

    if (!tabsHydratedRef.current) {
      tabsHydratedRef.current = true;
      const claimedRunIds = new Set<string>();
      const initialResumes: Record<string, ResumableRun> = {};
      const restoredTabs: SessionTab[] = [];

      for (const ptab of mergedWs.openTabs) {
        if (localClosedTabIdsRef.current.has(ptab.id)) continue;
        const resolvedProfile = resolvePersistedTabProfile(
          ptab,
          plain.hosts,
          nextKeys,
          nextEnforce
        );
        if (!resolvedProfile) continue;
        tabUpdatedAtMapRef.current[ptab.id] = ptab.updatedAt;
        restoredTabs.push({
          id: ptab.id,
          title: ptab.title,
          protocol: ptab.protocol,
          profile: resolvedProfile,
          initialPath: ptab.initialPath,
          createdAt: ptab.createdAt,
        });
        const run = matchRunningCommandForTab(ptab, mergedWs.resumableRuns, claimedRunIds);
        if (run) {
          claimedRunIds.add(run.id);
          tabRunIdsRef.current[ptab.id] = run.id;
          initialResumes[ptab.id] = run;
          dismissedResumeRef.current.add(run.id);
        }
      }

      const hasDeepLink =
        typeof window !== "undefined" && Boolean(parseHostDeepLink(window.location.search));
      const restoredActive =
        !hasDeepLink &&
        mergedWs.activeTabId !== "launchpad" &&
        restoredTabs.some((t) => t.id === mergedWs.activeTabId)
          ? mergedWs.activeTabId
          : "launchpad";

      activeTabUpdatedAtRef.current = mergedWs.activeTabUpdatedAt;
      tabsRef.current = restoredTabs;
      activeTabIdRef.current = restoredActive;
      setTabs(restoredTabs);
      if (!hasDeepLink) {
        setActiveTabId(restoredActive);
      }
      if (Object.keys(initialResumes).length > 0) {
        setTabResumes((prev) => ({ ...prev, ...initialResumes }));
      }
      savePersistedTabs(
        buildPersistedTabs(restoredTabs, plain.hosts),
        restoredActive,
        mergedWs.activeTabUpdatedAt
      );

      const unclaimed = mergedWs.resumableRuns.filter(
        (r) => !claimedRunIds.has(r.id) && !dismissedResumeRef.current.has(r.id)
      );
      const prompt = buildResumePrompt(unclaimed);
      if (prompt) setResumePrompt(prompt);

      // If this browser had local workspace items not yet present in the shared
      // vault, push the merged workspace state once a vault envelope exists.
      if (
        (pendingEnvelopeRef.current !== null || syncRevisionRef.current !== null) &&
        JSON.stringify(mergedWs) !== JSON.stringify(plain.workspace ?? null) &&
        (mergedWs.openTabs.length > 0 ||
          mergedWs.resumableRuns.length > 0 ||
          mergedWs.recentHosts.length > 0)
      ) {
        scheduleWorkspaceSyncRef.current();
      }
      return;
    }

    // Live cross-device update: keep every mounted tab running and uninterrupted,
    // refresh host credentials in-place, append any newly opened remote tabs, and
    // attach newly started remote commands.
    const claimedRunIds = new Set<string>(
      Object.values(tabRunIdsRef.current).filter((v): v is string => Boolean(v))
    );
    const existingIds = new Set(tabsRef.current.map((t) => t.id));
    const nextResumes: Record<string, ResumableRun> = {};
    let tabsChanged = false;

    const updatedExisting = tabsRef.current.map((tab) => {
      const resolvedProfile = resolvePersistedTabProfile(
        {
          id: tab.id,
          title: tab.title,
          protocol: tab.protocol,
          profile: tab.profile,
          hostId: tab.profile.id,
          initialPath: tab.initialPath,
          createdAt: tab.createdAt,
          updatedAt: tabUpdatedAtMapRef.current[tab.id] ?? tab.createdAt,
        },
        plain.hosts,
        nextKeys,
        nextEnforce
      );

      let nextTab = tab;
      if (resolvedProfile && JSON.stringify(resolvedProfile) !== JSON.stringify(tab.profile)) {
        const nextTitle =
          tab.title === tab.profile.name && resolvedProfile.name
            ? resolvedProfile.name
            : tab.title;
        nextTab = { ...tab, title: nextTitle, profile: resolvedProfile };
        tabsChanged = true;
      }

      if (nextTab.protocol === "ssh" && !tabRunIdsRef.current[nextTab.id]) {
        const matchingRun = matchRunningCommandForTab(
          { protocol: nextTab.protocol, profile: nextTab.profile },
          mergedWs.resumableRuns,
          claimedRunIds
        );
        if (matchingRun && !dismissedResumeRef.current.has(matchingRun.id)) {
          claimedRunIds.add(matchingRun.id);
          tabRunIdsRef.current[nextTab.id] = matchingRun.id;
          nextResumes[nextTab.id] = matchingRun;
          dismissedResumeRef.current.add(matchingRun.id);
        }
      }
      return nextTab;
    });

    const addedRemoteTabs: SessionTab[] = [];
    for (const ptab of mergedWs.openTabs) {
      if (existingIds.has(ptab.id) || localClosedTabIdsRef.current.has(ptab.id)) continue;
      const resolvedProfile = resolvePersistedTabProfile(
        ptab,
        plain.hosts,
        nextKeys,
        nextEnforce
      );
      if (!resolvedProfile) continue;
      tabUpdatedAtMapRef.current[ptab.id] = ptab.updatedAt;
      addedRemoteTabs.push({
        id: ptab.id,
        title: ptab.title,
        protocol: ptab.protocol,
        profile: resolvedProfile,
        initialPath: ptab.initialPath,
        createdAt: ptab.createdAt,
      });
      tabsChanged = true;
      const run = matchRunningCommandForTab(ptab, mergedWs.resumableRuns, claimedRunIds);
      if (run) {
        claimedRunIds.add(run.id);
        tabRunIdsRef.current[ptab.id] = run.id;
        nextResumes[ptab.id] = run;
        dismissedResumeRef.current.add(run.id);
      }
    }

    if (tabsChanged) {
      const combinedTabs = [...updatedExisting, ...addedRemoteTabs];
      tabsRef.current = combinedTabs;
      setTabs(combinedTabs);
      savePersistedTabs(
        buildPersistedTabs(combinedTabs, plain.hosts),
        activeTabIdRef.current,
        activeTabUpdatedAtRef.current
      );
    }
    if (Object.keys(nextResumes).length > 0) {
      setTabResumes((prev) => ({ ...prev, ...nextResumes }));
    }

    const unclaimed = mergedWs.resumableRuns.filter(
      (r) => !claimedRunIds.has(r.id) && !dismissedResumeRef.current.has(r.id)
    );
    const prompt = buildResumePrompt(unclaimed);
    if (prompt) {
      setResumePrompt((prev) => (prev?.run.id === prompt.run.id ? prev : prompt));
    }
  }, [buildCurrentWorkspaceState, buildPersistedTabs]);

  const createSessionVault = useCallback(async (
    plain: VaultPlaintext,
    sessionKey: string,
    gw: GatewaySettings,
    baseRevision: string | null,
    shared: boolean,
    expectedLocal?: EncryptedVaultEnvelope | null
  ) => {
    const localBase = expectedLocal === undefined ? loadLocalEnvelope() : expectedLocal;
    const envelope = await encryptVaultData(plain, sessionKey);
    envelope.keySource = "session";
    if (shared) {
      if (!sameOptionalVaultEnvelope(loadLocalEnvelope(), localBase)) {
        throw new Error("The browser vault changed in another tab. Reload it before enabling sync; no data was replaced.");
      }
      const revision = await saveRemoteVault(gw, envelope, baseRevision);
      syncRevisionRef.current = revision;
      if (!(await cacheSyncedVaultIfUnchanged(localBase, envelope, revision)) && !cacheSyncedVault(envelope, revision)) {
        setVaultSyncError("Vault saved to shared storage, but this browser could not cache it locally.");
      } else {
        bootLocalEnvelopeRef.current = envelope;
      }
    } else {
      await saveLocalVaultIfUnchanged(localBase, envelope);
      bootLocalEnvelopeRef.current = envelope;
    }
    updatePendingEnvelope(envelope);
    setVaultMode("passphrase");
    setVaultKeySource("session");
    setAccountVaultOutdated(false);
    setActivePassphrase(sessionKey);
    return envelope;
  }, [updatePendingEnvelope]);

  const bootAuthenticatedWorkspace = useCallback(async (password?: string, preferShared = false) => {
    const sequence = ++bootSequenceRef.current;
    if (password) accountPasswordRef.current = password;
    const currentPassword = accountPasswordRef.current;
    // Never unmount already-running terminal/SFTP/RDP sessions when re-checking
    // or reloading the vault in an active workspace.
    if (!vaultReadyRef.current) {
      setVaultReady(false);
    }
    setVaultBootError(null);
    setVaultRecoveryEnvelope(null);
    setVaultConflict(null);
    setVaultSyncError(null);
    const gw = loadGatewaySettings();
    setGatewaySettings(gw);

    try {
      const capsRes = await fetch("/api/system/capabilities", { headers: getAuthHeaders(gw), cache: "no-store" });
      if (!capsRes.ok) throw new Error("Could not check vault storage. No data was changed.");
      const caps = await capsRes.json() as SystemCapabilities;
      if (typeof caps.serverVault !== "boolean") throw new Error("Vault storage capabilities are invalid. No data was changed.");
      if (sequence !== bootSequenceRef.current) return;
      setLocalCaps(caps);

      if (gw.gatewayUrl) {
        try {
          const httpBase = resolveGatewayHttpBase(gw.gatewayUrl);
          const rRes = await fetch(`${httpBase}/api/system/capabilities`, { headers: getAuthHeaders(gw) });
          if (rRes.ok) setRemoteCaps(await rRes.json() as SystemCapabilities);
        } catch { /* gateway availability does not affect local vault safety */ }
      }
      if (sequence !== bootSequenceRef.current) return;
      const local = loadLocalEnvelope();
      bootLocalEnvelopeRef.current = local;
      const metadata = getLocalSyncMetadata();
      const remote = caps.serverVault ? await fetchRemoteVault(gw) : null;
      if (sequence !== bootSequenceRef.current) return;
      syncRevisionRef.current = remote?.revision ?? null;
      const sessionVaultKey = remote?.vaultKey ?? sessionVaultKeyRef.current;
      if (remote?.vaultKey) {
        sessionVaultKeyRef.current = remote.vaultKey;
      }

      let envelope = remote?.envelope ?? local;
      const isRemote = Boolean(remote?.envelope);
      if (remote?.envelope && local && !sameVaultEnvelope(local, remote.envelope) && !preferShared) {
        const localIsKnownSynced = metadata?.iv === local.iv && metadata.revision !== remote.revision;
        if (!localIsKnownSynced) {
          setVaultConflict(local);
          setConflictBackupDownloaded(false);
          setVaultReady(true);
          return;
        }
      }
      if (remote && !remote.envelope && local && metadata?.revision) {
        throw new Error("The shared vault is missing, but this browser has a previously synchronized copy. No data was replaced. Restore the shared storage or export a backup before continuing.");
      }

      if (!envelope) {
        const empty: VaultPlaintext = { version: 1, hosts: [], snippets: DEFAULT_SNIPPETS, sshKeys: [], enforceKeyWhitelist: false };
        applyPlainVault(empty);
        updatePendingEnvelope(null);
        setAccountVaultOutdated(false);
        if (caps.serverVault && sessionVaultKey) {
          setVaultMode("passphrase");
          setVaultKeySource("session");
          setActivePassphrase(sessionVaultKey);
        } else if (caps.serverVault && currentPassword) {
          setVaultMode("passphrase");
          setVaultKeySource("account");
          setActivePassphrase(currentPassword);
        } else {
          setVaultMode("device");
          setVaultKeySource("independent");
          setActivePassphrase(null);
        }
        setAuthMigrationNotice(null);
        setVaultReady(true);
        return;
      }

      updatePendingEnvelope(envelope);
      setAccountVaultOutdated(false);

      let plain: VaultPlaintext | null = null;
      let usedKey: string | null = null;
      if (envelope.mode === "device") {
        try {
          plain = await decryptVaultEnvelope(envelope, null);
        } catch {
          throw new Error("This device-key vault can only be opened on its original browser.");
        }
      } else {
        const candidates = [sessionVaultKey, currentPassword].filter(
          (v, idx, arr): v is string => Boolean(v) && arr.indexOf(v) === idx
        );
        for (const candidate of candidates) {
          try {
            plain = await decryptVaultEnvelope(envelope, candidate);
            usedKey = candidate;
            break;
          } catch {
            // Try next candidate
          }
        }
        if (!plain) {
          // Pre-upgrade password-encrypted vault with no password in memory yet:
          // ask for a one-time password sign-in on AuthGateScreen to auto-migrate.
          await fetch("/api/auth/logout", {
            method: "POST",
            headers: getAuthHeaders(gw),
          }).catch(() => {});
          setStoredSessionToken(null);
          accountPasswordRef.current = null;
          setAuthMigrationNotice(
            currentPassword
              ? "The saved vault uses a previous password. Sign in with that password or restore a backup."
              : "Sign in with your account password once to finish upgrading your encrypted vault for automatic unlock."
          );
          setAuthStatus((prev) => (prev ? { ...prev, authenticated: false } : null));
          return;
        }
      }

      if (sequence !== bootSequenceRef.current) return;
      if (caps.serverVault && sessionVaultKey) {
        if (!remote?.envelope && local) {
          envelope = await createSessionVault(plain, sessionVaultKey, gw, null, true, local);
        } else if (envelope.keySource !== "session" || usedKey !== sessionVaultKey) {
          envelope = await createSessionVault(
            plain,
            sessionVaultKey,
            gw,
            remote?.revision ?? null,
            true,
            local
          );
        } else {
          if (isRemote && remote?.revision) {
            const cached =
              (await cacheSyncedVaultIfUnchanged(local, envelope, remote.revision)) ||
              cacheSyncedVault(envelope, remote.revision);
            if (sequence !== bootSequenceRef.current) return;
            if (!cached) {
              setVaultSyncError("The shared vault opened, but this browser could not cache it locally.");
            } else {
              bootLocalEnvelopeRef.current = envelope;
            }
          }
          setVaultMode("passphrase");
          setVaultKeySource("session");
          setActivePassphrase(sessionVaultKey);
        }
      } else {
        if (isRemote && remote?.revision) {
          const cached =
            (await cacheSyncedVaultIfUnchanged(local, envelope, remote.revision)) ||
            cacheSyncedVault(envelope, remote.revision);
          if (sequence !== bootSequenceRef.current) return;
          if (cached) bootLocalEnvelopeRef.current = envelope;
        }
        setVaultMode(envelope.mode);
        setVaultKeySource(
          envelope.keySource === "session"
            ? "session"
            : envelope.keySource === "account"
              ? "account"
              : "independent"
        );
        setActivePassphrase(envelope.mode === "passphrase" ? usedKey : null);
      }
      if (sequence !== bootSequenceRef.current) return;
      setAuthMigrationNotice(null);
      applyPlainVault(plain);
      setVaultReady(true);
    } catch (error) {
      if (sequence !== bootSequenceRef.current) return;
      setVaultBootError(error instanceof Error ? error.message : "Could not load the vault. No data was changed.");
      try { setVaultRecoveryEnvelope(loadLocalEnvelope()); } catch { /* preserve the unreadable local data */ }
      setVaultReady(false);
    }
  }, [applyPlainVault, createSessionVault, updatePendingEnvelope]);

  // Boot auth check + workspace. A stale async boot never wins over a later one.
  useEffect(() => {
    async function init() {
      const statusData = await refreshAuthStatus();
      if (statusData?.authenticated) await bootAuthenticatedWorkspace();
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
      nextEnforceWhitelist?: boolean,
      explicitSource?: "account" | "independent" | "session",
      options: { background?: boolean } = {}
    ): Promise<VaultPlaintext> => {
      const targetMode = explicitMode ?? vaultMode;
      const source = targetMode === "passphrase" ? explicitSource ?? vaultKeySource : "independent";
      const passToUse =
        targetMode === "passphrase"
          ? passphraseOverride ?? activePassphrase ?? sessionVaultKeyRef.current
          : null;
      if (targetMode === "passphrase" && !passToUse) throw new Error("Vault encryption key is unavailable. Reload and try again.");
      if (accountVaultOutdated && explicitSource !== "account" && explicitSource !== "session") {
        throw new Error("Update the vault to the current account password before making changes.");
      }

      const executeSave = async (): Promise<VaultPlaintext> => {
        workspaceSyncDirtyRef.current = false;
        vaultMutationVersionRef.current++;
        try {
          if (!options.background && source === "account" && passToUse) {
            await verifyAccountPassword(gatewaySettings, passToUse);
          }

          let desiredPlain: VaultPlaintext = {
            version: 1,
            hosts: nextHosts,
            snippets: nextSnippets,
            sshKeys: nextSshKeys ?? sshKeysRef.current,
            enforceKeyWhitelist: nextEnforceWhitelist ?? enforceKeyWhitelistRef.current,
            workspace: buildCurrentWorkspaceState(undefined, undefined, nextHosts),
          };

          let baseRevision = syncRevisionRef.current;
          let baseLocalEnvelope = pendingEnvelopeRef.current;
          let envelope = await encryptVaultData(desiredPlain, passToUse);
          envelope.keySource = source;

          if (localCaps?.serverVault) {
            let revision: string | null;
            revision = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                revision = await saveRemoteVault(gatewaySettings, envelope, baseRevision);
                break;
              } catch (saveErr) {
                const msg = saveErr instanceof Error ? saveErr.message : "";
                if (attempt < 2 && /changed on another device/i.test(msg)) {
                  const latestRemote = await fetchRemoteVault(gatewaySettings);
                  if (latestRemote.vaultKey) {
                    sessionVaultKeyRef.current = latestRemote.vaultKey;
                  }
                  if (latestRemote.envelope && latestRemote.revision) {
                    const decryptPass =
                      latestRemote.envelope.mode === "passphrase"
                        ? latestRemote.vaultKey ?? activePassphrase ?? passToUse
                        : null;
                    const remotePlain = await decryptVaultEnvelope(
                      latestRemote.envelope,
                      decryptPass
                    );
                    desiredPlain = mergeVaultPlaintexts(
                      lastSyncedPlainRef.current,
                      desiredPlain,
                      remotePlain
                    );
                    baseRevision = latestRemote.revision;
                    baseLocalEnvelope = latestRemote.envelope;
                    envelope = await encryptVaultData(desiredPlain, passToUse);
                    envelope.keySource = source;
                    continue;
                  }
                }
                throw saveErr;
              }
            }
            if (!revision) {
              throw new Error("Could not save the encrypted vault.");
            }
            syncRevisionRef.current = revision;
            const cachedClean = await cacheSyncedVaultIfUnchanged(
              baseLocalEnvelope,
              envelope,
              revision
            );
            const cachedMerged = cachedClean || cacheSyncedVault(envelope, revision);
            if (!cachedMerged) {
              if (!options.background) {
                setVaultSyncError(
                  "Vault saved to shared storage, but this browser's local copy could not be cached."
                );
              }
            } else {
              bootLocalEnvelopeRef.current = envelope;
              setVaultSyncError(null);
            }
          } else {
            await saveLocalVaultIfUnchanged(baseLocalEnvelope, envelope);
            bootLocalEnvelopeRef.current = envelope;
            setVaultSyncError(null);
          }

          updatePendingEnvelope(envelope);
          applyPlainVault(desiredPlain);
          return desiredPlain;
        } catch (error) {
          let message = error instanceof Error ? error.message : "Could not save the encrypted vault.";
          if (source === "account" && !explicitSource && /account password is incorrect/i.test(message)) {
            setAccountVaultOutdated(true);
            message = "The account password has changed. Update the vault to the current account password before saving.";
          }
          if (!options.background) {
            setVaultSyncError(message);
          }
          throw new Error(message);
        } finally {
          vaultMutationVersionRef.current++;
        }
      };

      const queued = vaultWriteChainRef.current.then(executeSave, executeSave);
      vaultWriteChainRef.current = queued.then(() => undefined, () => undefined);
      return queued;
    },
    [
      accountVaultOutdated,
      activePassphrase,
      applyPlainVault,
      buildCurrentWorkspaceState,
      gatewaySettings,
      localCaps?.serverVault,
      updatePendingEnvelope,
      vaultKeySource,
      vaultMode,
    ]
  );

  const flushWorkspaceSync = useCallback(() => {
    if (workspaceSyncTimerRef.current) {
      clearTimeout(workspaceSyncTimerRef.current);
      workspaceSyncTimerRef.current = null;
    }
    if (!workspaceSyncDirtyRef.current) return;
    if (!vaultReadyRef.current || accountVaultOutdated) return;
    if (vaultMode === "passphrase" && !activePassphrase && !sessionVaultKeyRef.current) return;
    // Never create an initial empty shared vault before the user has saved or
    // migrated their vault on a brand-new account.
    if (
      localCaps?.serverVault &&
      syncRevisionRef.current === null &&
      pendingEnvelopeRef.current === null
    ) {
      return;
    }
    workspaceSyncDirtyRef.current = false;
    void persistVault(
      hostsRef.current,
      snippetsRef.current,
      undefined,
      undefined,
      sshKeysRef.current,
      enforceKeyWhitelistRef.current,
      undefined,
      { background: true }
    ).catch(() => {
      // Transient network errors during background tab/run sync retry on next change/focus.
    });
  }, [accountVaultOutdated, activePassphrase, localCaps?.serverVault, persistVault, vaultMode]);

  const scheduleWorkspaceSync = useCallback(() => {
    workspaceSyncDirtyRef.current = true;
    if (workspaceSyncTimerRef.current) {
      clearTimeout(workspaceSyncTimerRef.current);
    }
    workspaceSyncTimerRef.current = setTimeout(() => {
      workspaceSyncTimerRef.current = null;
      flushWorkspaceSync();
    }, 600);
  }, [flushWorkspaceSync]);

  useEffect(() => {
    scheduleWorkspaceSyncRef.current = scheduleWorkspaceSync;
  }, [scheduleWorkspaceSync]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        flushWorkspaceSync();
      }
    };
    const onPageHide = () => flushWorkspaceSync();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flushWorkspaceSync]);

  const refreshSharedVault = useCallback(async function refreshSharedVault() {
    if (!localCaps?.serverVault || !syncEligibleRef.current) return;
    if (syncRefreshInFlightRef.current) { syncRefreshRequestedRef.current = true; return; }
    syncRefreshInFlightRef.current = true;
    const version = vaultMutationVersionRef.current;
    const baseRevision = syncRevisionRef.current;
    try {
      const localBase = loadLocalEnvelope();
      const remote = await fetchRemoteVault(gatewaySettings);
      if (remote.vaultKey) sessionVaultKeyRef.current = remote.vaultKey;
      if (!syncEligibleRef.current || version !== vaultMutationVersionRef.current || baseRevision !== syncRevisionRef.current) return;
      if (!remote.envelope || !remote.revision) {
        // A brand-new account has no shared snapshot until its first save.
        if (baseRevision === null) return;
        throw new Error("The shared vault is missing. No local data was changed; check your storage before saving.");
      }
      if (remote.revision === baseRevision) return;
      const pass =
        remote.envelope.mode === "passphrase"
          ? remote.vaultKey ?? activePassphrase ?? sessionVaultKeyRef.current
          : null;
      let plain: VaultPlaintext;
      try {
        plain = await decryptVaultEnvelope(remote.envelope, pass);
      } catch {
        throw new Error("The shared vault changed and needs a different key. Reload the latest vault; local data was not replaced.");
      }
      if (!syncEligibleRef.current || version !== vaultMutationVersionRef.current || baseRevision !== syncRevisionRef.current) return;
      const cached =
        (await cacheSyncedVaultIfUnchanged(localBase, remote.envelope, remote.revision)) ||
        cacheSyncedVault(remote.envelope, remote.revision);
      if (!syncEligibleRef.current || version !== vaultMutationVersionRef.current || baseRevision !== syncRevisionRef.current) return;
      setAccountVaultOutdated(false);
      setVaultSyncError(cached ? null : "The shared vault updated, but this browser's local copy changed or could not be cached.");
      syncRevisionRef.current = remote.revision;
      if (cached) bootLocalEnvelopeRef.current = remote.envelope;
      updatePendingEnvelope(remote.envelope);
      setVaultMode(remote.envelope.mode);
      setVaultKeySource(
        remote.envelope.keySource === "session"
          ? "session"
          : remote.envelope.keySource === "account"
            ? "account"
            : "independent"
      );
      setActivePassphrase(pass);
      applyPlainVault(plain);
    } catch (error) {
      if (syncEligibleRef.current && version === vaultMutationVersionRef.current) {
        setVaultSyncError(error instanceof Error ? error.message : "Could not refresh the shared vault.");
      }
    } finally {
      syncRefreshInFlightRef.current = false;
      if (syncRefreshRequestedRef.current) {
        syncRefreshRequestedRef.current = false;
        if (syncEligibleRef.current) window.setTimeout(() => void refreshSharedVault(), 0);
      }
    }
  }, [activePassphrase, applyPlainVault, gatewaySettings, localCaps?.serverVault, updatePendingEnvelope]);

  const refreshLocalVault = useCallback(async function refreshLocalVault() {
    if (!localCaps || localCaps.serverVault || !syncEligibleRef.current) return;
    if (syncRefreshInFlightRef.current) { syncRefreshRequestedRef.current = true; return; }
    syncRefreshInFlightRef.current = true;
    const version = vaultMutationVersionRef.current;
    const knownEnvelope = pendingEnvelopeRef.current;
    try {
      const local = loadLocalEnvelope();
      if (sameOptionalVaultEnvelope(local, knownEnvelope)) return;
      if (!local) throw new Error("The browser vault is missing. This tab's saved connections were not changed.");
      const pass = local.mode === "passphrase" ? activePassphrase : null;
      let plain: VaultPlaintext;
      try {
        plain = await decryptVaultEnvelope(local, pass);
      } catch {
        throw new Error("The vault changed in another tab and needs a different password or device key. Reload the latest vault to unlock it; this tab's data was not replaced.");
      }
      if (!syncEligibleRef.current || version !== vaultMutationVersionRef.current || !sameOptionalVaultEnvelope(pendingEnvelopeRef.current, knownEnvelope)) return;
      if (!sameOptionalVaultEnvelope(loadLocalEnvelope(), local)) {
        syncRefreshRequestedRef.current = true;
        return;
      }
      if (
        local.keySource === "account" &&
        pass &&
        accountPasswordRef.current !== null &&
        accountPasswordRef.current !== pass
      ) {
        setAccountVaultOutdated(true);
        setVaultSyncError("The updated vault needs your current account password before it can be edited.");
      } else {
        setAccountVaultOutdated(false);
        setVaultSyncError(null);
      }
      bootLocalEnvelopeRef.current = local;
      updatePendingEnvelope(local);
      setVaultMode(local.mode);
      setVaultKeySource(
        local.keySource === "session"
          ? "session"
          : local.keySource === "account"
            ? "account"
            : "independent"
      );
      setActivePassphrase(pass);
      applyPlainVault(plain);
    } catch (error) {
      if (syncEligibleRef.current && version === vaultMutationVersionRef.current) {
        setVaultSyncError(error instanceof Error ? error.message : "Could not refresh the browser vault.");
      }
    } finally {
      syncRefreshInFlightRef.current = false;
      if (syncRefreshRequestedRef.current) {
        syncRefreshRequestedRef.current = false;
        if (syncEligibleRef.current) window.setTimeout(() => void refreshLocalVault(), 0);
      }
    }
  }, [activePassphrase, applyPlainVault, localCaps, updatePendingEnvelope]);

  const refreshVault = useCallback(() => {
    return localCaps?.serverVault ? refreshSharedVault() : refreshLocalVault();
  }, [localCaps?.serverVault, refreshLocalVault, refreshSharedVault]);

  useEffect(() => {
    if (!localCaps || !syncEligibleRef.current) return;
    // Catch changes that arrived while an editor was open, and poll every 5s
    // (plus immediate focus/visibility/storage events) so cross-device updates appear fast.
    void refreshVault();
    return subscribeVaultChanges(() => void refreshVault(), 5_000);
  }, [localCaps, vaultReady, hostModalOpen, vaultModalOpen, accountModalOpen, gatewayModalOpen, refreshVault]);

  const selectActiveTab = useCallback(
    (nextTabId: string) => {
      setActiveTabId(nextTabId);
      persistTabsLocally(tabsRef.current, nextTabId, true);
      scheduleWorkspaceSync();
    },
    [persistTabsLocally, scheduleWorkspaceSync]
  );

  const openSessionTab = useCallback(
    (
      profile: HostProfile,
      overrideProtocol?: ProtocolType,
      overrideInitialPath?: string,
      overrideTitle?: string,
      /**
       * A run to take over in the new tab: its command line is replayed and, when the
       * command is still alive on the host, the session attaches to that run instead
       * of starting a new one ("go back to my command").
       */
      resumeRun?: ResumableRun
    ) => {
      setMobileSidebarOpen(false);
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

      const now = Date.now();
      const tabId = `tab-${randomUUID()}`;
      const newTab: SessionTab = {
        id: tabId,
        title: overrideTitle?.trim() || `${profile.name}`,
        protocol: proto,
        profile: resolved.profile,
        initialPath: overrideInitialPath ?? profile.initialPath,
        createdAt: now,
      };
      tabUpdatedAtMapRef.current[tabId] = now;
      if (resumeRun) {
        tabRunIdsRef.current[tabId] = resumeRun.id;
        setTabResumes((prev) => ({ ...prev, [tabId]: resumeRun }));
      }
      const nextTabs = [...tabsRef.current, newTab];
      setTabs(nextTabs);
      setActiveTabId(tabId);
      persistTabsLocally(nextTabs, tabId, true);
      scheduleWorkspaceSync();
    },
    [enforceKeyWhitelist, persistTabsLocally, scheduleWorkspaceSync, sshKeys]
  );

  // ---------------------------------------------------------------------------
  // Session history: recently connected hosts, and runs that outlived their tab
  // ---------------------------------------------------------------------------

  /** Reads history + runs from localStorage (call after mount and after changes). */
  const refreshSessionHistory = useCallback(() => {
    setRecentHosts(loadRecentHosts());
    setResumableRuns(loadResumableRuns());
  }, []);

  useEffect(() => {
    refreshSessionHistory();
  }, [refreshSessionHistory]);

  /**
   * A session really connected: remember the host for the "Recently connected" list
   * and, if a command from this browser is still running there, offer to go back.
   */
  const handleSessionConnected = useCallback(
    (profile: HostProfile, savedHostId?: string | null) => {
      setRecentHosts(
        recordRecentHost(profile, { isSaved: Boolean(savedHostId ?? hosts.some((h) => h.id === profile.id)) })
      );
      scheduleWorkspaceSync();
      const runs = loadResumableRuns();
      setResumableRuns(runs);
      const activeRunIds = new Set<string>(
        Object.values(tabRunIdsRef.current).filter((v): v is string => Boolean(v))
      );
      const unclaimed = runs.filter((r) => !activeRunIds.has(r.id));
      const prompt = buildResumePrompt(unclaimed);
      if (!prompt) return;
      if (dismissedResumeRef.current.has(prompt.run.id)) return;
      // The tab that is running it right now does not need to be offered it.
      if (resumePrompt && resumePrompt.run.id === prompt.run.id) return;
      setResumePrompt(prompt);
    },
    [hosts, resumePrompt, scheduleWorkspaceSync]
  );

  /** A tab started / finished / updated a command: keep the run in the history. */
  const handleRunUpdated = useCallback((run: ResumableRun | null, tabId: string) => {
    if (!run) {
      // The tab forgot its run (new command, reconnect…): nothing to offer for it.
      delete tabRunIdsRef.current[tabId];
      tabUpdatedAtMapRef.current[tabId] = Date.now();
      setTabResumes((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      persistTabsLocally(tabsRef.current, activeTabIdRef.current);
      scheduleWorkspaceSync();
      return;
    }
    tabRunIdsRef.current[tabId] = run.running ? run.id : null;
    tabUpdatedAtMapRef.current[tabId] = Date.now();
    setResumableRuns(upsertResumableRun(run));
    persistTabsLocally(tabsRef.current, activeTabIdRef.current);
    scheduleWorkspaceSync();
  }, [persistTabsLocally, scheduleWorkspaceSync]);

  /** Closes the card, drops the run from history (its log stays on the host). */
  const dismissResumePrompt = useCallback(() => {
    setResumePrompt((current) => {
      if (current) {
        dismissedResumeRef.current.add(current.run.id);
        setResumableRuns(removeResumableRun(current.run.id));
        scheduleWorkspaceSync();
      }
      return null;
    });
  }, [scheduleWorkspaceSync]);

  /** "Go back": reopen or focus that host in a tab that attaches to the running command. */
  const resumeRunInTab = useCallback(
    (run: ResumableRun) => {
      dismissedResumeRef.current.add(run.id);
      setResumePrompt(null);
      const runKey = hostHistoryKey(run.profile);
      const existingTab = tabsRef.current.find(
        (t) =>
          t.protocol === "ssh" &&
          hostHistoryKey(t.profile) === runKey &&
          (!tabRunIdsRef.current[t.id] || tabRunIdsRef.current[t.id] === run.id)
      );
      if (existingTab) {
        tabRunIdsRef.current[existingTab.id] = run.id;
        tabUpdatedAtMapRef.current[existingTab.id] = Date.now();
        setTabResumes((prev) => ({ ...prev, [existingTab.id]: run }));
        selectActiveTab(existingTab.id);
        return;
      }
      // Prefer the saved vault entry (fresh credentials) over the stored snapshot.
      const saved = hosts.find(
        (h) =>
          h.protocol === run.profile.protocol &&
          h.host === run.profile.host &&
          Number(h.port) === Number(run.profile.port) &&
          h.username === run.profile.username
      );
      openSessionTab(saved ?? run.profile, "ssh", undefined, undefined, run);
    },
    [hosts, openSessionTab, selectActiveTab]
  );

  /** "Just open the host" from the resume card: a normal session, no resume. */
  const openRunHostFresh = useCallback(
    (run: ResumableRun) => {
      dismissedResumeRef.current.add(run.id);
      setResumePrompt(null);
      const saved = hosts.find(
        (h) =>
          h.protocol === run.profile.protocol &&
          h.host === run.profile.host &&
          Number(h.port) === Number(run.profile.port) &&
          h.username === run.profile.username
      );
      openSessionTab(saved ?? run.profile);
    },
    [hosts, openSessionTab]
  );

  /** Opens a host from the "Recently connected" list (saved entry when there is one). */
  const openRecentHost = useCallback(
    (entry: RecentHostEntry) => {
      const saved =
        hosts.find((h) => h.id === entry.profileId) ??
        hosts.find(
          (h) =>
            h.protocol === entry.protocol &&
            h.host.toLowerCase() === entry.host.toLowerCase() &&
            Number(h.port) === Number(entry.port) &&
            h.username === entry.username
        );
      openSessionTab(saved ?? entry.profile);
    },
    [hosts, openSessionTab]
  );

  /** Forget one host in the recent list (does not touch saved vault hosts). */
  const forgetRecentHost = useCallback((key: string) => {
    setRecentHosts(removeRecentHost(key));
    scheduleWorkspaceSync();
  }, [scheduleWorkspaceSync]);

  /**
   * Opens the same machine as a desktop: one click from a host row, a host card,
   * a terminal or the file manager. A saved RDP host just opens normally; an
   * SSH/SFTP host gets a derived profile on port 3389 (see lib/client/rdp-companion)
   * so nothing is duplicated in the Vault until the user saves it.
   */
  const openRdpCompanion = useCallback(
    (source: HostProfile) => {
      setMobileSidebarOpen(false);
      if (source.protocol === "rdp") {
        openSessionTab(source);
        return;
      }
      const companion = buildRdpCompanionProfile(source);
      // One desktop per host: re-clicking the button focuses the open tab
      // instead of stacking duplicates.
      const existing = tabs.find(
        (t) =>
          t.protocol === "rdp" &&
          t.profile.host === companion.host &&
          Number(t.profile.port) === Number(companion.port) &&
          t.profile.username === companion.username
      );
      if (existing) {
        selectActiveTab(existing.id);
        return;
      }
      openSessionTab(
        companion,
        "rdp",
        undefined,
        rdpCompanionTitle(source)
      );
    },
    [openSessionTab, tabs]
  );

  useEffect(() => {
    openRdpCompanionRef.current = openRdpCompanion;
  }, [openRdpCompanion]);

  /**
   * "Credentials" in an RDP session: edit the saved RDP host when there is one,
   * otherwise open a prefilled draft (no id → saving creates its own RDP host,
   * the SSH entry is left untouched).
   */
  const editRdpConnection = useCallback(
    (tab: SessionTab) => {
      const saved = hosts.find(
        (h) => h.id === tab.profile.id && h.protocol === "rdp"
      );
      setEditingProfile(saved ?? buildRdpCompanionDraft(tab.profile));
      setHostModalIntent(saved ? null : "rdp");
      setHostModalOpen(true);
    },
    [hosts]
  );

  const closeSessionTab = (tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    // Closing the tab does not stop the command: its run stays in the history so the
    // "go back?" prompt (or the launchpad list) can reopen it on any device.
    const now = Date.now();
    localClosedTabIdsRef.current.add(tabId);
    delete tabRunIdsRef.current[tabId];
    delete tabUpdatedAtMapRef.current[tabId];
    recordClosedTab(tabId, now);
    setTabResumes((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    const prev = tabsRef.current;
    const idx = prev.findIndex((t) => t.id === tabId);
    const next = prev.filter((t) => t.id !== tabId);
    let nextActive = activeTabIdRef.current;
    if (activeTabIdRef.current === tabId) {
      nextActive = next.length === 0 ? "launchpad" : next[Math.max(0, idx - 1)].id;
      setActiveTabId(nextActive);
    }
    setTabs(next);
    persistTabsLocally(next, nextActive, activeTabIdRef.current === tabId);
    scheduleWorkspaceSync();
  };

  const handleSaveHostProfile = async (
    profile: HostProfile,
    connectAfterSave?: boolean
  ) => {
    // Saving keeps the whole machine consistent: if the address or account changed,
    // the SSH / SFTP / RDP profiles of that machine move with it (see
    // lib/client/host-consistency). Otherwise one edit would split a machine in two.
    const change = applyIdentityChange(hosts, profile);
    if (change.conflict) {
      const merge = window.confirm(
        `${change.conflict.name || change.conflict.host} already uses ${profile.username}@${profile.host}. ` +
          `Saving this as well gives that machine two ${profile.protocol.toUpperCase()} profiles. Continue?`
      );
      if (!merge) return;
    }
    const nextHosts = change.conflict ? applyIdentityChange(hosts, profile, { moveSiblings: true }).hosts : change.hosts;
    const saved = await persistVault(nextHosts, snippets);
    setHosts(saved.hosts);

    // Keep any already-open tabs for this host (including unsaved `rdp-companion-*`
    // desktop tabs upgraded via "Edit desktop credentials") synchronized in-place so
    // live sessions reconnect immediately with the updated account/port/password.
    const savedById = new Map(saved.hosts.map((h) => [h.id, h]));
    const normalizedSavedHost = profile.host.trim().toLowerCase();
    let matchedActiveRdpTabId: string | null = null;
    let anyTabUpdated = false;
    const syncedTabs = tabsRef.current.map((tab) => {
      const direct = savedById.get(tab.profile.id);
      if (direct && direct.protocol === tab.protocol) {
        const resolved = resolveProfileWithKeychain(direct, sshKeys, enforceKeyWhitelist);
        const nextProfile = resolved.ok ? resolved.profile : direct;
        if (JSON.stringify(nextProfile) !== JSON.stringify(tab.profile)) {
          anyTabUpdated = true;
          tabUpdatedAtMapRef.current[tab.id] = Date.now();
          if (tab.protocol === "rdp" && profile.id === direct.id) {
            matchedActiveRdpTabId = tab.id;
          }
          return {
            ...tab,
            title: nextProfile.name || tab.title,
            profile: nextProfile,
          };
        }
        if (tab.protocol === "rdp" && profile.id === direct.id) {
          matchedActiveRdpTabId = tab.id;
        }
        return tab;
      }

      if (
        profile.protocol === "rdp" &&
        tab.protocol === "rdp" &&
        tab.profile.id.startsWith("rdp-companion-") &&
        tab.profile.host.trim().toLowerCase() === normalizedSavedHost
      ) {
        const savedRdp = savedById.get(profile.id) ?? profile;
        anyTabUpdated = true;
        matchedActiveRdpTabId = tab.id;
        tabUpdatedAtMapRef.current[tab.id] = Date.now();
        return {
          ...tab,
          title: savedRdp.name || tab.title,
          profile: savedRdp,
        };
      }
      return tab;
    });

    if (anyTabUpdated) {
      setTabs(syncedTabs);
      persistTabsLocally(syncedTabs, activeTabIdRef.current, false);
      scheduleWorkspaceSync();
    }

    setHostModalOpen(false);
    setEditingProfile(null);
    setHostModalIntent(null);
    if (connectAfterSave) {
      if (matchedActiveRdpTabId) {
        selectActiveTab(matchedActiveRdpTabId);
      } else {
        openSessionTab(profile);
      }
    }
  };

  /** Opens the editor for the profile behind a merged host row. */
  const handleEditHost = useCallback((entry: UnifiedHost) => {
    setEditingProfile(entry.primary);
    setHostModalIntent(null);
    setHostModalOpen(true);
    setMobileSidebarOpen(false);
  }, []);

  /**
   * Deletes a connection from the Edit Host dialog. `wholeMachine` removes every
   * protocol profile of that machine; `false` removes only the edited profile.
   */
  const handleDeleteHost = async (
    id: string,
    options: { wholeMachine?: boolean } = {}
  ) => {
    const target = hosts.find((host) => host.id === id);
    if (!target) return;
    const nextHosts = options.wholeMachine
      ? removeMachine(hosts, target).hosts
      : hosts.filter((h) => h.id !== id);
    const saved = await persistVault(nextHosts, snippets);
    setHosts(saved.hosts);
    setHostModalOpen(false);
    setEditingProfile(null);
    setHostModalIntent(null);
  };

  const savedEditingHost = useMemo(
    () =>
      editingProfile?.id
        ? hosts.find((h) => h.id === editingProfile.id) ?? null
        : null,
    [editingProfile?.id, hosts]
  );

  const editingHostSiblingProtocols = useMemo(() => {
    if (!savedEditingHost) return null;
    const siblings = siblingsOf(hosts, savedEditingHost);
    return siblings.length > 0 ? describeProtocols(siblings) : null;
  }, [hosts, savedEditingHost]);

  const handleQuickConnectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseQuickConnectInput(quickConnectInput);
    if (!parsed) {
      setEditingProfile({ protocol: "ssh" });
      setHostModalIntent(null);
      setHostModalOpen(true);
      return;
    }
    setHostModalIntent(null);
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

  const resolveSshProfileForHost = useCallback(
    (source: HostProfile): HostProfile | null => {
      const saved =
        hosts.find(
          (h) =>
            (h.protocol === "ssh" || h.protocol === "sftp") &&
            h.host.toLowerCase() === source.host.toLowerCase() &&
            Number(h.port) === Number(source.port) &&
            h.username === source.username
        ) ??
        hosts.find(
          (h) =>
            (h.protocol === "ssh" || h.protocol === "sftp") &&
            h.host.toLowerCase() === source.host.toLowerCase() &&
            h.username === source.username
        ) ??
        source;
      const resolved = resolveProfileWithKeychain(
        { ...saved, protocol: "ssh", port: Number(saved.port) || 22 },
        sshKeys,
        enforceKeyWhitelist
      );
      return resolved.ok ? resolved.profile : null;
    },
    [enforceKeyWhitelist, hosts, sshKeys]
  );

  const clearHostResumableRuns = useCallback(
    (target: Pick<HostProfile, "host" | "port" | "username">) => {
      const current = loadResumableRuns();
      let next = current;
      for (const run of current) {
        if (
          run.profile.host.toLowerCase() === target.host.toLowerCase() &&
          Number(run.profile.port || 22) === Number(target.port || 22) &&
          run.profile.username === target.username
        ) {
          dismissedResumeRef.current.add(run.id);
          next = removeResumableRun(run.id);
        }
      }
      setResumableRuns(next);
      setResumePrompt((prev) => {
        if (
          prev &&
          prev.run.profile.host.toLowerCase() === target.host.toLowerCase() &&
          Number(prev.run.profile.port || 22) === Number(target.port || 22) &&
          prev.run.profile.username === target.username
        ) {
          return null;
        }
        return prev;
      });
      scheduleWorkspaceSync();
    },
    [scheduleWorkspaceSync]
  );

  const stopBackgroundForRunHost = useCallback(
    async (run: ResumableRun) => {
      if (stoppingAllBg) return;
      const resolved = resolveSshProfileForHost(run.profile);
      if (!resolved) {
        setBgStopNotice({
          tone: "error",
          text: `Could not resolve SSH credentials for ${run.profile.username}@${run.profile.host}.`,
        });
        return;
      }
      setStoppingAllBg(true);
      setBgStopNotice(null);
      try {
        const res = await stopHostBackgroundProcesses(resolved, gatewaySettings);
        if (!res.ok) {
          throw new Error(
            res.error || `Failed to stop background SSH processes on ${resolved.host}.`
          );
        }
        clearHostResumableRuns(resolved);
        setBgStopNotice({
          tone: "success",
          text:
            res.stoppedCount > 0
              ? `Stopped ${res.stoppedCount} background process${res.stoppedCount === 1 ? "" : "es"} on ${resolved.username}@${resolved.host}.`
              : `No active background SSH processes found on ${resolved.username}@${resolved.host}.`,
        });
      } catch (err) {
        setBgStopNotice({
          tone: "error",
          text:
            err instanceof Error
              ? err.message
              : `Failed to stop background SSH processes on ${resolved.host}.`,
        });
      } finally {
        setStoppingAllBg(false);
      }
    },
    [clearHostResumableRuns, gatewaySettings, resolveSshProfileForHost, stoppingAllBg]
  );

  const handleStopAllBackgroundSsh = useCallback(async () => {
    if (stoppingAllBg) return;
    const candidateMap = new Map<string, HostProfile>();
    const pushCandidate = (p: HostProfile) => {
      if (p.protocol !== "ssh" && p.protocol !== "sftp") return;
      const resolved = resolveSshProfileForHost(p);
      if (!resolved) return;
      const key = `${resolved.username}@${resolved.host.toLowerCase()}:${resolved.port || 22}`;
      if (!candidateMap.has(key)) {
        candidateMap.set(key, resolved);
      }
    };

    for (const run of resumableRunCandidates(resumableRuns)) {
      pushCandidate(run.profile);
    }
    for (const tab of tabsRef.current) {
      if (tab.protocol === "ssh") pushCandidate(tab.profile);
    }
    if (candidateMap.size === 0) {
      for (const h of hosts) {
        if (h.protocol === "ssh" || h.protocol === "sftp") pushCandidate(h);
      }
    }

    const targets = Array.from(candidateMap.values());
    if (targets.length === 0) {
      setBgStopNotice({
        tone: "error",
        text: "No SSH hosts with credentials are configured yet.",
      });
      return;
    }

    setStoppingAllBg(true);
    setBgStopNotice(null);
    let totalSignaled = 0;
    let succeededHosts = 0;
    const errors: string[] = [];

    await Promise.all(
      targets.map(async (target) => {
        try {
          const res = await stopHostBackgroundProcesses(target, gatewaySettings);
          if (!res.ok) {
            throw new Error(res.error || "Failed");
          }
          totalSignaled += res.stoppedCount;
          succeededHosts += 1;
          clearHostResumableRuns(target);
        } catch (err) {
          errors.push(
            `${target.username}@${target.host}: ${
              err instanceof Error ? err.message : "Failed"
            }`
          );
        }
      })
    );

    setStoppingAllBg(false);
    if (errors.length > 0 && succeededHosts === 0) {
      setBgStopNotice({
        tone: "error",
        text: `Failed to stop background SSH processes (${errors[0]}).`,
      });
    } else if (errors.length > 0) {
      setBgStopNotice({
        tone: "error",
        text: `Stopped ${totalSignaled} process${totalSignaled === 1 ? "" : "es"} across ${succeededHosts}/${targets.length} host(s); failed on ${errors[0]}.`,
      });
    } else {
      setBgStopNotice({
        tone: "success",
        text:
          totalSignaled > 0
            ? `Stopped ${totalSignaled} background SSH process${totalSignaled === 1 ? "" : "es"} across ${succeededHosts} host${succeededHosts === 1 ? "" : "s"}.`
            : `Checked ${succeededHosts} SSH host${succeededHosts === 1 ? "" : "s"} — no running background SSH processes found.`,
      });
    }
  }, [
    clearHostResumableRuns,
    gatewaySettings,
    hosts,
     resolveSshProfileForHost,
    resumableRuns,
    stoppingAllBg,
  ]);

  const effectiveWsSsh = Boolean(
    remoteCaps ? remoteCaps.websocketSsh : localCaps?.websocketSsh
  );
  const effectiveRdpGuacd = Boolean(
    remoteCaps ? remoteCaps.rdpGuacd : localCaps?.rdpGuacd
  );
  const effectiveRdpCleanPath = Boolean(
    remoteCaps
      ? remoteCaps.rdpCleanPath
      : localCaps
        ? (localCaps.rdpCleanPath ?? true)
        : true
  );

  // ---------------------------------------------------------------------------
  // Deep links: /?host=<host-id>&protocol=ssh|sftp|rdp opens that machine.
  //
  // This is the "one URL per machine" half of the unified host list: /hosts (and
  // /api/hosts) hand out these links, so a bookmark, a chat message or a script can
  // point at one server and have Sushi open the right session once the vault is
  // unlocked. The URL carries no credentials — the vault does.
  // ---------------------------------------------------------------------------
  const deepLinkHandledRef = useRef(false);

  const applyDeepLink = useCallback(
    (entries: UnifiedHost[]) => {
      if (typeof window === "undefined") return;
      const link = parseHostDeepLink(window.location.search);
      if (!link) return;
      const entry = resolveHostDeepLink(entries, link.hostId);
      if (!entry) {
        setWhitelistBannerError(
          `This link points at “${link.hostId}”, which is not in this vault. It may belong to another device, or the host was deleted.`
        );
        return;
      }
      // Consume the link so a reload/re-render does not open the host again.
      window.history.replaceState(null, "", window.location.pathname);
      deepLinkHandledRef.current = true;
      openUnifiedHostRef.current(entry, link.protocol ?? undefined);
    },
    []
  );

  /** `openUnifiedHost` is declared below the vault boot code; call the latest one. */
  const openUnifiedHostRef = useRef<(entry: UnifiedHost, protocol?: ProtocolType) => void>(() => {});
  /** Latest merged hosts, for the deep-link effect (declared below). */
  const unifiedHostsRef = useRef<UnifiedHost[]>([]);

  /**
   * Runs once the vault is ready (that is when host names exist): a deep link is
   * applied, otherwise the URL is left alone.
   */
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (!vaultReady) return;
    if (!hosts.length) return;
    applyDeepLink(unifiedHostsRef.current);
  }, [applyDeepLink, hosts.length, unifiedHostsRef, vaultReady]);

  /** `openRdpCompanion` is declared below; the merged-host action calls it lazily. */
  const openRdpCompanionRef = useRef<(profile: HostProfile) => void>(() => {});

  /**
   * Saved profiles merged into one entry per machine + account, so a server saved as
   * SSH *and* SFTP *and* RDP is one row with three ways in (`lib/client/unified-hosts`).
   * The vault itself is untouched: edit/delete still act on the real profiles.
   */
  const unifiedHosts = useMemo(() => mergeHosts(hosts), [hosts]);
  unifiedHostsRef.current = unifiedHosts;

  /**
   * One click on a merged host opens the protocol you picked (or the best one): an
   * explicit profile when the vault has it, otherwise the derived RDP companion.
   */
  const openUnifiedHost = useCallback(
    (entry: UnifiedHost, protocol?: ProtocolType) => {
      setMobileSidebarOpen(false);
      const wanted: ProtocolType = protocol ?? (entry.protocols.ssh ? "ssh" : entry.available[0] ?? "ssh");
      const saved = entry.protocols[wanted];
      if (saved) {
        openSessionTab(saved);
        return;
      }
      if (wanted === "sftp" && entry.protocols.ssh) {
        openSessionTab(entry.protocols.ssh, "sftp");
        return;
      }
      if (wanted === "ssh" && entry.protocols.sftp) {
        openSessionTab(entry.protocols.sftp, "ssh");
        return;
      }
      if (wanted === "rdp") {
        openRdpCompanionRef.current(entry.primary);
        return;
      }
      openSessionTab(entry.primary);
    },
    [openSessionTab]
  );
  useEffect(() => {
    openUnifiedHostRef.current = openUnifiedHost;
  }, [openUnifiedHost]);

  // Authentication & Passkey Gate
  if (authChecking) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#090b10]">
        <Loader2 className="h-6 w-6 animate-spin text-[#ff6b57]" />
      </div>
    );
  }

  if (!authStatus) {
    return (
      <div role="alert" className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-rose-500/30 bg-[#0f131b] p-6 text-sm text-slate-200">
          <h1 className="font-semibold text-white">Account status unavailable</h1>
          <p>{authError || "Could not check the account. Setup is disabled until storage is available."}</p>
          <button type="button" onClick={async () => {
            setAuthChecking(true);
            const status = await refreshAuthStatus();
            if (status?.authenticated) await bootAuthenticatedWorkspace();
          }} className="rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white">Retry</button>
        </div>
      </div>
    );
  }

  if (!authStatus.authenticated) {
    return (
      <AuthGateScreen
        authStatus={authStatus}
        initialNotice={authMigrationNotice}
        onAuthenticated={async (loggedInUser, accountPassword) => {
          setAuthUsername(loggedInUser);
          accountPasswordRef.current = accountPassword || null;
          setAuthMigrationNotice(null);
          const status = await refreshAuthStatus();
          if (status?.authenticated) await bootAuthenticatedWorkspace(accountPassword);
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

  if (vaultBootError) {
    return (
      <div role="alert" className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-rose-500/30 bg-[#0f131b] p-6 text-sm text-slate-200">
          <h1 className="font-semibold text-white">Vault unavailable</h1>
          <p>{vaultBootError}</p>
          {vaultRecoveryEnvelope && (
            <div className="space-y-2 text-xs text-slate-400">
              <p>Keep this browser's data. You can also download its encrypted copy for recovery{vaultRecoveryEnvelope.mode === "device" ? "; a device-key copy only opens in this original browser" : ""}.</p>
              <button type="button" onClick={() => downloadEncryptedVault(vaultRecoveryEnvelope, "sushi-local-vault-recovery.enc.json")} className="rounded-xl border border-white/15 px-3 py-2 font-semibold text-slate-200">Download local encrypted copy</button>
            </div>
          )}
          <div className="flex gap-3">
            <button type="button" onClick={() => void bootAuthenticatedWorkspace()} className="rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white">Retry</button>
            <button type="button" onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST", headers: getAuthHeaders(gatewaySettings) }).catch(() => {});
              setStoredSessionToken(null); accountPasswordRef.current = null; window.location.reload();
            }} className="text-xs text-slate-400 hover:text-white">Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  if (vaultConflict) {
    return (
      <div role="alert" className="flex h-full w-full items-center justify-center bg-[#090b10] p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-amber-500/30 bg-[#0f131b] p-6 text-sm text-slate-200">
          <h1 className="font-semibold text-white">Different vaults found</h1>
          <p>This browser has a different saved vault from the shared one. Neither has been overwritten. Download the local encrypted copy before opening the shared vault.</p>
          {vaultConflict.mode === "device" && <p className="text-xs text-amber-200">This older device-key backup can only be restored in this original browser; keep its browser data and device key.</p>}
          <button type="button" onClick={() => {
            downloadEncryptedVault(vaultConflict, "sushi-local-vault-conflict.enc.json");
            setConflictBackupDownloaded(true);
          }} className="rounded-xl border border-white/15 px-4 py-2 text-xs font-semibold text-white">Download local encrypted backup</button>
          <button type="button" disabled={!conflictBackupDownloaded} onClick={() => {
            if (window.confirm("Have you saved the local encrypted backup? Opening the shared vault replaces the local cached copy.")) {
              void bootAuthenticatedWorkspace(undefined, true);
            }
          }} className="ml-2 rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">Open shared vault</button>
        </div>
      </div>
    );
  }

  // Do not allow imports or edits against an empty in-memory workspace while
  // the existing vault is still loading; saving then could overwrite it.
  if (!vaultReady) {
    return (
      <div role="status" className="flex h-full w-full items-center justify-center gap-2 bg-[#090b10] text-sm text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin text-[#ff6b57]" />
        Loading vault…
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#090b10] text-slate-100">
      {/* Mobile navigation overlays the workspace; the desktop sidebar remains collapsible. */}
      {mobileSidebarOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={closeMobileNavigation}
          className="fixed inset-0 z-40 bg-black/70 md:hidden"
        />
      )}
      <aside
        ref={sidebarRef}
        id="workspace-sidebar"
        role={mobileSidebarOpen ? "dialog" : undefined}
        aria-modal={mobileSidebarOpen || undefined}
        aria-label="Host navigation"
        className={`workspace-sidebar fixed inset-y-0 left-0 z-50 flex w-[min(20rem,calc(100vw-3rem))] shrink-0 flex-col border-r border-white/8 bg-[#0d1118] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] transition-transform duration-200 motion-reduce:transition-none md:relative md:inset-auto md:z-auto md:h-full md:w-68 md:translate-x-0 md:p-0 ${
          mobileSidebarOpen ? "translate-x-0" : "invisible -translate-x-full md:visible"
        } ${sidebarOpen ? "md:flex" : "md:hidden"}`}
      >
          {/* Brand Header */}
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3.5">
            <button
              type="button"
              onClick={() => {
                selectActiveTab("launchpad");
                setMobileSidebarOpen(false);
              }}
              className="flex items-center gap-2.5 text-left"
            >
              <img
                src="/sushi-icon.svg"
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 rounded-xl shadow-md shadow-[#ff6b57]/20"
              />
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
              ref={mobileMenuCloseRef}
              type="button"
              onClick={closeMobileNavigation}
              className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white md:hidden"
              aria-label="Close navigation"
            >
              <PanelLeftClose className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="hidden rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white md:block"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          {/* The mobile drawer leads with the list, so it carries no second search box. */}
          {isPhoneLayout ? (
            <>
              <div className="p-3 pb-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setEditingProfile(null);
                    setHostModalIntent(null);
                    setHostModalOpen(true);
                    setMobileSidebarOpen(false);
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#ff6b57] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e]"
                >
                  <Plus className="h-4 w-4" />
                  New Connection
                </button>
              </div>
              <div className="pb-2">
                <HostNavList
                  variant="page"
                  hosts={unifiedHosts}
                  protocolFilter={protocolFilter}
                  onProtocolFilterChange={setProtocolFilter}
                  search={hostSearch}
                  onSearchChange={setHostSearch}
                  onOpen={(entry, protocol) => openUnifiedHost(entry, protocol)}
                  onEdit={handleEditHost}
                />
              </div>
            </>
          ) : (
            <HostNavList
              hosts={unifiedHosts}
              protocolFilter={protocolFilter}
              onProtocolFilterChange={setProtocolFilter}
              search={hostSearch}
              onSearchChange={setHostSearch}
              searchInputRef={searchInputRef}
              onOpen={(entry, protocol) => openUnifiedHost(entry, protocol)}
              onEdit={handleEditHost}
              onNewHost={() => {
                setEditingProfile(null);
                setHostModalIntent(null);
                setHostModalOpen(true);
                setMobileSidebarOpen(false);
              }}
            />
          )}

          {/* Sidebar Bottom Controls */}
          <div className="space-y-1.5 border-t border-white/8 p-3">
            <button
              type="button"
              onClick={() => {
                setAccountModalOpen(true);
                setMobileSidebarOpen(false);
              }}
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

            <div ref={settingsContainerRef} className="relative" onKeyDown={(event) => {
              if (event.key !== "Escape" || !settingsOpen) return;
              event.preventDefault();
              event.stopPropagation();
              setSettingsOpen(false);
              settingsButtonRef.current?.focus();
            }}>
              {settingsOpen && (
                <div id="workspace-settings" role="dialog" aria-label="Settings" className="absolute bottom-[calc(100%+0.5rem)] left-0 right-0 z-50 max-h-[min(70dvh,32rem)] overflow-y-auto rounded-2xl border border-white/12 bg-[#151b26] p-2 shadow-2xl shadow-black/60">
                  <div className="px-2.5 pb-2 pt-1.5">
                    <div className="text-xs font-semibold text-white">Settings</div>
                    <p className="mt-0.5 text-[11px] text-slate-400">Connections, security &amp; storage</p>
                  </div>
                  <div className="mb-1.5 rounded-xl border border-white/8 bg-[#0d121b] px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-200">
                      <span className="flex items-center gap-1.5">
                        <Cloud className="h-3.5 w-3.5 text-sky-400" />
                        {localCaps?.storageBackend === "turso"
                          ? "Turso (libSQL)"
                          : localCaps?.storageBackend === "redis"
                            ? "Redis REST"
                            : localCaps?.storageBackend === "firestore"
                              ? "Google Cloud Firestore"
                              : "Cloud Vault Sync"}
                      </span>
                      <span className={
                        localCaps?.storageBackend === "turso" ||
                        localCaps?.storageBackend === "redis" ||
                        localCaps?.storageBackend === "firestore"
                          ? "text-emerald-400"
                          : "text-slate-400"
                      }>
                        {localCaps?.storageBackend === "turso" ||
                        localCaps?.storageBackend === "redis" ||
                        localCaps?.storageBackend === "firestore"
                          ? "Configured"
                          : "Not active"}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                      {localCaps?.storageBackend === "turso" ||
                      localCaps?.storageBackend === "redis" ||
                      localCaps?.storageBackend === "firestore"
                        ? localCaps.serverVault
                          ? "Encrypted vault sync is enabled for this deployment."
                          : "Shared storage is configured, but vault sync is disabled."
                        : localCaps?.serverVault
                          ? `Current vault storage: ${localCaps.storageBackend === "disk" ? "server disk" : "shared storage"}. Configure Turso, Firestore, or Redis for cloud sync.`
                          : "Vault sync is disabled. Configure Turso, Firestore, or Redis in your hosting environment."}
                    </p>
                    {localCaps?.storageBackend !== "turso" &&
                      localCaps?.storageBackend !== "redis" &&
                      localCaps?.storageBackend !== "firestore" && (
                        <a href="https://github.com/sarakplaystore/sushi#3-deploy-to-vercel--optional-companion-vps-gateway" target="_blank" rel="noreferrer" className="mt-1 inline-block text-[10px] font-medium text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200">Cloud storage setup guide</a>
                      )}
                  </div>
                  <button ref={settingsFirstActionRef} type="button" onClick={() => {
                    setSettingsOpen(false);
                    settingsButtonRef.current?.focus();
                    void refreshVault();
                  }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-slate-200 hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-[#ff6b57]">
                    <RefreshCw className="h-4 w-4 shrink-0 text-emerald-400" /> Refresh saved connections
                  </button>
                  <button type="button" onClick={() => {
                    setSettingsOpen(false); setVaultModalTab("termix"); setVaultModalOpen(true); setMobileSidebarOpen(false);
                  }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-slate-200 hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-[#ff6b57]">
                    <ArrowLeftRight className="h-4 w-4 shrink-0 text-[#ff6b57]" /> Import / Export
                  </button>
                  <button type="button" onClick={() => {
                    setSettingsOpen(false); setVaultModalTab("keys"); setVaultModalOpen(true); setMobileSidebarOpen(false);
                  }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-slate-200 hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-[#ff6b57]">
                    <KeyRound className="h-4 w-4 shrink-0 text-emerald-400" /> SSH Keys
                  </button>
                  <button type="button" onClick={() => {
                    setSettingsOpen(false); setGatewayModalOpen(true); setMobileSidebarOpen(false);
                  }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-slate-200 hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-[#ff6b57]">
                    <Radio className="h-4 w-4 shrink-0 text-sky-400" /> Gateway
                  </button>
                  <button type="button" onClick={() => {
                    setSettingsOpen(false); setVaultModalFocusBackup(true); setVaultModalTab("security"); setVaultModalOpen(true); setMobileSidebarOpen(false);
                  }} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-slate-200 hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-[#ff6b57]">
                    <HardDriveDownload className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                    <span>Vault &amp; iCloud Drive backup <span className="mt-0.5 block text-[10px] text-slate-400">Manual encrypted file backup / restore</span></span>
                  </button>
                </div>
              )}
              <button ref={settingsButtonRef} type="button" onClick={() => setSettingsOpen((open) => !open)} aria-haspopup="dialog" aria-expanded={settingsOpen} aria-controls="workspace-settings" className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-[#131823] px-3 py-2.5 text-xs font-medium text-slate-200 transition hover:border-white/18 hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-[#ff6b57]">
                <span className="flex items-center gap-2"><Settings className="h-4 w-4 text-slate-400" /> Settings</span>
                <ChevronUp className={`h-3.5 w-3.5 text-slate-500 transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
          </div>
      </aside>

      {/* Right Main Workspace */}
      <main inert={mobileSidebarOpen || undefined} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Multi-Tab Bar */}
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-white/8 bg-[#0c1017] px-2">
          <button
            ref={mobileMenuButtonRef}
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            className="shrink-0 rounded-lg p-2 text-slate-300 hover:bg-white/5 hover:text-white md:hidden"
            aria-label="Open navigation"
            aria-controls="workspace-sidebar"
            aria-expanded={mobileSidebarOpen}
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
          {!sidebarOpen && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="mr-1 hidden shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white md:block"
              aria-label="Open sidebar"
              aria-controls="workspace-sidebar"
              aria-expanded={false}
              title="Open sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}

          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {/* Launchpad Tab */}
          <button
            type="button"
            onClick={() => selectActiveTab("launchpad")}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeTabId === "launchpad"
                ? "bg-[#171d2b] text-white shadow-xs"
                : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 text-[#ff6b57]" />
            Launchpad
          </button>

          {/* One URL listing every host (SSH / SFTP / RDP merged) */}
          <a
            href="/hosts"
            className="flex shrink-0 items-center gap-1 rounded-t-xl border border-b-0 border-white/8 px-3 py-2 text-xs text-slate-400 transition hover:bg-white/8 hover:text-white"
            title="Every host on one page, with SSH, SFTP and RDP side by side"
          >
            <Server className="h-3.5 w-3.5" />
            All hosts
          </a>

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
                className={`group flex max-w-[220px] shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                  active
                    ? "border-white/12 bg-[#171d2b] text-white"
                    : "border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectActiveTab(tab.id)}
                  aria-current={active ? "page" : undefined}
                  className="flex min-w-0 items-center gap-2 text-left"
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} />
                  <span className="truncate font-medium">{tab.title}</span>
                  {tab.protocol === "ssh" &&
                    resumableRuns.some(
                      (r) =>
                        r.running &&
                        (r.id === tabRunIdsRef.current[tab.id] ||
                          hostHistoryKey(r.profile) === hostHistoryKey(tab.profile))
                    ) && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400"
                        title="Command running on remote host"
                      />
                    )}
                  <span className="font-mono-code text-[10px] uppercase opacity-60">
                    {tab.protocol}
                  </span>
                </button>
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
              setHostModalIntent(null);
              setHostModalOpen(true);
            }}
            className="ml-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/6 hover:text-white"
            title="New Connection Tab"
          >
            <Plus className="h-4 w-4" />
          </button>
          </div>
        </header>

        {/* Workspace Stage */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Launchpad Home View — host list is home on a phone, the hero on desktop */}
          <div
            className={
              activeTabId === "launchpad"
                ? "h-full w-full overflow-y-auto overscroll-contain p-3 pb-6 sm:p-8"
                : "hidden"
            }
          >
            {/* Pinned hero on a phone: one tap back to the host list. */}
            {isPhoneLayout && mobileHome === "launchpad" && (
              <div className="mx-auto mb-4 flex w-full max-w-5xl items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#0c1017] px-3 py-2">
                <span className="text-[11px] text-slate-400">
                  You pinned the dashboard as your phone home screen.
                </span>
                <button
                  type="button"
                  onClick={() => setMobileHome("hosts")}
                  className="shrink-0 rounded-lg bg-white/8 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/14"
                >
                  Show host list
                </button>
              </div>
            )}

            {/* Tells desktop users where the list went when they open Sushi on a phone. */}
            {!isPhoneLayout && !desktopHomeNoticeDismissed && (
              <div className="mx-auto mb-4 flex w-full max-w-5xl items-start justify-between gap-2 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] px-3 py-2 text-[11px] text-sky-100">
                <span>
                  On a phone, Sushi now opens on your <strong>host list</strong> (search,
                  filter and every saved machine one tap away) with Recently Connected on
                  top, instead of this dashboard.
                </span>
                <button
                  type="button"
                  onClick={dismissDesktopHomeNotice}
                  className="shrink-0 rounded p-1 text-sky-300 hover:bg-white/10"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* Desktop: Recently Connected, hero, quick connect and saved host cards.
                Kept mounted (just hidden) on a phone, which lands on the list below. */}
            <div
              className={
                isPhoneLayout === null
                  ? // Before hydration CSS already hides this on a phone, so the
                    // dashboard never flashes in front of the host list.
                    "hidden md:block"
                  : isPhoneLayout && mobileHome === "hosts"
                    ? "hidden"
                    : "block"
              }
            >

              {/* Recently connected (session history: nothing here is a saved host) */}
              {(recentHosts.length > 0 || resumableRunCandidates(resumableRuns).length > 0) && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white">
                      <Clock className="h-3.5 w-3.5 text-slate-400" />
                      Recently Connected
                    </h2>
                    <span className="text-[11px] text-slate-500">
                      This browser only · not saved hosts
                    </span>
                  </div>

                  {/* Commands that outlived their tab */}
                  {resumableRunCandidates(resumableRuns).map((run) => (
                    <div
                      key={run.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <InfinityIcon
                          className={`h-3.5 w-3.5 shrink-0 ${
                            run.running ? "text-amber-300" : "text-slate-500"
                          }`}
                        />
                        <span className="min-w-0">
                          <span className="font-mono-code block truncate text-[11px] text-slate-100">
                            {run.command}
                          </span>
                          <span className="block truncate text-[10px] text-slate-400">
                            {run.profile.username}@{run.profile.host}
                            {run.profile.port ? `:${run.profile.port}` : ""} ·{" "}
                            {describeRunState(run)}
                          </span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => resumeRunInTab(run)}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/25"
                          title="Reopen that session, replay the command line and attach to the run"
                        >
                          <CirclePlay className="h-3 w-3" />
                          {run.running ? "Go back to it" : "Open log"}
                        </button>
                        {run.running && (
                          <button
                            type="button"
                            disabled={stoppingAllBg}
                            onClick={() => void stopBackgroundForRunHost(run)}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-500/35 bg-rose-500/15 px-2.5 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
                            title="Stop all background SSH processes on this host"
                          >
                            <Square className="h-2.5 w-2.5 fill-current" />
                            Stop
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setResumableRuns(removeResumableRun(run.id))}
                          className="rounded-lg p-1 text-slate-500 hover:bg-white/8 hover:text-rose-300"
                          title="Forget this run (it is not stopped on the host)"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    </div>
                  ))}

                  {/* Hosts that were opened from this browser */}
                  {recentHosts.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {recentHosts.map((entry) => {
                        const Icon =
                          entry.protocol === "rdp"
                            ? Monitor
                            : entry.protocol === "sftp"
                              ? FolderKanban
                              : Terminal;
                        const saved = hosts.some((h) => h.id === entry.profileId);
                        return (
                          <div
                            key={entry.key}
                            className="group flex items-center gap-1 rounded-xl border border-white/8 bg-[#111520] pl-2.5 pr-1 py-1.5 transition hover:border-white/18"
                          >
                            <button
                              type="button"
                              onClick={() => openRecentHost(entry)}
                              className="flex min-w-0 items-center gap-2 text-left"
                              title={`${entry.username}@${entry.host}:${entry.port} — ${formatRunDuration(Date.now() - entry.lastConnectedAt)} ago`}
                            >
                              <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                              <span className="min-w-0">
                                <span className="block max-w-[160px] truncate text-[11px] font-medium text-slate-100">
                                  {entry.name}
                                </span>
                                <span className="font-mono-code block max-w-[160px] truncate text-[10px] text-slate-500">
                                  {entry.username}@{entry.host} ·{" "}
                                  {formatRunDuration(Date.now() - entry.lastConnectedAt)} ago
                                </span>
                              </span>
                              {!saved && (
                                <span
                                  className="shrink-0 rounded bg-white/6 px-1 text-[9px] uppercase text-slate-400"
                                  title="Not in the vault — this tab's history only"
                                >
                                  ad-hoc
                                </span>
                              )}
                            </button>
                            {saved && (
                              <button
                                type="button"
                                onClick={() => {
                                  const host = hosts.find((h) => h.id === entry.profileId);
                                  if (host) openSessionTab(host, host.protocol === "ssh" ? "sftp" : "ssh");
                                }}
                                className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-sky-300"
                                title={entry.protocol === "ssh" ? "Open as SFTP" : "Open as SSH"}
                              >
                                {entry.protocol === "ssh" ? (
                                  <FolderKanban className="h-3 w-3" />
                                ) : (
                                  <Terminal className="h-3 w-3" />
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => forgetRecentHost(entry.key)}
                              className="rounded p-1 text-slate-600 hover:bg-white/8 hover:text-rose-300"
                              title="Remove from recently connected"
                              aria-label={`Remove ${entry.name} from recently connected`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {insecureHttp && !insecureNoticeDismissed && (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                  <span className="flex items-start gap-2">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <span>
                      <span className="font-semibold text-amber-200">
                        You&apos;re using Sushi over plain HTTP.
                      </span>{" "}
                      SSH, SFTP, RDP and the vault work, but your Sushi login and the
                      server passwords/keys you send travel unencrypted between this
                      browser and Sushi, and passkeys are disabled. Put Sushi behind
                      HTTPS (e.g. Caddy or Nginx with a domain) for production use.
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setInsecureNoticeDismissed(true);
                      try {
                        sessionStorage.setItem("sushi_http_notice_dismissed", "1");
                      } catch {
                        // ignore storage errors
                      }
                    }}
                    className="shrink-0 rounded-lg bg-amber-500/20 px-3 py-1 font-semibold text-amber-100 hover:bg-amber-500/30"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* "Your command is still running — go back?" after a reload / closed tab */}
              {resumePrompt && (
                <div
                  role="status"
                  className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100"
                >
                  <span className="flex items-start gap-2">
                    <InfinityIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <span className="space-y-1">
                      <span className="block font-semibold text-amber-200">
                        {resumePrompt.title}
                      </span>
                      <span className="block text-amber-100/90">{resumePrompt.body}</span>
                      {resumePrompt.run.cwd ? (
                        <span className="font-mono-code block text-[11px] text-amber-200/60">
                          {resumePrompt.run.cwd}
                          {resumePrompt.run.runLog ? ` · log ${resumePrompt.run.runLog}` : ""}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => resumeRunInTab(resumePrompt.run)}
                      className="inline-flex items-center gap-1 rounded-lg bg-amber-500/25 px-3 py-1 font-semibold text-amber-50 hover:bg-amber-500/35"
                    >
                      <CirclePlay className="h-3 w-3" />
                      {resumePrompt.acceptLabel}
                    </button>
                    {resumePrompt.run.running && (
                      <button
                        type="button"
                        disabled={stoppingAllBg}
                        onClick={() => void stopBackgroundForRunHost(resumePrompt.run)}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/20 px-3 py-1 font-semibold text-rose-100 hover:bg-rose-500/30 disabled:opacity-50"
                        title="Stop all background SSH processes on that host"
                      >
                        <Square className="h-2.5 w-2.5 fill-current" />
                        Stop
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openRunHostFresh(resumePrompt.run)}
                      className="rounded-lg border border-amber-400/40 px-3 py-1 font-medium text-amber-100 hover:bg-amber-500/20"
                      title="Open a normal session on that host without attaching to the run"
                    >
                      Just open the host
                    </button>
                    <button
                      type="button"
                      onClick={dismissResumePrompt}
                      className="rounded-lg px-2 py-1 text-amber-200/70 hover:text-amber-100"
                      title="Do not ask again for this command"
                    >
                      Dismiss
                    </button>
                  </span>
                </div>
              )}

              {bgStopNotice && (
                <div
                  role="status"
                  className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs ${
                    bgStopNotice.tone === "success"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-200"
                  }`}
                >
                  <span>{bgStopNotice.text}</span>
                  <button
                    type="button"
                    onClick={() => setBgStopNotice(null)}
                    className="rounded p-1 opacity-70 hover:opacity-100"
                    aria-label="Dismiss notice"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {vaultSyncError && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                  <span>{vaultSyncError}</span>
                  <button type="button" onClick={() => {
                    if (!window.confirm("Reload the latest vault? Unsaved edits in open forms will be discarded.")) return;
                    setHostModalOpen(false); setVaultModalOpen(false); setEditingProfile(null);
                    void bootAuthenticatedWorkspace();
                  }} className="rounded-lg bg-rose-500/20 px-3 py-1 font-semibold">Reload latest vault</button>
                </div>
              )}
              {localCaps && !localCaps.serverVault && (
                <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                  Shared vault storage is disabled or not configured. Saved connections can appear in other tabs of this browser, but not on other devices. {localCaps.mode === "vercel" ? "Connect Turso, Firestore, or persistent Redis REST storage to this Vercel project to enable cross-device sync. Keep this browser's data until migration is complete." : "Enable persistent shared vault storage to sync other devices."}
                </div>
              )}

              {whitelistBannerError && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
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
              <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#131824] to-[#0e121b] p-4 shadow-xl sm:p-7">
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
                      disabled={stoppingAllBg}
                      onClick={() => void handleStopAllBackgroundSsh()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-medium text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
                      title="Stop all background SSH processes on connected or saved SSH hosts"
                    >
                      {stoppingAllBg ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-300" />
                      ) : (
                        <Square className="h-3 w-3 fill-current text-rose-300" />
                      )}
                      Stop Background SSH
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setVaultModalTab("termix");
                        setVaultModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                    >
                      <ArrowLeftRight className="h-3.5 w-3.5 text-[#ff6b57]" />
                      Import / Export
                    </button>
                    <button
                      type="button"
                      onClick={() => setAccountModalOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10"
                    >
                      <Fingerprint className="h-3.5 w-3.5 text-[#ff6b57]" />
                      Account &amp; Passkeys
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
                      : "RDP: Live HTML5 Desktop (IronRDP)"}
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
                    setHostModalIntent(null);
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
                    setHostModalIntent(null);
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
                    setHostModalIntent(null);
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
                    Live HTML5 Windows &amp; Linux xrdp desktop in your browser with
                    NLA/TLS auth, clipboard sync, and dynamic display scaling.
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
                      Vault &amp; Backup
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {unifiedHosts.map((h) => {
                      const Icon = h.protocols.rdp
                        ? Monitor
                        : h.protocols.ssh
                          ? Terminal
                          : FolderKanban;
                      const protocols = openableProtocols(h);
                      const primary = h.primary;
                      const profileCount = Object.values(h.protocols).filter(Boolean).length;
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
                                  {h.username}@{h.host}:
                                  {h.ports.ssh ?? h.ports.sftp ?? primary.port}
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              {profileCount > 1 && (
                                <span
                                  className="rounded-md bg-white/6 px-2 py-0.5 text-[10px] uppercase text-slate-300"
                                  title={`${profileCount} saved profiles merged into one machine`}
                                >
                                  {profileCount} profiles
                                </span>
                              )}
                              <span className="flex items-center gap-0.5">
                                {protocols.map((protocol) => (
                                  <span
                                    key={protocol}
                                    className="rounded bg-white/6 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-slate-300"
                                  >
                                    {protocol}
                                  </span>
                                ))}
                              </span>
                            </div>
                          </div>

                          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/6 pt-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => openUnifiedHost(h)}
                                className="rounded-lg bg-white/10 px-3 py-1 text-xs font-medium text-white transition hover:bg-white/18"
                              >
                                Connect
                              </button>
                              {protocols.includes("sftp") && (
                                <button
                                  type="button"
                                  onClick={() => openUnifiedHost(h, "sftp")}
                                  className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-white/6 hover:text-white"
                                >
                                  SFTP
                                </button>
                              )}
                              {protocols.includes("rdp") && (
                                <button
                                  type="button"
                                  onClick={() => openUnifiedHost(h, "rdp")}
                                  className="flex items-center gap-1 rounded-lg border border-[#ff6b57]/35 bg-[#ff6b57]/10 px-2.5 py-1 text-xs text-[#ff9587] transition hover:bg-[#ff6b57]/20"
                                  title={
                                    h.protocols.rdp
                                      ? "Open this host as an RDP desktop"
                                      : "Open this host as an RDP desktop (derived on port 3389)"
                                  }
                                >
                                  <Monitor className="h-3 w-3" />
                                  RDP
                                </button>
                              )}
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingProfile(primary);
                                  setHostModalIntent(null);
                                  setHostModalOpen(true);
                                }}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/8 hover:text-white"
                                aria-label={`Edit ${h.name}`}
                                title={profileCount > 1 ? "Edit or remove this machine (SSH / SFTP / RDP profiles)" : "Edit or remove host"}
                              >
                                <Pencil className="h-3.5 w-3.5" />
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

            {isPhoneLayout && mobileHome === "hosts" && (
              <div className="flex h-full flex-col">
                {/* Recently connected stays on top on a phone too. */}
                <div className="mb-3 space-y-2 rounded-2xl border border-white/8 bg-[#0c1017] p-3">
                  <div className="flex items-center justify-between">
                    <h2 className="flex items-center gap-1.5 text-xs font-semibold text-white">
                      <Clock className="h-3.5 w-3.5 text-slate-400" />
                      Recently Connected
                    </h2>
                    <span className="text-[10px] text-slate-500">This browser only</span>
                  </div>

                  {recentHosts.length === 0 &&
                    resumableRunCandidates(resumableRuns).length === 0 && (
                      <p className="text-[11px] text-slate-500">
                        Nothing yet — a host you connect from this device shows up here
                        first.
                      </p>
                    )}

                  {resumableRunCandidates(resumableRuns)
                    .slice(0, 2)
                    .map((run) => (
                      <div
                        key={run.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5"
                      >
                        <span className="min-w-0">
                          <span className="font-mono-code block truncate text-[11px] text-slate-100">
                            {run.command}
                          </span>
                          <span className="block truncate text-[10px] text-slate-400">
                            {run.profile.username}@{run.profile.host} ·{" "}
                            {describeRunState(run)}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => resumeRunInTab(run)}
                            className="shrink-0 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/25"
                          >
                            {run.running ? "Go back to it" : "Open log"}
                          </button>
                          {run.running && (
                            <button
                              type="button"
                              disabled={stoppingAllBg}
                              onClick={() => void stopBackgroundForRunHost(run)}
                              className="shrink-0 rounded-lg border border-rose-500/35 bg-rose-500/15 px-2 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
                              title="Stop background SSH processes on this host"
                            >
                              Stop
                            </button>
                          )}
                        </span>
                      </div>
                    ))}

                  {recentHosts.length > 0 && (
                    <div className="space-y-1">
                      {recentHosts.slice(0, 3).map((entry) => {
                        const Icon =
                          entry.protocol === "rdp"
                            ? Monitor
                            : entry.protocol === "sftp"
                              ? FolderKanban
                              : Terminal;
                        return (
                          <div
                            key={entry.key}
                            className="flex items-center gap-1 rounded-xl border border-white/8 bg-[#111520] py-1 pl-2.5 pr-1"
                          >
                            <button
                              type="button"
                              onClick={() => openRecentHost(entry)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                              <span className="min-w-0">
                                <span className="block truncate text-[11px] font-medium text-slate-100">
                                  {entry.name}
                                </span>
                                <span className="font-mono-code block truncate text-[10px] text-slate-500">
                                  {entry.username}@{entry.host} ·{" "}
                                  {formatRunDuration(Date.now() - entry.lastConnectedAt)} ago
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => forgetRecentHost(entry.key)}
                              className="shrink-0 rounded p-1.5 text-slate-600 hover:bg-white/8 hover:text-rose-300"
                              aria-label={`Remove ${entry.name} from recently connected`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* The host list is the phone home screen: search, filter, one row per machine. */}
                <HostNavList
                  variant="page"
                  hosts={unifiedHosts}
                  protocolFilter={protocolFilter}
                  onProtocolFilterChange={setProtocolFilter}
                  search={hostSearch}
                  onSearchChange={setHostSearch}
                  onOpen={(entry, protocol) => openUnifiedHost(entry, protocol)}
                  onEdit={handleEditHost}
                  onNewHost={() => {
                    setEditingProfile(null);
                    setHostModalIntent(null);
                    setHostModalOpen(true);
                  }}
                />

                <div className="mx-auto mt-4 flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 pb-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setMobileHome("launchpad")}
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-slate-300 hover:bg-white/8"
                  >
                    Show quick connect
                  </button>
                  <a
                    href="/hosts"
                    className="rounded-lg border border-white/10 px-2.5 py-1.5 text-slate-300 hover:bg-white/8"
                  >
                    All hosts &amp; API →
                  </a>
                </div>
              </div>
            )}
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
                    onOpenRdp={() => openRdpCompanion(tab.profile)}
                    onOpenGatewayModal={() => setGatewayModalOpen(true)}
                    onConnected={() => handleSessionConnected(tab.profile, tab.profile.id)}
                    onRunChange={(run) => handleRunUpdated(run, tab.id)}
                    onStopHostRuns={() => clearHostResumableRuns(tab.profile)}
                    resumeRun={tabResumes[tab.id] ?? null}
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
                    onOpenRdp={() => openRdpCompanion(tab.profile)}
                  />
                )}
                {tab.protocol === "rdp" && (
                  <RdpDesktopSession
                    profile={tab.profile}
                    isActive={isActive}
                    guacdAvailable={effectiveRdpGuacd}
                    websocketAvailable={effectiveWsSsh}
                    rdpCleanPathAvailable={effectiveRdpCleanPath}
                    gatewaySettings={gatewaySettings}
                    onEditCredentials={() => editRdpConnection(tab)}
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
        title={hostModalIntent === "rdp" ? "Open via RDP" : undefined}
        subtitle={
          hostModalIntent === "rdp"
            ? "Desktop login for this server — set the Windows / xrdp account, domain and port. Saving keeps your SSH host untouched by creating a separate RDP entry."
            : undefined
        }
        gatewaySettings={gatewaySettings}
        sshKeys={sshKeys}
        enforceKeyWhitelist={enforceKeyWhitelist}
        onAddWhitelistedKey={async (newKey) => {
          const nextKeys = [...sshKeys, newKey];
          const saved = await persistVault(
            hosts,
            snippets,
            undefined,
            undefined,
            nextKeys,
            enforceKeyWhitelist
          );
          setSshKeys(saved.sshKeys || nextKeys);
        }}
        onClose={() => {
          setHostModalOpen(false);
          setEditingProfile(null);
          setHostModalIntent(null);
        }}
        onSave={handleSaveHostProfile}
        siblingProtocolsDescription={editingHostSiblingProtocols}
        onDelete={
          savedEditingHost
            ? ({ wholeMachine }) =>
                handleDeleteHost(savedEditingHost.id, { wholeMachine })
            : undefined
        }
        onQuickConnectOnly={(p) => {
          setHostModalOpen(false);
          setEditingProfile(null);
          setHostModalIntent(null);
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
        initialSection={vaultModalFocusBackup ? "backup" : undefined}
        vaultMode={vaultMode}
        vaultKeySource={vaultKeySource}
        serverVaultEnabled={Boolean(localCaps?.serverVault)}
        hosts={hosts}
        sshKeys={sshKeys}
        enforceKeyWhitelist={enforceKeyWhitelist}
        gatewaySettings={gatewaySettings}
        onClose={() => { setVaultModalOpen(false); setVaultModalFocusBackup(false); }}
        onExportPortableEnvelope={(passphrase) =>
          encryptVaultData({
            version: 1,
            hosts,
            snippets,
            sshKeys,
            enforceKeyWhitelist,
          }, passphrase)
        }
        onImportEnvelope={async (env, pass) => {
          const plain = await decryptVaultEnvelope(env, pass);
          const nextKeys = plain.sshKeys || [];
          const nextEnforce = Boolean(plain.enforceKeyWhitelist);
          const saved = await persistVault(
            plain.hosts,
            plain.snippets,
            undefined,
            undefined,
            nextKeys,
            nextEnforce
          );
          setHosts(saved.hosts);
          setSnippets(saved.snippets);
          setSshKeys(saved.sshKeys || []);
          setEnforceKeyWhitelist(Boolean(saved.enforceKeyWhitelist));
        }}
        onUpdateKeychain={async (nextKeys, nextEnforce) => {
          const saved = await persistVault(
            hosts,
            snippets,
            undefined,
            undefined,
            nextKeys,
            nextEnforce
          );
          setSshKeys(saved.sshKeys || []);
          setEnforceKeyWhitelist(Boolean(saved.enforceKeyWhitelist));
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

          const saved = await persistVault(
            mergedHosts,
            mergedSnippets,
            undefined,
            undefined,
            mergedKeys,
            enforceKeyWhitelist
          );
          setHosts(saved.hosts);
          setSshKeys(saved.sshKeys || []);
          setSnippets(saved.snippets);
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
        onPreparePasswordChange={async (currentPassword) => {
          emptyPasswordRotationRef.current = false;
          if (vaultKeySource !== "account") return false;
          if (!pendingEnvelope) {
            if (!localCaps?.serverVault || syncRevisionRef.current !== null) throw new Error("Unlock the shared vault before changing your password.");
            await verifyAccountPassword(gatewaySettings, currentPassword);
            emptyPasswordRotationRef.current = true;
            return true;
          }
          // Verify locally before touching the vault. The server verifies the
          // same password again when it updates the account.
          await decryptVaultEnvelope(pendingEnvelope, currentPassword);
          await persistVault(hosts, snippets, currentPassword, "passphrase", undefined, undefined, "independent");
          setVaultMode("passphrase");
          setVaultKeySource("independent");
          setActivePassphrase(currentPassword);
          setAccountVaultOutdated(false);
          return true;
        }}
        onFinishPasswordChange={async (newPassword) => {
          if (!emptyPasswordRotationRef.current) {
            await persistVault(hosts, snippets, newPassword, "passphrase", undefined, undefined, "account");
          }
          emptyPasswordRotationRef.current = false;
          accountPasswordRef.current = newPassword;
          setVaultMode("passphrase");
          setVaultKeySource("account");
          setActivePassphrase(newPassword);
          setAccountVaultOutdated(false);
        }}
        onSignedOut={() => {
          if (workspaceSyncTimerRef.current) {
            clearTimeout(workspaceSyncTimerRef.current);
            workspaceSyncTimerRef.current = null;
          }
          workspaceSyncDirtyRef.current = false;
          tabsHydratedRef.current = false;
          lastSyncedPlainRef.current = null;
          localClosedTabIdsRef.current.clear();
          tabRunIdsRef.current = {};
          tabUpdatedAtMapRef.current = {};
          tabsRef.current = [];
          activeTabIdRef.current = "launchpad";
          setAccountModalOpen(false);
          setTabs([]);
          setActiveTabId("launchpad");
          setVaultReady(false);
          accountPasswordRef.current = null;
          sessionVaultKeyRef.current = null;
          setActivePassphrase(null);
          updatePendingEnvelope(null);
          setHosts([]);
          setSnippets(DEFAULT_SNIPPETS);
          setSshKeys([]);
          setEnforceKeyWhitelist(false);
          setAuthStatus((prev) =>
            prev ? { ...prev, authenticated: false } : null
          );
        }}
      />
    </div>
  );
}
