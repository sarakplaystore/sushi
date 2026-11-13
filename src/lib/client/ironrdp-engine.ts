import type { RdpSecurityMode } from "@/types/connection";

export const IRONRDP_SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  NumpadEnter: 0xe01c,
  ControlRight: 0xe01d,
  NumpadDivide: 0xe035,
  PrintScreen: 0xe037,
  AltRight: 0xe038,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c,
  OSLeft: 0xe05b,
  OSRight: 0xe05c,
  ContextMenu: 0xe05d,
  Pause: 0xe11d45,
};

/** X11 keysyms used by RdpDesktopSession's Special Keys menu -> PS/2 Set 1 scancodes. */
export const KEYSYM_TO_SCANCODE: Record<number, number> = {
  0xffe3: 0x1d, // CTRL_L
  0xffe9: 0x38, // ALT_L
  0xffff: 0xe053, // DELETE
  0xffeb: 0xe05b, // SUPER_L
  0xffe1: 0x2a, // SHIFT_L
  0xff1b: 0x01, // ESCAPE
  0xff09: 0x0f, // TAB
  0xffc1: 0x3e, // F4
};

export interface IronRdpErrorDiagnosis {
  title: string;
  detail: string;
  retryable: boolean;
  codeLabel: string;
}

export function formatRdpDestination(host: string, port: number): string {
  const trimmed = host.trim();
  const safePort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 3389;
  if (trimmed.includes(":") && !trimmed.startsWith("[")) {
    return `[${trimmed}]:${safePort}`;
  }
  return `${trimmed}:${safePort}`;
}

export function clampEvenDesktopSize(
  width: number,
  height: number
): { width: number; height: number } {
  const w = Math.max(640, Math.min(4096, Math.floor(width / 2) * 2));
  const h = Math.max(480, Math.min(2160, Math.floor(height / 2) * 2));
  return { width: w, height: h };
}

