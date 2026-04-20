import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { findClosestMatch } from "../services/face-matching.js";

const FACE_DESCRIPTOR_LENGTH = 128;

const FaceDescriptorSchema = z
  .array(z.number())
  .length(FACE_DESCRIPTOR_LENGTH, {
    message: `Face descriptor must have exactly ${FACE_DESCRIPTOR_LENGTH} elements`,
  });

const GenderSchema = z.enum(["male", "female", "other"]);

const CreatePersonSchema = z.object({
  name: z.string().min(1).max(100),
  faceDescriptor: FaceDescriptorSchema,
  photoUrl: z.string().nullable().optional(), // Can be URL or base64 data URL
  phone: z.string().max(30).nullable().optional(),
  gender: GenderSchema.nullable().optional(),
  preferences: z.array(z.string()).optional(),
  context: z.string().nullable().optional(),
});

const UpdatePersonSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  photoUrl: z.string().url().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  gender: GenderSchema.nullable().optional(),
  preferences: z.array(z.string()).optional(),
  context: z.string().nullable().optional(),
});

const MatchPersonSchema = z.object({
  descriptor: FaceDescriptorSchema,
  threshold: z.number().min(0).max(2).optional(),
});

interface PersonRow {
  id: string;
  name: string;
  faceDescriptor: unknown;
  photoUrl: string | null;
  phone: string | null;
  gender: string | null;
  preferences: unknown;
  context: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { visits: number; conversations: number };
  visits?: Array<{ startedAt: Date }>;
}

interface PersonDTO {
  id: string;
  name: string;
  photoUrl: string | null;
  phone: string | null;
  gender: string | null;
  preferences: string[];
  context: string | null;
  createdAt: string;
  updatedAt: string;
  visitCount?: number;
  conversationCount?: number;
  lastVisit?: string | null;
}

function serializePerson(row: PersonRow): PersonDTO {
  const dto: PersonDTO = {
    id: row.id,
    name: row.name,
    photoUrl: row.photoUrl,
    phone: row.phone,
    gender: row.gender,
    preferences: Array.isArray(row.preferences) ? (row.preferences as string[]) : [],
    context: row.context,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row._count) {
    dto.visitCount = row._count.visits;
    dto.conversationCount = row._count.conversations;
  }
  const lastVisit = row.visits?.[0];
  if (lastVisit) {
    dto.lastVisit = lastVisit.startedAt.toISOString();
  }
  return dto;
}

export const personRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Public routes (used by RealtimeDisplay without auth)
  registerPublicPersonRoutes(app);

  // Authenticated routes (admin panel)
  await app.register(async (authed) => {
    authed.addHook("onRequest", authed.authenticate);
    registerAuthedPersonRoutes(authed);
  });
};

function registerPublicPersonRoutes(app: FastifyInstance): void {
  // Match face descriptor against database (public - used by display)
  app.post("/persons/match", async (req) => {
    const input = MatchPersonSchema.parse(req.body);
    const result = await findClosestMatch(
      input.descriptor,
      input.threshold ?? 0.6,
    );

    if (result) {
      return {
        matched: true,
        person: serializePerson(result.person as PersonRow),
        distance: result.distance,
      };
    }

    return {
      matched: false,
      person: null,
      distance: null,
    };
  });

  // Create person (public - used by display for registration)
  app.post("/persons", async (req, reply) => {
    const input = CreatePersonSchema.parse(req.body);
    const row = await prisma.person.create({
      data: {
        name: input.name,
        faceDescriptor: input.faceDescriptor as unknown as object,
        photoUrl: input.photoUrl ?? null,
        phone: input.phone ?? null,
        gender: input.gender ?? null,
        preferences: input.preferences ?? [],
        context: input.context ?? null,
      },
    });
    return reply.status(201).send(serializePerson(row as PersonRow));
  });

  // Update person name (public - used by display when user says their name)
  app.patch<{ Params: { id: string } }>(
    "/persons/:id",
    async (req, reply) => {
      const input = UpdatePersonSchema.parse(req.body);
      try {
        const row = await prisma.person.update({
          where: { id: req.params.id },
          data: {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.photoUrl !== undefined && { photoUrl: input.photoUrl }),
            ...(input.phone !== undefined && { phone: input.phone }),
            ...(input.gender !== undefined && { gender: input.gender }),
            ...(input.preferences !== undefined && { preferences: input.preferences }),
            ...(input.context !== undefined && { context: input.context }),
          },
        });
        return serializePerson(row as PersonRow);
      } catch {
        return reply.status(404).send({ error: "NotFound" });
      }
    },
  );
}

function registerAuthedPersonRoutes(app: FastifyInstance): void {
  // List all persons with visit stats
  app.get("/persons", async () => {
    const rows = await prisma.person.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { visits: true, conversations: true } },
        visits: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } },
      },
    });
    return rows.map((r) => serializePerson(r as PersonRow));
  });

  // Get single person with stats
  app.get<{ Params: { id: string } }>("/persons/:id", async (req, reply) => {
    const row = await prisma.person.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { visits: true, conversations: true } },
        visits: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } },
      },
    });
    if (!row) return reply.status(404).send({ error: "NotFound" });
    return serializePerson(row as PersonRow);
  });

  // Delete person
  app.delete<{ Params: { id: string } }>(
    "/persons/:id",
    async (req, reply) => {
      try {
        await prisma.person.delete({ where: { id: req.params.id } });
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: "NotFound" });
      }
    },
  );
}
