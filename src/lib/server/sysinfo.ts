import type { SshSystemInfo } from "@/types/connection";

/**
 * One SSH exec that describes the machine you just connected to.
 *
 * The point is to answer "what am I on?" for self-hosted VPS boxes (Oracle Cloud,
 * AWS, Hetzner, DigitalOcean …): the distro + version (`Ubuntu 24.04.1 LTS`) and,
 * where it can be told apart, the cloud provider. Everything is read from files that
 * every Linux image has (`/etc/os-release`, `/proc`, `/sys/class/dmi/id`) plus
 * cloud-init's `cloud-id`, so it needs no root, no extra packages and no outbound
 * network from the host.
 *
 * Output is `KEY=value` lines so a single round trip is enough.
 */
export const SYSINFO_SCRIPT = [
  `printf 'HOST=%s\\n' "$(hostname 2>/dev/null || uname -n 2>/dev/null)"`,
  `printf 'PRETTY=%s\\n' "$( . /etc/os-release 2>/dev/null; printf '%s' "$PRETTY_NAME" )"`,
  `printf 'DISTRO=%s\\n' "$( . /etc/os-release 2>/dev/null; printf '%s' "\${NAME:-$ID}" )"`,
  `printf 'VERSION=%s\\n' "$( . /etc/os-release 2>/dev/null; printf '%s' "\${VERSION_ID:-}" )"`,
  `printf 'CODENAME=%s\\n' "$( . /etc/os-release 2>/dev/null; printf '%s' "\${VERSION_CODENAME:-\${UBUNTU_CODENAME:-}}" )"`,
  `printf 'KERNEL=%s\\n' "$(uname -sr 2>/dev/null)"`,
  `printf 'ARCH=%s\\n' "$(uname -m 2>/dev/null)"`,
  `printf 'UPTIME=%s\\n' "$(uptime -p 2>/dev/null || uptime 2>/dev/null)"`,
  `printf 'CPU=%s\\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"`,
  `printf 'MEM_MB=%s\\n' "$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)"`,
  `printf 'LOAD=%s\\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"`,
  `printf 'CLOUD_ID=%s\\n' "$(cat /run/cloud-init/cloud-id 2>/dev/null)"`,
  `printf 'DMI_VENDOR=%s\\n' "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"`,
  `printf 'DMI_PRODUCT=%s\\n' "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"`,
  `printf 'DMI_BOARD=%s\\n' "$(cat /sys/class/dmi/id/board_vendor 2>/dev/null)"`,
  `printf 'DMI_ASSET=%s\\n' "$(cat /sys/class/dmi/id/chassis_asset_tag 2>/dev/null)"`,
  `printf 'VIRT=%s\\n' "$(systemd-detect-virt 2>/dev/null)"`,
].join("; ");

export interface SysinfoSignals {
  /** cloud-init datasource (`oraclecloud`, `aws`, `gce`, `azure`, …). */
  cloudId?: string;
  dmiVendor?: string;
  dmiProduct?: string;
  dmiBoard?: string;
  dmiAsset?: string;
  /** `systemd-detect-virt` output: `kvm`, `none`, `microsoft`, … */
  virtualization?: string;
}

/**
 * Ordered list of provider fingerprints.
 *
 * `cloud-id` is authoritative when present (cloud-init writes it for the provider
 * that booted the instance), so it is tried first; the DMI strings cover images
 * without cloud-init. Matching is case-insensitive and needs only a substring,
 * because every provider spells its own firmware differently ("OracleCloud.com",
 * "Amazon EC2", "Google Compute Engine", "Hetzner", …).
 */
const PROVIDER_MATCHERS: Array<{
  id: string;
  label: string;
  /** cloud-init datasource ids. */
  cloudIds?: string[];
  /** Substrings found in DMI vendor/product/board/asset strings. */
  markers?: string[];
}> = [
  {
    id: "oraclecloud",
    label: "Oracle Cloud",
    cloudIds: ["oraclecloud", "oracle", "oci"],
    markers: ["oraclecloud", "oracle cloud", "oracle"],
  },
  {
    id: "aws",
    label: "AWS EC2",
    cloudIds: ["aws", "ec2", "amazon"],
    markers: ["amazon", "aws"],
  },
  {
    id: "gce",
    label: "Google Cloud",
    cloudIds: ["gce", "gcp", "google"],
    markers: ["google"],
  },
  {
    id: "azure",
    label: "Microsoft Azure",
    cloudIds: ["azure", "azure-*"],
    markers: ["microsoft corporation", "microsoft"],
  },
  {
    id: "digitalocean",
    label: "DigitalOcean",
    cloudIds: ["digitalocean"],
    markers: ["digitalocean", "digital ocean"],
  },
  {
    id: "hetzner",
    label: "Hetzner Cloud",
    cloudIds: ["hetzner"],
    markers: ["hetzner"],
  },
  {
    id: "linode",
    label: "Akamai / Linode",
    cloudIds: ["linode", "akamai"],
    markers: ["linode", "akamai"],
  },
  {
    id: "vultr",
    label: "Vultr",
    cloudIds: ["vultr"],
    markers: ["vultr", "the constant company"],
  },
  {
    id: "scaleway",
    label: "Scaleway",
    cloudIds: ["scaleway"],
    markers: ["scaleway", "online sas"],
  },
  {
    id: "ovh",
    label: "OVHcloud",
    cloudIds: ["ovh"],
    markers: ["ovh"],
  },
  {
    id: "upcloud",
    label: "UpCloud",
    cloudIds: ["upcloud"],
    markers: ["upcloud"],
  },
  {
    id: "contabo",
    label: "Contabo",
    cloudIds: ["contabo"],
    markers: ["contabo"],
  },
  {
    id: "netcup",
    label: "netcup",
    cloudIds: ["netcup"],
    markers: ["netcup"],
  },
  {
    id: "alibaba",
    label: "Alibaba Cloud",
    cloudIds: ["aliyun", "alibaba"],
    markers: ["alibaba", "aliyun"],
  },
  {
    id: "tencent",
    label: "Tencent Cloud",
    cloudIds: ["tencentcloud", "tencent"],
    markers: ["tencent"],
  },
  {
    id: "huawei",
    label: "Huawei Cloud",
    cloudIds: ["huaweicloud", "huawei"],
    markers: ["huawei"],
  },
  {
    id: "ibm",
    label: "IBM Cloud",
    cloudIds: ["ibmcloud", "ibm"],
    markers: ["ibm cloud", "softlayer"],
  },
  {
    id: "rackspace",
    label: "Rackspace",
    cloudIds: ["rackspace"],
    markers: ["rackspace"],
  },
  {
    id: "equinix",
    label: "Equinix Metal",
    cloudIds: ["equinix", "packet"],
    markers: ["equinix", "packet host"],
  },
  {
    id: "openstack",
    label: "OpenStack",
    cloudIds: ["openstack", "config-drive", "nocloud"],
    markers: ["openstack"],
  },
];

