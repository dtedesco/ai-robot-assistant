import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const CreateConversationSchema = z.object({
  personId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  visitId: z.string().nullable().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
  timestamp: z.string().datetime().optional(),
});

const ListConversationsSchema = z.object({
  personId: z.string().optional(),
  agentId: z.string().optional(),
  role: z.enum(["user", "assistant"]).optional(),
  limit: z.coerce.number().min(1).max(200).default(100),
  offset: z.coerce.number().min(0).default(0),
});

interface ConversationRow {
  id: string;
  personId: string | null;
  agentId: string | null;
  visitId: string | null;
  role: string;
  content: string;
  timestamp: Date;
  person: { id: string; name: string; photoUrl: string | null } | null;
  agent: { id: string; name: string } | null;
}

interface ConversationDTO {
  id: string;
  personId: string | null;
  agentId: string | null;
  visitId: string | null;
  role: string;
  content: string;
  timestamp: string;
  person: { id: string; name: string; photoUrl: string | null } | null;
  agent: { id: string; name: string } | null;
}

function serializeConversation(row: ConversationRow): ConversationDTO {
  return {
    id: row.id,
    personId: row.personId,
    agentId: row.agentId,
    visitId: row.visitId,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp.toISOString(),
    person: row.person,
    agent: row.agent,
  };
}

export const conversationRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
) => {
  // Public routes (used by RealtimeDisplay without auth)
  registerPublicConversationRoutes(app);

  // Authenticated routes (admin panel)
  await app.register(async (authed) => {
    authed.addHook("onRequest", authed.authenticate);
    registerAuthedConversationRoutes(authed);
  });
};

function registerPublicConversationRoutes(app: FastifyInstance): void {
  // Create conversation entry (public - used by display)
  app.post("/conversations", async (req, reply) => {
    const input = CreateConversationSchema.parse(req.body);
    const row = await prisma.conversation.create({
      data: {
        personId: input.personId ?? null,
        agentId: input.agentId ?? null,
        visitId: input.visitId ?? null,
        role: input.role,
        content: input.content,
        timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
      },
      include: {
        person: { select: { id: true, name: true, photoUrl: true } },
        agent: { select: { id: true, name: true } },
      },
    });
    return reply.status(201).send(serializeConversation(row as ConversationRow));
  });
}

function registerAuthedConversationRoutes(app: FastifyInstance): void {
  // List conversations with optional filters
  app.get("/conversations", async (req) => {
    const query = ListConversationsSchema.parse(req.query);
    const where: Record<string, unknown> = {};
    if (query.personId) where.personId = query.personId;
    if (query.agentId) where.agentId = query.agentId;
    if (query.role) where.role = query.role;

    const [rows, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          person: { select: { id: true, name: true, photoUrl: true } },
          agent: { select: { id: true, name: true } },
        },
        orderBy: { timestamp: "desc" },
        take: query.limit,
        skip: query.offset,
      }),
      prisma.conversation.count({ where }),
    ]);

    return {
      items: rows.map((r) => serializeConversation(r as ConversationRow)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  // Get single conversation
  app.get<{ Params: { id: string } }>(
    "/conversations/:id",
    async (req, reply) => {
      const row = await prisma.conversation.findUnique({
        where: { id: req.params.id },
        include: {
          person: { select: { id: true, name: true, photoUrl: true } },
          agent: { select: { id: true, name: true } },
        },
      });
      if (!row) return reply.status(404).send({ error: "NotFound" });
      return serializeConversation(row as ConversationRow);
    },
  );

  // Delete conversation
  app.delete<{ Params: { id: string } }>(
    "/conversations/:id",
    async (req, reply) => {
      try {
        await prisma.conversation.delete({ where: { id: req.params.id } });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: "NotFound" });
      }
    },
  );

  // Bulk delete conversations (for cleanup)
  app.delete("/conversations", async (req) => {
    const query = z
      .object({
        personId: z.string().optional(),
        agentId: z.string().optional(),
        before: z.string().datetime().optional(),
      })
      .parse(req.query);

    const where: Record<string, unknown> = {};
    if (query.personId) where.personId = query.personId;
    if (query.agentId) where.agentId = query.agentId;
    if (query.before) where.timestamp = { lt: new Date(query.before) };

    const result = await prisma.conversation.deleteMany({ where });
    return { deleted: result.count };
  });
}
