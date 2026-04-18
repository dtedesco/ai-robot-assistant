import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { TvDownMsg } from "@robot/shared";
import type { SessionHub } from "../services/session-hub.js";

function send(socket: WebSocket, msg: TvDownMsg): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* noop */
  }
}

export function registerTvWs(app: FastifyInstance, hub: SessionHub): void {
  app.get(
    "/ws/tv/:sessionId",
    { websocket: true },
    (socket, req) => {
      const params = req.params as { sessionId: string };
      const sessionId = params.sessionId;

      if (!hub.hasSession(sessionId)) {
        socket.close(4404, "session not active");
        return;
      }

      // Initial handshake payload so the TV client knows it's connected.
      send(socket, { type: "hello", sessionId });

      const unsub = hub.subscribeTv(sessionId, (msg) => send(socket, msg));

      socket.on("close", () => {
        unsub();
      });
    },
  );
}
