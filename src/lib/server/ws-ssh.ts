import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { ClientChannel } from "ssh2";
import type { ConnectionCredentials } from "@/types/connection";
import { verifyRequestAccess, withBrowserTokenHeaders } from "./security";
import { connectSsh, type ConnectedSshSession } from "./ssh-client";
import {
  SharedSshSession,
  generateSharePasscode,
  registerSharedSession,
  getSharedSession,
} from "./shared-ssh";

/**
 * `/ws/ssh` — the interactive PTY endpoint.
 *
 * One WebSocket here is normally one shell: connect, allocate a PTY, pipe bytes both
 * ways, tear it all down when the tab closes. Two extra modes ride on the same
 * endpoint so a team can sit in front of *one* shell instead of N:
 *
 *   - `share: { join }` attaches to a shell somebody else already shared (no new SSH
 *     connection is made — the scrollback buffer is replayed instead), and
 *   - `share: { create }` on the auth message, or a `{ type: "share", action: "start" }`
 *     control message later, publishes the shell this socket already owns.
 *
 * A shared shell is **detached**: closing every browser leaves the SSH channel running
 * on the gateway until its idle TTL expires, so whoever joins next keeps working in the
 * same session instead of starting over.
 */

const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** The sub-object the browser sends to create or join a share. */
interface ShareAuthPayload {
  create?: { write?: boolean; passcode?: string | null; label?: string } | boolean;
  join?: string;
  passcode?: string;
  name?: string;
}

function asSharePayload(value: unknown): ShareAuthPayload | null {
  if (!value || typeof value !== "object") return null;
  return value as ShareAuthPayload;
}

/** Turns "auto" / "none" / an explicit 6-digit code into what the registry expects. */
function normalizePasscodeRequest(raw: unknown): "auto" | string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") return "auto";
  const value = raw.trim();
  if (!value || value === "auto") return "auto";
  if (value === "none") return null;
  return /^\d{6}$/.test(value) ? value : "auto";
}

