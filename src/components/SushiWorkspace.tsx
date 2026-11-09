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
  Settings,
  HardDriveDownload,
  RefreshCw,
  ChevronUp,
  AlertCircle,
  ShieldAlert,
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
  clearDeviceKey,
  decryptVaultEnvelope,
  encryptVaultData,
  loadLocalEnvelope,
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
  cacheSyncedVaultIfUnchanged,
  clearLocalSyncMetadata,
  fetchRemoteVault,
  getLocalSyncMetadata,
  sameVaultEnvelope,
  sameOptionalVaultEnvelope,
  saveLocalVaultIfUnchanged,
  saveRemoteVault,
  subscribeVaultChanges,
  verifyAccountPassword,
} from "@/lib/client/vault-sync";
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
  setStoredSessionToken,
} from "@/lib/client/auth-storage";
import { isInsecureBrowserContext, randomUUID } from "@/lib/client/web-crypto";
import {
  buildRdpCompanionDraft,
  buildRdpCompanionProfile,
  rdpCompanionTitle,
} from "@/lib/client/rdp-companion";

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

  // Vault state
  const [vaultReady, setVaultReady] = useState(false);
  const [vaultLocked, setVaultLocked] = useState(false);
  const [vaultMode, setVaultMode] = useState<"device" | "passphrase">("device");
  const [activePassphrase, setActivePassphrase] = useState<string | null>(null);
  const [vaultKeySource, setVaultKeySource] = useState<"account" | "independent">("independent");
  const [accountVaultOutdated, setAccountVaultOutdated] = useState(false);
  const [needsInitialPassword, setNeedsInitialPassword] = useState(false);
  const [localVaultToMigrate, setLocalVaultToMigrate] = useState<{ plain: VaultPlaintext; envelope: EncryptedVaultEnvelope } | null>(null);
  const [vaultBootError, setVaultBootError] = useState<string | null>(null);
  const [vaultRecoveryEnvelope, setVaultRecoveryEnvelope] = useState<EncryptedVaultEnvelope | null>(null);
  const [vaultSyncError, setVaultSyncError] = useState<string | null>(null);
  const [vaultConflict, setVaultConflict] = useState<EncryptedVaultEnvelope | null>(null);
  const [conflictBackupDownloaded, setConflictBackupDownloaded] = useState(false);
  const syncRevisionRef = useRef<string | null>(null);
  // The password is held only while this workspace is unlocked, never stored.
  const accountPasswordRef = useRef<string | null>(null);
  const bootSequenceRef = useRef(0);
  const bootLocalEnvelopeRef = useRef<EncryptedVaultEnvelope | null>(null);
  const emptyPasswordRotationRef = useRef(false);
  const vaultMutationVersionRef = useRef(0);
  const syncRefreshInFlightRef = useRef(false);
  const syncRefreshRequestedRef = useRef(false);
  const syncEligibleRef = useRef(false);
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [pendingEnvelope, setPendingEnvelope] =
    useState<EncryptedVaultEnvelope | null>(null);
  const pendingEnvelopeRef = useRef<EncryptedVaultEnvelope | null>(null);
  const updatePendingEnvelope = useCallback((envelope: EncryptedVaultEnvelope | null) => {
    pendingEnvelopeRef.current = envelope;
    setPendingEnvelope(envelope);
  }, []);

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
  const [protocolFilter, setProtocolFilter] = useState<"all" | ProtocolType>("all");
  const [hostSearch, setHostSearch] = useState("");
  const [quickConnectInput, setQuickConnectInput] = useState("");

  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("launchpad");

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
  // Do not replace in-memory data while a form is being edited or a vault is locked.
  syncEligibleRef.current = vaultReady && !vaultLocked && !hostModalOpen &&
    !vaultModalOpen && !accountModalOpen && !gatewayModalOpen;

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const settingsContainerRef = useRef<HTMLDivElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsFirstActionRef = useRef<HTMLButtonElement | null>(null);

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

  const applyPlainVault = useCallback((plain: VaultPlaintext) => {
    setHosts(plain.hosts);
    setSnippets(plain.snippets);
    setSshKeys(plain.sshKeys || []);
    setEnforceKeyWhitelist(Boolean(plain.enforceKeyWhitelist));
  }, []);

  const createAccountVault = useCallback(async (
    plain: VaultPlaintext,
    password: string,
    gw: GatewaySettings,
    baseRevision: string | null,
    shared: boolean,
    expectedLocal?: EncryptedVaultEnvelope | null
  ) => {
    const localBase = expectedLocal === undefined ? loadLocalEnvelope() : expectedLocal;
    // A remembered password can become stale after another device changes the
    // account password. Never publish a newly encrypted account vault unless
    // the server has confirmed this is still the current password.
    await verifyAccountPassword(gw, password);
    const envelope = await encryptVaultData(plain, password);
    envelope.keySource = "account";
    if (shared) {
      if (!sameOptionalVaultEnvelope(loadLocalEnvelope(), localBase)) {
        throw new Error("The browser vault changed in another tab. Reload it before enabling sync; no data was replaced.");
      }
      const revision = await saveRemoteVault(gw, envelope, baseRevision);
      syncRevisionRef.current = revision;
      if (!await cacheSyncedVaultIfUnchanged(localBase, envelope, revision)) {
        const latest = loadLocalEnvelope();
        if (!sameOptionalVaultEnvelope(latest, localBase) && !sameOptionalVaultEnvelope(latest, envelope)) {
          throw new Error("A shared snapshot was saved, but this browser's vault changed during sync. No local data was replaced; reload and keep a backup of the newer local copy.");
        }
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
    setVaultKeySource("account");
    setAccountVaultOutdated(false);
    setActivePassphrase(password);
    return envelope;
  }, [updatePendingEnvelope]);

  const bootAuthenticatedWorkspace = useCallback(async (password?: string, preferShared = false) => {
    const sequence = ++bootSequenceRef.current;
    if (password) accountPasswordRef.current = password;
    const currentPassword = accountPasswordRef.current;
    setVaultReady(false);
    setVaultBootError(null);
    setVaultRecoveryEnvelope(null);
    setVaultConflict(null);
    setNeedsInitialPassword(false);
    setLocalVaultToMigrate(null);
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
        setUnlockError(null);
        setAccountVaultOutdated(false);
        if (caps.serverVault) {
          if (!currentPassword) {
            setVaultMode("passphrase");
            setVaultKeySource("account");
            setNeedsInitialPassword(true);
            setVaultLocked(true);
          } else {
            // Do not publish an empty vault just because a new device signed
            // in. The original browser may still need to upload its vault.
            setVaultMode("passphrase");
            setVaultKeySource("account");
            setActivePassphrase(currentPassword);
            setVaultLocked(false);
          }
        } else {
          setVaultMode("device");
          setVaultKeySource("independent");
          setActivePassphrase(null);
          setVaultLocked(false);
        }
        setVaultReady(true);
        return;
      }

      updatePendingEnvelope(envelope);
      setVaultMode(envelope.mode);
      setVaultKeySource(envelope.keySource === "account" ? "account" : "independent");
      setAccountVaultOutdated(false);
      setUnlockError(null);
      if (envelope.mode === "passphrase" && !currentPassword) {
        setActivePassphrase(null);
        setVaultLocked(true);
        setVaultReady(true);
        return;
      }

      let plain: VaultPlaintext;
      try {
        plain = await decryptVaultEnvelope(envelope, envelope.mode === "passphrase" ? currentPassword : null);
      } catch {
        setActivePassphrase(null);
        setVaultLocked(true);
        setUnlockError(envelope.mode === "device"
          ? "This device-key vault can only be opened on its original browser. Open it there and enable account-password sync."
          : envelope.keySource === "account" && currentPassword
            ? "The vault password may have changed. Enter the account password or the previous password used for this vault."
            : "Enter the existing vault passphrase to unlock your saved data.");
        setVaultReady(true);
        return;
      }
      if (sequence !== bootSequenceRef.current) return;
      if (caps.serverVault && !remote?.envelope && local) {
        // Storage was enabled after this browser had already saved hosts. Do
        // not create an empty shared vault or upload a device-only key.
        if (!currentPassword) {
          setLocalVaultToMigrate({ plain, envelope: local });
          setNeedsInitialPassword(true);
          setVaultMode("passphrase");
          setVaultKeySource("account");
          setActivePassphrase(null);
          setVaultLocked(true);
          setVaultReady(true);
          return;
        }
        envelope = await createAccountVault(plain, currentPassword, gw, null, true, local);
      } else if (caps.serverVault && currentPassword && envelope.keySource === undefined) {
        envelope = await createAccountVault(plain, currentPassword, gw, remote?.revision ?? null, true, local);
      } else {
        if (isRemote && remote?.revision) {
          const cached = await cacheSyncedVaultIfUnchanged(local, envelope, remote.revision);
          if (sequence !== bootSequenceRef.current) return;
          if (!cached) {
            setVaultSyncError("The shared vault opened, but this browser could not cache it locally.");
          } else {
            bootLocalEnvelopeRef.current = envelope;
          }
        }
        setActivePassphrase(envelope.mode === "passphrase" ? currentPassword : null);
      }
      if (sequence !== bootSequenceRef.current) return;
      applyPlainVault(plain);
      setVaultLocked(false);
      setVaultReady(true);
    } catch (error) {
      if (sequence !== bootSequenceRef.current) return;
      setVaultBootError(error instanceof Error ? error.message : "Could not load the vault. No data was changed.");
      try { setVaultRecoveryEnvelope(loadLocalEnvelope()); } catch { /* preserve the unreadable local data */ }
      setVaultReady(false);
    }
  }, [applyPlainVault, createAccountVault, updatePendingEnvelope]);

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
      explicitSource?: "account" | "independent"
    ) => {
      const targetMode = explicitMode ?? vaultMode;
      const source = targetMode === "passphrase" ? explicitSource ?? vaultKeySource : "independent";
      const passToUse = targetMode === "passphrase" ? passphraseOverride ?? activePassphrase : null;
      if (targetMode === "passphrase" && !passToUse) throw new Error("Unlock the vault before saving.");
      if (accountVaultOutdated && explicitSource !== "account") {
        throw new Error("Update the vault to the current account password before making changes.");
      }
      // Capture the base before encryption. Two simultaneous edits from this
      // tab must not silently overwrite each other either.
      const baseRevision = syncRevisionRef.current;
      const baseLocalEnvelope = pendingEnvelopeRef.current;
      vaultMutationVersionRef.current++;
      try {
        if (source === "account" && passToUse) await verifyAccountPassword(gatewaySettings, passToUse);
        const envelope = await encryptVaultData({
          version: 1,
          hosts: nextHosts,
          snippets: nextSnippets,
          sshKeys: nextSshKeys ?? sshKeys,
          enforceKeyWhitelist: nextEnforceWhitelist ?? enforceKeyWhitelist,
        }, passToUse);
        envelope.keySource = source;
        if (localCaps?.serverVault) {
          const revision = await saveRemoteVault(gatewaySettings, envelope, baseRevision);
          syncRevisionRef.current = revision;
          if (!await cacheSyncedVaultIfUnchanged(baseLocalEnvelope, envelope, revision)) {
            setVaultSyncError("Vault saved to shared storage, but this browser's local copy changed or could not be cached. Reload before editing again.");
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
      } catch (error) {
        let message = error instanceof Error ? error.message : "Could not save the encrypted vault.";
        if (source === "account" && !explicitSource && /account password is incorrect/i.test(message)) {
          setAccountVaultOutdated(true);
          message = "The account password has changed. Update the vault to the current account password before saving.";
        }
        setVaultSyncError(message);
        throw new Error(message);
      } finally {
        vaultMutationVersionRef.current++;
      }
    },
    [activePassphrase, accountVaultOutdated, enforceKeyWhitelist, gatewaySettings, localCaps?.serverVault, sshKeys, updatePendingEnvelope, vaultKeySource, vaultMode]
  );

  const refreshSharedVault = useCallback(async function refreshSharedVault() {
    if (!localCaps?.serverVault || !syncEligibleRef.current) return;
    if (syncRefreshInFlightRef.current) { syncRefreshRequestedRef.current = true; return; }
    syncRefreshInFlightRef.current = true;
    const version = vaultMutationVersionRef.current;
    const baseRevision = syncRevisionRef.current;
    try {
      const localBase = loadLocalEnvelope();
      const remote = await fetchRemoteVault(gatewaySettings);
      if (!syncEligibleRef.current || version !== vaultMutationVersionRef.current || baseRevision !== syncRevisionRef.current) return;
      if (!remote.envelope || !remote.revision) {
        // A brand-new account has no shared snapshot until its first save.
        if (baseRevision === null) return;
        throw new Error("The shared vault is missing. No local data was changed; check your storage before saving.");
      }
      if (remote.revision === baseRevision) return;
      const pass = remote.envelope.mode === "passphrase" ? activePassphrase : null;
      let plain: VaultPlaintext;
      try {
        plain = await decryptVaultEnvelope(remote.envelope, pass);
      } catch {
        throw new Error("The shared vault changed and needs a different password or device key. Reload the latest vault to unlock it; local data was not replaced.");
      }
      if (!syncEligibleRef.current || version !== vaultMutationVersionRef.current || baseRevision !== syncRevisionRef.current) return;
      const cached = await cacheSyncedVaultIfUnchanged(localBase, remote.envelope, remote.revision);
      if (!syncEligibleRef.current || version !== vaultMutationVersionRef.current || baseRevision !== syncRevisionRef.current) return;
      if (remote.envelope.keySource === "account" && pass && accountPasswordRef.current !== pass) {
        setAccountVaultOutdated(true);
        setVaultSyncError("The updated vault needs your current account password before it can be edited.");
      } else {
        setAccountVaultOutdated(false);
        setVaultSyncError(cached ? null : "The shared vault updated, but this browser's local copy changed or could not be cached.");
      }
      syncRevisionRef.current = remote.revision;
      if (cached) bootLocalEnvelopeRef.current = remote.envelope;
      updatePendingEnvelope(remote.envelope);
      setVaultMode(remote.envelope.mode);
      setVaultKeySource(remote.envelope.keySource === "account" ? "account" : "independent");
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
      if (local.keySource === "account" && pass && accountPasswordRef.current !== pass) {
        setAccountVaultOutdated(true);
        setVaultSyncError("The updated vault needs your current account password before it can be edited.");
      } else {
        setAccountVaultOutdated(false);
        setVaultSyncError(null);
      }
      bootLocalEnvelopeRef.current = local;
      updatePendingEnvelope(local);
      setVaultMode(local.mode);
      setVaultKeySource(local.keySource === "account" ? "account" : "independent");
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
    // Catch changes that arrived while an editor was open, and listen for
    // subsequent same-browser writes without waiting for the polling timer.
    void refreshVault();
    return subscribeVaultChanges(() => void refreshVault());
  }, [localCaps, vaultReady, vaultLocked, hostModalOpen, vaultModalOpen, accountModalOpen, gatewayModalOpen, refreshVault]);

  const openSessionTab = useCallback(
    (
      profile: HostProfile,
      overrideProtocol?: ProtocolType,
      overrideInitialPath?: string,
      overrideTitle?: string
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

      const tabId = `tab-${randomUUID()}`;
      const newTab: SessionTab = {
        id: tabId,
        title: overrideTitle?.trim() || `${profile.name}`,
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
        setActiveTabId(existing.id);
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
    await persistVault(nextHosts, snippets);
    setHosts(nextHosts);
    setHostModalOpen(false);
    setEditingProfile(null);
    setHostModalIntent(null);
    if (connectAfterSave) {
      openSessionTab(profile);
    }
  };

  const handleDeleteHost = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextHosts = hosts.filter((h) => h.id !== id);
    try {
      await persistVault(nextHosts, snippets);
      setHosts(nextHosts);
    } catch {
      // persistVault displays the failure; leave the original host intact.
    }
  };

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

  const handleUnlockVault = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnlockError(null);
    const input = unlockInput;
    try {
      if (needsInitialPassword) {
        if (localVaultToMigrate) {
          await createAccountVault(localVaultToMigrate.plain, input, gatewaySettings, syncRevisionRef.current, true, localVaultToMigrate.envelope);
          applyPlainVault(localVaultToMigrate.plain);
          setLocalVaultToMigrate(null);
        } else {
          // Verify the account password without creating an empty shared vault.
          await verifyAccountPassword(gatewaySettings, input);
          setVaultMode("passphrase");
          setVaultKeySource("account");
          setActivePassphrase(input);
        }
        accountPasswordRef.current = input;
        setNeedsInitialPassword(false);
        setUnlockInput("");
        setVaultLocked(false);
        return;
      }
      if (!pendingEnvelope) return;
      const plain = await decryptVaultEnvelope(pendingEnvelope, pendingEnvelope.mode === "passphrase" ? input : null);
      let active = pendingEnvelope.mode === "passphrase" ? input : null;
      let rewrapped = false;
      const loginPassword = accountPasswordRef.current;
      if (localCaps?.serverVault && !syncRevisionRef.current) {
        // This is a local vault being migrated after shared storage was added.
        // A separate old vault passphrase is not necessarily the account password.
        let migrationPassword = loginPassword;
        if (!migrationPassword && pendingEnvelope.keySource === "account" && active) {
          try { await verifyAccountPassword(gatewaySettings, active); migrationPassword = active; }
          catch { /* Ask for the current account password instead. */ }
        }
        const localBase = bootLocalEnvelopeRef.current ?? pendingEnvelope;
        if (!migrationPassword) {
          setLocalVaultToMigrate({ plain, envelope: localBase });
          setNeedsInitialPassword(true);
          setVaultMode("passphrase");
          setVaultKeySource("account");
          setUnlockInput("");
          return;
        }
        await createAccountVault(plain, migrationPassword, gatewaySettings, null, true, localBase);
        accountPasswordRef.current = migrationPassword;
        applyPlainVault(plain);
        setActivePassphrase(migrationPassword);
        setUnlockInput("");
        setVaultLocked(false);
        return;
      }
      if (pendingEnvelope.keySource === "account" && active) {
        // First check the password that actually decrypted the current vault.
        // Another device may have changed the account since this tab signed in.
        let inputIsCurrent = false;
        try {
          await verifyAccountPassword(gatewaySettings, active);
          inputIsCurrent = true;
        } catch { /* It may be a previous vault password, or storage may be offline. */ }
        if (inputIsCurrent) {
          accountPasswordRef.current = active;
          setAccountVaultOutdated(false);
        } else {
          let rememberedIsCurrent = false;
          if (loginPassword && loginPassword !== active) {
            try {
              await verifyAccountPassword(gatewaySettings, loginPassword);
              rememberedIsCurrent = true;
            } catch { /* Do not publish an unverified password. */ }
          }
          if (rememberedIsCurrent && loginPassword) {
            await createAccountVault(plain, loginPassword, gatewaySettings, syncRevisionRef.current, Boolean(localCaps?.serverVault), bootLocalEnvelopeRef.current);
            active = loginPassword;
            rewrapped = true;
          } else {
            setAccountVaultOutdated(true);
            setVaultSyncError("This vault unlocked with a previous or unverified account password. Update it to the current account password in Vault Security before editing.");
          }
        }
      } else if (localCaps?.serverVault && loginPassword && pendingEnvelope.keySource === undefined) {
        await createAccountVault(plain, loginPassword, gatewaySettings, syncRevisionRef.current, true, bootLocalEnvelopeRef.current);
        active = loginPassword;
        rewrapped = true;
      }
      if (!rewrapped && localCaps?.serverVault && syncRevisionRef.current) {
        if (!await cacheSyncedVaultIfUnchanged(bootLocalEnvelopeRef.current, pendingEnvelope, syncRevisionRef.current)) {
          setVaultSyncError("The shared vault opened, but this browser could not cache it locally.");
        } else {
          bootLocalEnvelopeRef.current = pendingEnvelope;
        }
      }
      applyPlainVault(plain);
      setActivePassphrase(active);
      setUnlockInput("");
      setVaultLocked(false);
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : "Could not unlock the vault.");
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
        onAuthenticated={async (loggedInUser, accountPassword) => {
          setAuthUsername(loggedInUser);
          accountPasswordRef.current = accountPassword || null;
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

  // Vault Unlock Gate
  if (vaultLocked) {
    return (
      <div className="flex h-full w-full overflow-y-auto bg-[#090b10] p-4">
        <form
          onSubmit={handleUnlockVault}
          className="m-auto w-full max-w-md shrink-0 space-y-5 rounded-2xl border border-white/10 bg-[#0f131b] p-5 shadow-2xl sm:p-7"
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
                {needsInitialPassword ? (localVaultToMigrate ? "Enter your account password to sync this browser's saved connections" : "Enter your account password to set up encrypted sync") : vaultMode === "passphrase" ? (vaultKeySource === "account" ? "Unlock with your account password" : "Unlock with your existing master passphrase") : "Device-key vault could not be opened"}
              </p>
            </div>
          </div>

          {unlockError && (
            <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-300">
              {unlockError}
            </div>
          )}
          {localVaultToMigrate && <p className="text-xs text-slate-400">Your existing encrypted vault will be preserved while it is copied to shared storage. Keep this browser's data until you verify your connections on another device.</p>}

          {vaultMode === "passphrase" && <input
            type="password"
            value={unlockInput}
            onChange={(e) => setUnlockInput(e.target.value)}
            placeholder={vaultKeySource === "account" || needsInitialPassword ? "Enter account password..." : "Enter master passphrase..."}
            aria-label={vaultKeySource === "account" || needsInitialPassword ? "Account password" : "Master passphrase"}
            autoFocus
            className="w-full rounded-xl border border-white/12 bg-[#090b10] px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-[#ff6b57]"
          />}

          <div className="flex flex-wrap items-center justify-between gap-3">
            {localCaps?.serverVault && (
              <button type="button" onClick={() => void bootAuthenticatedWorkspace()} className="text-xs text-slate-400 hover:text-white">
                Check for updated vault
              </button>
            )}
            <button type="button" onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST", headers: getAuthHeaders(gatewaySettings) }).catch(() => {});
              setStoredSessionToken(null); accountPasswordRef.current = null; window.location.reload();
            }} className="text-xs text-slate-400 hover:text-white">Sign out</button>
            {!localCaps?.serverVault && <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Reset local encrypted vault? Unbacked-up saved hosts in this browser will be cleared."
                  )
                ) {
                  localStorage.removeItem("sushi_encrypted_vault_v1");
                  clearLocalSyncMetadata();
                  clearDeviceKey();
                  setHosts([]);
                  setSnippets(DEFAULT_SNIPPETS);
                  setSshKeys([]);
                  setEnforceKeyWhitelist(false);
                  updatePendingEnvelope(null);
                  setActivePassphrase(null);
                  setUnlockError(null);
                  setVaultMode("device");
                  setVaultLocked(false);
                }
              }}
              className="text-xs text-slate-500 hover:text-rose-400"
            >
              Reset Local Vault
            </button>}
            <button
              type="submit"
              className="rounded-xl bg-[#ff6b57] px-5 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e]"
            >
              {vaultMode === "passphrase" ? "Unlock Workspace" : "Retry Device Key"}
            </button>
          </div>
        </form>
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
                setActiveTabId("launchpad");
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
                  setHostModalIntent(null);
                  setHostModalOpen(true);
                  setMobileSidebarOpen(false);
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
          <div className="workspace-sidebar-hosts min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-1">
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
                    setHostModalIntent(null);
                    setHostModalOpen(true);
                    setMobileSidebarOpen(false);
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
                        className="group flex items-center justify-between rounded-xl px-2.5 py-2 transition hover:bg-white/[0.06]"
                      >
                        <button
                          type="button"
                          onClick={() => openSessionTab(h)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                        >
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
                        </button>

                        <div className="flex shrink-0 items-center gap-0.5">
                          {/* Always visible so the desktop is one click away */}
                          {h.protocol !== "rdp" && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openRdpCompanion(h);
                              }}
                              className="rounded p-2 text-[#ff6b57]/75 transition hover:bg-[#ff6b57]/20 hover:text-[#ff9587] md:p-1"
                              title="Open desktop via RDP"
                              aria-label={`Open ${h.name} via RDP`}
                            >
                              <Monitor className="h-3 w-3" />
                            </button>
                          )}

                          <div className="hidden items-center gap-0.5 group-hover:flex group-focus-within:flex [@media(hover:none)]:flex">
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
                                className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-sky-300 md:p-1"
                                aria-label={`Open ${h.name} as ${h.protocol === "ssh" ? "SFTP" : "SSH"}`}
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
                                setHostModalIntent(null);
                                setHostModalOpen(true);
                                setMobileSidebarOpen(false);
                              }}
                              className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-white md:p-1"
                              aria-label={`Edit ${h.name}`}
                              title="Edit host"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => void handleDeleteHost(h.id, e)}
                              className="rounded p-2 text-slate-400 hover:bg-rose-500/20 hover:text-rose-400 md:p-1"
                              aria-label={`Delete ${h.name}`}
                              title="Delete host"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
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
                      <span className="flex items-center gap-1.5"><Cloud className="h-3.5 w-3.5 text-sky-400" /> Google Cloud Firestore</span>
                      <span className={localCaps?.storageBackend === "firestore" ? "text-emerald-400" : "text-slate-400"}>
                        {localCaps?.storageBackend === "firestore" ? "Configured" : "Not active"}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                      {localCaps?.storageBackend === "firestore"
                        ? localCaps.serverVault ? "Encrypted vault sync is enabled for this deployment." : "Firestore is configured, but vault sync is disabled."
                        : localCaps?.serverVault
                          ? `Current vault storage: ${localCaps.storageBackend === "redis" ? "Redis" : localCaps.storageBackend === "disk" ? "server disk" : "shared storage"}. Configure Firestore in your hosting environment.`
                          : "Vault sync is disabled. Configure Firestore in your hosting environment."}
                    </p>
                    {localCaps?.storageBackend !== "firestore" && (
                      <a href="https://github.com/sarakplaystore/sushi#google-cloud-firestore" target="_blank" rel="noreferrer" className="mt-1 inline-block text-[10px] font-medium text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200">Firestore setup guide</a>
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
                className={`group flex max-w-[220px] shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                  active
                    ? "border-white/12 bg-[#171d2b] text-white"
                    : "border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  aria-current={active ? "page" : undefined}
                  className="flex min-w-0 items-center gap-2 text-left"
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} />
                  <span className="truncate font-medium">{tab.title}</span>
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
          {/* Launchpad Home View */}
          <div
            className={
              activeTabId === "launchpad"
                ? "h-full w-full overflow-y-auto p-4 sm:p-8"
                : "hidden"
            }
          >
            <div className="mx-auto max-w-5xl space-y-8">
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

              {vaultSyncError && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                  <span>{vaultSyncError}</span>
                  {accountVaultOutdated ? (
                    <button type="button" onClick={() => { setVaultModalTab("security"); setVaultModalOpen(true); }} className="rounded-lg bg-rose-500/20 px-3 py-1 font-semibold">Update sync password</button>
                  ) : (
                    <button type="button" onClick={() => {
                      if (!window.confirm("Reload the latest vault? Unsaved edits in open forms will be discarded.")) return;
                      setHostModalOpen(false); setVaultModalOpen(false); setEditingProfile(null);
                      void bootAuthenticatedWorkspace();
                    }} className="rounded-lg bg-rose-500/20 px-3 py-1 font-semibold">Reload latest vault</button>
                  )}
                </div>
              )}
              {localCaps && !localCaps.serverVault && (
                <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                  Shared vault storage is disabled or not configured. Saved connections can appear in other tabs of this browser, but not on other devices. {localCaps.mode === "vercel" ? "Connect persistent Redis REST storage to this Vercel project to enable cross-device sync. Keep this browser's data until migration is complete." : "Enable persistent shared vault storage to sync other devices."}
                </div>
              )}
              {localCaps?.serverVault && vaultKeySource !== "account" && !vaultSyncError && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                  <span>This vault uses {vaultMode === "device" ? "a device-only key" : "a separate passphrase"}. Use your account password to make saved connections available on your other devices.</span>
                  <button type="button" onClick={() => { setVaultModalTab("security"); setVaultModalOpen(true); }} className="rounded-lg bg-amber-500/20 px-3 py-1 font-semibold">Enable account sync</button>
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

                          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/6 pt-3">
                            <div className="flex flex-wrap items-center gap-1.5">
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
                              {h.protocol !== "rdp" && (
                                <button
                                  type="button"
                                  onClick={() => openRdpCompanion(h)}
                                  className="flex items-center gap-1 rounded-lg border border-[#ff6b57]/35 bg-[#ff6b57]/10 px-2.5 py-1 text-xs text-[#ff9587] transition hover:bg-[#ff6b57]/20"
                                  title="Open this host as an RDP desktop"
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
                                  setEditingProfile(h);
                                  setHostModalIntent(null);
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
                    onOpenRdp={() => openRdpCompanion(tab.profile)}
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
                    onOpenRdp={() => openRdpCompanion(tab.profile)}
                  />
                )}
                {tab.protocol === "rdp" && (
                  <RdpDesktopSession
                    profile={tab.profile}
                    isActive={isActive}
                    guacdAvailable={effectiveRdpGuacd}
                    gatewaySettings={gatewaySettings}
                    onOpenGatewayModal={() => setGatewayModalOpen(true)}
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
          await persistVault(
            hosts,
            snippets,
            undefined,
            undefined,
            nextKeys,
            enforceKeyWhitelist
          );
          setSshKeys(nextKeys);
        }}
        onClose={() => {
          setHostModalOpen(false);
          setEditingProfile(null);
          setHostModalIntent(null);
        }}
        onSave={handleSaveHostProfile}
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
        onSetPassphrase={async (pass) => {
          if (pass) {
            await persistVault(hosts, snippets, pass, "passphrase", undefined, undefined, "independent");
            setVaultMode("passphrase");
            setVaultKeySource("independent");
            setAccountVaultOutdated(false);
            setActivePassphrase(pass);
          } else {
            await persistVault(hosts, snippets, null, "device", undefined, undefined, "independent");
            setVaultMode("device");
            setVaultKeySource("independent");
            setAccountVaultOutdated(false);
            setActivePassphrase(null);
          }
        }}
        onEnableAccountSync={async (password) => {
          if (!localCaps?.serverVault) throw new Error("Persistent shared vault storage is not enabled.");
          await persistVault(hosts, snippets, password, "passphrase", undefined, undefined, "account");
          accountPasswordRef.current = password;
          setVaultMode("passphrase");
          setVaultKeySource("account");
          setActivePassphrase(password);
          setAccountVaultOutdated(false);
          setVaultSyncError(null);
        }}
        onLockNow={() => {
          accountPasswordRef.current = null;
          setActivePassphrase(null);
          setVaultLocked(true);
        }}
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
          await persistVault(
            plain.hosts,
            plain.snippets,
            undefined,
            undefined,
            nextKeys,
            nextEnforce
          );
          setHosts(plain.hosts);
          setSnippets(plain.snippets);
          setSshKeys(nextKeys);
          setEnforceKeyWhitelist(nextEnforce);
        }}
        onUpdateKeychain={async (nextKeys, nextEnforce) => {
          await persistVault(
            hosts,
            snippets,
            undefined,
            undefined,
            nextKeys,
            nextEnforce
          );
          setSshKeys(nextKeys);
          setEnforceKeyWhitelist(nextEnforce);
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

          await persistVault(
            mergedHosts,
            mergedSnippets,
            undefined,
            undefined,
            mergedKeys,
            enforceKeyWhitelist
          );
          setHosts(mergedHosts);
          setSshKeys(mergedKeys);
          setSnippets(mergedSnippets);
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
          setAccountModalOpen(false);
          setTabs([]);
          setActiveTabId("launchpad");
          setVaultReady(false);
          accountPasswordRef.current = null;
          setActivePassphrase(null);
          setUnlockInput("");
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
