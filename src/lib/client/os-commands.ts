import type { CommandSnippet, SshSystemInfo } from "@/types/connection";

/**
 * "What OS is this, exactly?" — one-tap commands per distribution.
 *
 * Sushi already shows the remote distro in the session header (see
 * `@/lib/server/sysinfo`), but the commands that produce that answer differ per
 * family: `lsb_release -a` on Ubuntu/Debian, `/etc/redhat-release` on Rocky/Alma,
 * `/etc/alpine-release` on Alpine, and so on. These snippets are the manual
 * equivalents, so you can re-check a host by hand — or confirm a box that a
 * restricted shell hides from the automatic probe.
 *
 * Everything here is read-only and runs as the login user: no package installs,
 * no `sudo`, no network access. Each command is written to work on a stock
 * install of its distro, with a fallback when the usual tool is missing.
 */

/** Snippet categories, in the order they appear in the Snippets popover. */
export const OS_SNIPPET_CATEGORIES = {
  /** Portable POSIX probe that works on every Linux. */
  anyLinux: "OS · Any Linux",
  ubuntu: "OS · Ubuntu",
  debian: "OS · Debian",
  rhel: "OS · RHEL / Rocky / Alma",
  fedora: "OS · Fedora",
  arch: "OS · Arch",
  alpine: "OS · Alpine",
  suse: "OS · SUSE / openSUSE",
  amazon: "OS · Amazon Linux",
} as const;

export type OsFlavour = keyof typeof OS_SNIPPET_CATEGORIES;

/** `README`-style label for a flavour, e.g. "Ubuntu" or "RHEL / Rocky / Alma". */
export function osFlavourLabel(flavour: OsFlavour): string {
  return OS_SNIPPET_CATEGORIES[flavour].replace(/^OS · /, "");
}

function snippet(
  id: string,
  title: string,
  command: string,
  category: string,
  description: string
): CommandSnippet {
  return { id, title, command, category, description };
}

/**
 * The portable probe. `os-release` is the one file systemd distros agree on, and
 * `/usr/lib/os-release` is the fallback usr-merge images use when `/etc` has no
 * copy. `uname` covers anything without os-release at all.
 */
const ANY_LINUX_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-release",
    "Distro & version (any Linux)",
    `(cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null || printf 'NAME=%s\\n' "$(uname -s)") | grep -E '^(PRETTY_NAME|NAME|VERSION|VERSION_ID|VERSION_CODENAME|ID)='`,
    OS_SNIPPET_CATEGORIES.anyLinux,
    "PRETTY_NAME, VERSION_ID and codename from /etc/os-release — the same file Sushi's OS badge reads"
  ),
  snippet(
    "snip-os-kernel",
    "Kernel & architecture",
    "uname -srm && printf 'libc: %s\\n' \"$(ldd --version 2>&1 | head -n 1)\"",
    OS_SNIPPET_CATEGORIES.anyLinux,
    "Kernel release, machine architecture and the libc family (glibc or musl)"
  ),
  snippet(
    "snip-os-host",
    "Host, uptime & load",
    "hostnamectl 2>/dev/null || (hostname && uptime)",
    OS_SNIPPET_CATEGORIES.anyLinux,
    "hostnamectl prints the OS, kernel, architecture and virtualisation in one block"
  ),
  snippet(
    "snip-os-platform",
    "Cloud / VM platform",
    "cat /run/cloud-init/cloud-id 2>/dev/null; systemd-detect-virt 2>/dev/null; cat /sys/class/dmi/id/sys_vendor 2>/dev/null",
    OS_SNIPPET_CATEGORIES.anyLinux,
    "cloud-init datasource, hypervisor and firmware vendor — how Sushi labels Oracle/AWS/Hetzner/KVM"
  ),
  snippet(
    "snip-os-resources",
    "CPU & memory",
    "nproc && (free -h 2>/dev/null || head -n 3 /proc/meminfo)",
    OS_SNIPPET_CATEGORIES.anyLinux,
    "Core count plus total/used RAM, with /proc/meminfo as the fallback"
  ),
];

