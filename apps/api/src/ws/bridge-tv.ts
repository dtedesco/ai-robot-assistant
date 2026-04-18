import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { TvDownMsg } from "@robot/shared";
import type { TvHub } from "../services/tv-hub.js";

function send(socket: WebSocket, msg: TvDownMsg): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* noop */
  }
}

/**
 * Public TV socket keyed by bridgeId. Anyone can subscribe — the TV display
 * pages are meant to be kiosk-style and shared. The bridge itself is the
 * only publisher (via /api/bridge/:bridgeId/tv/*).
 */
export function registerBridgeTvWs(app: FastifyInstance, hub: TvHub): void {
  app.get(
    "/ws/tv/bridge/:bridgeId",
    { websocket: true },
    (socket, req) => {
      const { bridgeId } = req.params as { bridgeId: string };
      send(socket, { type: "hello", sessionId: bridgeId });
      const unsub = hub.subscribe(bridgeId, (msg) => send(socket, msg));
      socket.on("close", () => unsub());
    },
  );
}
