import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { TvDownMsg } from "@robot/shared";
import type { TvHub } from "../services/tv-hub.js";
import { prisma } from "../db.js";

function send(socket: WebSocket, msg: TvDownMsg): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* noop */
  }
}

async function findAgent(idOrSlug: string) {
  let agent = await prisma.agent.findUnique({
    where: { id: idOrSlug },
    select: { id: true },
  });
  if (!agent) {
    agent = await prisma.agent.findUnique({
      where: { slug: idOrSlug },
      select: { id: true },
    });
  }
  return agent;
}

/**
 * WebSocket endpoint for TV displays connected to a realtime agent session.
 * The RealtimeDisplay (browser with mic/camera) sends TV commands via HTTP,
 * and this WebSocket broadcasts them to connected TV displays.
 *
 * Uses agent's real ID as the key (prefixed with "rt:") to ensure consistency
 * between slug-based and ID-based access.
 */
export function registerRealtimeTvWs(
  app: FastifyInstance,
  tvHub: TvHub,
): void {
  app.get(
    "/ws/tv/realtime/:agentId",
    { websocket: true },
    async (socket, req) => {
      const { agentId } = req.params as { agentId: string };
      const log = req.log.child({ agentId, ws: "realtime-tv" });

      // Resolve slug to real agent ID
      const agent = await findAgent(agentId);
      if (!agent) {
        log.warn("Agent not found, closing connection");
        send(socket, { type: "error", message: "Agent not found" } as any);
        socket.close();
        return;
      }

      const hubKey = `rt:${agent.id}`;
      log.info({ hubKey }, "TV display connected");
      send(socket, { type: "hello", sessionId: agent.id });

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
