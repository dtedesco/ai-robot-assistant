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
 * WebSocket endpoint for TV displays connected to a realtime agent session.
 * The RealtimeDisplay (browser with mic/camera) sends TV commands via HTTP,
 * and this WebSocket broadcasts them to connected TV displays.
 *
 * Uses agentId as the key (prefixed with "rt:" to avoid collision with bridgeId).
 */
export function registerRealtimeTvWs(
  app: FastifyInstance,
  tvHub: TvHub,
): void {
  app.get(
    "/ws/tv/realtime/:agentId",
    { websocket: true },
    (socket, req) => {
      const { agentId } = req.params as { agentId: string };
      const hubKey = `rt:${agentId}`;
      const log = req.log.child({ agentId, ws: "realtime-tv" });

      log.info("TV display connected");
      send(socket, { type: "hello", sessionId: agentId });

      // Subscribe to TV messages for this agent
      const unsub = tvHub.subscribe(hubKey, (msg) => send(socket, msg));

      socket.on("close", () => {
        log.info("TV display disconnected");
        unsub();
      });

      socket.on("error", (err) => {
        log.error({ err }, "TV socket error");
        unsub();
      });
    },
  );
}

/**
 * Get the hub key for a realtime agent session.
 */
export function getRealtimeHubKey(agentId: string): string {
  return `rt:${agentId}`;
}