const UBUNTU_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-ubuntu-lsb",
    "Ubuntu version (lsb_release)",
    "lsb_release -a 2>/dev/null || cat /etc/os-release",
    OS_SNIPPET_CATEGORIES.ubuntu,
    "The classic Ubuntu answer: distributor, release, codename — same output as `lsb_release -a`"
  ),
  snippet(
    "snip-os-ubuntu-codename",
    "Ubuntu codename",
    "(. /etc/os-release 2>/dev/null; printf '%s\\n' \"${UBUNTU_CODENAME:-$VERSION_CODENAME}\")",
    OS_SNIPPET_CATEGORIES.ubuntu,
    "Release codename (noble, jammy, focal …) for apt sources and PPAs"
  ),
  snippet(
    "snip-os-ubuntu-kernel",
    "Ubuntu kernel & installed images",
    "uname -r; dpkg -l 'linux-image-*' 2>/dev/null | awk '$1 == \"ii\" { print $2, $3 }'",
    OS_SNIPPET_CATEGORIES.ubuntu,
    "Running kernel plus every installed linux-image package — shows HWE and leftover kernels"
  ),
  snippet(
    "snip-os-ubuntu-upgrade",
    "Ubuntu release upgrade (check)",
    "command -v do-release-upgrade >/dev/null 2>&1 && do-release-upgrade -c || printf 'update-manager-core is not installed\\n'",
    OS_SNIPPET_CATEGORIES.ubuntu,
    "Asks the Ubuntu release server whether a newer LTS is available; changes nothing"
  ),
];

const DEBIAN_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-debian-release",
    "Debian version",
    "cat /etc/debian_version && (. /etc/os-release 2>/dev/null; printf '%s (%s)\\n' \"$PRETTY_NAME\" \"$VERSION_CODENAME\")",
    OS_SNIPPET_CATEGORIES.debian,
    "Point release from /etc/debian_version plus the pretty name and codename"
  ),
  snippet(
    "snip-os-debian-lsb",
    "Debian release (lsb_release)",
    "lsb_release -a 2>/dev/null || hostnamectl 2>/dev/null",
    OS_SNIPPET_CATEGORIES.debian,
    "lsb_release when installed, hostnamectl otherwise"
  ),
  snippet(
    "snip-os-debian-policy",
    "Debian apt sources",
    "grep -rhE '^[[:space:]]*deb ' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null | head -n 10",
    OS_SNIPPET_CATEGORIES.debian,
    "The first ten configured apt repositories — confirms stable/bookworm vs testing"
  ),
];

const RHEL_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-rhel-release",
    "RHEL / Rocky / Alma version",
    "cat /etc/redhat-release 2>/dev/null || cat /etc/system-release 2>/dev/null",
    OS_SNIPPET_CATEGORIES.rhel,
    "One line with the family and version, e.g. `Rocky Linux release 9.4 (Blue Onyx)`"
  ),
  snippet(
    "snip-os-rhel-detail",
    "RHEL family details",
    "rpm -E '%{rhel} %{dist}' 2>/dev/null; (. /etc/os-release 2>/dev/null; printf '%s %s (%s)\\n' \"$NAME\" \"$VERSION_ID\" \"$VERSION_CODENAME\")",
    OS_SNIPPET_CATEGORIES.rhel,
    "Major version macro plus NAME/VERSION_ID — tells Rocky from Alma from genuine RHEL"
  ),
  snippet(
    "snip-os-rhel-packages",
    "RHEL family updates (check)",
    "(command -v dnf >/dev/null 2>&1 && dnf -q check-update) || (command -v yum >/dev/null 2>&1 && yum -q check-update) || printf 'no dnf/yum available\\n'",
    OS_SNIPPET_CATEGORIES.rhel,
    "Lists pending updates without installing anything"
  ),
];

const FEDORA_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-fedora-release",
    "Fedora version",
    "cat /etc/fedora-release && (. /etc/os-release 2>/dev/null; printf '%s\\n' \"$PRETTY_NAME\")",
    OS_SNIPPET_CATEGORIES.fedora,
    "Fedora release number plus the pretty name"
  ),
  snippet(
    "snip-os-fedora-updates",
    "Fedora updates (check)",
    "dnf -q check-update 2>/dev/null || printf 'no dnf available\\n'",
    OS_SNIPPET_CATEGORIES.fedora,
    "Pending dnf updates, nothing installed"
  ),
  snippet(
    "snip-os-fedora-kernel",
    "Fedora kernel",
    "uname -r && rpm -q kernel 2>/dev/null",
    OS_SNIPPET_CATEGORIES.fedora,
    "Running kernel and every installed kernel package"
  ),
];

