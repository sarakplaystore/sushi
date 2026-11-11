import type { HostProfile } from "@/types/connection";
import { unifiedHostKey } from "./unified-hosts";

/**
 * Keeps a machine's data consistent once its profiles are shown as one entry
 * ("fix all data process").
 *
 * Sushi saves one profile per connection, so one server can be three profiles (SSH,
 * SFTP, RDP). The unified list merges them, which raises two problems that used to be
 * invisible:
 *
 *  1. **Identity drift.** Edit the SSH entry's host or username and it silently leaves
 *     the group — the RDP and SFTP entries still point at the old address, so one
 *     machine becomes two half-broken entries. {@link applyIdentityChange} moves the
 *     machine's siblings with it (or reports the conflict when the new address is
 *     already taken).
 *  2. **Delete leftovers.** Deleting the row on screen used to remove a single profile
 *     and leave the other two behind. {@link siblingsOf} finds them so the UI can
 *     offer "delete this machine" and so the fallback delete path can clean up.
 *
 * Nothing here talks to storage: the caller persists the returned list through the
 * normal vault path, so encryption, revision checks and sync stay exactly as they were.
 */

/** Address fields that define which machine a profile belongs to. */
export interface HostIdentity {
  host: string;
  username: string;
}

/** Any profile-shaped object with an address (protocol/port are ignored). */
export type MachineLike = HostIdentity & Partial<HostProfile>;

const sameText = (a?: string, b?: string) =>
  (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();

/** True when two profiles describe the same machine + account. */
export function sameMachine(a: MachineLike, b: MachineLike): boolean {
  return unifiedHostKey(a) === unifiedHostKey(b);
}

/**
 * The other saved profiles of the same machine (all protocols, excluding `profile`
 * itself by id).
 */
export function siblingsOf(hosts: HostProfile[], profile: HostProfile): HostProfile[] {
  return hosts.filter(
    (other) => other.id !== profile.id && sameMachine(other, profile)
  );
}

export interface IdentityChangeResult {
  /** The host list to persist (the edited profile plus any moved siblings). */
  hosts: HostProfile[];
  /** Siblings that were moved with the machine. */
  moved: HostProfile[];
  /** A sibling already uses the new address: the change must not be saved blindly. */
  conflict?: HostProfile;
}

/**
 * Applies a saved profile to the vault list, keeping the whole machine together.
 *
 * - The profile is updated in place when its id exists, otherwise inserted (new host).
 * - If its host or username changed, the machine's siblings follow, so SSH/SFTP/RDP
 *   never drift apart.
 * - If a *different* machine already lives at the new address, `conflict` is returned
 *   and the caller should ask before merging two machines into one entry.
 */
export function applyIdentityChange(
  hosts: HostProfile[],
  profile: HostProfile,
  options: { moveSiblings?: boolean } = {}
): IdentityChangeResult {
  const existing = hosts.find((host) => host.id === profile.id);
  const moveSiblings = options.moveSiblings !== false;

  // A brand-new host: nothing to move, but still detect "this machine already exists".
  if (!existing) {
    const clash = hosts.find((host) => sameMachine(host, profile) && host.id !== profile.id);
    return {
      hosts: [profile, ...hosts],
      moved: [],
      // Same machine but a different protocol is fine (that is how a host gets SFTP);
      // the same machine *and* protocol is a duplicate.
      ...(clash && clash.protocol === profile.protocol ? { conflict: clash } : {}),
    };
  }

  const identityChanged =
    !sameText(existing.host, profile.host) || !sameText(existing.username, profile.username);
  const oldIdentity: HostIdentity = { host: existing.host, username: existing.username };

  // Does another machine already sit at the destination?
  const destination = hosts.filter(
    (host) =>
      host.id !== profile.id &&
      sameMachine(host, profile) &&
      // Siblings of the *old* identity are ours to move, not a conflict.
      !(moveSiblings && sameMachine(host, oldIdentity))
  );
  const conflict = destination.find((host) => host.protocol === profile.protocol) ?? destination[0];

  const moved: HostProfile[] = [];
  const next = hosts.map((host) => {
    if (host.id === profile.id) return profile;
    if (!identityChanged || !moveSiblings) return host;
    if (!sameMachine(host, oldIdentity)) return host;
    const updated: HostProfile = {
      ...host,
      host: profile.host,
      username: profile.username,
      updatedAt: Math.max(host.updatedAt || 0, Date.now()),
    };
    moved.push(updated);
    return updated;
  });

  return { hosts: next, moved, ...(conflict && identityChanged ? { conflict } : {}) };
}

/**
 * Removes every profile of a machine (or just one protocol when `protocols` is given).
 * Used by "Delete this machine" in the unified list.
 */
export function removeMachine(
  hosts: HostProfile[],
  profile: HostProfile,
  options: { protocols?: Array<HostProfile["protocol"]> } = {}
): { hosts: HostProfile[]; removed: HostProfile[] } {
  const removed: HostProfile[] = [];
  const next = hosts.filter((host) => {
    if (!sameMachine(host, profile)) return true;
    // A protocol-scoped delete keeps the machine (e.g. remove its RDP profile only).
    if (options.protocols && !options.protocols.includes(host.protocol)) return true;
    removed.push(host);
    return false;
  });
  return { hosts: next, removed };
}

/** Human summary for the delete confirmation, e.g. "SSH and RDP". */
export function describeProtocols(profiles: HostProfile[]): string {
  const names = [...new Set(profiles.map((profile) => profile.protocol.toUpperCase()))];
  if (names.length <= 1) return names[0] || "this connection";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
