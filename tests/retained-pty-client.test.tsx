import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostProfile } from "../src/types/connection";
import {
  RETAINED_PTY_EVENT,
  RETAINED_PTY_KEY,
  forgetRetainedPty,
  loadRetainedPtys,
  moveRetainedPty,
  retainedPtyMatches,
  saveRetainedPty,
  type RetainedPty,
} from "../src/lib/client/retained-pty";
import { RetainedPtyList } from "../src/components/RetainedPtyList";
import { SshTerminalSession } from "../src/components/SshTerminalSession";

async function main() {
  console.log("==> Retained PTY browser metadata and UI");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://sushi.example.test/" });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  try {
    const profile: HostProfile = {
      id: "ad-hoc", name: "Ephemeral server", protocol: "ssh", host: "Box.Example.test", port: 2222,
      username: "alice", authMethod: "privateKey", password: "password-secret", privateKey: "private-key-secret",
      passphrase: "passphrase-secret", notes: "private-notes", sshKeyId: "key-secret-reference",
      createdAt: 1, updatedAt: 2,
    };
    const record: RetainedPty = {
      tabId: "tab-original", sessionId: "Abcdef_1234567890-ABCDEF", gatewayUrl: "https://gateway.example.test",
      profile, savedAt: Date.now(), idleTtlMs: 43200000,
    };
    let notifications = 0;
    dom.window.addEventListener(RETAINED_PTY_EVENT, () => { notifications += 1; });
    assert.equal(saveRetainedPty(record), true);
    const serialized = dom.window.localStorage.getItem(RETAINED_PTY_KEY)!;
    for (const secret of ["password-secret", "private-key-secret", "passphrase-secret", "private-notes", "key-secret-reference"]) {
      assert(!serialized.includes(secret), `${secret} is never stored in plain resume metadata`);
    }
    assert.equal(notifications, 1);
    let saved = loadRetainedPtys();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].profile.host, profile.host);
    assert.equal(saved[0].profile.password, undefined);
    assert.equal(retainedPtyMatches(saved[0], "wss://gateway.example.test/", { ...profile, host: "box.example.test" }), true);
    assert.equal(retainedPtyMatches(saved[0], "https://different-gateway.test", profile), false);
    assert.equal(retainedPtyMatches(saved[0], saved[0].gatewayUrl, { ...profile, username: "bob" }), false);
    assert.equal(retainedPtyMatches(saved[0], saved[0].gatewayUrl, { ...profile, port: 22 }), false);
    assert.equal(saveRetainedPty({ ...record, tabId: "bad", gatewayUrl: "https://key@gateway.example.test" }), false);
    assert.equal(saveRetainedPty({ ...record, tabId: "bad", sessionId: "../../unsafe" }), false);

    assert.equal(moveRetainedPty("tab-original", "tab-reopened"), true);
    saved = loadRetainedPtys();
    assert.equal(saved[0].tabId, "tab-reopened");
    assert.equal(moveRetainedPty("tab-original", "other"), false);
    assert.equal(forgetRetainedPty("tab-reopened", "not-the-current-id"), true);
    assert.equal(loadRetainedPtys().length, 1, "a stale socket cannot erase a newer record");

    const resumed: string[] = [];
    const forgotten: string[] = [];
    await act(async () => {
      root.render(<RetainedPtyList entries={saved} onResume={(entry) => resumed.push(entry.tabId)} onForget={(entry) => forgotten.push(entry.tabId)} />);
      await flush();
    });
    assert.match(container.textContent || "", /Resume the same shell on this browser if/);
    const resumeButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Resume terminal"))!;
    const forgetButton = container.querySelector<HTMLButtonElement>('button[aria-label="Forget saved terminal Ephemeral server"]')!;
    await act(async () => { resumeButton.click(); forgetButton.click(); await flush(); });
    assert.deepEqual(resumed, ["tab-reopened"]);
    assert.deepEqual(forgotten, ["tab-reopened"]);
    assert.match(forgetButton.title, /does not stop/i);

    const props = {
      tabId: "tab-ui", profile, isActive: true, gatewaySettings: { gatewayUrl: "", gatewayToken: "" }, snippets: [],
      onOpenCompanionSftp: () => {}, onOpenRdp: () => {}, onOpenGatewayModal: () => {},
    };
    const wsHtml = renderToStaticMarkup(<SshTerminalSession {...props} wsAvailable retainedPtySupported />);
    assert.match(wsHtml, /Keep this private PTY on the gateway/);
    assert.doesNotMatch(wsHtml, /No timeout for serverless commands/, "serverless toggle is not displayed for WebSocket PTYs");
    const httpHtml = renderToStaticMarkup(<SshTerminalSession {...props} wsAvailable={false} retainedPtySupported={false} />);
    assert.match(httpHtml, /No timeout for serverless commands/);
    assert.doesNotMatch(httpHtml, /Keep this private PTY on the gateway/);
    const oldHtml = renderToStaticMarkup(<SshTerminalSession {...props} wsAvailable retainedPtySupported={false} />);
    assert.match(oldHtml, /gateway does not advertise private terminal retention/);

    assert.equal(forgetRetainedPty("tab-reopened", record.sessionId), true);
    assert.equal(loadRetainedPtys().length, 0);
    const descriptor = Object.getOwnPropertyDescriptor(dom.window, "localStorage")!;
    Object.defineProperty(dom.window, "localStorage", { configurable: true, get() { throw new Error("storage denied"); } });
    assert.equal(saveRetainedPty(record), false, "blocked browser storage is never reported as safely saved");
    Object.defineProperty(dom.window, "localStorage", descriptor);
    console.log("Retained PTY metadata, secret stripping, gateway binding, transport controls and launchpad cards passed.");
  } finally {
    await act(async () => { root.unmount(); await flush(); });
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