const ARCH_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-arch-release",
    "Arch version",
    "cat /etc/arch-release 2>/dev/null || echo 'Arch Linux (rolling release)'",
    OS_SNIPPET_CATEGORIES.arch,
    "Arch has no version number — the release file is empty, so this also prints the model"
  ),
  snippet(
    "snip-os-arch-kernel",
    "Arch kernel package",
    "uname -r && pacman -Q linux linux-lts linux-zen linux-hardened 2>/dev/null",
    OS_SNIPPET_CATEGORIES.arch,
    "Which installed kernel package matches the running kernel"
  ),
  snippet(
    "snip-os-arch-count",
    "Arch package count & last upgrade",
    "pacman -Q | wc -l; grep -E 'starting full system upgrade|upgraded ' /var/log/pacman.log 2>/dev/null | tail -n 3",
    OS_SNIPPET_CATEGORIES.arch,
    "Number of installed packages and the most recent upgrade entries from pacman.log"
  ),
];

const ALPINE_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-alpine-release",
    "Alpine version",
    "cat /etc/alpine-release 2>/dev/null; (. /etc/os-release 2>/dev/null; printf '%s\\n' \"$PRETTY_NAME\")",
    OS_SNIPPET_CATEGORIES.alpine,
    "Alpine's short version (3.20.x) plus the pretty name from os-release"
  ),
  snippet(
    "snip-os-alpine-repos",
    "Alpine repositories",
    "cat /etc/apk/repositories 2>/dev/null && apk --version 2>/dev/null",
    OS_SNIPPET_CATEGORIES.alpine,
    "Enabled apk repositories (main/community) and the apk version"
  ),
  snippet(
    "snip-os-alpine-libc",
    "Alpine libc (musl)",
    "ldd --version 2>&1 | head -n 1; apk info -v musl 2>/dev/null",
    OS_SNIPPET_CATEGORIES.alpine,
    "Confirms the musl libc version — the usual reason prebuilt glibc binaries fail here"
  ),
];

const SUSE_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-suse-release",
    "SUSE / openSUSE version",
    "cat /etc/os-release 2>/dev/null | grep -E '^(NAME|VERSION|VERSION_ID|PRETTY_NAME)='",
    OS_SNIPPET_CATEGORIES.suse,
    "SUSE Linux Enterprise and openSUSE both describe themselves in os-release"
  ),
  snippet(
    "snip-os-suse-brand",
    "SUSE brand & products",
    "cat /etc/SUSE-brand 2>/dev/null; command -v SUSEConnect >/dev/null 2>&1 && SUSEConnect --status-text 2>/dev/null",
    OS_SNIPPET_CATEGORIES.suse,
    "Brand file and SLES registration status, when the host is registered"
  ),
  snippet(
    "snip-os-suse-updates",
    "SUSE updates (check)",
    "zypper --quiet list-updates 2>/dev/null || printf 'no zypper available\\n'",
    OS_SNIPPET_CATEGORIES.suse,
    "Pending zypper updates without installing them"
  ),
];

const AMAZON_SNIPPETS: CommandSnippet[] = [
  snippet(
    "snip-os-amazon-release",
    "Amazon Linux version",
    "cat /etc/system-release 2>/dev/null; rpm -q system-release 2>/dev/null",
    OS_SNIPPET_CATEGORIES.amazon,
    "Amazon Linux 2 vs 2023 vs the older AMI, straight from the system-release package"
  ),
  snippet(
    "snip-os-amazon-family",
    "Amazon Linux family",
    "(. /etc/os-release 2>/dev/null; printf 'ID=%s VERSION_ID=%s\\n' \"$ID\" \"$VERSION_ID\"); command -v dnf >/dev/null 2>&1 && echo 'package manager: dnf' || echo 'package manager: yum'",
    OS_SNIPPET_CATEGORIES.amazon,
    "Amazon Linux 2023 is dnf-based while Amazon Linux 2 uses yum"
  ),
];

/**
 * Every OS snippet, grouped in popover order: the portable probe first (it works
 * anywhere), then one group per distribution.
 */
export const OS_COMMAND_SNIPPETS: CommandSnippet[] = [
  ...ANY_LINUX_SNIPPETS,
  ...UBUNTU_SNIPPETS,
  ...DEBIAN_SNIPPETS,
  ...RHEL_SNIPPETS,
  ...FEDORA_SNIPPETS,
  ...ARCH_SNIPPETS,
  ...ALPINE_SNIPPETS,
  ...SUSE_SNIPPETS,
  ...AMAZON_SNIPPETS,
];

