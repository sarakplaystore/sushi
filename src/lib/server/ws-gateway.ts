import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ConnectionCredentials } from "@/types/connection";
import { verifyRequestAccess, withBrowserTokenHeaders } from "./security";
import { handleSshConnection } from "./ws-ssh";
import { bridgeRdpToGuacd } from "./guacd-bridge";
import {
  buildRDCleanPathError,
  handleRDCleanPathWebSocket,
} from "./rdcleanpath";

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

  const rdpCleanPathWss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  });

  // One handler for both modes: a private shell, and a shell shared with the team
  // (see src/lib/server/ws-ssh.ts).
  sshWss.on("connection", handleSshConnection);

  rdpWss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = new URL(req.url || "/ws/rdp", "http://localhost");
    const auth = await verifyRequestAccess(
      withBrowserTokenHeaders(req.headers, {
        session: reqUrl.searchParams.get("session"),
        gateway: reqUrl.searchParams.get("token"),
      })
    );

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

  rdpCleanPathWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = new URL(req.url || "/ws/rdp-cleanpath", "http://localhost");
    const ignoreCert = reqUrl.searchParams.get("ignoreCert") !== "0";

    // Buffer any binary frames sent by IronRDP WASM while async auth resolves.
    const earlyMessages: Buffer[] = [];
    let closedEarly = false;
    const onEarlyMessage = (rawData: unknown) => {
      const buf = Buffer.isBuffer(rawData)
        ? rawData
        : Array.isArray(rawData)
          ? Buffer.concat(rawData)
          : Buffer.from(rawData as ArrayBuffer);
      earlyMessages.push(buf);
    };
    const onEarlyClose = () => {
      closedEarly = true;
    };
    ws.on("message", onEarlyMessage);
    ws.once("close", onEarlyClose);
    ws.once("error", onEarlyClose);

    void (async () => {
      const auth = await verifyRequestAccess(
        withBrowserTokenHeaders(req.headers, {
          session: reqUrl.searchParams.get("session"),
          gateway: reqUrl.searchParams.get("token"),
        })
      );

      ws.removeListener("message", onEarlyMessage);
      ws.removeListener("close", onEarlyClose);
      ws.removeListener("error", onEarlyClose);
      if (closedEarly) return;

      if (!auth.ok) {
        try {
          if (ws.readyState === ws.OPEN) {
            ws.send(buildRDCleanPathError({ errorCode: 1, httpStatusCode: 401 }));
          }
        } catch {
          // ignore
        }
        ws.close(1008, "Unauthorized");
        return;
      }

      handleRDCleanPathWebSocket(ws, { ignoreCert });
      for (const msg of earlyMessages) {
        ws.emit("message", msg, true);
      }
    })();
  });

  return {
    canHandle(pathname: string) {
      return (
        pathname === "/ws/ssh" ||
        pathname === "/ws/rdp" ||
        pathname === "/ws/rdp-cleanpath"
      );
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
      } else if (reqUrl.pathname === "/ws/rdp-cleanpath") {
        rdpCleanPathWss.handleUpgrade(req, socket, head, (ws) => {
          rdpCleanPathWss.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    },
  };
}
