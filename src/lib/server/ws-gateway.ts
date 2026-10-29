import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientChannel } from "ssh2";
import type { ConnectionCredentials } from "@/types/connection";
import { verifyGatewayTokenFromHeaders } from "./security";
import { connectSsh, type ConnectedSshSession } from "./ssh-client";
import { bridgeRdpToGuacd } from "./guacd-bridge";

export interface GatewayUpgradeDispatcher {
  canHandle: (pathname: string) => boolean;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export function createGatewayWebSockets(): GatewayUpgradeDispatcher {
  // Set global runtime flag so /api/system/capabilities knows WebSocket server is active
  (globalThis as Record<string, unknown>).__SUSHI_WS_ACTIVE__ = true;

  const sshWss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });

  const rdpWss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: (protocols) => {
      if (protocols.has("guacamole")) return "guacamole";
      const first = protocols.values().next().value;
      return first || false;
    },
  });

  sshWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = new URL(req.url || "/ws/ssh", "http://localhost");
    const queryToken = reqUrl.searchParams.get("token");

    let sshSession: ConnectedSshSession | null = null;
    let shellStream: ClientChannel | null = null;
    let authenticated = false;

    const sendJson = (payload: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        sendJson({ type: "error", message: "SSH authentication handshake timed out." });
        ws.close(1008, "Auth timeout");
      }
    }, 15000);

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
        const tokenCheck = verifyGatewayTokenFromHeaders(
          req.headers,
          (typeof msg.gatewayToken === "string" ? msg.gatewayToken : null) || queryToken
        );
        if (!tokenCheck.ok) {
          sendJson({ type: "error", message: tokenCheck.error });
          ws.close(1008, "Unauthorized");
          return;
        }

        authenticated = true;
        clearTimeout(authTimeout);

        const creds = msg.credentials as ConnectionCredentials | undefined;
        if (!creds || !creds.host || !creds.username) {
          sendJson({ type: "error", message: "Missing SSH host or username." });
          ws.close(1008, "Invalid credentials");
          return;
        }

        const cols = Math.max(20, Math.min(500, Number(msg.cols || 100)));
        const rows = Math.max(5, Math.min(200, Number(msg.rows || 30)));

        try {
          sshSession = await connectSsh(creds, 15000);

          sshSession.client.on("error", (err) => {
            sendJson({ type: "error", message: err.message });
            cleanup();
          });

          sshSession.client.on("end", () => {
            sendJson({ type: "exit" });
            ws.close(1000, "SSH ended");
          });

          sshSession.client.shell(
            { term: "xterm-256color", cols, rows },
            (err, stream) => {
              if (err) {
                sendJson({
                  type: "error",
                  message: err.message || "Failed to allocate interactive PTY shell.",
                });
                cleanup();
                ws.close(1011, "Shell error");
                return;
              }

              shellStream = stream;
              sendJson({
                type: "ready",
                fingerprint: sshSession?.fingerprint,
                banner: sshSession?.serverBanner,
              });

              stream.on("data", (chunk: Buffer) => {
                sendJson({
                  type: "data",
                  data: chunk.toString("base64"),
                });
              });

              stream.stderr.on("data", (chunk: Buffer) => {
                sendJson({
                  type: "data",
                  data: chunk.toString("base64"),
                });
              });

              stream.on("close", () => {
                sendJson({ type: "exit" });
                cleanup();
                if (ws.readyState === ws.OPEN) {
                  ws.close(1000, "Shell closed");
                }
              });
            }
          );
        } catch (err) {
          sendJson({
            type: "error",
            message: err instanceof Error ? err.message : "SSH connection failed.",
          });
          cleanup();
          ws.close(1011, "SSH failed");
        }
        return;
      }

      if (msg.type === "input" && shellStream) {
        if (typeof msg.data === "string") {
          shellStream.write(msg.data);
        }
        return;
      }

      if (msg.type === "resize" && shellStream) {
        const cols = Math.max(20, Math.min(500, Number(msg.cols || 80)));
        const rows = Math.max(5, Math.min(200, Number(msg.rows || 24)));
        shellStream.setWindow(rows, cols, 0, 0);
      }
    });

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  rdpWss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = new URL(req.url || "/ws/rdp", "http://localhost");
    const queryToken = reqUrl.searchParams.get("token");
    const auth = verifyGatewayTokenFromHeaders(req.headers, queryToken);

    if (!auth.ok) {
      ws.close(1008, "769");
      return;
    }

    const encodedPayload = reqUrl.searchParams.get("payload");
    if (!encodedPayload) {
      ws.close(1008, "512");
      return;
    }

    let creds: ConnectionCredentials;
    try {
      const jsonStr = Buffer.from(encodedPayload, "base64url").toString("utf8");
      creds = JSON.parse(jsonStr) as ConnectionCredentials;
    } catch {
      ws.close(1008, "512");
      return;
    }

    try {
      await bridgeRdpToGuacd(ws, creds);
    } catch {
      ws.close(1011, "519");
    }
  });

  return {
    canHandle(pathname: string) {
      return pathname === "/ws/ssh" || pathname === "/ws/rdp";
    },
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const reqUrl = new URL(req.url || "/", "http://localhost");
      if (reqUrl.pathname === "/ws/ssh") {
        sshWss.handleUpgrade(req, socket, head, (ws) => {
          sshWss.emit("connection", ws, req);
        });
      } else if (reqUrl.pathname === "/ws/rdp") {
        rdpWss.handleUpgrade(req, socket, head, (ws) => {
          rdpWss.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    },
  };
}
