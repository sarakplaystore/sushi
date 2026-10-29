export type ProtocolType = "ssh" | "sftp" | "rdp";

export type AuthMethod = "password" | "privateKey";

export type RdpSecurityMode = "any" | "nla" | "tls" | "rdp";

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
  // RDP specific options
  domain?: string;
  rdpSecurity?: RdpSecurityMode;
  ignoreCert?: boolean;
  rdpWidth?: number;
  rdpHeight?: number;
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

export interface SshTestResult {
  ok: boolean;
  latencyMs: number;
  serverBanner?: string;
  fingerprint?: string;
  systemInfo?: {
    hostname?: string;
    os?: string;
    kernel?: string;
    uptime?: string;
    load?: string;
    memory?: string;
  };
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