export function describeIronRdpError(err: unknown): IronRdpErrorDiagnosis {
  if (err && typeof err === "object" && "kind" in err && typeof (err as { kind?: unknown }).kind === "function") {
    try {
      const ironErr = err as {
        kind: () => number;
        backtrace?: () => string;
        rdcleanpathDetails?: () => {
          errorCode?: number;
          httpStatusCode?: number;
          wsaErrorCode?: number;
          tlsAlertCode?: number;
        };
      };
      const kind = ironErr.kind();
      const rawBt = ironErr.backtrace ? ironErr.backtrace() : "";
      const details = ironErr.rdcleanpathDetails ? ironErr.rdcleanpathDetails() : undefined;

      if (kind === 1 || kind === 2) {
        return {
          title: "Authentication failed",
          detail:
            "The remote Windows / xrdp machine rejected the username, domain, or password. Click Edit desktop credentials to update the account.",
          retryable: false,
          codeLabel: kind === 1 ? "WrongPassword" : "LogonFailure",
        };
      }
      if (kind === 3) {
        return {
          title: "Remote Desktop access denied",
          detail:
            "Credentials were accepted, but this account is not permitted to sign in over Remote Desktop (check Remote Desktop Users membership).",
          retryable: false,
          codeLabel: "AccessDenied",
        };
      }
      if (kind === 6 || rawBt.includes("HYBRID_REQUIRED_BY_SERVER") || rawBt.includes("NegotiationFailure")) {
        const needsNla =
          rawBt.includes("HYBRID_REQUIRED_BY_SERVER") || /requires.*CredSSP/i.test(rawBt);
        return {
          title: "RDP security negotiation failed",
          detail: needsNla
            ? "This server requires Network Level Authentication (NLA / CredSSP). Set RDP Security to Any or NLA and make sure a valid password is saved."
            : `Security mode negotiation failed.${rawBt ? ` (${rawBt.split("\n")[0]})` : ""}`,
          retryable: false,
          codeLabel: "NegotiationFailure",
        };
      }
      if (details) {
        if (details.httpStatusCode === 401 || details.httpStatusCode === 403) {
          return {
            title:
              details.wsaErrorCode === 10013
                ? "Target host blocked by server policy"
                : "Sushi session authorization required",
            detail:
              details.wsaErrorCode === 10013
                ? "Connections to private/metadata addresses are blocked on this server."
                : "Your Sushi session or gateway token was not accepted. Reload or check Gateway settings.",
            retryable: false,
            codeLabel: `HTTP ${details.httpStatusCode}`,
          };
        }
        if (details.wsaErrorCode === 10061) {
          return {
            title: "Connection refused by remote host",
            detail:
              "Nothing is listening on the RDP port (default 3389), or a firewall blocked the TCP connection. Verify Remote Desktop / xrdp is running.",
            retryable: true,
            codeLabel: "ECONNREFUSED",
          };
        }
        if (details.wsaErrorCode === 10060) {
          return {
            title: "Timed out reaching RDP server",
            detail:
              "TCP port 3389 did not respond in time. Check the host IP/hostname and cloud security group / firewall rules for port 3389.",
            retryable: true,
            codeLabel: "ETIMEDOUT",
          };
        }
        if (details.wsaErrorCode === 10051 || details.wsaErrorCode === 10065) {
          return {
            title: "Remote host unreachable",
            detail:
              "DNS lookup failed or there is no network route to this host.",
            retryable: false,
            codeLabel: "EHOSTUNREACH",
          };
        }
        if (details.tlsAlertCode !== undefined) {
          return {
            title: "TLS certificate / handshake rejected",
            detail:
              details.tlsAlertCode === 48
                ? 'The RDP server uses a self-signed certificate. Enable "Ignore Self-Signed Certificate" in host settings.'
                : `TLS handshake failed (alert ${details.tlsAlertCode}).`,
            retryable: false,
            codeLabel: `TLS_${details.tlsAlertCode}`,
          };
        }
      }
      if (kind === 4 || kind === 5) {
        return {
          title: kind === 5 ? "Could not reach RDP relay" : "Could not establish RDP tunnel",
          detail:
            rawBt.split("\n")[0] ||
            "The RDP server closed or rejected the connection during handshake.",
          retryable: true,
          codeLabel: kind === 5 ? "ProxyConnect" : "RDCleanPath",
        };
      }
      return {
        title: "Remote desktop disconnected",
        detail: rawBt.split("\n")[0] || "The RDP session ended unexpectedly.",
        retryable: true,
        codeLabel: "IronRDP",
      };
    } catch {
      // Fall through to generic handling
    }
  }

  const msg = err instanceof Error ? err.message : String(err || "Unknown RDP error");
  return {
    title: "Remote desktop connection failed",
    detail: msg,
    retryable: !/unauthorized|authentication|password|denied|wasm|webassembly/i.test(msg),
    codeLabel: "RDP",
  };
}

type IronRdpModule = typeof import("ironrdp-wasm");

let wasmLoadPromise: Promise<IronRdpModule> | null = null;

export function loadIronRdpModule(wasmUrl = "/api/rdp/wasm"): Promise<IronRdpModule> {
  if (!wasmLoadPromise) {
    wasmLoadPromise = import("ironrdp-wasm")
      .then(async (mod) => {
        // In browser builds, Next.js / Turbopack emits `rdp_client_bg.<hash>.wasm` directly
        // into `/_next/static/media/` on Vercel's static Edge CDN (Brotli-compressed, with no
        // 4.5 MB Lambda payload limit). Try the bundled static CDN asset first when same-origin,
        // falling back to `wasmUrl` (`/api/rdp/wasm`) for custom gateways or Node test runners.
        const useBundledStaticFirst =
          typeof window !== "undefined" &&
          typeof window.location?.origin === "string" &&
          window.location.origin.startsWith("http") &&
          (!wasmUrl || wasmUrl === "/api/rdp/wasm");

        if (useBundledStaticFirst) {
          try {
            await mod.default();
          } catch {
            await mod.default({ module_or_path: wasmUrl });
          }
        } else {
          await mod.default({ module_or_path: wasmUrl });
        }
        try {
          mod.setup("warn");
        } catch {
          // setup() may only be called once
        }
        return mod;
      })
      .catch((err) => {
        wasmLoadPromise = null;
        throw err;
      });
  }
  return wasmLoadPromise;
}

