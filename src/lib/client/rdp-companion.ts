/**
 * "Open via RDP": the same machine, reached as a desktop.
 *
 * Sushi stores one profile per host, so a host saved for SSH/SFTP can be opened
 * as an RDP desktop without duplicating it in the vault. The companion profile
 * is derived on the fly and never persisted:
 *
 *   - the desktop port is 3389 (or the profile's own port when it already *is*
 *     an RDP host), so an SSH host on 2222 does not try to speak RDP on 2222;
 *   - SSH-only material (private key, passphrase, keychain id, SFTP start path)
 *     is dropped, so no key ever travels to the RDP bridge;
 *   - RDP options the profile already carries (domain, security mode, size,
 *     ignore-certificate flag, password) are kept as-is.
 */

import type { HostProfile } from "@/types/connection";

export const DEFAULT_RDP_PORT = 3389;

export interface RdpCompanionOptions {
  /** Port to use when the source profile is not already an RDP host. */
  port?: number;
}

/**
 * Builds the profile a "Open via RDP" button connects with.
 * Pure: the source profile is not mutated.
 */
export function buildRdpCompanionProfile(
  source: HostProfile,
  options: RdpCompanionOptions = {}
): HostProfile {
  const alreadyRdp = source.protocol === "rdp";
  return {
    ...source,
    protocol: "rdp",
    port: alreadyRdp ? source.port : (options.port ?? DEFAULT_RDP_PORT),
    // RDP only ever authenticates with a password.
    authMethod: "password",
    privateKey: undefined,
    passphrase: undefined,
    sshKeyId: undefined,
    initialPath: undefined,
    accentColor: alreadyRdp ? source.accentColor : "#ff6b57",
    updatedAt: Date.now(),
  };
}

/**
 * Draft handed to the connection dialog when the user wants to fix the RDP
 * credentials of a companion session. It has no `id`, so saving it creates a
 * separate RDP host instead of rewriting the SSH entry it came from.
 */
export function buildRdpCompanionDraft(source: HostProfile): Partial<HostProfile> {
  const companion = buildRdpCompanionProfile(source);
  const draft: Partial<HostProfile> = { ...companion };
  delete draft.id;
  delete draft.createdAt;
  const baseName = source.name.replace(/\s*\(RDP\)$/i, "");
  draft.name = `${baseName} (RDP)`;
  return draft;
}

/** Tab title, so the SSH tab and its RDP twin are told apart at a glance. */
export function rdpCompanionTitle(source: HostProfile): string {
  return source.protocol === "rdp" ? source.name : `${source.name} (RDP)`;
}
