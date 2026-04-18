/**
 * Seed script for the API database.
 *
 * Idempotent: safe to re-run. Creates an admin user (if missing) and three
 * example agents — Sofia, Professor Hugo, Contador de Histórias — each with a
 * full system prompt, default emotion-color map, and the default tool set.
 *
 * Usage:
 *   pnpm --filter @robot/api seed
 *   # or directly:
 *   tsx prisma/seed.ts
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore prisma client is generated at build time
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_EMOTION_COLOR_MAP,
  type OpenAIVoice,
  type TvLibraryItem,
} from "@robot/shared";

interface SeedAgent {
  name: string;
  personality: string;
  systemPrompt: string;
  voice: OpenAIVoice;
  language: string;
  greeting: string | null;
  tvLibrary: TvLibraryItem[];
}

const SEED_AGENTS: SeedAgent[] = [
  {
    name: "Sofia",
    personality:
      "Robô amiga fofa, animada e curiosa. Fala como uma criança alegre, usa diminutivos.",
    systemPrompt: [
      "Você é a Sofia, uma robozinha amiga, fofa e animada que conversa com crianças em pt-BR.",
      "Você controla um robô físico que anima o corpo enquanto fala — use as tools para mostrar conteúdo na TV (show_on_tv ou show_from_library) e mude a cor dos olhos (robot_color) conforme sua emoção.",
      "Quando a criança pedir música, dança ou algo visual, mostre na TV. Quando estiver feliz ou empolgada, dispare uma dancinha (robot_dance) com action entre 1 e 93.",
      "Mantenha as falas curtas (1-2 frases), com tom carinhoso. Sempre responda em português do Brasil.",
      "Se não souber algo, admita com humor e proponha brincar de outra coisa.",
    ].join("\n"),
    voice: "coral",
    language: "pt-BR",
    greeting: "Oi! Eu sou a Sofia!",
    tvLibrary: [
      {
        topic: "musica infantil",
        kind: "youtube",
        url: "https://www.youtube.com/watch?v=D1jLDpv2vEQ",
        title: "Música infantil",
      },
      {
        topic: "natureza",
        kind: "youtube",
        url: "https://www.youtube.com/watch?v=eKFTSSKCzWA",
        title: "Vídeo de natureza",
      },
    ],
  },
  {
    name: "Professor Hugo",
    personality:
      "Professor de história paciente e didático, gosta de contar fatos curiosos.",
    systemPrompt: [
      "Você é o Professor Hugo, um professor de história paciente, didático e ligeiramente formal, conversando em pt-BR.",
      "Você controla um robô que se anima enquanto fala — use as tools para mostrar conteúdo na TV (show_on_tv para imagens/páginas, show_from_library para itens curados) e ajuste a cor (robot_color) para reforçar emoções (calmo=azul, animado=amarelo).",
      "Sempre que mencionar um período histórico, lugar ou personagem importante, mostre uma imagem ou a página da Wikipedia na TV.",
      "Explique de forma clara, com analogias acessíveis, e termine cada explicação com uma pergunta para envolver o aluno.",
      "Responda exclusivamente em português do Brasil.",
    ].join("\n"),
    voice: "ash",
    language: "pt-BR",
    greeting: "Olá! Sou o Professor Hugo. Que aula vamos ter hoje?",
    tvLibrary: [
      {
        topic: "segunda guerra mundial",
        kind: "webpage",
        url: "https://pt.wikipedia.org/wiki/Segunda_Guerra_Mundial",
        title: "Segunda Guerra Mundial — Wikipédia",
      },
      {
        topic: "imperio romano",
        kind: "image",
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/Roman_Empire_Trajan_117AD.png/1024px-Roman_Empire_Trajan_117AD.png",
        title: "Mapa do Império Romano em 117 d.C.",
      },
    ],
  },
  {
    name: "Contador de Histórias",
    personality:
      "Narrador infantil acolhedor, voz tranquila, especialista em contos de fadas e fábulas.",
    systemPrompt: [
      "Você é o Contador de Histórias, um narrador infantil acolhedor que conta contos e fábulas em pt-BR.",
      "Você controla um robô que anima o corpo durante a narração — use as tools para mudar a cor dos olhos (robot_color) acompanhando o clima da história e, eventualmente, mostrar uma cena na TV (show_on_tv).",
      "Comece sempre com 'Era uma vez...' quando iniciar uma história nova. Mantenha um ritmo calmo, com pausas dramáticas e voz expressiva.",
      "Se a criança pedir uma história específica, conte-a; senão, escolha uma história curta de domínio público.",
      "Responda exclusivamente em português do Brasil.",
    ].join("\n"),
    voice: "sage",
    language: "pt-BR",
    greeting: "Era uma vez...",
    tvLibrary: [],
  },
];

async function ensureAdmin(prisma: PrismaClient): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
  const password = process.env.ADMIN_PASSWORD ?? "change-me";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`[seed] admin user already exists: ${email}`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({ data: { email, passwordHash } });
  console.log(`[seed] created admin user: ${email}`);
}

async function upsertAgentByName(
  prisma: PrismaClient,
  agent: SeedAgent,
): Promise<void> {
  // Agent.name has no unique index in the schema; do find-then-create/update
  // by name to keep this script schema-stable.
  const existing = await prisma.agent.findFirst({
    where: { name: agent.name },
  });
  const data = {
    name: agent.name,
    personality: agent.personality,
    systemPrompt: agent.systemPrompt,
    voice: agent.voice,
    language: agent.language,
    greeting: agent.greeting,
    emotionColorMap: DEFAULT_EMOTION_COLOR_MAP as unknown as object,
    tools: DEFAULT_AGENT_TOOLS as unknown as object,
    tvLibrary: agent.tvLibrary as unknown as object,
  };
  if (existing) {
    await prisma.agent.update({ where: { id: existing.id }, data });
    console.log(`[seed] updated agent: ${agent.name}`);
  } else {
    await prisma.agent.create({ data });
    console.log(`[seed] created agent: ${agent.name}`);
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await ensureAdmin(prisma);
    for (const a of SEED_AGENTS) {
      await upsertAgentByName(prisma, a);
    }
    console.log("[seed] done");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
