import crypto from "node:crypto";
import net from "node:net";
import type { WebSocket } from "ws";
import type { ConnectionCredentials } from "@/types/connection";
import { validateTargetHost } from "./security";

export function getGuacdConfig(): { host: string; port: number } {
  const host = process.env.GUACD_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.GUACD_PORT || 4822);
  return { host, port };
}

export async function checkGuacdAvailable(timeoutMs = 350): Promise<boolean> {
  const { host, port } = getGuacdConfig();
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Encodes a Guacamole instruction for guacd (counts Unicode code points).
 */
export function encodeGuacForDaemon(elements: string[]): string {
  return (
    elements
      .map((el) => {
        const str = String(el ?? "");
        const cpLen = Array.from(str).length;
        return `${cpLen}.${str}`;
      })
      .join(",") + ";"
  );
}

/**
 * Encodes a Guacamole instruction for Guacamole.WebSocketTunnel in browser JS
 * (counts UTF-16 code units matching JS String.prototype.length / substring).
 */
export function encodeGuacForBrowser(elements: string[]): string {
  return (
    elements
      .map((el) => {
        const str = String(el ?? "");
        return `${str.length}.${str}`;
      })
      .join(",") + ";"
  );
}

/**
 * Parses complete ';'-terminated Guacamole instructions from a guacd UTF-8 stream
 * buffer (where lengths represent Unicode code points), returning parsed instructions
 * and any incomplete trailing buffer.
 */
export function parseGuacDaemonStream(buffer: string): {
  instructions: string[][];
  remainder: string;
} {
  const instructions: string[][] = [];
  let cursor = 0;
  let instructionStart = 0;
  let currentElements: string[] = [];

  while (cursor < buffer.length) {
    const dotIdx = buffer.indexOf(".", cursor);
    if (dotIdx === -1) {
      break;
    }

    const lenStr = buffer.slice(cursor, dotIdx);
    if (!/^\d+$/.test(lenStr)) {
      throw new Error(`Invalid Guacamole element length prefix: "${lenStr.slice(0, 20)}"`);
    }
    const cpCount = Number(lenStr);

    let pos = dotIdx + 1;
    let seenCodePoints = 0;
    while (seenCodePoints < cpCount && pos < buffer.length) {
      const cp = buffer.codePointAt(pos)!;
      pos += cp > 0xffff ? 2 : 1;
      seenCodePoints++;
    }

    if (seenCodePoints < cpCount || pos >= buffer.length) {
      // Need more bytes from TCP stream
      break;
    }

    const elementValue = buffer.slice(dotIdx + 1, pos);
    const terminator = buffer[pos];
    pos += 1;

    currentElements.push(elementValue);

    if (terminator === ",") {
      cursor = pos;
      continue;
    } else if (terminator === ";") {
      instructions.push(currentElements);
      currentElements = [];
      cursor = pos;
      instructionStart = pos;
    } else {
      throw new Error(`Unexpected Guacamole instruction terminator: "${terminator}"`);
    }
  }

  return {
    instructions,
    remainder: buffer.slice(instructionStart),
  };
}

/**
 * Parses Guacamole instructions sent from Guacamole.WebSocketTunnel in the browser
 * (where lengths are UTF-16 string lengths).
 */
export function parseGuacBrowserMessage(message: string): string[][] {
  const instructions: string[][] = [];
  let cursor = 0;
  let current: string[] = [];

  while (cursor < message.length) {
    const dotIdx = message.indexOf(".", cursor);
    if (dotIdx === -1) break;
    const len = parseInt(message.slice(cursor, dotIdx), 10);
    if (Number.isNaN(len) || len < 0) break;

    const valStart = dotIdx + 1;
    const valEnd = valStart + len;
    if (valEnd >= message.length) break;

    const val = message.slice(valStart, valEnd);
    const term = message[valEnd];
    current.push(val);
    cursor = valEnd + 1;

    if (term === ";") {
      instructions.push(current);
      current = [];
    }
  }

  return instructions;
}

export async function bridgeRdpToGuacd(
  ws: WebSocket,
  creds: ConnectionCredentials
): Promise<void> {
  const rdpPort = Number(creds.port || 3389);
  await validateTargetHost(creds.host, rdpPort);

  const { host: guacdHost, port: guacdPort } = getGuacdConfig();
  const width = Math.max(640, Math.min(4096, Number(creds.width || 1280)));
  const height = Math.max(480, Math.min(2160, Number(creds.height || 720)));
  const dpi = Math.max(72, Math.min(300, Number(creds.dpi || 96)));
  const sessionUuid = crypto.randomUUID();

  const rdpParams: Record<string, string> = {
    hostname: creds.host.trim(),
    port: String(rdpPort),
    username: creds.username?.trim() || "",
    password: creds.password || "",
    domain: creds.domain?.trim() || "",
    security: creds.rdpSecurity || "any",
    "ignore-cert": creds.ignoreCert !== false ? "true" : "false",
    width: String(width),
    height: String(height),
    dpi: String(dpi),
    "color-depth": "24",
    "resize-method": "display-update",
    "enable-wallpaper": "true",
    "enable-theming": "true",
    "enable-font-smoothing": "true",
    "disable-audio": "false",
    "client-name": "Sushi Remote Workspace",
  };

  const guacdSocket = new net.Socket();
  guacdSocket.setEncoding("utf8");

  let handshakeState: "awaiting_args" | "awaiting_ready" | "active" = "awaiting_args";
  let tcpRemainder = "";
  let closed = false;

  const cleanup = (wsCloseCode?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    try {
      guacdSocket.destroy();
    } catch {
      // ignore
    }
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        if (reason && ws.readyState === ws.OPEN) {
          ws.send(encodeGuacForBrowser(["error", reason, String(wsCloseCode || 519)]));
        }
        ws.close(1000, String(wsCloseCode || 0));
      }
    } catch {
      // ignore
    }
  };

  guacdSocket.setTimeout(20000);

  guacdSocket.on("timeout", () => {
    if (handshakeState !== "active") {
      cleanup(516, "Timed out waiting for guacd RDP daemon.");
    }
  });

  guacdSocket.on("error", (err) => {
    cleanup(
      519,
      `Cannot connect to guacd (${guacdHost}:${guacdPort}): ${err.message}. Start guacd via 'docker compose up -d'.`
    );
  });

  guacdSocket.on("close", () => {
    cleanup(0);
  });

  guacdSocket.on("connect", () => {
    guacdSocket.write(encodeGuacForDaemon(["select", "rdp"]));
  });

  guacdSocket.on("data", (chunk: string) => {
    tcpRemainder += chunk;
    let parsed: { instructions: string[][]; remainder: string };
    try {
      parsed = parseGuacDaemonStream(tcpRemainder);
      tcpRemainder = parsed.remainder;
    } catch (err) {
      cleanup(512, err instanceof Error ? err.message : "Guacamole protocol error");
      return;
    }

    const outboundForBrowser: string[] = [];

    for (const instr of parsed.instructions) {
      const opcode = instr[0];
      const args = instr.slice(1);

      if (handshakeState === "awaiting_args") {
        if (opcode === "error") {
          cleanup(Number(args[1] || 512), args[0] || "guacd rejected RDP selection");
          return;
        }
        if (opcode !== "args") {
          continue;
        }

        // Send client display/media capabilities before connect
        guacdSocket.write(
          encodeGuacForDaemon(["size", String(width), String(height), String(dpi)])
        );
        guacdSocket.write(encodeGuacForDaemon(["audio", "audio/L16"]));
        guacdSocket.write(encodeGuacForDaemon(["video"]));
        guacdSocket.write(
          encodeGuacForDaemon(["image", "image/png", "image/jpeg", "image/webp"])
        );
        guacdSocket.write(encodeGuacForDaemon(["timezone", "UTC"]));

        const connectValues = args.map((argName) => {
          if (argName.startsWith("VERSION_")) {
            return argName;
          }
          return rdpParams[argName] ?? "";
        });

        guacdSocket.write(encodeGuacForDaemon(["connect", ...connectValues]));
        handshakeState = "awaiting_ready";
      } else if (handshakeState === "awaiting_ready") {
        if (opcode === "error") {
          cleanup(Number(args[1] || 519), args[0] || "RDP connection failed");
          return;
        }
        if (opcode === "ready") {
          handshakeState = "active";
          guacdSocket.setTimeout(0);
          // Send tunnel UUID instruction expected by Guacamole.WebSocketTunnel
          outboundForBrowser.push(encodeGuacForBrowser(["", sessionUuid]));
        }
      } else {
        outboundForBrowser.push(encodeGuacForBrowser(instr));
      }
    }

    if (outboundForBrowser.length > 0 && ws.readyState === ws.OPEN) {
      ws.send(outboundForBrowser.join(""));
    }
  });

  ws.on("message", (raw) => {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const instructions = parseGuacBrowserMessage(text);
    for (const instr of instructions) {
      const opcode = instr[0];
      // Handle Guacamole.WebSocketTunnel internal stability ping
      if (opcode === "") {
        if (instr[1] === "ping" && ws.readyState === ws.OPEN) {
          ws.send(encodeGuacForBrowser(["", "ping", instr[2] || String(Date.now())]));
        }
        continue;
      }

      if (handshakeState === "active" && !guacdSocket.destroyed) {
        guacdSocket.write(encodeGuacForDaemon(instr));
      }
    }
  });

  ws.on("close", () => {
    if (!guacdSocket.destroyed) {
      try {
        guacdSocket.write(encodeGuacForDaemon(["disconnect"]));
      } catch {
        // ignore
      }
    }
    cleanup(0);
  });

  ws.on("error", () => {
    cleanup(0);
  });

  guacdSocket.connect(guacdPort, guacdHost);
}
