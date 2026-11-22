import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { SystemCapabilities } from "../src/types/connection";
import type { GatewaySettings } from "../src/lib/client/gateway";
import railwayTemplateVariables from "../.railway/gateway-template-variables.json";

const localCaps: SystemCapabilities = {
  mode: "vercel", websocketSsh: false, serverlessSshExec: true, serverlessSftp: true,
  rdpGuacd: false, rdpProbe: true, serverVault: true, requiresGatewayToken: false, nodeVersion: "v22",
};
const gatewayCaps: SystemCapabilities = {
  mode: "gateway", websocketSsh: true, serverlessSshExec: false, serverlessSftp: false,
  rdpGuacd: false, rdpProbe: false, serverVault: false, requiresGatewayToken: true, nodeVersion: "v22",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function testGatewayGuide() {
  console.log("==> Gateway guide: deployed-provider steps, safe copy, and honest endpoint checks");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://sushi.example.test/workspace",
  });
  const oldGlobals = new Map<string, PropertyDescriptor | undefined>();
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const oldFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
  })) {
    oldGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const clipboard: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true, value: { writeText: async (text: string) => { clipboard.push(text); } },
  });
  dom.window.localStorage.setItem("sushi_encrypted_vault_v1", "existing-vault-must-not-change");
  dom.window.localStorage.setItem("sushi.auth.sessionToken.v1", "private-session-for-test");
  dom.window.localStorage.setItem("sushi.auth.adminProfileCert.v1", "private-cert-for-test");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const replies: Array<() => Promise<Response>> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected network request");
    return await reply();
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const { GatewaySetupModal } = await import("../src/components/GatewaySetupModal");
  const { fetchGatewayCapabilities } = await import("../src/lib/client/gateway");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
    assert(found, `button not found: ${label}`);
    return found as HTMLButtonElement;
  };
  const click = async (label: string) => { await act(async () => { button(label).click(); await flush(); }); };
  const tokenInput = () => {
    const found = container.querySelector<HTMLInputElement>("#gateway-token");
    assert(found);
    return found;
  };
  const tokenToggle = () => {
    const found = container.querySelector<HTMLButtonElement>('button[aria-controls="gateway-token"]');
    assert(found);
    return found;
  };
  const toggleToken = async () => { await act(async () => { tokenToggle().click(); await flush(); }); };
  const setInput = async (id: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`);
    assert(input, `input not found: ${id}`);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    assert(setter);
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  };
  const guide = () => {
    const found = container.querySelector<HTMLElement>('section[aria-labelledby="gateway-guide-title"]');
    assert(found);
    return found;
  };
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const saves: Array<{ settings: GatewaySettings; caps: SystemCapabilities | null }> = [];
  let closed = 0;
  const render = async (settings: GatewaySettings, remote: SystemCapabilities | null = null) => {
    await act(async () => {
      root.render(
        <GatewaySetupModal
          isOpen
          localCapabilities={localCaps}
          gatewayCapabilities={remote}
          gatewaySettings={settings}
          onClose={() => { closed += 1; }}
          onSaveSettings={(next, caps) => { saves.push({ settings: next, caps }); }}
        />
      );
      await flush();
    });
  };

  try {
    await render({ gatewayUrl: "", gatewayToken: "" });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="gateway-modal-title"]');
    assert(dialog);
    assert.equal(dom.window.document.activeElement, dialog, "keyboard focus moves into the dialog");
    const keyPanel = container.querySelector<HTMLElement>('section[aria-labelledby="gateway-token-generator-title"]');
    assert(keyPanel);
    assert.equal(keyPanel.parentElement?.firstElementChild, keyPanel, "key generation is visible before the long setup guide");
    assert(keyPanel.compareDocumentPosition(guide()) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.match(guide().textContent || "", /Find your PTY gateway/);
    assert.match(guide().textContent || "", /not your\s+database URL/i);
    assert.match(guide().textContent || "", /Public Networking/);
    assert.match(guide().textContent || "", /Generate Domain/);
    assert.match(guide().textContent || "", /not guacd/i);
    assert.equal(button("Railway").getAttribute("aria-pressed"), "true");
    assert(guide().querySelector('a[href="https://railway.com/dashboard"][target="_blank"]'));
    assert(guide().compareDocumentPosition(container.querySelector("#gateway-url")!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal((container.querySelector('label[for="gateway-url"]') as HTMLLabelElement)?.htmlFor, "gateway-url");
    assert.equal((container.querySelector('label[for="gateway-token"]') as HTMLLabelElement)?.htmlFor, "gateway-token");
    assert.equal(tokenInput().type, "password", "the token is masked by default");
    assert.equal(tokenInput().getAttribute("aria-describedby"), "gateway-token-visibility-note");
    assert.equal(tokenToggle().type, "button");
    assert.equal(tokenToggle().tabIndex, 0, "the visibility control is keyboard focusable");
    assert.equal(tokenToggle().getAttribute("aria-label"), "Show gateway token");
    assert.match(container.querySelector("#gateway-token-visibility-note")?.textContent || "", /cannot fetch a\s+token from the gateway host/i);
    await setInput("gateway-token", "example+gateway/token==");
    tokenToggle().focus();
    assert.equal(dom.window.document.activeElement, tokenToggle());
    await toggleToken();
    assert.equal(dom.window.document.activeElement, tokenToggle(), "toggling keeps keyboard focus on the control");
    assert.equal(tokenInput().type, "text", "the button reveals the token already in the field");
    assert.equal(tokenInput().value, "example+gateway/token==");
    assert.equal(tokenToggle().getAttribute("aria-label"), "Hide gateway token");
    await toggleToken();
    assert.equal(tokenInput().type, "password", "the same button masks it again");
    assert.equal(tokenInput().value, "example+gateway/token==", "visibility does not edit the token");
    assert.equal(calls.length, 0, "revealing a token never contacts a gateway or provider");
    assert.equal(saves.length, 0, "revealing a token does not save settings");
    assert.equal(clipboard.length, 0, "revealing a token does not copy it to the clipboard");
    await setInput("gateway-token", "");
    assert.match(guide().textContent || "", /https:\/\/sushi\.example\.test/);
    assert.match(guide().textContent || "", /https:\/\/sushi-lyart-three\.vercel\.app/);
    assert.match(guide().textContent || "", /only\s+when\s+ALLOWED_ORIGIN\s+is absent/i);
    assert.match(guide().textContent || "", /Existing overrides are kept/i);
    assert.match(guide().textContent || "", /without\s+\/ws\/ssh/i);
    assert.match(guide().textContent || "", /local storage/i);
    assert.match(guide().textContent || "", /sealed or hidden/i);
    assert.match(guide().textContent || "", /set and\s+deploy it on the gateway, then update all gateway clients/i);
    assert.match(container.textContent || "", /asleep, open its public URL in another tab/i);
    assert.equal(calls.length, 0, "viewing the guide does not contact a provider or alter a service");

    const deploymentDetails = container.querySelector<HTMLDetailsElement>("details");
    assert(deploymentDetails);
    deploymentDetails.open = true;
    assert.match(deploymentDetails.textContent || "", /template must first be created in Railway/i);
    assert.match(deploymentDetails.textContent || "", /NOT an existing service/i);
    assert.match(deploymentDetails.textContent || "", /will not fill the separately hosted Sushi UI/i);
    assert(deploymentDetails.querySelector('a[href="https://railway.com/workspace/templates"][target="_blank"]'));
    const copyTemplate = deploymentDetails.querySelector<HTMLButtonElement>('button[aria-label="Copy Template variables (JSON)"]');
    assert(copyTemplate);
    const shownJson = copyTemplate.closest("div.space-y-2")?.querySelector("pre")?.textContent;
    assert.equal(shownJson, JSON.stringify(railwayTemplateVariables, null, 2), "the panel displays the checked-in template variables");
    await act(async () => { copyTemplate.click(); await flush(); });
    assert.deepEqual(clipboard, [shownJson], "copy the symbolic defaults, not a real gateway token");
    assert.equal(copyTemplate.getAttribute("aria-label"), "Copied Template variables (JSON)");
    Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await act(async () => { copyTemplate.click(); await flush(); });
    assert.equal(copyTemplate.getAttribute("aria-label"), "Could not copy Template variables (JSON)", "a denied clipboard is not reported as copied");
    assert.match(copyTemplate.title, /select the text/i);
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true, value: { writeText: async (text: string) => { clipboard.push(text); } },
    });
    assert.equal(tokenInput().value, "", "copying template settings does not populate or rotate the gateway token");
    assert.equal(saves.length, 0);
    assert.equal(calls.length, 0, "copying the recipe does not contact Railway or change a deployment");
    clipboard.length = 0;
    deploymentDetails.open = false;

    await click("Copy Sushi origin");
    assert.deepEqual(clipboard, ["https://sushi.example.test"], "copy the origin, not the page path or a token");
    assert.match(guide().querySelector('[role="status"]')?.textContent || "", /Copied/);
    Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await click("Copy Sushi origin");
    assert.match(guide().querySelector('[role="status"]')?.textContent || "", /Could not copy/);
    Object.defineProperty(dom.window.document, "execCommand", {
      configurable: true,
      value: (command: string) => {
        assert.equal(command, "copy");
        clipboard.push(dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value);
        return true;
      },
    });
    await click("Copy Sushi origin");
    assert.deepEqual(clipboard, ["https://sushi.example.test", "https://sushi.example.test"]);
    assert.match(guide().querySelector('[role="status"]')?.textContent || "", /Copied/);
    assert.equal(dom.window.document.querySelector("textarea"), null, "fallback removes temporary clipboard field");

    await click("Render");
    assert.equal(button("Render").getAttribute("aria-pressed"), "true");
    assert.equal(button("Railway").getAttribute("aria-pressed"), "false");
    assert.match(guide().textContent || "", /at the top of the service page/i);
    assert.match(guide().textContent || "", /Environment/);
    assert.match(guide().textContent || "", /your-gateway\.onrender\.com/);
    assert(!/Generate Domain/.test(guide().textContent || ""));
    assert(guide().querySelector('a[href="https://dashboard.render.com"][target="_blank"]'));
    await click("VPS / Docker");
    assert.match(guide().textContent || "", /reverse proxy/i);
    assert.equal(calls.length, 0);

    // A saved managed-host URL selects its provider; editing it must never reuse
    // capabilities that were probed for the previously saved URL or token.
    await render({ gatewayUrl: "https://old.onrender.com", gatewayToken: "old-test-token" }, gatewayCaps);
    assert.equal(button("Render").getAttribute("aria-pressed"), "true");
    assert.equal(tokenInput().type, "password", "saved tokens start masked");
    await toggleToken();
    assert.equal(tokenInput().type, "text");
    assert.equal(tokenInput().value, "old-test-token", "the saved token can be revealed locally");
    await render({ gatewayUrl: "https://old.onrender.com", gatewayToken: "updated-test-token" }, gatewayCaps);
    assert.equal(tokenInput().type, "password", "changed saved settings are masked again");
    assert.equal(tokenInput().value, "updated-test-token");
    await render({ gatewayUrl: "https://old.onrender.com", gatewayToken: "old-test-token" }, gatewayCaps);
    assert.match(container.textContent || "", /Gateway advertises PTY/);
    const pendingOld = deferred<Response>();
    replies.push(() => pendingOld.promise);
    await click("Test Gateway Endpoint");
    assert.doesNotMatch(container.textContent || "", /Gateway advertises PTY|HTTP endpoint responded/,
      "an in-flight recheck must not display a stale success");
    await act(async () => { pendingOld.resolve(new Response("unavailable", { status: 503 })); await flush(); });
    assert.match(container.textContent || "", /Gateway returned HTTP 503/);
    assert.match(container.textContent || "", /Last endpoint check failed/);
    assert.doesNotMatch(container.textContent || "", /Gateway advertises PTY|HTTP endpoint responded/,
      "a failed latest probe must override saved capabilities even if settings have not changed");
    await setInput("gateway-url", "https://different.onrender.com");
    await setInput("gateway-url", "https://old.onrender.com");
    assert.doesNotMatch(container.textContent || "", /Gateway advertises PTY|HTTP endpoint responded/,
      "editing back to saved settings must not resurrect the earlier success after failure");
    await setInput("gateway-url", "https://new.onrender.com");
    assert.match(container.textContent || "", /Entered URL not checked yet/);
    assert.doesNotMatch(container.textContent || "", /Gateway advertises PTY/);
    await setInput("gateway-token", "test-gateway-token");
    assert(!container.textContent?.includes("test-gateway-token"), "the token is never rendered as visible text");
    assert.equal(dom.window.localStorage.getItem("sushi_encrypted_vault_v1"), "existing-vault-must-not-change");
    const keepAwake = container.querySelector<HTMLInputElement>("#gateway-keep-awake");
    assert(keepAwake);
    replies.push(async () => response(gatewayCaps));
    await act(async () => { keepAwake.click(); await flush(); });
    assert.equal(calls.at(-1)?.url, "https://new.onrender.com/health");
    assert.equal(calls.at(-1)?.init?.headers, undefined, "the public keep-awake ping sends no secrets");
    assert.equal(calls.at(-1)?.init?.credentials, "omit");
    await act(async () => { keepAwake.click(); await flush(); });

    const pending = deferred<Response>();
    replies.push(() => pending.promise);
    await click("Test Gateway Endpoint");
    assert.equal(button("Test Gateway Endpoint").disabled, true);
    assert.equal(button("Save Gateway Settings").disabled, true);
    assert.equal(button("Close").disabled, true);
    assert.equal(dialog.querySelector<HTMLButtonElement>('button[aria-label="Close gateway settings"]')?.disabled, true);
    assert.equal(container.querySelector<HTMLInputElement>("#gateway-url")?.disabled, true);
    assert.equal(tokenToggle().disabled, false, "visibility remains controllable while probing");
    const callsBeforeToggle = calls.length;
    await toggleToken();
    assert.equal(tokenInput().type, "text");
    await toggleToken();
    assert.equal(tokenInput().type, "password", "a token can be hidden during a slow probe");
    assert.equal(calls.length, callsBeforeToggle, "the visibility control does not start another probe");
    assert.equal(calls.at(-1)?.url, "https://new.onrender.com/api/system/capabilities");
    assert.equal(calls.at(-1)?.init?.headers, undefined, "the public test does not send account or gateway tokens");
    assert.equal(calls.at(-1)?.init?.credentials, "omit", "nor does it send browser cookies");
    await act(async () => {
      dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flush();
    });
    assert.equal(closed, 0, "a probe or save cannot close and then unexpectedly complete in the background");
    await act(async () => { pending.resolve(response(gatewayCaps)); await flush(); });
    assert.equal(button("Test Gateway Endpoint").disabled, false);
    assert.match(container.textContent || "", /HTTP endpoint reached/);
    assert.match(container.textContent || "", /verify WebSocket and token/);
    assert.match(container.textContent || "", /does not verify the token or WebSocket/);
    assert.match(container.textContent || "", /Gateway advertises PTY/);
    assert.doesNotMatch(container.textContent || "", /Connected to GATEWAY Gateway/);
    const callsBeforeReveal = calls.length;
    await toggleToken();
    assert.equal(tokenInput().value, "test-gateway-token");
    assert.match(container.textContent || "", /HTTP endpoint reached/, "visibility does not invalidate a successful probe");
    assert.equal(calls.length, callsBeforeReveal);
    await toggleToken();

    await setInput("gateway-token", "");
    assert.doesNotMatch(container.textContent || "", /HTTP endpoint reached/);
    replies.push(async () => response(gatewayCaps));
    await click("Test Gateway Endpoint");
    assert.match(container.textContent || "", /token is required/i);
    await setInput("gateway-token", "test-gateway-token");
    replies.push(async () => response({ unexpected: "not a Sushi gateway" }));
    await click("Test Gateway Endpoint");
    assert.match(container.textContent || "", /did not return Sushi gateway capabilities/i);
    assert.doesNotMatch(container.textContent || "", /Gateway advertises PTY/);

    replies.push(async () => response(gatewayCaps));
    await click("Test Gateway Endpoint");
    await toggleToken();
    assert.equal(tokenInput().type, "text", "save is exercised with the token revealed");
    const requestsBeforeSave = calls.length;
    await click("Save Gateway Settings");
    assert.equal(calls.length, requestsBeforeSave, "saving a just-tested URL does not repeat the HTTP probe");
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0], {
      settings: { gatewayUrl: "https://new.onrender.com", gatewayToken: "test-gateway-token" },
      caps: gatewayCaps,
    });
    assert.equal(closed, 1);
    assert.equal(dom.window.localStorage.getItem("sushi_encrypted_vault_v1"), "existing-vault-must-not-change");
    assert.equal(tokenInput().type, "password", "saving masks the token");
    await toggleToken();
    await click("Reset to Same-Origin");
    assert.equal(tokenInput().type, "password", "reset masks the token before new input");
    assert.equal(tokenInput().value, "");
    await click("Test Gateway Endpoint");
    assert.doesNotMatch(container.textContent || "", /Attached gateway:|Gateway advertises PTY/,
      "testing same-origin settings must not present local capabilities as a remote gateway");

    // JSDOM has no layout; mark the open dialog's focus targets as visible so
    // Shift+Tab and Tab can exercise its focus loop, including closed details.
    const rects = dom.window.HTMLElement.prototype.getClientRects;
    Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", {
      configurable: true,
      value: function (this: HTMLElement) {
        return this.closest("details:not([open])") && this.tagName !== "SUMMARY" ? [] : [{}];
      },
    });
    dialog.focus();
    await act(async () => {
      dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(dom.window.document.activeElement, button("Save Gateway Settings"), "Shift+Tab wraps to the last control");
    await act(async () => {
      button("Save Gateway Settings").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    assert.equal(dom.window.document.activeElement, dialog.querySelector('button[aria-label="Close gateway settings"]'), "Tab wraps to the first control");
    Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { configurable: true, value: rects });
    await act(async () => {
      dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(closed, 2, "Escape closes the dialog after the probe finishes");

    // Older gateways can omit informational fields; unrelated or invalid JSON
    // must not become a false success or crash the capabilities display.
    replies.push(async () => response({ mode: "gateway", websocketSsh: true }));
    const older = await fetchGatewayCapabilities({ gatewayUrl: "https://older.example", gatewayToken: "" });
    assert.equal(older.ok, true);
    assert.equal(older.caps?.nodeVersion, "unknown");
    replies.push(async () => new Response("not JSON", { status: 200 }));
    const invalid = await fetchGatewayCapabilities({ gatewayUrl: "https://wrong.example", gatewayToken: "" });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error || "", /did not return Sushi gateway capabilities/i);

    // The shared probe remains bounded even when a sleeping host never replies.
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
    const timeout = await fetchGatewayCapabilities({ gatewayUrl: "https://sleeping.example", gatewayToken: "" }, 10);
    assert.equal(timeout.ok, false);
    assert.equal(timeout.timedOut, true);

    // A closed mobile sidebar can still have layout rectangles, but is hidden.
    // Restore focus to the visible navigation trigger, not that hidden button.
    const hiddenSettings = dom.window.document.createElement("button");
    hiddenSettings.setAttribute("aria-controls", "workspace-settings");
    hiddenSettings.style.visibility = "hidden";
    const mobileNavigation = dom.window.document.createElement("button");
    mobileNavigation.setAttribute("aria-label", "Open navigation");
    Object.defineProperty(hiddenSettings, "getClientRects", { value: () => [{}] });
    Object.defineProperty(mobileNavigation, "getClientRects", { value: () => [{}] });
    dom.window.document.body.append(hiddenSettings, mobileNavigation);
    await act(async () => {
      root.render(<GatewaySetupModal isOpen={false} localCapabilities={localCaps} gatewaySettings={{ gatewayUrl: "", gatewayToken: "" }} onClose={() => {}} onSaveSettings={() => {}} />);
      await flush();
    });
    assert.equal(dom.window.document.activeElement, mobileNavigation, "closing the dialog restores focus to visible mobile navigation");
    hiddenSettings.remove();
    mobileNavigation.remove();

    // A revealed token must not remain visible when the persistent modal is reopened.
    const reopenedSettings = { gatewayUrl: "https://gateway.example.test", gatewayToken: "saved-token-for-reopen" };
    await render(reopenedSettings);
    await toggleToken();
    assert.equal(tokenInput().type, "text");
    await act(async () => {
      root.render(<GatewaySetupModal isOpen={false} localCapabilities={localCaps} gatewaySettings={reopenedSettings} onClose={() => {}} onSaveSettings={() => {}} />);
      await flush();
    });
    assert.equal(container.querySelector("#gateway-token"), null);
    await render(reopenedSettings);
    assert.equal(tokenInput().type, "password", "reopening always masks the saved token");
    assert.equal(tokenInput().value, "saved-token-for-reopen", "hiding the token does not remove it");
    assert.equal(tokenToggle().getAttribute("aria-label"), "Show gateway token");
  } finally {
    await act(async () => { root.unmount(); await flush(); });
    globalThis.fetch = oldFetch;
    if (oldActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
    else globals.IS_REACT_ACT_ENVIRONMENT = oldActEnvironment;
    for (const [key, descriptor] of oldGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
}

testGatewayGuide().then(() => console.log("Gateway guide tests passed.")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