export function handleSshConnection(ws: WebSocket, req: IncomingMessage): void {
  const reqUrl = new URL(req.url || "/ws/ssh", "http://localhost");
  const queryToken = reqUrl.searchParams.get("token");

  let sshSession: ConnectedSshSession | null = null;
  let shellStream: ClientChannel | null = null;
  /**
   * The share this socket is *attached* to (cleared when it detaches).
   */
  let shared: SharedSshSession | null = null;
  let participantId: string | null = null;
  /**
   * The share this socket *published*. It outlives `shared` on purpose: once the host
   * detaches, the shell's output must still reach the participants, and the only
   * listeners on that shell belong to the socket that created it.
   */
  let publishedShare: SharedSshSession | null = null;
  let authenticated = false;
  let shareCredentials: ConnectionCredentials | null = null;
  let lastCols = 100;
  let lastRows = 30;

  const sendJson = (payload: Record<string, unknown>) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  };

  const closeSocket = (code: number, reason: string) => {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  };

  /** Where shell output goes: the live share this socket published or joined. */
  const outputTarget = (): SharedSshSession | null => {
    const session = shared ?? publishedShare;
    return session && !session.isDestroyed ? session : null;
  };

  const authTimeout = setTimeout(() => {
    if (authenticated) return;
    sendJson({ type: "error", message: "SSH authentication handshake timed out." });
    closeSocket(1008, "Auth timeout");
  }, 15000);

  /** Ends the SSH connection — only ever safe when the shell is not shared. */
  const cleanup = () => {
    clearTimeout(authTimeout);
    try {
      shellStream?.close();
    } catch {
      // ignore
    }
    try {
      sshSession?.client.end();
    } catch {
      // ignore
    }
    shellStream = null;
    sshSession = null;
  };

  /**
   * Every socket leaves the share on the way out; the shell itself stays.
   *
   * Runs on both "close" and "error", so it has to be idempotent: a second call must
   * not fall through to `cleanup()`, which would end the SSH connection everybody
   * else is still using.
   */
  let finished = false;
  const detach = () => {
    if (finished) return;
    finished = true;
    clearTimeout(authTimeout);
    if (shared && participantId) {
      shared.detach(participantId);
      shared = null;
      participantId = null;
      return;
    }
    cleanup();
  };

  // ---- joining somebody else's shared shell ------------------------------------

  const joinShared = async (
    shareId: string,
    payload: ShareAuthPayload,
    cols: number,
    rows: number
  ) => {
    const session = getSharedSession(shareId);
    if (!session || session.status !== "live") {
      sendJson({
        type: "error",
        code: "SHARE_NOT_FOUND",
        message:
          "This shared session is no longer available. Ask the host to share the terminal again.",
      });
      closeSocket(1008, "Share not found");
      return;
    }

    const accountCheck = await verifyRequestAccess(
      withBrowserTokenHeaders(req.headers, {
        session: reqUrl.searchParams.get("session"),
        gateway: queryToken,
      })
    );

    // A signed-in Sushi account always gets in; otherwise the 6-digit code does.
    // (A passcode-only share still accepts the account, so the host is never locked
    // out of their own shell by a code they misplaced.)
    const viaAccount = accountCheck.ok;
    if (!viaAccount) {
      const passcodeCheck = session.verifyPasscode(payload.passcode);
      if (!passcodeCheck.ok) {
        // A share with no code is account-only, so say that instead of asking for a
        // code that will never be accepted.
        sendJson({
          type: "error",
          code: session.requiresPasscode ? "BAD_PASSCODE" : "PASSCODE_REQUIRED",
          requiresPasscode: session.requiresPasscode,
          message: session.requiresPasscode
            ? passcodeCheck.error
            : "This shared session is only open to people signed in to this Sushi instance.",
        });
        closeSocket(1008, "Unauthorized");
        return;
      }
    }

    authenticated = true;
    clearTimeout(authTimeout);

    shared = session;
    const entry = session.attach(ws, {
      role: viaAccount ? "owner" : "guest",
      name: payload.name,
      canWrite: session.write,
      cols,
      rows,
    });
    participantId = entry.id;

    const size = session.terminalSize;
    sendJson({
      type: "ready",
      share: { ...session.summary(), participantId: entry.id },
      replay: session.replay().toString("base64"),
      cols: size.cols,
      rows: size.rows,
      you: entry.id,
      write: entry.canWrite,
      viaAccount,
    });
    session.broadcastParticipants();
  };

  // ---- publishing this socket's shell ------------------------------------------

  const startSharing = (options: {
    write?: boolean;
    passcode?: unknown;
    label?: string;
    name?: string;
  }) => {
    if (shared || !sshSession || !shellStream) {
      sendJson({ type: "error", message: "Connect the terminal before sharing it." });
      return;
    }

    const session = new SharedSshSession({
      host: String((shareCredentials?.host || "").trim()),
      port: Number(shareCredentials?.port || 22),
      username: String((shareCredentials?.username || "").trim()),
      label: options.label,
      ssh: sshSession,
      stream: shellStream,
      cols: lastCols,
      rows: lastRows,
      write: options.write !== false,
      passcode: normalizePasscodeRequest(options.passcode),
    });

    const registered = registerSharedSession(session);
    if (!registered.ok) {
      sendJson({ type: "error", message: registered.error });
      return;
    }

    shared = session;
    publishedShare = session;
    const entry = session.attach(ws, {
      role: "owner",
      name: options.name,
      canWrite: true,
      cols: lastCols,
      rows: lastRows,
    });
    participantId = entry.id;
    // A stop issued from the HTTP API must return this socket to a private shell.
    session.onRevokedByApi = () => {
      mintedPasscode = null;
      if (shared === session) {
        shared = null;
        participantId = null;
      }
      if (publishedShare === session) publishedShare = null;
    };

    const summary = session.summary();
    sendJson({
      type: "share",
      action: "started",
      // The code is handed back exactly once, when the share is created.
      passcode: mintedPasscode || undefined,
      share: { ...summary, participantId: entry.id },
      you: entry.id,
    });
    session.broadcastParticipants();
  };

  const stopSharing = () => {
    if (!shared || !participantId) return;
    const session = shared;
    shared = null;
    participantId = null;
    mintedPasscode = null;
    if (publishedShare === session) publishedShare = null;
    // Guests are disconnected; the host keeps the shell in their own tab.
    session.revoke("The host stopped sharing this session.");
    sendJson({ type: "share", action: "stopped" });
  };

  const rotatePasscode = () => {
    if (!shared || !participantId) {
      sendJson({ type: "error", message: "This terminal is not being shared." });
      return;
    }
    const code = shared.rotatePasscode("auto");
    mintedPasscode = code;
    sendJson({
      type: "share",
      action: "rotated",
      passcode: code || undefined,
      share: shared.summary(),
    });
  };

  /** The code shown to the host, kept only so the create message can echo it back. */
  let mintedPasscode: string | null = null;

  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return;
    }

    if (msg.type === "ping") {
      sendJson({ type: "pong", ts: Date.now() });
      return;
    }

    if (msg.type === "auth" && !authenticated) {
      // Joining a shared shell is the one request that carries no SSH credentials.
      const share = asSharePayload(msg.share);
      const joinId = typeof share?.join === "string" ? share.join.trim() : "";
      if (joinId) {
        await joinShared(
          joinId,
          share ?? {},
          clamp(msg.cols, 100, MIN_COLS, MAX_COLS),
          clamp(msg.rows, 30, MIN_ROWS, MAX_ROWS)
        );
        return;
      }

      const tokenCheck = await verifyRequestAccess(
        withBrowserTokenHeaders(req.headers, {
          session:
            (typeof msg.sessionToken === "string" ? msg.sessionToken.trim() : "") ||
            reqUrl.searchParams.get("session"),
          gateway:
            (typeof msg.gatewayToken === "string" ? msg.gatewayToken.trim() : "") || queryToken,
        })
      );
      if (!tokenCheck.ok) {
        sendJson({ type: "error", message: tokenCheck.error });
        closeSocket(1008, "Unauthorized");
        return;
      }

      const creds = msg.credentials as ConnectionCredentials | undefined;
      if (!creds || !creds.host || !creds.username) {
        sendJson({ type: "error", message: "Missing SSH host or username." });
        closeSocket(1008, "Invalid credentials");
        return;
      }

      authenticated = true;
      clearTimeout(authTimeout);
      lastCols = clamp(msg.cols, 100, MIN_COLS, MAX_COLS);
      lastRows = clamp(msg.rows, 30, MIN_ROWS, MAX_ROWS);
      shareCredentials = creds;

      const shareRequest = asSharePayload(msg.share)?.create;
      const createOptions =
        typeof shareRequest === "object" && shareRequest !== null
          ? shareRequest
          : shareRequest === true
            ? {}
            : null;

      try {
        sshSession = await connectSsh(creds, 15000);

        sshSession.client.on("error", (err: Error) => {
          sendJson({ type: "error", message: err.message });
          const session = outputTarget();
          if (session) {
            session.destroy(`SSH connection error: ${err.message}`);
            shared = null;
            participantId = null;
            publishedShare = null;
          }
          cleanup();
        });

        sshSession.client.on("end", () => {
          const session = outputTarget();
          if (session) {
            session.destroy("The remote host closed the SSH connection.");
            shared = null;
            participantId = null;
            publishedShare = null;
            return;
          }
          sendJson({ type: "exit" });
          closeSocket(1000, "SSH ended");
        });

        sshSession.client.shell(
          { term: "xterm-256color", cols: lastCols, rows: lastRows },
          (err, stream) => {
            if (err) {
              sendJson({
                type: "error",
                message: err.message || "Failed to allocate interactive PTY shell.",
              });
              cleanup();
              closeSocket(1011, "Shell error");
              return;
            }

            shellStream = stream;
            sendJson({
              type: "ready",
              fingerprint: sshSession?.fingerprint,
              banner: sshSession?.serverBanner,
            });

            stream.on("data", (chunk: Buffer) => {
              const target = outputTarget();
              if (target) {
                target.handleOutput(chunk);
                return;
              }
              sendJson({ type: "data", data: chunk.toString("base64") });
            });

            stream.stderr.on("data", (chunk: Buffer) => {
              const target = outputTarget();
              if (target) {
                target.handleOutput(chunk);
                return;
              }
              sendJson({ type: "data", data: chunk.toString("base64") });
            });

            stream.on("close", () => {
              const session = outputTarget();
              if (session) {
                shared = null;
                participantId = null;
                publishedShare = null;
                session.destroy("The remote shell closed.");
                return;
              }
              sendJson({ type: "exit" });
              cleanup();
              if (ws.readyState === ws.OPEN) closeSocket(1000, "Shell closed");
            });

            // Only now is there a shell that can be shared.
            if (createOptions) {
              const requested = normalizePasscodeRequest(createOptions.passcode);
              mintedPasscode = requested === "auto" ? generateSharePasscode() : requested;
              startSharing({
                write: createOptions.write !== false,
                passcode: mintedPasscode,
                label: createOptions.label,
                name: asSharePayload(msg.share)?.name,
              });
            }
          }
        );
      } catch (err) {
        sendJson({
          type: "error",
          message: err instanceof Error ? err.message : "SSH connection failed.",
        });
        cleanup();
        closeSocket(1011, "SSH failed");
      }
      return;
    }

    if (!authenticated) return;

    if (msg.type === "input") {
      const data = msg.data;
      if (typeof data !== "string" || data.length === 0) return;
      if (shared && participantId) {
        shared.handleInput(participantId, data);
        return;
      }
      try {
        shellStream?.write(data);
      } catch {
        // ignore
      }
      return;
    }

    if (msg.type === "resize") {
      lastCols = clamp(msg.cols, lastCols, MIN_COLS, MAX_COLS);
      lastRows = clamp(msg.rows, lastRows, MIN_ROWS, MAX_ROWS);
      if (shared && participantId) {
        shared.handleResize(participantId, lastCols, lastRows);
        return;
      }
      try {
        shellStream?.setWindow(lastRows, lastCols, 0, 0);
      } catch {
        // ignore
      }
      return;
    }

    if (msg.type === "name" && shared && participantId) {
      if (typeof msg.name === "string") shared.rename(participantId, msg.name);
      return;
    }

    if (msg.type === "share") {
      if (msg.action === "start") {
        const requested = normalizePasscodeRequest(msg.passcode);
        mintedPasscode = requested === "auto" ? generateSharePasscode() : requested;
        startSharing({
          write: msg.write !== false,
          passcode: mintedPasscode,
          label: typeof msg.label === "string" ? msg.label : undefined,
          name: typeof msg.name === "string" ? msg.name : undefined,
        });
      } else if (msg.action === "stop") {
        stopSharing();
      } else if (msg.action === "rotate") {
        rotatePasscode();
      }
    }
  });

  ws.on("close", detach);
  ws.on("error", detach);
}
