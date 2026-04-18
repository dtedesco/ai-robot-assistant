import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { SessionDTO } from "@robot/shared";
import { prisma } from "../db.js";
import { buildTvUrl } from "../config.js";
import type { SessionHub } from "../services/session-hub.js";

const StartSessionSchema = z.object({
  agentId: z.string().min(1),
  bridgeId: z.string().min(1),
});

interface SessionRow {
  id: string;
  agentId: string;
  bridgeId: string;
  startedAt: Date;
  endedAt: Date | null;
}

function serializeSession(row: SessionRow): SessionDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    bridgeId: row.bridgeId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

export function sessionRoutes(hub: SessionHub): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    // ---------- Public route (no auth) ----------
    // Encapsulated child plugin: auth hook from sibling plugin doesn't apply.
    await app.register(async (pub) => {
      pub.get<{ Params: { id: string } }>(
        "/sessions/:id/public",
        async (req, reply) => {
          const row = await prisma.session.findUnique({
            where: { id: req.params.id },
            select: { id: true, agentId: true },
          });
          if (!row) return reply.status(404).send({ error: "NotFound" });
          return { id: row.id, agentId: row.agentId };
        },
      );
    });

    // ---------- Authenticated routes ----------
    await app.register(async (authed) => {
      authed.addHook("onRequest", authed.authenticate);
      registerAuthedSessionRoutes(authed, hub);
    });
  };
}

function registerAuthedSessionRoutes(
  app: FastifyInstance,
  hub: SessionHub,
): void {
  app.get("/sessions", async () => {
    const rows = await prisma.session.findMany({
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    return rows.map((r: SessionRow) => serializeSession(r));
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const row = await prisma.session.findUnique({
      where: { id: req.params.id },
    });
    if (!row) return reply.status(404).send({ error: "NotFound" });
    return serializeSession(row);
  });

  app.post("/sessions", async (req, reply) => {
    const { agentId, bridgeId } = StartSessionSchema.parse(req.body);

    const [agent, bridge] = await Promise.all([
      prisma.agent.findUnique({ where: { id: agentId } }),
      prisma.bridge.findUnique({ where: { id: bridgeId } }),
    ]);
    if (!agent) {
      return reply.status(404).send({ error: "AgentNotFound" });
    }
    if (!bridge) {
      return reply.status(404).send({ error: "BridgeNotFound" });
    }

    const row = await prisma.session.create({
      data: { agentId, bridgeId },
    });

    try {
      await hub.startSession(row.id, agent, bridge);
    } catch (err) {
      req.log.error({ err }, "Failed to start session in hub");
      await prisma.session.update({
        where: { id: row.id },
        data: { endedAt: new Date() },
      });
      return reply
        .status(502)
        .send({ error: "SessionStartFailed", message: String(err) });
    }

    return reply.status(201).send({
      ...serializeSession(row),
      tvUrl: buildTvUrl(row.id),
    });
  });

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/end",
    async (req, reply) => {
      const existing = await prisma.session.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) return reply.status(404).send({ error: "NotFound" });
      if (existing.endedAt) {
        return serializeSession(existing);
      }
      const row = await prisma.session.update({
        where: { id: req.params.id },
        data: { endedAt: new Date() },
      });
      await hub.endSession(row.id, "manual");
      return serializeSession(row);
    },
  );
}
