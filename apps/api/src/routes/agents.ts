import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_EMOTION_COLOR_MAP,
  EMOTIONS,
  type AgentDTO,
  type AgentToolsConfig,
  type EmotionColorMap,
  type OpenAIVoice,
  type TvLibraryItem,
} from "@robot/shared";
import { prisma } from "../db.js";
import { loadConfig } from "../config.js";

const VoiceSchema = z.enum([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
]);

const EmotionSchema = z.enum(EMOTIONS);
const EmotionColorMapSchema = z
  .record(EmotionSchema, z.number().int().min(1).max(7))
  .refine(
    (m) => EMOTIONS.every((e) => Object.prototype.hasOwnProperty.call(m, e)),
    { message: "emotionColorMap must contain every known emotion" },
  );

const AgentToolsSchema = z.object({
  showOnTv: z.boolean(),
  showFromLibrary: z.boolean(),
  clearTv: z.boolean(),
  robotDance: z.boolean(),
  robotColor: z.boolean(),
});

const TvLibraryItemSchema = z.object({
  topic: z.string().min(1),
  kind: z.enum(["youtube", "image", "webpage", "text"]),
  url: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
});

const CreateAgentSchema = z.object({
  name: z.string().min(1),
  personality: z.string().min(1),
  systemPrompt: z.string().min(1),
  voice: VoiceSchema.optional(),
  language: z.string().optional(),
  greeting: z.string().nullable().optional(),
  emotionColorMap: EmotionColorMapSchema.optional(),
  tools: AgentToolsSchema.optional(),
  tvLibrary: z.array(TvLibraryItemSchema).optional(),
  tvIdleBackgroundUrl: z
    .string()
    .url()
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});

const UpdateAgentSchema = CreateAgentSchema.partial();

const TestVoiceSchema = z.object({
  text: z.string().min(1).max(2_000).optional(),
});

interface AgentRow {
  id: string;
  name: string;
  slug: string | null;
  personality: string;
  systemPrompt: string;
  voice: string;
  language: string;
  greeting: string | null;
  emotionColorMap: unknown;
  tools: unknown;
  tvLibrary: unknown;
  tvIdleBackgroundUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Generate a URL-friendly slug from a name */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, "") // Trim hyphens from start/end
    .substring(0, 50); // Limit length
}

function serializeAgent(row: AgentRow): AgentDTO {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    personality: row.personality,
    systemPrompt: row.systemPrompt,
    voice: row.voice as OpenAIVoice,
    language: row.language,
    greeting: row.greeting,
    emotionColorMap: row.emotionColorMap as EmotionColorMap,
    tools: row.tools as AgentToolsConfig,
    tvLibrary: (row.tvLibrary as TvLibraryItem[]) ?? [],
    tvIdleBackgroundUrl: row.tvIdleBackgroundUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Naive in-memory cache for /test-voice MP3 bytes, keyed by agentId+text. */
const ttsCache = new Map<string, Buffer>();
/** Cap to prevent unbounded growth across many test runs. */
const TTS_CACHE_MAX = 50;

function ttsCacheGet(agentId: string, text: string): Buffer | undefined {
  return ttsCache.get(`${agentId}::${text}`);
}

function ttsCacheSet(agentId: string, text: string, buf: Buffer): void {
  if (ttsCache.size >= TTS_CACHE_MAX) {
    // Drop oldest entry (Map preserves insertion order).
    const firstKey = ttsCache.keys().next().value;
    if (firstKey !== undefined) ttsCache.delete(firstKey);
  }
  ttsCache.set(`${agentId}::${text}`, buf);
}

async function synthesizeTts(opts: {
  apiKey: string;
  voice: string;
  text: string;
}): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice: opts.voice,
      input: opts.text,
      response_format: "mp3",
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI TTS failed: ${res.status} ${errText}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function sendOpenAIUnavailable(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({
    error: "OpenAINotConfigured",
    message: "OPENAI_API_KEY not configured on server",
  });
}

export const agentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ---------- Public routes (no auth) ----------
  // Encapsulated child plugin: hooks registered in the sibling authed plugin
  // below do not leak here.
  await app.register(async (pub) => {
    pub.get<{ Params: { id: string } }>(
      "/agents/:id/public",
      async (req, reply) => {
        const row = await prisma.agent.findUnique({
          where: { id: req.params.id },
          select: { id: true, name: true, personality: true },
        });
        if (!row) return reply.status(404).send({ error: "NotFound" });
        return { id: row.id, name: row.name, personality: row.personality };
      },
    );
  });

  // ---------- Authenticated routes ----------
  // Encapsulated child plugin so the auth hook is scoped to these routes only.
  await app.register(async (authed) => {
    authed.addHook("onRequest", authed.authenticate);
    registerAuthedAgentRoutes(authed);
  });
};

