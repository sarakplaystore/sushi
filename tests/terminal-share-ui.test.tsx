import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { SharedSessionView } from "../src/lib/client/shared-ssh";
import type { GatewaySettings } from "../src/lib/client/gateway";

async function main() {
  console.log("==> Terminal font and remote share management UI");
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
  const previousFetch = globalThis.fetch;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { TerminalFontSizeControl, DEFAULT_TERMINAL_FONT_SIZE } = await import("../src/components/TerminalFontSizeControl");
  const { SshTerminalSession } = await import("../src/components/SshTerminalSession");
  const { SharedTerminalSession } = await import("../src/components/SharedTerminalSession");
  const { ShareSessionModal } = await import("../src/components/ShareSessionModal");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  try {
    function FontHarness() {
      const [size, setSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
      return <TerminalFontSizeControl size={size} setSize={setSize} />;
    }
    await act(async () => { root.render(<FontHarness />); await flush(); });
    const minus = container.querySelector<HTMLButtonElement>('button[title="Decrease font size"]')!;
    const plus = container.querySelector<HTMLButtonElement>('button[title="Increase font size"]')!;
    const number = () => container.querySelector('[role="group"][aria-label="Terminal font size"] span')!.textContent;
    assert.equal(number(), "12");
    assert(!minus.parentElement!.className.includes("hidden"), "the control is also available on small screens");
    await act(async () => { for (let i = 0; i < 20; i += 1) minus.click(); await flush(); });
    assert.equal(number(), "4");
    assert.equal(minus.disabled, true);
    await act(async () => { for (let i = 0; i < 50; i += 1) plus.click(); await flush(); });
    assert.equal(number(), "40");
    assert.equal(plus.disabled, true);
    await act(async () => { minus.click(); await flush(); });
    assert.equal(number(), "39");

    const html = renderToStaticMarkup(<SshTerminalSession
      tabId="fixture-tab" retainedPtySupported
      profile={{ id: "p", name: "fixture", protocol: "ssh", host: "example.test", port: 22, username: "alice", authMethod: "password", createdAt: 1, updatedAt: 1 }}
      isActive wsAvailable gatewaySettings={{ gatewayUrl: "", gatewayToken: "" }} snippets={[]}
      onOpenCompanionSftp={() => {}} onOpenRdp={() => {}} onOpenGatewayModal={() => {}} />);
    assert.match(html, /aria-label="Terminal font size"[\s\S]*?>12<\/span>/,
      "the actual terminal starts at the shared default, not only the test harness");
    const guestHtml = renderToStaticMarkup(<SharedTerminalSession shareId="hostshare123" />);
    assert.match(guestHtml, /aria-label="Terminal font size"[\s\S]*?>12<\/span>/,
      "a shared terminal also starts at 12 and exposes the same size control");

    const active: SharedSessionView = {
      shareId: "hostshare123", host: "host.test", port: 22, username: "alice", label: "Active shell",
      createdAt: Date.now(), lastActivityAt: Date.now(), status: "live", write: true,
      requiresPasscode: true, scrollbackBytes: 0, participants: [],
    };
    const other = { ...active, shareId: "othershare123", label: "Other shell" };
    const settings: GatewaySettings = { gatewayUrl: "wss://gateway.example.test/", gatewayToken: "private-gateway-key" };
    dom.window.localStorage.setItem("sushi.auth.sessionToken.v1", "private-account-session");
    dom.window.localStorage.setItem("sushi.auth.adminProfileCert.v1", "private-account-cert");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(status === 200
        ? { ok: true, shares: [active, other], limits: { idleTtlMs: 43200000 } }
        : { ok: false, error: "Not found" }), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const stopped: string[] = [];
    const renderModal = async (gatewaySettings: GatewaySettings) => {
      await act(async () => {
        root.render(<ShareSessionModal open onClose={() => {}} activeShare={active} passcode="123456"
          hostLabel="alice@host.test:22" canShare busy={false} error={null} onStart={() => {}}
          onStop={async (id) => { stopped.push(id || "active"); }} onRotate={() => {}}
          onOpenGatewayModal={() => {}} gatewaySettings={gatewaySettings} />);
        await flush();
      });
    };
    await renderModal(settings);
    assert.equal(requests[0].url, "https://gateway.example.test/api/ssh/share");
    assert.equal(requests[0].init.credentials, "omit");
    const headers = requests[0].init.headers as Record<string, string>;
    assert.equal(headers["X-Sushi-Token"], settings.gatewayToken);
    assert.equal(headers["X-Sushi-Session"], undefined);
    assert.equal(headers["X-Sushi-Admin-Cert"], undefined);
    const link = container.querySelector<HTMLInputElement>('input[readonly]')!.value;
    const parsed = new URL(link);
    assert.equal(parsed.origin, "https://sushi.example.test");
    assert.equal(parsed.pathname, "/share/hostshare123");
    assert.equal(parsed.searchParams.get("gateway"), "https://gateway.example.test");
    assert(!link.includes(settings.gatewayToken) && !link.includes("private-account-session") && !link.includes("123456"));
    const rejoin = [...container.querySelectorAll("a")].find((item) => item.textContent?.trim() === "Rejoin")!;
    assert.equal(new URL(rejoin.href).searchParams.get("gateway"), "https://gateway.example.test");
    const stop = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Stop")!;
    await act(async () => { stop.click(); await flush(); await flush(); });
    assert.deepEqual(stopped, ["othershare123"]);
    assert(requests.length >= 2, "the other-share list refreshes after stopping it");

    status = 404;
    await renderModal({ ...settings, gatewayUrl: "https://older-gateway.example.test" });
    assert.match(container.textContent || "", /Update the gateway to list and manage shared sessions/,
      "old gateways are diagnosed rather than silently showing an empty list");
    console.log("Terminal font and remote share UI passed.");
  } finally {
    await act(async () => { root.unmount(); await flush(); });
    globalThis.fetch = previousFetch;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
