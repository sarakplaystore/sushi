import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

console.log("==> Testing the phone home screen (host list first, Recently Connected on top)...");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// ---- the rule itself -----------------------------------------------------------
const mobileHome = read("src/lib/client/mobile-home.ts");
assert.match(
  mobileHome,
  /return localStorage\.getItem\(MOBILE_HOME_KEY\) === "launchpad" \? "launchpad" : "hosts"/,
  "a phone lands on the host list unless the hero was pinned"
);
assert.match(mobileHome, /export function useIsPhoneViewport\(\): boolean \| null/, "viewport hook");
assert.match(mobileHome, /max-width: \$\{MOBILE_BREAKPOINT_PX - 1\}px/, "matches Tailwind's md breakpoint");
assert.equal(/return true/.test(mobileHome.split("useState<Home")[0]), false, "no guessing before mount");

// ---- the workspace wires it up -------------------------------------------------
const workspace = read("src/components/SushiWorkspace.tsx");
assert.match(workspace, /useIsPhoneViewport\(\) === true/, "phone layout is opt-in after hydration");
assert.match(workspace, /const \[mobileHome, setMobileHome\] = useMobileHome\(\);/, "remembered choice");
assert.match(
  workspace,
  /isPhoneLayout && mobileHome === "hosts"/,
  "the desktop dashboard is hidden (not unmounted) on a phone"
);
assert.match(
  workspace,
  /"hidden md:block"/,
  "before hydration the dashboard is CSS-hidden on phones, so it never flashes"
);
assert.match(
  workspace,
  /isPhoneLayout && mobileHome === "hosts" && \(/,
  "the host-list home screen only renders on a phone"
);

// Recently Connected must come before the list on the phone screen.
const phoneStart = workspace.indexOf('{isPhoneLayout && mobileHome === "hosts" && (');
assert.ok(phoneStart > 0, "phone home block exists");
const phoneList = workspace.indexOf('variant="page"', phoneStart);
const phoneRecent = workspace.indexOf("Recently Connected", phoneStart);
assert.ok(phoneRecent > 0 && phoneRecent < phoneList, "Recently Connected renders above the host list");

// The list is searchable and filterable there, with a new-connection action.
const phoneBlock = workspace.slice(phoneStart, phoneStart + 9000);
assert.match(phoneBlock, /onSearchChange=\{setHostSearch\}/, "search box on the phone home screen");
assert.match(phoneBlock, /onProtocolFilterChange=\{setProtocolFilter\}/, "All / SSH / SFTP / RDP filter");
assert.match(phoneBlock, /onNewHost=/, "can add a host from the phone home screen");
assert.match(phoneBlock, /Show quick connect/, "the hero/quick connect stays one tap away");
assert.match(phoneBlock, /href="\/hosts"/, "the one-URL host page is linked");

// ---- the sidebar reuses the same component, never a second copy ---------------
const listImports = workspace.match(/<HostNavList/g) ?? [];
assert.ok(listImports.length >= 2, "sidebar + phone home share one list component");
assert.match(workspace, /import \{ HostNavList \} from "\.\/HostNavList"/);
// No leftover hand-rolled host rows in the workspace file.
assert.ok(!/groupedHosts/.test(workspace), "the old duplicated row renderer is gone");
assert.ok(!/filterUnifiedHostsByProtocol\(unifiedHosts/.test(workspace), "filtering lives in the list component");

const list = read("src/components/HostNavList.tsx");
assert.match(list, /filterUnifiedHostsByProtocol\(hosts, protocolFilter\)/, "filter applies to merged hosts");
assert.match(list, /groupUnifiedHosts\(filtered\)/, "grouped like the vault folders");
assert.ok(!list.includes("ArrowLeftRight"), "row does not render the ArrowLeftRight URL icon button");
assert.match(list, /onOpen\(entry, "rdp"\)/, "RDP action per row");
assert.match(list, /onOpen\(entry, "sftp"\)/, "SFTP action per row");
assert.ok(!list.includes('onOpen(entry, "ssh")'), "redundant SSH icon button is removed from host row");
assert.ok(!list.includes("Trash2"), "inline Trash2 delete button is removed from host row");
assert.ok(!workspace.includes("Trash2"), "inline Trash2 delete button is removed from saved host cards");
assert.match(list, /machineHasManyProfiles/, "merged row edit tooltip notes multi-protocol machines");

const hostModal = read("src/components/HostProfileModal.tsx");
assert.match(hostModal, /Remove Host/, "host removal lives inside Edit Host Profile modal");
assert.match(hostModal, /Confirm Remove/, "Edit Host Profile modal requires confirmation before deleting");
assert.match(hostModal, /Remove Entire Machine/, "Edit Host Profile modal supports removing all profiles of a merged machine");
assert.match(workspace, /siblingProtocolsDescription=\{editingHostSiblingProtocols\}/, "workspace wires sibling protocol info into HostProfileModal");
// Phones have no hover: the roomy variant must not hide the SFTP button behind it.
const sftpButton = list.slice(list.indexOf('onOpen(entry, "sftp")') - 120, list.indexOf('onOpen(entry, "sftp")'));
assert.ok(!sftpButton.includes("group-hover"), "SFTP button itself does not gate on group-hover when roomy is active");
assert.match(list, /roomy \? "flex" : "hidden group-hover:flex/, "roomy variant keeps secondary protocol button visible on phones");
// Row content shrinks instead of pushing actions off-screen.
assert.match(list, /min-w-0 flex-1 truncate text-xs font-medium/, "long host names truncate");

// ---- desktop keeps the hero, with a one-time explanation ---------------------
assert.match(workspace, /desktopHomeNoticeDismissed/, "desktop notice is dismissible and remembered");
assert.match(workspace, /On a phone, Sushi now opens on your/, "notice explains the new phone home");

// ---- mobile responsiveness: touch, scroll containers, soft keyboard & crypto --
assert.match(
  workspace,
  /flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-2/,
  "mobile drawer wraps HostNavList in a flex-1 min-h-0 container so hosts scroll and Settings stays reachable"
);
assert.match(
  workspace,
  /pointer-events-none invisible -translate-x-full/,
  "closed mobile drawer disables pointer-events so it never intercepts taps"
);
assert.match(
  workspace,
  /reuseSalt:/,
  "routine vault updates reuse existing PBKDF2 salt + cached key instead of freezing mobile main thread"
);

const cryptoVault = read("src/lib/client/crypto-vault.ts");
assert.match(cryptoVault, /derivedKeyCache/, "PBKDF2 derived keys are cached in memory");

const ironEngine = read("src/lib/client/ironrdp-engine.ts");
assert.match(ironEngine, /addEventListener\("touchstart"/, "IronRDP canvas binds touchstart for mobile touch");
assert.match(ironEngine, /addEventListener\("touchmove"/, "IronRDP canvas binds touchmove for mobile drag & 2-finger scroll");
assert.match(ironEngine, /touchAction = "none"/, "IronRDP canvas prevents browser pan/zoom hijacking");
assert.match(ironEngine, /typeText\(text: string\)/, "IronRDP exposes Unicode/IME text typing for mobile soft keyboards");

const rdpSession = read("src/components/RdpDesktopSession.tsx");
assert.match(rdpSession, /Toggle mobile keyboard/, "RDP toolbar exposes mobile on-screen keyboard button");
assert.match(rdpSession, /Mobile remote desktop keyboard input/, "RDP stage includes hidden mobile soft-keyboard textarea bridge");

const sshSession = read("src/components/SshTerminalSession.tsx");
assert.match(sshSession, /Mobile terminal shortcut keys/, "SSH terminal exposes mobile shortcut key bar (Esc, Tab, Ctrl+C, arrows)");

const globalsCss = read("src/app/globals.css");
assert.match(globalsCss, /touch-action:\s*manipulation/, "interactive elements disable 300ms double-tap-zoom delay on mobile");

console.log("Phone home screen (host list first) tests passed.");
