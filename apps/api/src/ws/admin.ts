import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AdminDownMsg, AdminUpMsg } from "@robot/shared";
import type { SessionHub } from "../services/session-hub.js";

function send(socket: WebSocket, msg: AdminDownMsg): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* noop */
  }
}

function parseMsg(raw: string): AdminUpMsg | null {
  try {
    const obj = JSON.parse(raw) as AdminUpMsg;
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

export function registerAdminWs(
  app: FastifyInstance,
  hub: SessionHub,
): void {
  app.get("/ws/admin", { websocket: true }, async (socket, req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const authHeader = req.headers.authorization;
    const token =
      typeof q.token === "string" && q.token
        ? q.token
        : typeof authHeader === "string" && authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length)
          : null;

    if (!token) {
      socket.close(4401, "missing token");
      return;
    }

    try {
      app.jwt.verify(token);
    } catch {
      socket.close(4403, "invalid token");
      return;
    }

    // Subscriptions owned by this socket; cleaned up on close.
    const unsubs = new Map<string, () => void>();

    // Bridge status listener — push to this admin any online/offline changes.
    const onBridgeStatus = (bridgeId: string, online: boolean) => {
      send(socket, { type: "bridge:status", bridgeId, online });
    };
    hub.on("bridge:status", onBridgeStatus);

    socket.on("message", (raw) => {
      const msg = parseMsg(raw.toString());
      if (!msg) return;
      switch (msg.type) {
        case "subscribe": {
          if (unsubs.has(msg.sessionId)) return;
          const unsub = hub.subscribeAdmin(msg.sessionId, (event) => {
            send(socket, {
              type: "session:event",
              sessionId: msg.sessionId,
              event,
            });
          });
          unsubs.set(msg.sessionId, unsub);
          break;
        }
        case "unsubscribe": {
          const unsub = unsubs.get(msg.sessionId);
          if (unsub) {
            unsub();
            unsubs.delete(msg.sessionId);
          }
          break;
        }
        case "sendText": {
          if (!hub.hasSession(msg.sessionId)) {
            send(socket, {
              type: "error",
              message: `session ${msg.sessionId} not active`,
            });
            return;
          }
          hub.sendAdminText(msg.sessionId, msg.text);
          break;
        }
        default:
          break;
      }
    });

    socket.on("close", () => {
      for (const unsub of unsubs.values()) unsub();
      unsubs.clear();
      hub.off("bridge:status", onBridgeStatus);
    });
  });
}
