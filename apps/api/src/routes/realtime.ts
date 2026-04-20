import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { loadConfig } from "../config.js";
import type { TvHub } from "../services/tv-hub.js";
import type { TvContent } from "@robot/shared";
import { getRealtimeHubKey } from "../ws/realtime-tv.js";

/**
 * Find agent by ID or slug.
 */
async function findAgent(idOrSlug: string) {
  // First try by ID
  let agent = await prisma.agent.findUnique({
    where: { id: idOrSlug },
  });
  // If not found, try by slug
  if (!agent) {
    agent = await prisma.agent.findUnique({
      where: { slug: idOrSlug },
    });
  }
  return agent;
}

/**
 * Realtime credentials and agent configuration for browser clients.
 *
 * The browser fetches this to connect directly to OpenAI Realtime API.
 * This keeps the API key on the server while allowing direct browser connections.
 */
export function realtimeRoutes(tvHub: TvHub): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
  const config = loadConfig();

  /**
   * Get realtime credentials for a specific agent.
   * Public endpoint (no auth required) - the agent ID or slug acts as the access token.
   */
  app.get<{ Params: { agentId: string } }>(
    "/realtime/credentials/:agentId",
    async (req, reply) => {
      if (!config.OPENAI_API_KEY) {
        return reply.status(503).send({
          error: "OpenAINotConfigured",
          message: "OPENAI_API_KEY not configured on server",
        });
      }

      const agent = await findAgent(req.params.agentId);

      if (!agent) {
        return reply.status(404).send({ error: "AgentNotFound" });
      }

      // Build tools based on agent configuration
      const tools = buildToolsForAgent(agent);

      // Compose instructions
      const instructions = composeInstructions(agent);

      return {
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview-2024-12-17",
        voice: agent.voice,
        instructions,
        tools,
        agent: {
          id: agent.id,
          name: agent.name,
          greeting: agent.greeting,
          tvLibrary: agent.tvLibrary,
          tvIdleBackgroundUrl: agent.tvIdleBackgroundUrl,
        },
      };
    },
  );

  /**
   * List available agents for the realtime interface.
   * Public endpoint.
   */
  app.get("/realtime/agents", async () => {
    const agents = await prisma.agent.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        voice: true,
        greeting: true,
        tvIdleBackgroundUrl: true,
      },
      orderBy: { name: "asc" },
    });
    return { agents };
  });

  // --- TV Control Routes ---

  const TvDisplayBody = z.object({
    content: z.object({
      kind: z.enum(["youtube", "image", "webpage", "text"]),
      url: z.string().optional(),
      text: z.string().optional(),
      title: z.string().optional(),
      caption: z.string().optional(),
    }),
  });

  const TvIdleBody = z.object({
    backgroundUrl: z.string().nullable(),
  });

  /**
   * Send content to the TV display for this agent.
   */
  app.post<{ Params: { agentId: string } }>(
    "/realtime/:agentId/tv/display",
    async (req, reply) => {
      const agent = await findAgent(req.params.agentId);
      if (!agent) {
        return reply.status(404).send({ error: "AgentNotFound" });
      }
      const body = TvDisplayBody.parse(req.body);
      const hubKey = getRealtimeHubKey(agent.id);

      const count = tvHub.publish(hubKey, {
        type: "display",
        content: body.content as TvContent,
      });

      return { ok: true, subscribers: count };
    },
  );

  /**
   * Clear the TV display for this agent.
   */
  app.post<{ Params: { agentId: string } }>(
    "/realtime/:agentId/tv/clear",
    async (req, reply) => {
      const agent = await findAgent(req.params.agentId);
      if (!agent) {
        return reply.status(404).send({ error: "AgentNotFound" });
      }
      const hubKey = getRealtimeHubKey(agent.id);

      const count = tvHub.publish(hubKey, { type: "clear" });

      return { ok: true, subscribers: count };
    },
  );

  /**
   * Set idle background for the TV display.
   */
  app.post<{ Params: { agentId: string } }>(
    "/realtime/:agentId/tv/idle",
    async (req, reply) => {
      const agent = await findAgent(req.params.agentId);
      if (!agent) {
        return reply.status(404).send({ error: "AgentNotFound" });
      }
      const body = TvIdleBody.parse(req.body);
      const hubKey = getRealtimeHubKey(agent.id);

      const count = tvHub.publish(hubKey, {
        type: "idle-config",
        backgroundUrl: body.backgroundUrl,
      });

      return { ok: true, subscribers: count };
    },
  );
  };
}