function registerAuthedAgentRoutes(app: FastifyInstance): void {
  app.get("/agents", async () => {
    const rows = await prisma.agent.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r: AgentRow) => serializeAgent(r));
  });

  app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const row = await prisma.agent.findUnique({
      where: { id: req.params.id },
    });
    if (!row) return reply.status(404).send({ error: "NotFound" });
    return serializeAgent(row);
  });

  app.post("/agents", async (req, reply) => {
    const input = CreateAgentSchema.parse(req.body);
    const slug = generateSlug(input.name);
    const row = await prisma.agent.create({
      data: {
        name: input.name,
        slug,
        personality: input.personality,
        systemPrompt: input.systemPrompt,
        voice: input.voice ?? "alloy",
        language: input.language ?? "pt-BR",
        greeting: input.greeting ?? null,
        emotionColorMap: (input.emotionColorMap ??
          DEFAULT_EMOTION_COLOR_MAP) as unknown as object,
        tools: (input.tools ?? DEFAULT_AGENT_TOOLS) as unknown as object,
        tvLibrary: (input.tvLibrary ?? []) as unknown as object,
        tvIdleBackgroundUrl: input.tvIdleBackgroundUrl ?? null,
      },
    });
    return reply.status(201).send(serializeAgent(row));
  });

  app.patch<{ Params: { id: string } }>(
    "/agents/:id",
    async (req, reply) => {
      const input = UpdateAgentSchema.parse(req.body);
      try {
        const row = await prisma.agent.update({
          where: { id: req.params.id },
          data: {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.personality !== undefined && {
              personality: input.personality,
            }),
            ...(input.systemPrompt !== undefined && {
              systemPrompt: input.systemPrompt,
            }),
            ...(input.voice !== undefined && { voice: input.voice }),
            ...(input.language !== undefined && { language: input.language }),
            ...(input.greeting !== undefined && { greeting: input.greeting }),
            ...(input.emotionColorMap !== undefined && {
              emotionColorMap:
                input.emotionColorMap as unknown as object,
            }),
            ...(input.tools !== undefined && {
              tools: input.tools as unknown as object,
            }),
            ...(input.tvLibrary !== undefined && {
              tvLibrary: input.tvLibrary as unknown as object,
            }),
            ...(input.tvIdleBackgroundUrl !== undefined && {
              tvIdleBackgroundUrl: input.tvIdleBackgroundUrl,
            }),
          },
        });
        return serializeAgent(row);
      } catch (e) {
        return reply.status(404).send({ error: "NotFound" });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/agents/:id",
    async (req, reply) => {
      try {
        await prisma.agent.delete({ where: { id: req.params.id } });
        return reply.status(204).send();
      } catch (e) {
        return reply.status(404).send({ error: "NotFound" });
      }
    },
  );

  /**
   * Stream a short MP3 sample of this agent's voice.
   *
   * Uses OpenAI's `tts-1` model with the agent's configured voice. If the
   * caller does not provide `text`, falls back to the agent greeting or a
   * default introduction. Responses are cached in-memory by (agentId, text).
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/agents/:id/test-voice",
    async (req, reply) => {
      const cfg = loadConfig();
      if (!cfg.OPENAI_API_KEY) return sendOpenAIUnavailable(reply);

      const row = await prisma.agent.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, voice: true, greeting: true },
      });
      if (!row) return reply.status(404).send({ error: "NotFound" });

      const body = TestVoiceSchema.parse(req.body ?? {});
      const text =
        body.text?.trim() ||
        row.greeting?.trim() ||
        `Olá, eu sou ${row.name}.`;

      const cached = ttsCacheGet(row.id, text);
      let audio: Buffer;
      if (cached) {
        audio = cached;
      } else {
        try {
          audio = await synthesizeTts({
            apiKey: cfg.OPENAI_API_KEY,
            voice: row.voice,
            text,
          });
        } catch (err) {
          req.log.error({ err }, "tts failed");
          return reply
            .status(502)
            .send({ error: "TtsFailed", message: String(err) });
        }
        ttsCacheSet(row.id, text, audio);
      }

      reply
        .header("Content-Type", "audio/mpeg")
        .header("Content-Length", String(audio.length))
        .header("Cache-Control", "private, max-age=300");
      return reply.send(audio);
    },
  );
};
