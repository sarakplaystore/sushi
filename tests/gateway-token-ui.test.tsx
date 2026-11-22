import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { GatewaySettings } from "../src/lib/client/gateway";
import type { SystemCapabilities } from "../src/types/connection";

const localCaps: SystemCapabilities = {
  mode: "vercel", websocketSsh: false, serverlessSshExec: true, serverlessSftp: true,
  rdpGuacd: false, rdpProbe: true, serverVault: true, requiresGatewayToken: false, nodeVersion: "v22",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function testGatewayTokenUi() {
  console.log("==> Gateway token UI: secure local generation, safe copy, and explicit save");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://sushi.example.test/",
  });
  Object.defineProperty(dom.window, "isSecureContext", { configurable: true, value: true });
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const oldFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls += 1; throw new Error("Unexpected network request"); }) as typeof fetch;
  const clipboard: string[] = [];
  const allowClipboard = () => Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true, value: { writeText: async (text: string) => { clipboard.push(text); } },
  });
  allowClipboard();
  dom.window.localStorage.setItem("sushi_encrypted_vault_v1", "vault-must-not-change");
  dom.window.localStorage.setItem("sushi.auth.sessionToken.v1", "admin-session-must-not-leak");
  dom.window.sessionStorage.setItem("existing-session-value", "untouched");
  const storageSnapshot = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)!;
    return [key, storage.getItem(key)];
  }).sort(([a], [b]) => (a || "").localeCompare(b || ""));
  const localBefore = storageSnapshot(dom.window.localStorage);
  const sessionBefore = storageSnapshot(dom.window.sessionStorage);

  const nativeRandom = dom.window.crypto.getRandomValues.bind(dom.window.crypto);
  let randomCalls = 0;
  const randomHexResults: string[] = [];
  const useNativeRandom = () => Object.defineProperty(dom.window.crypto, "getRandomValues", {
    configurable: true,
    value: (bytes: Uint8Array) => {
      assert.equal(bytes.length, 24, "24 random bytes yield 192 bits before hex encoding");
      randomCalls += 1;
      const result = nativeRandom(bytes);
      randomHexResults.push(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
      return result;
    },
  });
  useNativeRandom();

  const { createRoot } = await import("react-dom/client");
  const { GatewaySetupModal } = await import("../src/components/GatewaySetupModal");
  const { saveGatewaySettings } = await import("../src/lib/client/gateway");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  const saves: GatewaySettings[] = [];
  let closed = 0;
  let rejectSave = false;
  const onSave = (settings: GatewaySettings) => {
    if (rejectSave) throw new Error(`storage denied: ${settings.gatewayToken}`);
    saveGatewaySettings(settings);
    saves.push(settings);
  };
  const render = async (settings: GatewaySettings, isOpen = true) => {
    await act(async () => {
      root.render(<GatewaySetupModal isOpen={isOpen} localCapabilities={localCaps} gatewaySettings={settings}
        onClose={() => { closed += 1; }} onSaveSettings={onSave} />);
      await flush();
    });
  };
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
    assert(found, `button not found: ${label}`);
    return found as HTMLButtonElement;
  };
  const click = async (label: string) => { await act(async () => { button(label).click(); await flush(); }); };
  const tokenInput = () => {
    const input = container.querySelector<HTMLInputElement>("#gateway-token");
    assert(input);
    return input;
  };
  const confirmation = () => {
    const input = container.querySelector<HTMLInputElement>("#gateway-token-absent");
    assert(input);
    return input;
  };
  const checkAbsence = async () => { await act(async () => { confirmation().click(); await flush(); }); };
  const setInput = async (id: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    assert(input && setter);
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  };
  const setToken = (value: string) => setInput("gateway-token", value);
  const generator = () => {
    const section = container.querySelector<HTMLElement>('section[aria-labelledby="gateway-token-generator-title"]');
    assert(section);
    return section;
  };
  const empty: GatewaySettings = { gatewayUrl: "", gatewayToken: "" };

  try {
    await render(empty);
    assert.equal(tokenInput().value, "");
    assert.equal(tokenInput().type, "password");
    assert.equal(generator().parentElement?.firstElementChild, generator(), "key controls are the first content in the dialog");
    assert.equal(button("Generate and show token").closest("section"), generator(), "the button is in the first visible section");
    assert.equal(button("Generate and show token").closest("details"), null, "the button is not hidden in a collapsed guide");
    assert(button("Generate and show token").compareDocumentPosition(confirmation()) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "the button is discoverable before the confirmation instructions");
    assert(generator().querySelector('[role="group"][aria-label="Where did you deploy the gateway?"]'));
    assert.match(generator().textContent || "", /To enable generation, confirm below/i);
    assert.equal(generator().querySelector<HTMLDivElement>("#gateway-token-display")?.hidden, true, "no empty key is revealed");
    assert.equal(button("Generate and show token").disabled, true, "requires an explicit absence confirmation");
    assert.equal(button("Copy token").disabled, true);
    assert.match(generator().textContent || "", /sealed or hidden variable still counts as existing/i);
    assert.match(generator().textContent || "", /does not contact a provider or change the gateway/i);
    await click("Generate and show token");
    assert.equal(randomCalls, 0, "mounting or clicking a disabled button never creates a token");
    assert.equal(networkCalls, 0);
    assert.equal(saves.length, 0);
    assert.equal(clipboard.length, 0);

    await checkAbsence();
    assert.equal(button("Generate and show token").disabled, false);
    Object.defineProperty(dom.window, "isSecureContext", { configurable: true, value: false });
    await click("Generate and show token");
    const generationError = generator().querySelector<HTMLElement>('[role="alert"]');
    assert(generationError);
    assert.match(generationError.textContent || "", /Open Sushi over HTTPS/i);
    assert(generationError.compareDocumentPosition(confirmation()) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "a failed generation explains the problem near the action");
    assert.equal(tokenInput().value, "", "insecure contexts fail without generating a value");
    assert.equal(randomCalls, 0);
    Object.defineProperty(dom.window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(dom.window.crypto, "getRandomValues", { configurable: true, value: undefined });
    await click("Generate and show token");
    assert.match(generator().querySelector('[role="alert"]')?.textContent || "", /no token was created/i);
    assert.equal(tokenInput().value, "", "missing Web Crypto never generates a value");
    Object.defineProperty(dom.window.crypto, "getRandomValues", { configurable: true, value: () => { throw new Error("unavailable"); } });
    await click("Generate and show token");
    assert.match(generator().querySelector('[role="alert"]')?.textContent || "", /no token was created/i);
    assert.equal(tokenInput().value, "", "a failed CSPRNG has no predictable fallback");
    useNativeRandom();

    await act(async () => {
      // Two clicks before a render must not silently replace the first result.
      button("Generate and show token").click();
      button("Generate and show token").click();
      await flush();
    });
    const first = tokenInput().value;
    assert.match(first, /^[0-9a-f]{48}$/, "browser CSPRNG produces the format expected by the Railway template guard");
    assert.equal(randomCalls, 1, "rapid clicks create exactly one token");
    assert.equal(first, randomHexResults[0], "the visible token encodes the exact bytes returned by Web Crypto");
    assert.equal(tokenInput().type, "text", "an explicit generation shows the value in the field");
    assert.equal(button("Generate and show token").disabled, true, "a generated token cannot be replaced by another click");
    assert.match(generator().textContent || "", /not saved or configured on the gateway yet/i);
    assert.match(generator().textContent || "", /add\s+SUSHI_GATEWAY_TOKEN/i);
    assert.match(generator().textContent || "", /do not overwrite it/i);
    assert.match(generator().textContent || "", /closing this panel discards/i);
    const revealedKey = generator().querySelector<HTMLDivElement>("#gateway-token-display");
    assert(revealedKey);
    assert.equal(revealedKey.hidden, false, "generation visibly reveals the key beside the button");
    assert.equal(revealedKey.querySelector("code")?.textContent, first, "the complete generated key is shown");
    assert.match(revealedKey.querySelector("code")?.className || "", /break-all/, "the key wraps on narrow screens");
    const generationStatus = generator().querySelector<HTMLElement>('[role="status"]');
    assert(generationStatus);
    assert(!generationStatus.textContent?.includes(first), "the live status does not announce the key");
    assert(generationStatus.compareDocumentPosition(confirmation()) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "generation and copy feedback stay near the key controls");
    assert.equal(dom.window.localStorage.getItem("sushi_gateway_settings_v1"), null, "generation alone does not save");
    assert.equal(dom.window.localStorage.getItem("sushi_encrypted_vault_v1"), "vault-must-not-change");
    assert.equal(dom.window.localStorage.getItem("sushi.auth.sessionToken.v1"), "admin-session-must-not-leak");
    assert.deepEqual(storageSnapshot(dom.window.localStorage), localBefore, "generation does not change any local storage");
    assert.deepEqual(storageSnapshot(dom.window.sessionStorage), sessionBefore, "generation does not change session storage");
    assert.equal(saves.length, 0);
    assert.equal(networkCalls, 0, "generation does not contact a provider or gateway");
    assert.equal(clipboard.length, 0, "generation does not silently copy a secret");
    const visibilityButton = container.querySelector<HTMLButtonElement>('button[aria-controls="gateway-token"]');
    assert(visibilityButton);
    assert.equal(button("Hide gateway key").getAttribute("aria-expanded"), "true");
    await click("Hide gateway key");
    assert.equal(tokenInput().type, "password", "the generated value can be hidden again");
    assert.equal(tokenInput().value, first);
    assert.equal(revealedKey.hidden, true);
    assert(!container.textContent?.includes(first), "a hidden key is removed from visible text");
    assert.match(generator().querySelector('[role="status"]')?.textContent || "", /hidden/);
    assert.equal(button("Show gateway key").getAttribute("aria-expanded"), "false");
    await click("Show gateway key");
    assert.equal(tokenInput().type, "text");
    assert.equal(revealedKey.querySelector("code")?.textContent, first);
    await act(async () => { visibilityButton.click(); await flush(); });
    assert.equal(revealedKey.hidden, true, "the original eye control also hides the prominent display");
    await act(async () => { visibilityButton.click(); await flush(); });
    assert.equal(revealedKey.querySelector("code")?.textContent, first);

    await click("Copy token");
    assert.deepEqual(clipboard, [first], "only the explicit copy action copies the generated token");
    assert.match(generator().querySelector('[role="status"]')?.textContent || "", /Token copied/);
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true, value: { writeText: async () => { throw new Error("denied"); } },
    });
    let fallbackCopy = "";
    Object.defineProperty(dom.window.document, "execCommand", {
      configurable: true, value: (command: string) => {
        assert.equal(command, "copy");
        fallbackCopy = dom.window.document.querySelector<HTMLTextAreaElement>("textarea")?.value || "";
        return true;
      },
    });
    await click("Copy token");
    assert.equal(fallbackCopy, first, "explicit copy supports the legacy clipboard fallback");
    assert.match(generator().querySelector('[role="status"]')?.textContent || "", /Token copied/);
    assert.equal(dom.window.document.querySelector("textarea"), null, "successful fallback removes its temporary token field");
    Object.defineProperty(dom.window.document, "execCommand", { configurable: true, value: () => false });
    await click("Copy token");
    assert.match(generator().querySelector('[role="status"]')?.textContent || "", /Could not copy/);
    assert.equal(dom.window.document.querySelector("textarea"), null, "failed fallback removes its temporary token field");
    allowClipboard();

    // A stale clipboard request must not announce success for a changed token.
    const pendingCopy = deferred<void>();
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true, value: { writeText: async () => pendingCopy.promise },
    });
    await click("Copy token");
    await setToken("");
    assert.equal(confirmation().checked, false, "editing resets the missing-token confirmation");
    await act(async () => { pendingCopy.resolve(); await flush(); });
    assert.doesNotMatch(generator().querySelector('[role="status"]')?.textContent || "", /Token copied/);
    assert.equal(button("Generate and show token").disabled, true);
    allowClipboard();
    await checkAbsence();
    await click("Generate and show token");
    const second = tokenInput().value;
    assert.match(second, /^[0-9a-f]{48}$/);
    assert.notEqual(second, first, "a new explicit request uses fresh random bytes");
    assert.equal(randomCalls, 2);
    await render({ ...empty });
    assert.equal(tokenInput().value, second, "an equivalent parent rerender does not discard an unsaved token");
    await setInput("gateway-url", "https://other-gateway.up.railway.app");
    assert.equal(confirmation().checked, false, "changing the gateway address invalidates the earlier confirmation");
    assert.equal(button("Copy token").disabled, true);
    assert.match(generator().querySelector('[role="status"]')?.textContent || "", /Confirm this gateway/);
    await setInput("gateway-url", "");
    await checkAbsence();
    assert.equal(button("Copy token").disabled, false);
    assert.equal(tokenInput().value, second, "changing address never silently regenerates the token");

    // A freshly generated value is compatible with the gateway's auth logic,
    // but this local check does not claim the provider was configured.
    const oldMode = process.env.GATEWAY_ONLY;
    const oldGatewayToken = process.env.SUSHI_GATEWAY_TOKEN;
    try {
      process.env.GATEWAY_ONLY = "true";
      process.env.SUSHI_GATEWAY_TOKEN = second;
      const { verifyIncomingAuth } = await import("../src/lib/server/auth");
      assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-token": second }))).ok, true);
      assert.equal((await verifyIncomingAuth(new Headers({ "x-sushi-token": first }))).ok, false);
    } finally {
      if (oldMode === undefined) delete process.env.GATEWAY_ONLY; else process.env.GATEWAY_ONLY = oldMode;
      if (oldGatewayToken === undefined) delete process.env.SUSHI_GATEWAY_TOKEN; else process.env.SUSHI_GATEWAY_TOKEN = oldGatewayToken;
    }

    await click("Render");
    assert.equal(confirmation().checked, false, "switching providers clears the confirmation");
    assert.equal(button("Copy token").disabled, true, "reconfirm before copying a generated token for a different provider");
    await click("Railway");
    await checkAbsence();
    assert.equal(button("Copy token").disabled, false);
    assert.equal(networkCalls, 0);
    assert.equal(saves.length, 0);

    rejectSave = true;
    await click("Save Gateway Settings");
    const saveError = container.querySelector('[role="alert"]')?.textContent || "";
    assert.match(saveError, /Could not save gateway settings/i);
    assert(!saveError.includes(second), "a storage error does not disclose the token");
    assert.equal(tokenInput().value, second, "a failed save keeps the token available for copying");
    assert.equal(closed, 0, "a failed save leaves the modal open");
    assert.deepEqual(storageSnapshot(dom.window.localStorage), localBefore, "a failed save does not change local storage");
    rejectSave = false;
    await click("Save Gateway Settings");
    assert.deepEqual(saves, [{ gatewayUrl: "", gatewayToken: second }], "only an explicit save persists the generated token");
    assert.equal(JSON.parse(dom.window.localStorage.getItem("sushi_gateway_settings_v1") || "{}").gatewayToken, second);
    assert.equal(closed, 1);
    assert.equal(tokenInput().type, "password", "saving masks the value");
    assert.equal(networkCalls, 0);

    await render({ gatewayUrl: "", gatewayToken: "existing-saved-token" });
    assert.equal(revealedKey.hidden, true, "a saved token is masked when the panel opens");
    assert(!container.textContent?.includes("existing-saved-token"));
    await click("Show gateway key");
    assert.equal(revealedKey.querySelector("code")?.textContent, "existing-saved-token", "saved keys can be revealed at the top");
    await click("Hide gateway key");
    assert(!container.textContent?.includes("existing-saved-token"), "hiding removes the displayed saved key");
    await checkAbsence();
    assert.equal(button("Generate and show token").disabled, true, "a saved token cannot be overwritten");
    await setToken("");
    await checkAbsence();
    assert.equal(button("Generate and show token").disabled, true, "clearing the input alone cannot replace a saved token");
    await click("Generate and show token");
    assert.equal(randomCalls, 2);
    assert.equal(saves.length, 1);
    assert.equal(JSON.parse(dom.window.localStorage.getItem("sushi_gateway_settings_v1") || "{}").gatewayToken, second);

    await render(empty);
    await setToken("already-typed-token");
    await checkAbsence();
    assert.equal(button("Generate and show token").disabled, true, "a typed token is never overwritten");
    await setToken("");
    await checkAbsence();
    await click("Generate and show token");
    assert.equal(randomCalls, 3);
    await render(empty, false);
    await render(empty);
    assert.equal(tokenInput().value, "", "closing discards an unsaved generated token");
    assert.equal(tokenInput().type, "password");
    assert.equal(confirmation().checked, false);
    assert.equal(saves.length, 1);
    assert.equal(networkCalls, 0);

    // Normal remote-gateway save probes HTTP capabilities, but must not send
    // the newly generated credential to that unverified address.
    const remoteUrl = "https://gateway.up.railway.app";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    dom.window.localStorage.setItem("sushi_gateway_settings_v1", JSON.stringify({ gatewayUrl: remoteUrl, gatewayToken: "" }));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      networkCalls += 1;
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ...localCaps, mode: "gateway", websocketSsh: true, requiresGatewayToken: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    await render({ gatewayUrl: remoteUrl, gatewayToken: "" });
    await checkAbsence();
    await click("Generate and show token");
    const remoteToken = tokenInput().value;
    assert.match(remoteToken, /^[0-9a-f]{48}$/);
    assert.equal(networkCalls, 0, "generating for a real-looking URL still makes no network calls");
    await click("Save Gateway Settings");
    assert.equal(networkCalls, 1, "saving an untested remote URL performs only the existing capability probe");
    assert.equal(calls[0].url, `${remoteUrl}/api/system/capabilities`);
    assert.equal(calls[0].init?.credentials, "omit");
    assert.equal(calls[0].init?.cache, "no-store");
    assert.equal(new Headers(calls[0].init?.headers).has("x-sushi-token"), false);
    assert(!JSON.stringify(calls[0]).includes(remoteToken), "the unauthenticated probe never sends the new token");
    assert.deepEqual(saves[1], { gatewayUrl: remoteUrl, gatewayToken: remoteToken });
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem("sushi_gateway_settings_v1") || "{}"), saves[1]);
  } finally {
    await act(async () => { root.unmount(); await flush(); });
    globalThis.fetch = oldFetch;
    if (oldActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
    else globals.IS_REACT_ACT_ENVIRONMENT = oldActEnvironment;
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
  console.log("Gateway token UI tests passed.");
}

testGatewayTokenUi().catch((error) => { console.error(error); process.exitCode = 1; });