interface AgentRow {
  id: string;
  slug: string | null;
  name: string;
  personality: string;
  systemPrompt: string;
  voice: string;
  language: string;
  greeting: string | null;
  emotionColorMap: unknown;
  tools: unknown;
  tvLibrary: unknown;
  tvIdleBackgroundUrl: string | null;
}

interface TvLibraryItem {
  topic: string;
  kind: "youtube" | "image" | "webpage" | "text";
  url?: string;
  text?: string;
  title?: string;
}

function buildToolsForAgent(agent: AgentRow): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}> {
  const library = (agent.tvLibrary ?? []) as TvLibraryItem[];
  const topics = library
    .map((i) => i.topic)
    .filter((t): t is string => !!t && t.trim().length > 0);

  const tools: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }> = [];

  if (topics.length > 0) {
    tools.push({
      type: "function",
      name: "show_tv",
      description:
        "Mostra na TV um item pré-cadastrado da biblioteca do agente.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: topics,
            description: "Tópico da biblioteca a exibir.",
          },
        },
        required: ["topic"],
      },
    });
  }

  tools.push(
    {
      type: "function",
      name: "show_url",
      description: "Abre uma URL na TV (YouTube embuta; outros abrem como página).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL completa (https://…)" },
          title: { type: "string", description: "Título opcional" },
        },
        required: ["url"],
      },
    },
    {
      type: "function",
      name: "show_image",
      description: "Mostra uma imagem na TV.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          caption: { type: "string" },
        },
        required: ["url"],
      },
    },
    {
      type: "function",
      name: "clear_tv",
      description: "Limpa a TV e volta à tela neutra.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "register_person",
      description:
        "Registra o nome de uma pessoa nova que acabou de se apresentar.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Nome da pessoa.",
          },
        },
        required: ["name"],
      },
    },
  );

  return tools;
}

function composeInstructions(agent: AgentRow): string {
  const base = agent.systemPrompt.trim();
  const library = (agent.tvLibrary ?? []) as TvLibraryItem[];
  const topics = library.filter((i) => i.topic);
  const topicLines = topics
    .map((i) => {
      const desc = i.title ?? i.url ?? i.text ?? "";
      return `- "${i.topic}"${desc ? ` — ${desc}` : ""}`;
    })
    .join("\n");

  const tvBlock = `## Instruções de TV (sistema — sempre siga)

Ao seu lado há uma TV grande para enriquecer a conversa. Ferramentas:
- show_tv(topic): mostra um item pré-cadastrado.
- show_url(url, title?): mostra uma URL livre.
- show_image(url, caption?): mostra uma imagem.
- clear_tv(): limpa a tela.
${topics.length > 0 ? `\nBiblioteca disponível:\n${topicLines}\n` : ""}
REGRAS:
1. Quando o cliente mencionar um assunto da biblioteca, use show_tv.
2. Dê a resposta completa junto com a ferramenta — não chame só a ferramenta.
3. Não peça permissão para usar a ferramenta.
4. A TV volta sozinha para tela neutra — não chame clear_tv ao fim.

## Reconhecimento de Pessoas

Você tem uma câmera que detecta rostos. O sistema avisará quando alguém se aproximar:
- Se for pessoa CONHECIDA, receberá o nome. Cumprimente pelo nome.
- Se for pessoa DESCONHECIDA, pergunte o nome gentilmente.

Quando a pessoa disser o nome:
- Use register_person(name) para salvar.
- Confirme: "Prazer, [nome]! Agora vou lembrar de você."`;

  return base ? `${base}\n\n${tvBlock}` : tvBlock;
}