/** Virtualization labels for a machine that is not a named cloud provider. */
const VIRT_LABELS: Record<string, string> = {
  kvm: "KVM VPS",
  qemu: "KVM VPS",
  vmware: "VMware",
  xen: "Xen",
  microsoft: "Hyper-V",
  hyperv: "Hyper-V",
  oracle: "Oracle VM",
  virtualbox: "VirtualBox",
  parallels: "Parallels",
  bochs: "Bochs",
  docker: "Docker container",
  lxc: "LXC container",
  "lxc-libvirt": "LXC container",
  podman: "Podman container",
  "systemd-nspawn": "systemd-nspawn",
  openvz: "OpenVZ",
};

function normalized(value?: string): string {
  return (value || "").trim().toLowerCase();
}

/**
 * Works out which cloud (if any) the machine lives on.
 *
 * Returns `providerId` too: it is what the UI shows when a label is unknown, so an
 * unfamiliar cloud-init datasource still tells the user something useful.
 */
export function detectCloudProvider(signals: SysinfoSignals): {
  provider?: string;
  providerId?: string;
  virtualization?: string;
} {
  const cloudId = normalized(signals.cloudId).split(/\s+/)[0];
  const haystack = [
    signals.dmiVendor,
    signals.dmiProduct,
    signals.dmiBoard,
    signals.dmiAsset,
  ]
    .map(normalized)
    .filter(Boolean)
    .join(" | ");

  const virtualizationLabel = VIRT_LABELS[normalized(signals.virtualization)];

  if (cloudId) {
    for (const entry of PROVIDER_MATCHERS) {
      if (entry.cloudIds?.some((id) => cloudId === id || (id.endsWith("*") && cloudId.startsWith(id.slice(0, -1))))) {
        return {
          provider: entry.label,
          providerId: cloudId,
          virtualization: signals.virtualization?.trim() || undefined,
        };
      }
    }
  }

  if (haystack) {
    for (const entry of PROVIDER_MATCHERS) {
      if (entry.markers?.some((marker) => haystack.includes(marker))) {
        return {
          provider: entry.label,
          providerId: cloudId || entry.id,
          virtualization: signals.virtualization?.trim() || undefined,
        };
      }
    }
  }

  return {
    provider: virtualizationLabel,
    providerId: cloudId || normalized(signals.virtualization) || undefined,
    virtualization: signals.virtualization?.trim() || undefined,
  };
}

/** Turns the probe's `KEY=value` output into `SshSystemInfo`. */
export function parseSysinfo(raw: string): SshSystemInfo {
  const map: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) map[key] = value;
  }

  const distro = map.DISTRO || "";
  const version = map.VERSION || "";
  const pretty =
    map.PRETTY ||
    [distro, version].filter(Boolean).join(" ") ||
    map.KERNEL ||
    "Linux";

  const provider = detectCloudProvider({
    cloudId: map.CLOUD_ID,
    dmiVendor: map.DMI_VENDOR,
    dmiProduct: map.DMI_PRODUCT,
    dmiBoard: map.DMI_BOARD,
    dmiAsset: map.DMI_ASSET,
    virtualization: map.VIRT,
  });

  const cpu = Number.parseInt(map.CPU || "", 10);
  const memoryMb = Number.parseInt(map.MEM_MB || "", 10);

  return {
    hostname: map.HOST || undefined,
    os: pretty,
    distro: distro || undefined,
    version: version || undefined,
    codename: map.CODENAME || undefined,
    kernel: map.KERNEL || undefined,
    arch: map.ARCH || undefined,
    uptime: map.UPTIME || undefined,
    load: map.LOAD || undefined,
    cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : undefined,
    memoryMb: Number.isFinite(memoryMb) && memoryMb > 0 ? memoryMb : undefined,
    provider: provider.provider,
    providerId: provider.providerId,
    virtualization: provider.virtualization,
  };
}