/** Category → the flavours whose snippets live in it (for the header chip). */
const CATEGORY_FLAVOURS: Record<string, OsFlavour[]> = {
  [OS_SNIPPET_CATEGORIES.anyLinux]: ["anyLinux"],
  [OS_SNIPPET_CATEGORIES.ubuntu]: ["ubuntu"],
  [OS_SNIPPET_CATEGORIES.debian]: ["debian"],
  [OS_SNIPPET_CATEGORIES.rhel]: ["rhel"],
  [OS_SNIPPET_CATEGORIES.fedora]: ["fedora"],
  [OS_SNIPPET_CATEGORIES.arch]: ["arch"],
  [OS_SNIPPET_CATEGORIES.alpine]: ["alpine"],
  [OS_SNIPPET_CATEGORIES.suse]: ["suse"],
  [OS_SNIPPET_CATEGORIES.amazon]: ["amazon"],
};

/**
 * Distro fingerprints, most specific first (a Red Hat derivative also matches
 * "Red Hat", so the RHEL family is checked before anything generic).
 */
const FLAVOUR_MATCHERS: Array<{ flavour: OsFlavour; patterns: RegExp[] }> = [
  { flavour: "ubuntu", patterns: [/\bubuntu\b/] },
  { flavour: "debian", patterns: [/\bdebian\b/] },
  {
    flavour: "rhel",
    patterns: [/\bred hat\b/, /\brhel\b/, /\brocky\b/, /\balma(linux)?\b/, /\bcentos\b/, /\bol\b/],
  },
  { flavour: "fedora", patterns: [/\bfedora\b/] },
  { flavour: "arch", patterns: [/\barch\b/, /\bmanjaro\b/, /\bendeavou?ros\b/] },
  { flavour: "alpine", patterns: [/\balpine\b/] },
  { flavour: "suse", patterns: [/\bsuse\b/, /\bsles\b/, /\bsled\b/, /\bopensuse\b/] },
  { flavour: "amazon", patterns: [/\bamazon linux\b/, /\bamzn\b/] },
];

/**
 * Works out which family the connected host belongs to, so the Snippets popover
 * can flag the matching group as "this host". Returns null when unknown
 * (macOS, BSD, a restricted shell that hid os-release).
 */
export function detectOsFlavour(info: SshSystemInfo | null | undefined): OsFlavour | null {
  if (!info) return null;
  const haystack = [info.distro, info.os, info.codename, info.providerId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return null;
  for (const { flavour, patterns } of FLAVOUR_MATCHERS) {
    if (patterns.some((pattern) => pattern.test(haystack))) return flavour;
  }
  return null;
}

/** Snippet category for a detected flavour, e.g. `OS · Ubuntu`. */
export function osSnippetCategory(flavour: OsFlavour | null | undefined): string | null {
  return flavour ? OS_SNIPPET_CATEGORIES[flavour] : null;
}

/** Convenience for the terminal header: `OS · Ubuntu` for the connected host. */
export function osSnippetCategoryFor(info: SshSystemInfo | null | undefined): string | null {
  return osSnippetCategory(detectOsFlavour(info));
}

/** True when a snippet group is the connected host's own family. */
export function isSnippetCategoryForHost(
  category: string,
  info: SshSystemInfo | null | undefined
): boolean {
  const target = osSnippetCategoryFor(info);
  if (!target || category !== target) return false;
  // The portable probe always applies, but it is not "the host's family".
  return target !== OS_SNIPPET_CATEGORIES.anyLinux;
}

/** A run of snippets sharing a category, in first-seen order. */
export interface SnippetGroup {
  category: string;
  snippets: CommandSnippet[];
}

/**
 * Groups snippets by category for the popover, keeping the order in which each
 * category first appears (so the built-in list stays Diagnostics → Containers →
 * Network → … and imported Termix folders land at the end).
 */
export function groupSnippetsByCategory(snippets: CommandSnippet[]): SnippetGroup[] {
  const groups: SnippetGroup[] = [];
  const index = new Map<string, SnippetGroup>();
  for (const item of snippets) {
    const category = (item.category || "Other").trim() || "Other";
    let group = index.get(category);
    if (!group) {
      group = { category, snippets: [] };
      index.set(category, group);
      groups.push(group);
    }
    group.snippets.push(item);
  }
  return groups;
}

/**
 * Adds the OS commands to an existing snippet list (used when a vault predates
 * them) without touching the user's own snippets: an OS snippet is only added
 * when its id is not present yet. Returns the original array when nothing is new.
 */
export function mergeOsCommandSnippets(snippets: CommandSnippet[]): CommandSnippet[] {
  const ids = new Set(snippets.map((item) => item.id));
  const additions = OS_COMMAND_SNIPPETS.filter((item) => !ids.has(item.id));
  return additions.length ? [...snippets, ...additions] : snippets;
}

/** Categories that belong to the built-in OS command set. */
export function isOsSnippetCategory(category: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATEGORY_FLAVOURS, category);
}
