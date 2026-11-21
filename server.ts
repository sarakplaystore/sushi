import http from "node:http";
import next from "next";
import { createGatewayWebSockets } from "./src/lib/server/ws-gateway";
import { checkGuacdAvailable, getGuacdConfig } from "./src/lib/server/guacd-bridge";
import { getCorsHeaders } from "./src/lib/server/security";
import { DEFAULT_GATEWAY_ALLOWED_ORIGIN } from "./src/lib/gateway-defaults.mjs";

const dev = process.env.NODE_ENV !== "production";
const gatewayOnly = process.env.GATEWAY_ONLY === "true";
// Apply the default only when the variable is absent, never over an existing
// provider override (including an intentionally empty value or `*`). Keeping it
// here, rather than as a managed Blueprint literal, preserves Render overrides
// on later syncs and also covers Node and other Docker hosts.
if (gatewayOnly && process.env.ALLOWED_ORIGIN === undefined) {
  process.env.ALLOWED_ORIGIN = DEFAULT_GATEWAY_ALLOWED_ORIGIN;
}
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

async function bootstrap() {
  const gateway = createGatewayWebSockets();

  if (gatewayOnly) {
    const server = http.createServer(async (req, res) => {
      const origin = req.headers.origin || null;
      const cors = getCorsHeaders(origin);

      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/health" || url.pathname === "/api/system/capabilities") {
        const guacdCfg = getGuacdConfig();
        const guacdOk = await checkGuacdAvailable(350);
        const body = JSON.stringify({
          mode: "gateway",
          websocketSsh: true,
          sshTransport: "websocket",
          serverlessSshExec: false,
          serverlessSftp: false,
          rdpGuacd: guacdOk,
          rdpProbe: false,
          serverVault: false,
          requiresGatewayToken: Boolean(process.env.SUSHI_GATEWAY_TOKEN?.trim()),
          guacdHost: `${guacdCfg.host}:${guacdCfg.port}`,
          nodeVersion: process.version,
        });
        res.writeHead(200, {
          ...cors,
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(body);
        return;
      }

      // Unknown API routes must 404 (not 200) so frontends fall back to their own
      // serverless endpoints, e.g. "Test SSH Auth" -> local /api/ssh/test.
      const isUnknownApi = url.pathname.startsWith("/api/");
      res.writeHead(isUnknownApi ? 404 : 200, {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify(
          isUnknownApi
            ? {
                ok: false,
                error: `${url.pathname} is not served by a GATEWAY_ONLY Sushi gateway (WebSocket SSH/RDP only).`,
              }
            : {
                service: "sushi-gateway",
                status: "online",
                endpoints: ["/ws/ssh", "/ws/rdp", "/api/system/capabilities"],
              }
        )
      );
    });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (gateway.canHandle(url.pathname)) {
        gateway.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });

    server.listen(port, hostname, () => {
      console.log(
        `[sushi-gateway] WebSocket SSH & RDP gateway listening on http://${hostname}:${port}`
      );
    });
    return;
  }

  const app = next({ dev, hostname, port });
  await app.prepare();

  const handle = app.getRequestHandler();
  const nextUpgrade = app.getUpgradeHandler();

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (gateway.canHandle(url.pathname)) {
      gateway.handleUpgrade(req, socket, head);
    } else {
      nextUpgrade(req, socket, head);
    }
  });

  server.listen(port, hostname, () => {
    console.log(
      `[sushi] Unified Web + SSH/SFTP/RDP server ready on http://${hostname}:${port} (${
        dev ? "development" : "production"
      })`
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  console.error("[sushi] Fatal startup error:", err);
  process.exit(1);
});