export interface ConnectIronRdpOptions {
  canvas: HTMLCanvasElement;
  proxyAddress: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  domain?: string;
  rdpSecurity?: RdpSecurityMode;
  width: number;
  height: number;
  wasmUrl?: string;
  isReadOnly: () => boolean;
  isKeyboardCaptured: () => boolean;
  onReleaseCapture: () => void;
  onSyncPasteShortcut: () => Promise<void>;
  onRemoteClipboardText: (text: string) => void;
  onDesktopSize?: (width: number, height: number) => void;
  onUploadProgress?: (state: { name: string; percent: number } | null) => void;
  onToast?: (msg: string) => void;
  onTerminated: (info: { clean: boolean; reason: string; error?: unknown }) => void;
}

export interface ActiveIronRdpHandle {
  resize: (width: number, height: number) => void;
  sendKeyCombo: (keysyms: number[]) => void;
  pushClipboardText: (text: string) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<void>;
  releaseAllInputs: () => void;
  shutdown: () => void;
}

export async function connectIronRdpSession(
  opts: ConnectIronRdpOptions
): Promise<ActiveIronRdpHandle> {
  const mod = await loadIronRdpModule(opts.wasmUrl);
  const {
    SessionBuilder,
    DesktopSize,
    Extension,
    DeviceEvent,
    InputTransaction,
    ClipboardData,
  } = mod;

  const initialSize = clampEvenDesktopSize(opts.width, opts.height);
  opts.canvas.width = initialSize.width;
  opts.canvas.height = initialSize.height;

  const uploadedFiles = new Map<number, File>();
  const streamToDownload = new Map<
    number,
    {
      name: string;
      clipDataId?: number;
      fileIndex: number;
      sizeReceived?: boolean;
      expectedSize?: number;
      chunks: Uint8Array[];
      totalSize: number;
    }
  >();

  let activeSession: import("ironrdp-wasm").Session | null = null;
  let clipboardInitialized = false;
  let disposed = false;

  const builder = new SessionBuilder();
  builder.username(opts.username || "");
  builder.password(opts.password || "");
  if (opts.domain && opts.domain.trim()) {
    builder.serverDomain(opts.domain.trim());
  }
  builder.destination(formatRdpDestination(opts.host, opts.port || 3389));
  builder.proxyAddress(opts.proxyAddress);
  builder.authToken("none");
  builder.desktopSize(new DesktopSize(initialSize.width, initialSize.height));
  builder.renderCanvas(opts.canvas);

  const enableCredssp = opts.rdpSecurity !== "tls" && opts.rdpSecurity !== "rdp";
  builder.extension(new Extension("enable_credssp", enableCredssp));

  builder.setCursorStyleCallbackContext(opts.canvas);
  builder.setCursorStyleCallback(function (style: string) {
    if (!disposed) {
      opts.canvas.style.cursor = style || "default";
    }
  });

  builder.canvasResizedCallback(() => {
    if (disposed || !activeSession) return;
    try {
      const ds = activeSession.desktopSize();
      if (ds.width > 0 && ds.height > 0) {
        opts.canvas.width = ds.width;
        opts.canvas.height = ds.height;
        opts.onDesktopSize?.(ds.width, ds.height);
      }
    } catch {
      // ignore
    }
  });

  builder.remoteClipboardChangedCallback((clipboardData: import("ironrdp-wasm").ClipboardData) => {
    if (disposed) return;
    clipboardInitialized = true;
    try {
      if (clipboardData.isEmpty()) return;
      const items = clipboardData.items();
      for (const item of items) {
        const mime = item.mimeType();
        if (mime.startsWith("text/plain") || mime.includes("utf8") || mime.includes("unicode")) {
          const val = item.value();
          if (typeof val === "string") {
            opts.onRemoteClipboardText(val);
            break;
          }
        }
      }
    } catch {
      // ignore clipboard decode errors
    }
  });

  builder.forceClipboardUpdateCallback(async () => {
    if (disposed || clipboardInitialized || !activeSession) return;
    clipboardInitialized = true;
    try {
      const text = await navigator.clipboard?.readText();
      const data = new ClipboardData();
      if (text) {
        data.addText("text/plain", text);
      }
      await activeSession.onClipboardPaste(data);
    } catch {
      try {
        const empty = new ClipboardData();
        await activeSession.onClipboardPaste(empty);
      } catch {
        // ignore
      }
    }
  });

  // CLIPRDR file upload & download callbacks
  builder.extension(
    new Extension(
      "file_contents_request_callback",
      async (request: {
        streamId: number;
        index: number;
        flags: number;
        position: number;
        size: number;
      }) => {
        if (disposed || !activeSession) return;
        const file = uploadedFiles.get(request.index);
        if (!file) {
          activeSession.invokeExtension(
            new Extension("submit_file_contents", {
              stream_id: request.streamId,
              is_error: true,
              data: new Uint8Array(0),
            })
          );
          return;
        }
        try {
          if (request.flags & 0x1) {
            const sizeBytes = new Uint8Array(8);
            new DataView(sizeBytes.buffer).setBigUint64(0, BigInt(file.size), true);
            activeSession.invokeExtension(
              new Extension("submit_file_contents", {
                stream_id: request.streamId,
                is_error: false,
                data: sizeBytes,
              })
            );
          } else if (request.flags & 0x2) {
            const slice = file.slice(request.position, request.position + request.size);
            const buf = new Uint8Array(await slice.arrayBuffer());
            const endPos = Math.min(file.size, request.position + buf.byteLength);
            const pct = file.size > 0 ? Math.min(100, Math.round((endPos / file.size) * 100)) : 100;
            opts.onUploadProgress?.(pct >= 100 ? null : { name: file.name, percent: pct });
            activeSession.invokeExtension(
              new Extension("submit_file_contents", {
                stream_id: request.streamId,
                is_error: false,
                data: buf,
              })
            );
            if (endPos >= file.size) {
              opts.onToast?.(`Uploaded ${file.name} to remote desktop`);
            }
          }
        } catch {
          opts.onUploadProgress?.(null);
          activeSession.invokeExtension(
            new Extension("submit_file_contents", {
              stream_id: request.streamId,
              is_error: true,
              data: new Uint8Array(0),
            })
          );
        }
      }
    )
  );

  builder.extension(
    new Extension(
      "files_available_callback",
      (files: Array<{ name?: string; fileSize?: number }>, clipDataId?: number) => {
        if (disposed || !activeSession || !Array.isArray(files) || files.length === 0) return;
        files.forEach((f, idx) => {
          const streamId = idx + 1;
          streamToDownload.set(streamId, {
            name: f.name || `remote-file-${idx + 1}`,
            clipDataId,
            fileIndex: idx,
            chunks: [],
            totalSize: 0,
          });
          try {
            activeSession?.invokeExtension(
              new Extension("request_file_contents", {
                stream_id: streamId,
                file_index: idx,
                flags: 0x1,
                position: 0,
                size: 8,
                clip_data_id: clipDataId,
              })
            );
          } catch {
            // ignore
          }
        });
      }
    )
  );

  builder.extension(
    new Extension(
      "file_contents_response_callback",
      (response: { streamId: number; isError?: boolean; data: Uint8Array }) => {
        if (disposed || !activeSession) return;
        const info = streamToDownload.get(response.streamId);
        if (!info || response.isError) {
          streamToDownload.delete(response.streamId);
          return;
        }
        if (response.data.length === 8 && !info.sizeReceived) {
          const view = new DataView(
            response.data.buffer,
            response.data.byteOffset,
            response.data.byteLength
          );
          const expectedSize = Number(view.getBigUint64(0, true));
          info.sizeReceived = true;
          info.expectedSize = expectedSize;
          const dataStreamId = response.streamId + 1000;
          streamToDownload.set(dataStreamId, info);
          streamToDownload.delete(response.streamId);
          if (expectedSize === 0) return;
          activeSession.invokeExtension(
            new Extension("request_file_contents", {
              stream_id: dataStreamId,
              file_index: info.fileIndex,
              flags: 0x2,
              position: 0,
              size: expectedSize,
              clip_data_id: info.clipDataId,
            })
          );
          return;
        }
        info.chunks.push(new Uint8Array(response.data));
        info.totalSize += response.data.length;
        if (info.expectedSize !== undefined && info.totalSize >= info.expectedSize) {
          streamToDownload.delete(response.streamId);
          if (typeof document !== "undefined") {
            const blobParts: BlobPart[] = info.chunks.map((chunk) => {
              const copy = new Uint8Array(chunk.byteLength);
              copy.set(chunk);
              return copy.buffer;
            });
            const blob = new Blob(blobParts);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = info.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            opts.onToast?.(`Downloaded ${info.name} from remote desktop`);
          }
        }
      }
    )
  );

  const session = await builder.connect();
  activeSession = session;

  const ds = session.desktopSize();
  if (ds.width > 0 && ds.height > 0) {
    opts.canvas.width = ds.width;
    opts.canvas.height = ds.height;
    opts.onDesktopSize?.(ds.width, ds.height);
  }

  // Input listeners
  const canvas = opts.canvas;

  const onKeyDown = (e: KeyboardEvent) => {
    if (disposed || !activeSession || opts.isReadOnly() || !opts.isKeyboardCaptured()) {
      return;
    }
    if (e.ctrlKey && e.altKey && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      try {
        activeSession.releaseAllInputs();
      } catch {
        // ignore
      }
      opts.onReleaseCapture();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "v" || e.key === "V")) {
      void opts.onSyncPasteShortcut();
    }

    e.preventDefault();
    e.stopPropagation();

    const scancode = IRONRDP_SCANCODES[e.code];
    try {
      const tx = new InputTransaction();
      if (scancode !== undefined) {
        tx.addEvent(DeviceEvent.keyPressed(scancode));
      } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        tx.addEvent(DeviceEvent.unicodePressed(e.key));
      } else {
        tx.free();
        return;
      }
      activeSession.applyInputs(tx);
    } catch {
      // ignore transient input errors
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (disposed || !activeSession || opts.isReadOnly() || !opts.isKeyboardCaptured()) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const scancode = IRONRDP_SCANCODES[e.code];
    try {
      const tx = new InputTransaction();
      if (scancode !== undefined) {
        tx.addEvent(DeviceEvent.keyReleased(scancode));
      } else if (e.key && e.key.length === 1) {
        tx.addEvent(DeviceEvent.unicodeReleased(e.key));
      } else {
        tx.free();
        return;
      }
      activeSession.applyInputs(tx);
    } catch {
      // ignore
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (disposed || !activeSession || opts.isReadOnly()) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(
      0,
      Math.min(canvas.width - 1, Math.round(((e.clientX - rect.left) / rect.width) * canvas.width))
    );
    const y = Math.max(
      0,
      Math.min(canvas.height - 1, Math.round(((e.clientY - rect.top) / rect.height) * canvas.height))
    );
    try {
      const tx = new InputTransaction();
      tx.addEvent(DeviceEvent.mouseMove(x, y));
      activeSession.applyInputs(tx);
    } catch {
      // ignore
    }
  };

  const onMouseDown = (e: MouseEvent) => {
    if (disposed || !activeSession) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    if (opts.isReadOnly()) return;
    try {
      try {
        activeSession.synchronizeLockKeys(
          e.getModifierState?.("ScrollLock") ?? false,
          e.getModifierState?.("NumLock") ?? true,
          e.getModifierState?.("CapsLock") ?? false,
          false
        );
      } catch {
        // ignore
      }
      const tx = new InputTransaction();
      tx.addEvent(DeviceEvent.mouseButtonPressed(e.button));
      activeSession.applyInputs(tx);
    } catch {
      // ignore
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    if (disposed || !activeSession || opts.isReadOnly()) return;
    e.preventDefault();
    try {
      const tx = new InputTransaction();
      tx.addEvent(DeviceEvent.mouseButtonReleased(e.button));
      activeSession.applyInputs(tx);
    } catch {
      // ignore
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (disposed || !activeSession || opts.isReadOnly()) return;
    e.preventDefault();
    try {
      if (e.deltaY !== 0) {
        const tx = new InputTransaction();
        tx.addEvent(DeviceEvent.wheelRotations(true, e.deltaY > 0 ? -1 : 1, 1));
        activeSession.applyInputs(tx);
      }
      if (e.deltaX !== 0) {
        const tx = new InputTransaction();
        tx.addEvent(DeviceEvent.wheelRotations(false, e.deltaX > 0 ? -1 : 1, 1));
        activeSession.applyInputs(tx);
      }
    } catch {
      // ignore
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  const onWindowBlur = () => {
    if (disposed || !activeSession) return;
    try {
      activeSession.releaseAllInputs();
    } catch {
      // ignore
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
  }
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);

  const detachListeners = () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    }
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mouseup", onMouseUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };

  // Start IronRDP event loop in background
  session
    .run()
    .then((info) => {
      if (disposed) return;
      disposed = true;
      detachListeners();
      let reason = "Remote desktop session ended.";
      try {
        reason = info.reason() || reason;
      } catch {
        // ignore
      }
      opts.onTerminated({ clean: true, reason });
    })
    .catch((err) => {
      if (disposed) return;
      disposed = true;
      detachListeners();
      opts.onTerminated({
        clean: false,
        reason: err instanceof Error ? err.message : String(err),
        error: err,
      });
    });

  return {
    resize(width: number, height: number) {
      if (disposed || !activeSession) return;
      const clamped = clampEvenDesktopSize(width, height);
      try {
        activeSession.resize(clamped.width, clamped.height);
      } catch {
        // Display Control channel may not yet be open on older servers
      }
    },
    sendKeyCombo(keysyms: number[]) {
      if (disposed || !activeSession || opts.isReadOnly()) return;
      const scancodes = keysyms
        .map((ks) => KEYSYM_TO_SCANCODE[ks])
        .filter((sc): sc is number => sc !== undefined);
      if (scancodes.length === 0) return;
      try {
        const downTx = new InputTransaction();
        for (const sc of scancodes) {
          downTx.addEvent(DeviceEvent.keyPressed(sc));
        }
        activeSession.applyInputs(downTx);

        const upTx = new InputTransaction();
        for (const sc of [...scancodes].reverse()) {
          upTx.addEvent(DeviceEvent.keyReleased(sc));
        }
        activeSession.applyInputs(upTx);
      } catch {
        // ignore
      }
    },
    async pushClipboardText(text: string) {
      if (disposed || !activeSession) return;
      try {
        const data = new ClipboardData();
        data.addText("text/plain", text);
        await activeSession.onClipboardPaste(data);
      } catch {
        // ignore
      }
    },
    async uploadFiles(files: File[]) {
      if (disposed || !activeSession || files.length === 0) return;
      uploadedFiles.clear();
      const descriptors = files.map((file, index) => {
        uploadedFiles.set(index, file);
        return {
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
        };
      });
      activeSession.invokeExtension(new Extension("initiate_file_copy", descriptors));
      opts.onToast?.(
        `Staged ${files.length} file${files.length > 1 ? "s" : ""} on remote clipboard — press Ctrl+V in Explorer or Desktop to paste`
      );
    },
    releaseAllInputs() {
      if (disposed || !activeSession) return;
      try {
        activeSession.releaseAllInputs();
      } catch {
        // ignore
      }
    },
    shutdown() {
      if (disposed) return;
      disposed = true;
      detachListeners();
      uploadedFiles.clear();
      streamToDownload.clear();
      try {
        activeSession?.shutdown();
      } catch {
        // ignore
      }
      activeSession = null;
    },
  };
}
