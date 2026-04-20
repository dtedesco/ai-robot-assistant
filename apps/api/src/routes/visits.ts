import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const CreateVisitSchema = z.object({
  personId: z.string(),
  agentId: z.string().optional(),
});

const EndVisitSchema = z.object({
  endedAt: z.string().datetime().optional(),
});

const ListVisitsSchema = z.object({
  personId: z.string().optional(),
  agentId: z.string().optional(),
  includeConversations: z.coerce.boolean().default(false),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

interface ConversationItem {
  id: string;
  role: string;
  content: string;
  timestamp: Date;
}

interface VisitRow {
  id: string;
  personId: string;
  agentId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  person: { id: string; name: string; photoUrl: string | null };
  agent: { id: string; name: string } | null;
  conversations?: ConversationItem[];
}

interface ConversationDTO {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

interface VisitDTO {
  id: string;
  personId: string;
  agentId: string | null;
  startedAt: string;
  endedAt: string | null;
  person: { id: string; name: string; photoUrl: string | null };
  agent: { id: string; name: string } | null;
  conversations?: ConversationDTO[];
}

function serializeVisit(row: VisitRow, includeConversations = false): VisitDTO {
  const dto: VisitDTO = {
    id: row.id,
    personId: row.personId,
    agentId: row.agentId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    person: row.person,
    agent: row.agent,
  };
  if (includeConversations && row.conversations) {
    dto.conversations = row.conversations.map((c) => ({
      id: c.id,
      role: c.role,
      content: c.content,
      timestamp: c.timestamp.toISOString(),
    }));
  }
  return dto;
}

export const visitRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Public routes (used by RealtimeDisplay without auth)
  registerPublicVisitRoutes(app);

  // Authenticated routes (admin panel)
  await app.register(async (authed) => {
    authed.addHook("onRequest", authed.authenticate);
    registerAuthedVisitRoutes(authed);
  });
};

function registerPublicVisitRoutes(app: FastifyInstance): void {
  // Create visit (public - used by display)
  app.post("/visits", async (req, reply) => {
    const input = CreateVisitSchema.parse(req.body);
    const row = await prisma.visit.create({
      data: {
        personId: input.personId,
        agentId: input.agentId,
      },
      include: {
        person: { select: { id: true, name: true, photoUrl: true } },
        agent: { select: { id: true, name: true } },
      },
    });
    return reply.status(201).send(serializeVisit(row as VisitRow));
  });

  // End visit (public - used by display)
  app.patch<{ Params: { id: string } }>(
    "/visits/:id/end",
    async (req, reply) => {
      const input = EndVisitSchema.parse(req.body);
      try {
        const row = await prisma.visit.update({
          where: { id: req.params.id },
          data: {
            endedAt: input.endedAt ? new Date(input.endedAt) : new Date(),
          },
          include: {
            person: { select: { id: true, name: true, photoUrl: true } },
            agent: { select: { id: true, name: true } },
          },
        });
        return serializeVisit(row as VisitRow);
      } catch {
        return reply.status(404).send({ error: "NotFound" });
      }
    },
  );
}

function registerAuthedVisitRoutes(app: FastifyInstance): void {
  // List visits with optional filters
  app.get("/visits", async (req) => {
    const query = ListVisitsSchema.parse(req.query);
    const where: Record<string, unknown> = {};
    if (query.personId) where.personId = query.personId;
    if (query.agentId) where.agentId = query.agentId;

    const include: Record<string, unknown> = {
      person: { select: { id: true, name: true, photoUrl: true } },
      agent: { select: { id: true, name: true } },
    };
    if (query.includeConversations) {
      include.conversations = {
        select: { id: true, role: true, content: true, timestamp: true },
        orderBy: { timestamp: "asc" },
      };
    }

    const [rows, total] = await Promise.all([
      prisma.visit.findMany({
        where,
        include,
        orderBy: { startedAt: "desc" },
        take: query.limit,
        skip: query.offset,
      }),
      prisma.visit.count({ where }),
    ]);

    return {
      items: rows.map((r) => serializeVisit(r as unknown as VisitRow, query.includeConversations)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  // Get single visit with conversations
  app.get<{ Params: { id: string } }>("/visits/:id", async (req, reply) => {
    const row = await prisma.visit.findUnique({
      where: { id: req.params.id },
      include: {
        person: { select: { id: true, name: true, photoUrl: true } },
        agent: { select: { id: true, name: true } },
        conversations: {
          select: { id: true, role: true, content: true, timestamp: true },
          orderBy: { timestamp: "asc" },
        },
      },
    });
    if (!row) return reply.status(404).send({ error: "NotFound" });
    return serializeVisit(row as VisitRow, true);
  });

  // Delete visit
  app.delete<{ Params: { id: string } }>("/visits/:id", async (req, reply) => {
    try {
      await prisma.visit.delete({ where: { id: req.params.id } });
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: "NotFound" });
    }
  });
}
