export type ProtocolType = "ssh" | "sftp" | "rdp";

export type AuthMethod = "password" | "privateKey";

export type RdpSecurityMode = "any" | "nla" | "tls" | "rdp";

/**
 * How much eye candy the RDP server is allowed to send.
 *
 * `best` keeps wallpaper, themes, font smoothing and lossless updates; `fast` drops
 * all of it and uses 16-bit colour for slow links; `balanced` is the default.
 */
export type RdpPerformance = "best" | "balanced" | "fast";

export interface WhitelistedSshKey {
  id: string;
  name: string;
  privateKey: string;
  passphrase?: string;
  publicKey?: string;
  keyType?: string;
  fingerprint?: string;
  createdAt: number;
}

export interface HostProfile {
  id: string;
  name: string;
  protocol: ProtocolType;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sshKeyId?: string;
  // RDP specific options
  domain?: string;
  rdpSecurity?: RdpSecurityMode;
  ignoreCert?: boolean;
  rdpWidth?: number;
  rdpHeight?: number;
  /** Picture preset pinned to this host (unset = the browser's last choice). */
  rdpPerformance?: RdpPerformance;
  /** Play the desktop's audio (default on). */
  rdpAudio?: boolean;
  /** Redirect a drive so files can be dropped into the session (default on). */
  rdpDrive?: boolean;
  // SFTP specific options
  initialPath?: string;
  // Organization
  group?: string;
  tags?: string[];
  accentColor?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  lastConnectedAt?: number;
}

export interface ConnectionCredentials {
  host: string;
  port: number;
  username: string;
  authMethod?: AuthMethod;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  domain?: string;
  rdpSecurity?: RdpSecurityMode;
  ignoreCert?: boolean;
  width?: number;
  height?: number;
  /** Display quality preset (see `RdpPerformance`). */
  rdpPerformance?: RdpPerformance;
  /** Stream the remote's audio to this browser. */
  rdpAudio?: boolean;
  /** View-only session: the remote ignores keyboard and mouse. */
  rdpReadOnly?: boolean;
  /** Redirect a drive into the session so files can be uploaded to it. */
  rdpDrive?: boolean;
  /** Machine name the remote session shows (Task Manager, drive label, …). */
  rdpClientName?: string;
  /** IANA zone for the remote clock, e.g. "Asia/Phnom_Penh". */
  timezone?: string;
  dpi?: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  permissions: string;
  octal: string;
  mtime: number;
  atime: number;
  uid: number;
  gid: number;
}

/**
 * What the remote machine is: distro + version (`Ubuntu 24.04.1 LTS`) and, when it
 * can be recognised, the cloud provider it is hosted on (`Oracle Cloud`, `AWS EC2`,
 * `Hetzner Cloud`, `KVM VPS`, …). Shown in the SSH session header after connecting.
 */
export interface SshSystemInfo {
  hostname?: string;
  /** `PRETTY_NAME` from `/etc/os-release`, e.g. "Ubuntu 24.04.1 LTS". */
  os?: string;
  /** `NAME`, e.g. "Ubuntu". */
  distro?: string;
  /** `VERSION_ID`, e.g. "24.04". */
  version?: string;
  /** `VERSION_CODENAME`, e.g. "noble". */
  codename?: string;
  kernel?: string;
  arch?: string;
  uptime?: string;
  load?: string;
  /** Cores reported by `nproc`. */
  cpu?: number;
  memoryMb?: number;
  /** Human label for the hosting platform ("Oracle Cloud", "KVM VPS", …). */
  provider?: string;
  /** Raw platform id (cloud-init datasource id, virtualization type, …). */
  providerId?: string;
  /** `systemd-detect-virt` output ("kvm", "none", …). */
  virtualization?: string;
}

export interface SshTestResult {
  ok: boolean;
  latencyMs: number;
  serverBanner?: string;
  fingerprint?: string;
  systemInfo?: SshSystemInfo;
  error?: string;
}

export interface RdpProbeResult {
  ok: boolean;
  reachable: boolean;
  latencyMs: number;
  host: string;
  port: number;
  negotiatedProtocol?: string;
  supportedProtocols: string[];
  nlaRequired: boolean;
  tlsSupported: boolean;
  certificate?: {
    subjectCN?: string;
    issuerCN?: string;
    validFrom?: string;
    validTo?: string;
    fingerprint256?: string;
  };
  failureCode?: string;
  error?: string;
}

export interface SystemCapabilities {
  mode: "vps" | "vercel" | "gateway";
  websocketSsh: boolean;
  serverlessSshExec: boolean;
  serverlessSftp: boolean;
  rdpGuacd: boolean;
  rdpProbe: boolean;
  serverVault: boolean;
  storageBackend?: "disk" | "redis" | "turso" | "firestore" | "none";
  requiresGatewayToken: boolean;
  guacdHost?: string;
  nodeVersion: string;
  region?: string;
}

export interface CommandSnippet {
  id: string;
  title: string;
  command: string;
  category: string;
  description?: string;
}

export interface SessionTab {
  id: string;
  title: string;
  protocol: ProtocolType;
  profile: HostProfile;
  createdAt: number;
  initialPath?: string;
}
