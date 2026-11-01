"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Monitor,
  Maximize2,
  Camera,
  Clipboard,
  RotateCw,
  Download,
  Keyboard as KeyboardIcon,
  Radio,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ShieldCheck,
  X,
  UserRound,
  Upload,
  SlidersHorizontal,
  Eye,
  Volume2,
  VolumeX,
  Gauge,
  Sparkles,
  ArrowDownToLine,
  Unlink,
  Maximize,
} from "lucide-react";
import type { HostProfile, RdpPerformance, RdpProbeResult } from "@/types/connection";
import {
  type GatewaySettings,
  buildWebSocketUrl,
  getAuthHeaders,
} from "@/lib/client/gateway";
import { getStoredSessionToken } from "@/lib/client/auth-storage";
import { downloadRdpFile } from "@/lib/client/rdp-file";
import {
  type RdpPrefs,
  describeRdpStatus,
  fitRemoteSize,
  formatRemoteSize,
  loadRdpPrefs,
  nextRemoteSize,
  reconnectDelayMs,
  saveRdpPrefs,
  shouldRetryRdpStatus,
} from "@/lib/client/rdp-session";

interface RdpDesktopSessionProps {
  profile: HostProfile;
  isActive: boolean;
  guacdAvailable: boolean;
  gatewaySettings: GatewaySettings;
  onOpenGatewayModal: () => void;
  /** Adjust the desktop credentials (Windows user / domain / port). */
  onEditCredentials: () => void;
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Modifier keysyms, used to implement the Ctrl+Alt+Shift release. */
const CTRL_KEYSYMS = new Set([0xffe3, 0xffe4]);
const ALT_KEYSYMS = new Set([0xffe9, 0xffea]);
const SHIFT_KEYSYMS = new Set([0xffe1, 0xffe2]);
const MODIFIER_KEYSYMS = new Set([...CTRL_KEYSYMS, ...ALT_KEYSYMS, ...SHIFT_KEYSYMS]);

// X11 keysyms used by Guacamole protocol
const KEYSYMS = {
  CTRL_L: 0xffe3,
  ALT_L: 0xffe9,
  SHIFT_L: 0xffe1,
  DELETE: 0xffff,
  SUPER_L: 0xffeb,
  TAB: 0xff09,
  ESCAPE: 0xff1b,
  F4: 0xffc1,
};

/** Guacamole.Client.State.CONNECTED / DISCONNECTED */
const STATE_CONNECTED = 3;
const STATE_DISCONNECTED = 5;

/** How many times a dropped desktop is retried before giving up. */
const MAX_RECONNECT_ATTEMPTS = 5;

/** True when the user is typing into one of Sushi's own inputs, not the desktop. */
function isTypingInField(): boolean {
  const el = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

const PERFORMANCE_OPTIONS: Array<{
  value: RdpPerformance;
  label: string;
  hint: string;
  Icon: typeof Sparkles;
}> = [
  { value: "best", label: "Best", hint: "Wallpaper, themes, 32-bit colour", Icon: Sparkles },
  { value: "balanced", label: "Balanced", hint: "Themes + smoothing, no wallpaper", Icon: Gauge },
  { value: "fast", label: "Fast", hint: "16-bit, no themes — for slow links", Icon: ArrowDownToLine },
];

export function RdpDesktopSession({
  profile,
  isActive,
  guacdAvailable,
  gatewaySettings,
  onOpenGatewayModal,
  onEditCredentials,
}: RdpDesktopSessionProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const displayHostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<import("guacamole-common-js").Client | null>(null);
  const keyboardRef = useRef<import("guacamole-common-js").Keyboard | null>(null);
  /** Root of the drive guacd redirects into the session (upload target). */
  const filesystemRef = useRef<import("guacamole-common-js").GuacamoleObject | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  /** Keyboard goes to the desktop only while the user has clicked into it. */
  const keyboardCapturedRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const connectedRef = useRef(false);
  /** Last resolution we asked the server for (avoids resize loops). */
  const lastSentSizeRef = useRef<{ width: number; height: number } | null>(null);

  /**
   * Session preferences: the host can pin the pictures preset / audio / drive, and
   * whatever it does not pin comes from this browser's last session.
   */
  const [prefs, setPrefs] = useState<RdpPrefs>(() => {
    const saved = loadRdpPrefs();
    return {
      ...saved,
      performance: profile.rdpPerformance ?? saved.performance,
      audio: profile.rdpAudio ?? saved.audio,
      drive: profile.rdpDrive ?? saved.drive,
    };
  });
  const prefsRef = useRef(prefs);

  const shouldAttemptStreamDefault = Boolean(
    guacdAvailable || gatewaySettings.gatewayUrl.trim()
  );

  const [streamEnabled, setStreamEnabled] = useState<boolean>(shouldAttemptStreamDefault);
  const [connState, setConnState] = useState<
    "idle" | "connecting" | "connected" | "reconnecting" | "error" | "closed"
  >(shouldAttemptStreamDefault ? "connecting" : "idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [remoteSize, setRemoteSize] = useState<{ w: number; h: number }>({
    w: profile.rdpWidth || 1280,
    h: profile.rdpHeight || 720,
  });
  const [connectSeq, setConnectSeq] = useState(0);
  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectCountdown, setReconnectCountdown] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [driveLabel, setDriveLabel] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [showSpecialKeys, setShowSpecialKeys] = useState(false);
  const [showClipboard, setShowClipboard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [clipboardText, setClipboardText] = useState("");

  // Live RDP X.224 / TLS / NLA Probe state
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<RdpProbeResult | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectScheduledRef = useRef(false);

  const pushToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4500);
  }, []);

  const setCaptured = useCallback((value: boolean) => {
    keyboardCapturedRef.current = value;
    setKeyboardCaptured(value);
    if (!value) keyboardRef.current?.reset();
  }, []);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  /** Unlocks the Web Audio context; browsers only allow that after a real click. */
  const unlockAudio = useCallback(async () => {
    if (!prefsRef.current.audio) return;
    try {
      const GuacamoleMod = await import("guacamole-common-js");
      const Guacamole = GuacamoleMod.default || GuacamoleMod;
      const context = Guacamole.AudioContextFactory.getAudioContext();
      if (context && context.state === "suspended") {
        await context.resume();
      }
    } catch {
      // No Web Audio API: the desktop simply stays silent.
    }
  }, []);

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      const res = await fetch("/api/rdp/probe", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          host: profile.host,
          port: profile.port || 3389,
        }),
      });
      const data = (await res.json()) as RdpProbeResult;
      setProbeResult(data);
    } catch (err) {
      setProbeResult({
        ok: false,
        reachable: false,
        latencyMs: 0,
        host: profile.host,
        port: profile.port || 3389,
        supportedProtocols: [],
        nlaRequired: false,
        tlsSupported: false,
        error: err instanceof Error ? err.message : "Probe request failed.",
      });
    } finally {
      setProbing(false);
    }
  }, [gatewaySettings, profile.host, profile.port]);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  useEffect(() => {
    if (guacdAvailable || gatewaySettings.gatewayUrl.trim()) {
      setStreamEnabled(true);
    }
  }, [guacdAvailable, gatewaySettings.gatewayUrl]);

  const recalcScale = useCallback(() => {
    const client = clientRef.current;
    const stage = stageRef.current;
    if (!client || !stage) return;
    const display = client.getDisplay();
    const dw = display.getWidth();
    const dh = display.getHeight();
    if (!dw || !dh) return;

    const availW = Math.max(200, stage.clientWidth - 16);
    const availH = Math.max(200, stage.clientHeight - 16);

    if (!prefsRef.current.fitWindow) {
      // Fixed resolution: scale the picture down (or up to 1.5×) to fit the pane.
      display.scale(Math.min(availW / dw, availH / dh, 1.5));
      return;
    }

    // Fit window: the server resolution follows the pane, so draw 1:1 — only
    // shrink while the server is still catching up with the last resize.
    display.scale(Math.min(1, availW / dw, availH / dh));
  }, []);

  /**
   * Asks the desktop to match the pane (guacd `resize-method: display-update`).
   * Debounced by the caller; skipped when the change is only a pixel or two.
   */
  const applyRemoteSize = useCallback(
    (force = false) => {
      const client = clientRef.current;
      const stage = stageRef.current;
      if (!client || !stage || !connectedRef.current) return;
      if (!prefsRef.current.fitWindow) return;

      const display = client.getDisplay();
      const pane = { width: stage.clientWidth - 8, height: stage.clientHeight - 8 };
      // Compare against both what we asked for and what the desktop currently is, so
      // a resize that does not change the picture cannot trigger the next one.
      const target =
        nextRemoteSize(lastSentSizeRef.current, pane) ??
        (force ? nextRemoteSize({ width: display.getWidth(), height: display.getHeight() }, pane) : null);
      if (!target) return;
      lastSentSizeRef.current = target;
      client.sendSize(target.width, target.height);
    },
    []
  );

  const clearReconnectTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    reconnectScheduledRef.current = false;
    setReconnectCountdown(0);
  }, []);

  /** Retries a desktop that dropped, unless the failure was authentication. */
  const scheduleReconnect = useCallback(
    (statusCode: number) => {
      if (reconnectScheduledRef.current) return;
      if (statusCode && !shouldRetryRdpStatus(statusCode)) return;

      const attempt = reconnectAttemptRef.current + 1;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        setConnState("error");
        setErrorMessage(
          `The desktop stayed unreachable after ${MAX_RECONNECT_ATTEMPTS} automatic retries. Check the VPS gateway and try again.`
        );
        return;
      }

      reconnectAttemptRef.current = attempt;
      reconnectScheduledRef.current = true;
      const delay = reconnectDelayMs(attempt);
      setReconnectAttempt(attempt);
      setConnState("reconnecting");
      setReconnectCountdown(Math.ceil(delay / 1000));

      countdownTimerRef.current = window.setInterval(() => {
        setReconnectCountdown((value) => Math.max(0, value - 1));
      }, 1000);

      reconnectTimerRef.current = window.setTimeout(() => {
        clearReconnectTimers();
        setConnectSeq((value) => value + 1);
      }, delay);
    },
    [clearReconnectTimers]
  );

  // Connect Guacamole HTML5 RDP Client
  useEffect(() => {
    if (!streamEnabled) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let guacKeyboard: import("guacamole-common-js").Keyboard | null = null;
    let resizeTimer: number | null = null;

    async function startGuacSession() {
      if (!displayHostRef.current) return;
      setConnState("connecting");
      setErrorMessage(null);
      connectedRef.current = false;

      const GuacamoleMod = await import("guacamole-common-js");
      const Guacamole = GuacamoleMod.default || GuacamoleMod;
      if (disposed || !displayHostRef.current) return;

      const wsUrl = buildWebSocketUrl("/ws/rdp", gatewaySettings);
      const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
      const client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      const displayEl = display.getElement();
      displayHostRef.current.innerHTML = "";
      displayHostRef.current.appendChild(displayEl);

      display.onresize = (w: number, h: number) => {
        setRemoteSize({ w, h });
        recalcScale();
      };

      tunnel.onerror = (status) => {
        if (disposed) return;
        connectedRef.current = false;
        setConnState("error");
        setErrorMessage(describeRdpStatus(status.code, status.message));
        scheduleReconnect(status.code);
      };

      client.onerror = (status) => {
        if (disposed) return;
        connectedRef.current = false;
        setConnState("error");
        setErrorMessage(describeRdpStatus(status.code, status.message));
        scheduleReconnect(status.code);
      };

      client.onstatechange = (state: number) => {
        if (disposed) return;
        if (state === STATE_CONNECTED) {
          connectedRef.current = true;
          reconnectAttemptRef.current = 0;
          setReconnectAttempt(0);
          setConnState("connected");
          recalcScale();
          // Match the pane exactly once the server is listening, then let the
          // user click into the picture to start typing.
          lastSentSizeRef.current = { width: display.getWidth(), height: display.getHeight() };
          applyRemoteSize(false);
          window.setTimeout(() => {
            if (!disposed) displayHostRef.current?.focus();
          }, 60);
        } else if (state === 1 || state === 2) {
          setConnState((prev) => (prev === "reconnecting" ? prev : "connecting"));
        } else if (state === STATE_DISCONNECTED) {
          connectedRef.current = false;
          setConnState((prev) => (prev === "error" ? "error" : "closed"));
          scheduleReconnect(0);
        }
      };

      /**
       * A desktop that goes away cleanly (guacd stopped, network dropped with a clean
       * FIN, the RDP server rebooting) closes the tunnel without an error status, so
       * nothing would otherwise notice it died. Treat "tunnel closed while we thought
       * we were connected" as a drop and rebuild the session.
       */
      tunnel.onstatechange = (state: number) => {
        if (disposed) return;
        if (state !== Guacamole.Tunnel.State.CLOSED) return;
        // Only a session that actually produced a picture is retried here; a failure
        // during the handshake already carries a status code of its own.
        if (!connectedRef.current) return;
        connectedRef.current = false;
        setConnState((prev) => (prev === "error" ? "error" : "closed"));
        setErrorMessage((prev) => prev ?? "The desktop connection closed.");
        scheduleReconnect(0);
      };

      // Remote clipboard → the OS clipboard (best effort), so Ctrl+V works locally.
      client.onclipboard = (stream, mimetype) => {
        if (mimetype !== "text/plain") return;
        const reader = new Guacamole.StringReader(stream);
        let buf = "";
        reader.ontext = (chunk: string) => {
          buf += chunk;
        };
        reader.onend = () => {
          setClipboardText(buf);
          if (navigator.clipboard?.writeText && document.hasFocus()) {
            navigator.clipboard.writeText(buf).then(
              () => pushToast(`Desktop clipboard copied to your clipboard (${buf.length} chars)`),
              () => pushToast("Desktop clipboard updated — open Clipboard to copy it")
            );
          }
        };
      };

      // The drive guacd redirects into the session is the upload target.
      client.onfilesystem = (object, name) => {
        filesystemRef.current = object;
        setDriveLabel(name || "Sushi");
      };

      // Mouse binding with scale awareness
      const mouse = new Guacamole.Mouse(displayEl);
      mouse.onmousedown = (state) => {
        setCaptured(true);
        if (prefsRef.current.readOnly) return;
        client.sendMouseState(state, true);
      };
      mouse.onmouseup = (state) => {
        if (prefsRef.current.readOnly) return;
        client.sendMouseState(state, true);
      };
      mouse.onmousemove = (state) => {
        if (prefsRef.current.readOnly) return;
        client.sendMouseState(state, true);
      };

      // Keyboard binding (only while the desktop owns the keyboard).
      // Ctrl+Alt+Shift is the standard Guacamole escape hatch: it hands the
      // keyboard back to the browser instead of sending anything.
      guacKeyboard = new Guacamole.Keyboard(window);
      keyboardRef.current = guacKeyboard;
      const heldModifiers = new Set<number>();
      guacKeyboard.onkeydown = (keysym: number) => {
        if (!keyboardCapturedRef.current || !isActiveRef.current) return true;
        if (isTypingInField() || prefsRef.current.readOnly) return true;

        if (MODIFIER_KEYSYMS.has(keysym)) {
          heldModifiers.add(keysym);
          const held = Array.from(heldModifiers);
          if (
            held.some((key) => CTRL_KEYSYMS.has(key)) &&
            held.some((key) => ALT_KEYSYMS.has(key)) &&
            held.some((key) => SHIFT_KEYSYMS.has(key))
          ) {
            // Tell the desktop the modifiers went up, otherwise it stays stuck
            // thinking Ctrl is still pressed.
            for (const key of heldModifiers) client.sendKeyEvent(0, key);
            heldModifiers.clear();
            guacKeyboard?.reset();
            setCaptured(false);
            pushToast("Keyboard released to the browser");
            return true;
          }
        }

        client.sendKeyEvent(1, keysym);
        return false;
      };
      guacKeyboard.onkeyup = (keysym: number) => {
        if (heldModifiers.delete(keysym) && !keyboardCapturedRef.current) return;
        if (!keyboardCapturedRef.current || !isActiveRef.current) return;
        if (isTypingInField() || prefsRef.current.readOnly) return;
        client.sendKeyEvent(0, keysym);
      };

      // First frame: start at the pane size so the desktop is crisp immediately.
      const stageEl = stageRef.current;
      const initial = prefsRef.current.fitWindow && stageEl
        ? fitRemoteSize(stageEl.clientWidth - 8, stageEl.clientHeight - 8)
        : {
            width: profile.rdpWidth || 1280,
            height: profile.rdpHeight || 720,
          };

      const payload = toBase64Url(
        JSON.stringify({
          host: profile.host,
          port: profile.port || 3389,
          username: profile.username,
          password: profile.password || "",
          domain: profile.domain || "",
          rdpSecurity: profile.rdpSecurity || "any",
          ignoreCert: profile.ignoreCert !== false,
          width: initial.width,
          height: initial.height,
          dpi: 96,
          rdpPerformance: prefsRef.current.performance,
          rdpAudio: prefsRef.current.audio,
          rdpReadOnly: prefsRef.current.readOnly,
          rdpDrive: prefsRef.current.drive,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      );
      lastSentSizeRef.current = initial;

      const queryParts = [`payload=${encodeURIComponent(payload)}`];
      const sessionToken = getStoredSessionToken();
      if (sessionToken) {
        queryParts.push(`session=${encodeURIComponent(sessionToken)}`);
      }
      if (gatewaySettings.gatewayToken) {
        queryParts.push(`token=${encodeURIComponent(gatewaySettings.gatewayToken)}`);
      }

      client.connect(queryParts.join("&"));

      if (stageEl) {
        resizeObserver = new ResizeObserver(() => {
          recalcScale();
          if (resizeTimer) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => applyRemoteSize(), 350);
        });
        resizeObserver.observe(stageEl);
      }
    }

    void startGuacSession();

    return () => {
      disposed = true;
      connectedRef.current = false;
      filesystemRef.current = null;
      keyboardRef.current = null;
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      guacKeyboard?.reset();
      try {
        clientRef.current?.disconnect();
      } catch {
        // ignore
      }
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamEnabled, connectSeq]);

  useEffect(() => {
    recalcScale();
  }, [recalcScale, isActive]);

  useEffect(() => {
    if (connState === "connected") recalcScale();
  }, [connState, recalcScale]);

  // A real paste (Ctrl+V) goes to the desktop clipboard while it has the keyboard.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!keyboardCapturedRef.current || !isActiveRef.current) return;
      if (isTypingInField()) return;
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      const client = clientRef.current;
      if (!client) return;
      void (async () => {
        const GuacamoleMod = await import("guacamole-common-js");
        const Guacamole = GuacamoleMod.default || GuacamoleMod;
        const stream = client.createClipboardStream("text/plain");
        const writer = new Guacamole.StringWriter(stream);
        writer.sendText(text);
        writer.sendEnd();
      })();
      pushToast("Pasted into the desktop clipboard");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [pushToast]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
    };
  }, []);

  const applyPrefs = useCallback(
    (patch: Partial<RdpPrefs>, options: { reconnect?: boolean } = {}) => {
      const next = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      setPrefs(next);
      saveRdpPrefs(next);

      if (options.reconnect) {
        // guacd receives these at connect time, so the stream is rebuilt.
        clearReconnectTimers();
        reconnectAttemptRef.current = 0;
        setConnState("connecting");
        setConnectSeq((value) => value + 1);
        pushToast("Applying desktop settings…");
      } else {
        recalcScale();
      }
    },
    [clearReconnectTimers, pushToast, recalcScale]
  );

  const reconnectNow = useCallback(() => {
    clearReconnectTimers();
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setErrorMessage(null);
    setConnState("connecting");
    setStreamEnabled(true);
    setConnectSeq((value) => value + 1);
    void runProbe();
  }, [clearReconnectTimers, runProbe]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const object = filesystemRef.current;
      if (!object) {
        pushToast("This desktop did not offer a drive, so uploads are unavailable.");
        return;
      }
      const GuacamoleMod = await import("guacamole-common-js");
      const Guacamole = GuacamoleMod.default || GuacamoleMod;
      let uploaded = 0;
      for (const file of files) {
        setUpload({ name: file.name, percent: 0 });
        try {
          await new Promise<void>((resolve, reject) => {
            const stream = object.createOutputStream("application/octet-stream", file.name);
            const writer = new Guacamole.BlobWriter(stream);
            writer.onprogress = (_blob: Blob, offset: number) => {
              setUpload({
                name: file.name,
                percent: file.size ? Math.min(100, Math.round((offset / file.size) * 100)) : 100,
              });
            };
            writer.oncomplete = () => resolve();
            writer.onerror = () => reject(new Error(`${file.name} could not be uploaded`));
            writer.sendBlob(file);
          });
          uploaded += 1;
        } catch (err) {
          pushToast(err instanceof Error ? err.message : "Upload failed.");
        }
      }
      setUpload(null);
      if (uploaded > 0) {
        pushToast(
          `${uploaded} file${uploaded === 1 ? "" : "s"} copied to the desktop drive (${driveLabel || "Sushi"})`
        );
      }
    },
    [driveLabel, pushToast]
  );

  const sendKeyCombo = (keys: number[]) => {
    const client = clientRef.current;
    if (!client) return;
    for (const k of keys) client.sendKeyEvent(1, k);
    for (let i = keys.length - 1; i >= 0; i--) client.sendKeyEvent(0, keys[i]);
    setShowSpecialKeys(false);
  };

  const pushClipboardToRemote = async (text: string) => {
    const client = clientRef.current;
    if (!client) return;
    const GuacamoleMod = await import("guacamole-common-js");
    const Guacamole = GuacamoleMod.default || GuacamoleMod;
    const stream = client.createClipboardStream("text/plain");
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
  };

  const captureScreenshot = () => {
    const client = clientRef.current;
    if (!client) return;
    const canvas = client.getDisplay().flatten();
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `rdp-${profile.host}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const toggleFullscreen = () => {
    if (!stageRef.current) return;
    if (!document.fullscreenElement) {
      void stageRef.current.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  };

  const showDiagnosticsPanel =
    !streamEnabled || connState === "error" || connState === "closed";

  const performanceLabel =
    PERFORMANCE_OPTIONS.find((option) => option.value === prefs.performance)?.label ?? "Balanced";

  const toolbarChip = useMemo(
    () =>
      connState === "connected"
        ? `Live RDP (${formatRemoteSize(remoteSize.w, remoteSize.h)})`
        : connState === "connecting"
          ? "Negotiating RDP..."
          : connState === "reconnecting"
            ? `Reconnecting ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}… ${reconnectCountdown}s`
            : "RDP Inspector / Launcher",
    [connState, reconnectAttempt, reconnectCountdown, remoteSize.w, remoteSize.h]
  );

  return (
    <div
      data-rdp-root=""
      className="flex h-full w-full flex-col overflow-hidden bg-[#090b10]"
    >
      {/* RDP Control Bar */}
      {/*
        One row, never wrapped: the toolbar's height must not depend on how long the
        status chip is. A wrapping toolbar shrinks the desktop pane by a row, the pane
        asks for a smaller desktop, and the two sizes ping-pong forever.
      */}
      <div
        onPointerDown={() => setCaptured(false)}
        className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-white/8 bg-[#0f131b] px-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              connState === "connected"
                ? "bg-emerald-500/15 text-emerald-300"
                : connState === "connecting" || connState === "reconnecting"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-[#ff6b57]/15 text-[#ff8b7b]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connState === "connected"
                  ? "bg-emerald-400"
                  : connState === "connecting" || connState === "reconnecting"
                    ? "animate-pulse bg-amber-400"
                    : "bg-[#ff6b57]"
              }`}
            />
            {toolbarChip}
          </span>

          <span className="font-mono-code hidden truncate text-xs text-slate-400 xl:inline">
            {profile.domain ? `${profile.domain}\\` : ""}
            {profile.username}@{profile.host}:{profile.port || 3389}
          </span>

          {connState === "connected" && prefs.readOnly && (
            <span
              title="The desktop ignores keyboard and mouse. Turn this off in Settings to take control."
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-200"
            >
              <Eye className="h-3 w-3" />
              View only
            </span>
          )}

          {connState === "connected" && keyboardCaptured && !prefs.readOnly && (
            <button
              type="button"
              onClick={() => setCaptured(false)}
              title="Keys go to the desktop. Click to release them (or press Ctrl+Alt+Shift)."
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-500/20"
            >
              <KeyboardIcon className="h-3 w-3" />
              Keyboard captured
              <Unlink className="h-3 w-3 opacity-70" />
            </button>
          )}

          {connState === "connected" && !prefs.audio && (
            <span
              title="Desktop audio is muted for this session"
              className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300"
            >
              <VolumeX className="h-3 w-3" />
              Muted
            </span>
          )}

          {upload && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-200">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="max-w-[160px] truncate">{upload.name}</span>
              {upload.percent}%
            </span>
          )}
        </div>

        <div className="relative flex shrink-0 items-center gap-1">
          {connState === "connected" && (
            <>
              {/* Fit / fixed resolution */}
              <button
                type="button"
                onClick={() => {
                  const nextFit = !prefs.fitWindow;
                  applyPrefs({ fitWindow: nextFit });
                  const client = clientRef.current;
                  if (!nextFit && client) {
                    // Back to the resolution stored on the host.
                    const width = profile.rdpWidth || 1280;
                    const height = profile.rdpHeight || 720;
                    lastSentSizeRef.current = { width, height };
                    client.sendSize(width, height);
                  } else {
                    window.setTimeout(() => applyRemoteSize(true), 80);
                  }
                }}
                title={
                  prefs.fitWindow
                    ? "Fit window: the desktop resolution follows this pane. Click to use the host's fixed resolution."
                    : "Fixed resolution, scaled to fit. Click to make the desktop match this pane."
                }
                className={`rounded-lg border p-1.5 transition ${
                  prefs.fitWindow
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
                    : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>

              {/* Special Keys */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowSpecialKeys((v) => !v);
                    setShowClipboard(false);
                    setShowSettings(false);
                  }}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
                >
                  <KeyboardIcon className="h-3.5 w-3.5 text-[#ff6b57]" />
                  <span className="hidden sm:inline">Keys</span>
                </button>
                {showSpecialKeys && (
                  <div className="absolute right-0 top-9 z-30 w-52 space-y-1 rounded-xl border border-white/12 bg-[#141924] p-1.5 shadow-2xl">
                    <button
                      type="button"
                      onClick={() =>
                        sendKeyCombo([
                          KEYSYMS.CTRL_L,
                          KEYSYMS.ALT_L,
                          KEYSYMS.DELETE,
                        ])
                      }
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Ctrl + Alt + Del
                    </button>
                    <button
                      type="button"
                      onClick={() => sendKeyCombo([KEYSYMS.SUPER_L])}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Windows / Super Key
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        sendKeyCombo([
                          KEYSYMS.CTRL_L,
                          KEYSYMS.SHIFT_L,
                          KEYSYMS.ESCAPE,
                        ])
                      }
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Task Manager (Ctrl+Shift+Esc)
                    </button>
                    <button
                      type="button"
                      onClick={() => sendKeyCombo([KEYSYMS.ALT_L, KEYSYMS.TAB])}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Alt + Tab
                    </button>
                    <button
                      type="button"
                      onClick={() => sendKeyCombo([KEYSYMS.ALT_L, KEYSYMS.F4])}
                      className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/8"
                    >
                      Alt + F4
                    </button>
                  </div>
                )}
              </div>

              {/* Clipboard Sync */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowClipboard((v) => !v);
                    setShowSpecialKeys(false);
                    setShowSettings(false);
                  }}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
                  title="Clipboard: Ctrl+V in the desktop pastes your local clipboard"
                >
                  <Clipboard className="h-3.5 w-3.5 text-sky-400" />
                  <span className="hidden sm:inline">Clipboard</span>
                </button>
                {showClipboard && (
                  <div className="absolute right-0 top-9 z-30 w-80 space-y-2 rounded-xl border border-white/12 bg-[#141924] p-3 shadow-2xl">
                    <div className="flex items-center justify-between text-xs font-medium text-white">
                      <span>Remote Clipboard Sync</span>
                      <button
                        type="button"
                        onClick={() => setShowClipboard(false)}
                        className="text-slate-400 hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-slate-400">
                      Pressing <span className="font-mono-code text-slate-300">Ctrl+V</span> inside the
                      desktop pastes your local clipboard. Text copied in the desktop is put back on
                      your clipboard automatically.
                    </p>
                    <textarea
                      rows={4}
                      value={clipboardText}
                      onChange={(e) => setClipboardText(e.target.value)}
                      placeholder="Paste text here to send to remote RDP clipboard..."
                      className="font-mono-code w-full rounded-lg border border-white/10 bg-[#090b10] p-2 text-xs text-white outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void pushClipboardToRemote(clipboardText);
                          setShowClipboard(false);
                          pushToast("Sent to the desktop clipboard");
                        }}
                        className="flex-1 rounded-lg bg-sky-500 py-1.5 text-xs font-semibold text-slate-950"
                      >
                        Send to Desktop
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard?.writeText(clipboardText);
                          pushToast("Copied the desktop clipboard locally");
                        }}
                        className="rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/10"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Upload into the session */}
              {prefs.drive && (
                <button
                  type="button"
                  onClick={() => uploadInputRef.current?.click()}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
                  title={
                    driveLabel
                      ? `Upload a file into the session (drive "${driveLabel}")`
                      : "Upload a file into the session (needs drive redirection)"
                  }
                >
                  <Upload className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="hidden sm:inline">Upload</span>
                </button>
              )}

              <button
                type="button"
                onClick={captureScreenshot}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
                title="Capture PNG screenshot"
              >
                <Camera className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
                title="Toggle Fullscreen"
              >
                <Maximize className="h-3.5 w-3.5" />
              </button>
            </>
          )}

          {/* Session settings */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowSettings((v) => !v);
                setShowSpecialKeys(false);
                setShowClipboard(false);
              }}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
              title="Desktop quality, audio, view-only and upload settings"
            >
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#ff6b57]" />
              <span className="hidden md:inline">{performanceLabel}</span>
            </button>
            {showSettings && (
              <div className="absolute right-0 top-9 z-30 w-72 space-y-3 rounded-xl border border-white/12 bg-[#141924] p-3 shadow-2xl">
                <div className="flex items-center justify-between text-xs font-medium text-white">
                  <span>Desktop settings</span>
                  <button
                    type="button"
                    onClick={() => setShowSettings(false)}
                    className="text-slate-400 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div>
                  <div className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-400">
                    Picture quality
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {PERFORMANCE_OPTIONS.map(({ value, label, Icon }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          value === prefs.performance
                            ? undefined
                            : applyPrefs({ performance: value }, { reconnect: true })
                        }
                        className={`flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-[11px] transition ${
                          prefs.performance === value
                            ? "border-[#ff6b57]/60 bg-[#ff6b57]/15 text-white"
                            : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-snug text-slate-400">
                    {PERFORMANCE_OPTIONS.find((option) => option.value === prefs.performance)?.hint}
                  </p>
                </div>

                {(
                  [
                    {
                      key: "audio" as const,
                      label: "Desktop audio",
                      hint: "Play the remote's sounds here",
                      Icon: prefs.audio ? Volume2 : VolumeX,
                    },
                    {
                      key: "readOnly" as const,
                      label: "View only",
                      hint: "Stop sending keyboard and mouse to the desktop",
                      Icon: Eye,
                    },
                    {
                      key: "drive" as const,
                      label: "File uploads",
                      hint: `Redirect a drive so files can be dropped in${driveLabel ? ` (${driveLabel})` : ""}`,
                      Icon: Upload,
                    },
                  ]
                ).map(({ key, label, hint, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => applyPrefs({ [key]: !prefs[key] }, { reconnect: true })}
                    title={hint}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10"
                  >
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 text-slate-400" />
                      {label}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                        prefs[key]
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-white/10 text-slate-400"
                      }`}
                    >
                      {prefs[key] ? "ON" : "OFF"}
                    </span>
                  </button>
                ))}

                <div className="flex items-center justify-between gap-2 border-t border-white/8 pt-2 text-[11px] text-slate-400">
                  <span>
                    Auto-reconnect: {reconnectAttempt > 0 ? `retry ${reconnectAttempt}` : "armed"}
                  </span>
                  <button
                    type="button"
                    onClick={() => downloadRdpFile(profile)}
                    className="inline-flex items-center gap-1 text-slate-300 hover:text-white"
                    title="Download a native .rdp file"
                  >
                    <Download className="h-3 w-3" /> .rdp
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onEditCredentials}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
            title="Edit the desktop username, domain, port and password"
          >
            <UserRound className="h-3.5 w-3.5 text-[#ff6b57]" />
            <span className="hidden 2xl:inline">Credentials</span>
          </button>

          <button
            type="button"
            onClick={reconnectNow}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
            title="Reconnect the desktop session"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">
              {streamEnabled ? "Reconnect" : "Try Live Stream"}
            </span>
          </button>
        </div>
      </div>

      {/* Main Viewport */}
      <div
        ref={stageRef}
        data-rdp-stage=""
        tabIndex={0}
        onPointerDown={() => {
          void unlockAudio();
          if (!prefsRef.current.readOnly) setCaptured(true);
        }}
        onDragOver={(event) => {
          // Always swallow the drop: without this the browser navigates away
          // and the session is lost.
          event.preventDefault();
          if (connState === "connected") setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!filesystemRef.current) {
            pushToast("This desktop did not offer a drive, so uploads are unavailable.");
            return;
          }
          void uploadFiles(Array.from(event.dataTransfer.files));
        }}
        className={`relative flex min-h-0 flex-1 items-center justify-center bg-[#07090d] outline-none ring-inset transition ${
          // Fit-window must never grow scrollbars: a scrollbar shrinks the pane, the
          // pane asks for a smaller desktop, the scrollbar disappears — a resize loop.
          prefs.fitWindow ? "overflow-hidden" : "overflow-auto"
        } ${keyboardCaptured && connState === "connected" ? "ring-1 ring-emerald-500/25" : ""}`}
      >
        {/* Guacamole HTML5 Canvas Container */}
        <div
          ref={displayHostRef}
          tabIndex={-1}
          className={`flex items-center justify-center outline-none ${
            showDiagnosticsPanel ? "hidden" : "block"
          }`}
        />

        {connState === "connecting" && streamEnabled && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#090b10]/90 backdrop-blur-xs">
            <Loader2 className="mb-3 h-8 w-8 animate-spin text-[#ff6b57]" />
            <div className="text-sm font-medium text-white">
              Connecting HTML5 RDP Desktop to {profile.host}:{profile.port || 3389}...
            </div>
            <div className="mt-1 text-xs text-slate-400">
              Negotiating X.224 / {profile.rdpSecurity?.toUpperCase() || "ANY"} via guacd ·{" "}
              {performanceLabel} quality
            </div>
          </div>
        )}

        {connState === "reconnecting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#090b10]/95">
            <Loader2 className="mb-3 h-8 w-8 animate-spin text-amber-400" />
            <div className="text-sm font-medium text-white">
              Desktop dropped — reconnecting in {reconnectCountdown}s
            </div>
            <div className="mt-1 text-xs text-slate-400">
              Attempt {reconnectAttempt} of {MAX_RECONNECT_ATTEMPTS} · the session is rebuilt
              automatically
            </div>
            <button
              type="button"
              onClick={reconnectNow}
              className="mt-3 rounded-lg border border-white/12 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10"
            >
              Retry now
            </button>
          </div>
        )}

        {/* Click-to-type hint: the desktop only gets keys once it is clicked. */}
        {connState === "connected" && !keyboardCaptured && !prefs.readOnly && (
          <button
            type="button"
            onClick={() => setCaptured(true)}
            className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-1.5 text-xs font-medium text-emerald-100 shadow-xl backdrop-blur transition hover:bg-emerald-500/25"
          >
            Click the desktop to type
          </button>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-sky-400/70 bg-sky-500/10">
            <Upload className="mb-2 h-7 w-7 text-sky-300" />
            <div className="text-sm font-medium text-sky-100">
              Drop to copy into the desktop
            </div>
            <div className="text-xs text-sky-200/80">
              Files land on the redirected drive ({driveLabel || "Sushi"})
            </div>
          </div>
        )}

        {toast && (
          <div className="absolute bottom-4 right-4 z-30 max-w-xs rounded-xl border border-white/12 bg-[#141924]/95 px-3 py-2 text-xs text-slate-100 shadow-2xl">
            {toast}
          </div>
        )}

        {/* Diagnostics & Hybrid Launcher View (when guacd isn't active or stream errored) */}
        {showDiagnosticsPanel && (
          <div className="mx-auto w-full max-w-2xl space-y-5 p-6">
            <div className="rounded-2xl border border-white/10 bg-[#111621] p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#ff6b57]/15 text-[#ff6b57]">
                    <Monitor className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-white">
                      {profile.name}
                    </h3>
                    <p className="font-mono-code text-xs text-slate-400">
                      rdp://{profile.username}@{profile.host}:{profile.port || 3389}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void runProbe()}
                  disabled={probing}
                  className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10"
                >
                  {probing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                  Re-probe X.224
                </button>
              </div>

              {errorMessage && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div>{errorMessage}</div>
                    <div className="text-amber-200/80">
                      Desktop logins are usually a Windows account
                      (<span className="font-mono-code">Administrator</span>,
                      a domain user, or the Linux user signed in to xrdp), which
                      can differ from the SSH login this session was opened from.
                    </div>
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      <button
                        type="button"
                        onClick={onEditCredentials}
                        className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 px-2 py-0.5 font-medium text-amber-100 transition hover:bg-amber-500/20"
                      >
                        <UserRound className="h-3 w-3" />
                        Edit desktop credentials
                      </button>
                      <button
                        type="button"
                        onClick={reconnectNow}
                        className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 px-2 py-0.5 font-medium text-amber-100 transition hover:bg-amber-500/20"
                      >
                        <RotateCw className="h-3 w-3" />
                        Retry now
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Live RDP Handshake Probe Results */}
              <div className="mt-5 rounded-xl border border-white/8 bg-[#0b0e15] p-4">
                <div className="mb-2.5 flex items-center justify-between text-xs font-medium text-slate-300">
                  <span>Live MS-RDPBCGR X.224 &amp; TLS Server Handshake</span>
                  {probeResult && (
                    <span className="font-mono-code text-slate-400">
                      {probeResult.latencyMs} ms
                    </span>
                  )}
                </div>

                {probing && !probeResult ? (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#ff6b57]" />
                    Probing TCP &amp; X.224 negotiation on {profile.host}:
                    {profile.port || 3389}...
                  </div>
                ) : probeResult ? (
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center gap-2">
                      {probeResult.reachable ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-rose-400" />
                      )}
                      <span
                        className={
                          probeResult.reachable
                            ? "font-medium text-emerald-300"
                            : "font-medium text-rose-300"
                        }
                      >
                        {probeResult.reachable
                          ? `Online • ${probeResult.negotiatedProtocol || "RDP Confirmed"}`
                          : probeResult.error || "Host unreachable on RDP port"}
                      </span>
                    </div>

                    {probeResult.supportedProtocols.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {probeResult.supportedProtocols.map((p) => (
                          <span
                            key={p}
                            className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300"
                          >
                            {p}
                          </span>
                        ))}
                        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300">
                          NLA Required: {probeResult.nlaRequired ? "Yes" : "Optional"}
                        </span>
                      </div>
                    )}

                    {probeResult.certificate?.subjectCN && (
                      <div className="font-mono-code mt-2 rounded-lg border border-white/6 bg-white/[0.02] p-2.5 text-[11px] text-slate-300">
                        <div>Certificate CN: {probeResult.certificate.subjectCN}</div>
                        {probeResult.certificate.fingerprint256 && (
                          <div className="truncate text-slate-400">
                            SHA-256: {probeResult.certificate.fingerprint256}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              {/* Launch Actions */}
              <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => downloadRdpFile(profile)}
                  className="flex items-center justify-center gap-2 rounded-xl bg-[#ff6b57] px-4 py-3 text-xs font-semibold text-white shadow-lg shadow-[#ff6b57]/20 transition hover:bg-[#ff7f6e]"
                >
                  <Download className="h-4 w-4" />
                  Launch Native .rdp Client
                </button>

                <button
                  type="button"
                  onClick={onOpenGatewayModal}
                  className="flex items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/6 px-4 py-3 text-xs font-semibold text-white transition hover:bg-white/12"
                >
                  <Radio className="h-4 w-4 text-emerald-400" />
                  Configure VPS Gateway (guacd)
                </button>
              </div>

              <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
                Live browser RDP streaming uses Apache Guacamole&apos;s{" "}
                <code className="font-mono-code text-slate-300">guacd</code> daemon
                included in <code className="font-mono-code text-slate-300">docker-compose.yml</code>.
                Self-host on a VPS with <code className="font-mono-code text-slate-300">docker compose up -d</code>{" "}
                or attach your VPS Gateway URL to stream full desktop sessions directly inside
                this tab.
              </p>
            </div>
          </div>
        )}
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          void uploadFiles(files);
        }}
      />
    </div>
  );
}
