import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { getDb } from "../db/index.js";

interface WsClient {
  id: string;
  terminalId?: string;
  role: string; // "pos" | "kds" | "admin"
  socket: WebSocket;
  connectedAt: number; // Date.now() when client connected
}

const clients = new Map<string, WsClient>();

// Broadcast to all connected clients (or filtered by role)
export function broadcast(event: string, data: unknown, filter?: { role?: string; excludeId?: string }) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });

  for (const [, client] of clients) {
    if (filter?.excludeId && client.id === filter.excludeId) continue;
    if (filter?.role && client.role !== filter.role) continue;

    try {
      if (client.socket.readyState === 1) { // OPEN
        client.socket.send(message);
      }
    } catch {
      // Client disconnected, will be cleaned up
    }
  }
}

// Send to specific terminal
export function sendToTerminal(terminalId: string, event: string, data: unknown) {
  for (const [, client] of clients) {
    if (client.terminalId === terminalId) {
      try {
        if (client.socket.readyState === 1) {
          client.socket.send(JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
        }
      } catch {
        // Ignore
      }
      break;
    }
  }
}

export function getConnectedClients() {
  return Array.from(clients.values()).map((c) => ({
    id: c.id,
    terminalId: c.terminalId,
    role: c.role,
    connectedAt: new Date(c.connectedAt).toISOString(),
  }));
}

export function registerWebSocketHandler(app: FastifyInstance) {
  // Use Fastify's route-level websocket handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get("/ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const clientId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const query = (req.query ?? {}) as Record<string, string>;

    // Resolve role server-side from terminal record (prevents client spoofing)
    let role = "pos";
    if (query.terminalId) {
      try {
        const db = getDb();
        const terminal = db
          .prepare("SELECT type FROM terminals WHERE id = ?")
          .get(query.terminalId) as { type?: string } | undefined;
        if (terminal?.type) {
          role = terminal.type.toLowerCase(); // e.g. "POS", "KDS", "ADMIN"
        }
      } catch {
        // DB not ready or terminal not found — default to "pos"
      }
    }

    const client: WsClient = {
      id: clientId,
      terminalId: query.terminalId,
      role,
      socket,
      connectedAt: Date.now(),
    };

    clients.set(clientId, client);
    console.log(`[WS] Client connected: ${clientId} (role=${client.role}, terminal=${client.terminalId})`);

    // Send welcome message
    socket.send(JSON.stringify({
      event: "connected",
      data: { clientId, connectedClients: clients.size },
      timestamp: new Date().toISOString(),
    }));

    // Handle incoming messages
    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { event: string; data: unknown };
        if (!msg.event) return; // Ignore messages without event field

        switch (msg.event) {
          case "ping":
            socket.send(JSON.stringify({ event: "pong", timestamp: new Date().toISOString() }));
            break;

          // KDS: Order status updates
          case "order:status":
            broadcast("order:status", msg.data, { excludeId: clientId });
            break;

          // KDS: Item bumped
          case "item:bumped":
            broadcast("item:bumped", msg.data, { excludeId: clientId });
            break;

          // POS: New order created
          case "order:created":
            broadcast("order:created", msg.data, { role: "kds" });
            break;

          // POS: Order voided
          case "order:voided":
            broadcast("order:voided", msg.data);
            break;

          // Table status changed
          case "table:updated":
            broadcast("table:updated", msg.data, { excludeId: clientId });
            break;

          // Cash drawer event
          case "drawer:opened":
            broadcast("drawer:opened", msg.data, { role: "admin" });
            break;

          default:
            // Forward unknown events to all
            broadcast(msg.event, msg.data, { excludeId: clientId });
        }
      } catch (err) {
        console.error(`[WS] Malformed message from ${clientId}:`, err);
      }
    });

    socket.on("close", () => {
      clients.delete(clientId);
      console.log(`[WS] Client disconnected: ${clientId} (${clients.size} remaining)`);
    });

    socket.on("error", () => {
      clients.delete(clientId);
    });
  });
}
