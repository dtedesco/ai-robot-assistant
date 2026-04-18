# AI Robot Assistant — Plano de Implementação

## Visão

Plataforma **cloud** para criar e gerenciar **agentes com personalidade** que conversam através do robô **Robert RS01** (BLE), com **TV sincronizada** exibindo conteúdo durante a fala. Um **bridge local** (Raspberry Pi / Mac) faz a ponte BLE entre o cloud e o robô.

## Componentes

```
┌──────────── CLOUD (Docker / Fly.io-ready) ────────────────────────┐
│  apps/api   Fastify + TypeScript + Prisma (Postgres)              │
│             - CRUD agentes/bridges/sessões                        │
│             - WebSocket hub (admin/bridge/tv)                     │
│             - Proxy OpenAI Realtime                               │
│  apps/web   React + Vite (admin + /tv/:sessionId)                 │
└───────────────────────────────────────────────────────────────────┘
                         ▲ WebSocket
                         │
┌───────────────── LOCAL ────────────────┐   ┌─── TV ──────────────┐
│  apps/bridge  Node.js daemon           │   │ Browser / Chromecast│
│   - noble (BLE) → Robert RS01          │   │ abre /tv/:sessionId │
│   - mic + speaker                      │   └─────────────────────┘
└────────────────────────────────────────┘
```

## Stack

| Camada | Escolha |
|---|---|
| Linguagem | TypeScript em tudo |
| Backend | Fastify + @fastify/websocket |
| DB | Postgres (Prisma) |
| Frontend | React + Vite + Tailwind + shadcn-like |
| BLE | @abandonware/noble |
| Realtime | openai SDK + ws (proxy) |
| Monorepo | pnpm workspaces + turbo |
| Deploy | Dockerfile por app |

## Monorepo

```
ai-robot-assistant/
├── PLAN.md
├── package.json              # pnpm workspaces + turbo
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .env.example
├── docker-compose.yml        # postgres local
├── legacy/                   # scripts Python originais
├── packages/
│   ├── shared/               # tipos compartilhados (contratos WS, DTOs)
│   └── robot-protocol/       # pacote puro do protocolo BLE
└── apps/
    ├── api/                  # backend
    ├── web/                  # admin + TV
    └── bridge/               # daemon local
```

## Modelo de dados

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
}

model Agent {
  id              String   @id @default(cuid())
  name            String
  personality     String   // descrição curta
  systemPrompt    String   // prompt completo
  voice           String   // id de voz OpenAI (alloy, nova, etc.)
  language        String   @default("pt-BR")
  greeting        String?  // saudação inicial opcional
  emotionColorMap Json     // {feliz: 3, triste: 2, ...}
  tools           Json     // {showOnTv: bool, robotDance: bool, ...}
  tvLibrary       Json     // [{topic, type, url, title}]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  sessions        Session[]
}

model Bridge {
  id         String   @id @default(cuid())
  name       String
  token      String   @unique
  status     String   @default("offline") // offline | online
  lastSeenAt DateTime?
  createdAt  DateTime @default(now())
  sessions   Session[]
}

model Session {
  id          String    @id @default(cuid())
  agentId     String
  bridgeId    String
  startedAt   DateTime  @default(now())
  endedAt     DateTime?
  transcript  Json      @default("[]") // [{role, text, ts}]
  agent       Agent     @relation(fields: [agentId], references: [id])
  bridge      Bridge    @relation(fields: [bridgeId], references: [id])
}
```

## Contratos WebSocket

Todos os tipos ficam em `packages/shared/src/messages.ts`. Três barramentos:

### Bridge ↔ API (`/ws/bridge`)
```ts
// Bridge → API
type BridgeUpMsg =
  | { type: "hello"; token: string; version: string }
  | { type: "ble:scanResult"; devices: BLEDevice[] }
  | { type: "ble:connected"; address: string }
  | { type: "ble:disconnected"; reason?: string }
  | { type: "audio:in"; pcm: string /* base64 pcm16 */ }
  | { type: "pong" };

// API → Bridge
type BridgeDownMsg =
  | { type: "welcome"; bridgeId: string }
  | { type: "ble:scan" }
  | { type: "ble:connect"; address: string }
  | { type: "ble:disconnect" }
  | { type: "ble:packet"; hex: string }
  | { type: "audio:out"; pcm: string }
  | { type: "session:start"; sessionId: string; realtime: RealtimeConfig }
  | { type: "session:end" }
  | { type: "ping" };
```

### Admin ↔ API (`/ws/admin`, auth por JWT)
```ts
type AdminUpMsg =
  | { type: "subscribe"; sessionId: string }
  | { type: "sendText"; sessionId: string; text: string };

type AdminDownMsg =
  | { type: "session:event"; sessionId: string; event: SessionEvent }
  | { type: "bridge:status"; bridgeId: string; online: boolean };
```

### TV ↔ API (`/ws/tv/:sessionId`, público, só-leitura)
```ts
type TvDownMsg =
  | { type: "display"; content: TvContent }
  | { type: "clear" };

type TvContent =
  | { kind: "youtube"; url: string; title?: string }
  | { kind: "image"; url: string; caption?: string }
  | { kind: "webpage"; url: string }
  | { kind: "text"; text: string };
```

## Tools do agente (OpenAI Realtime)

- `show_on_tv({ kind, url, title? })` — mostra conteúdo livre
- `show_from_library({ topic })` — mostra item pré-cadastrado
- `clear_tv()` — limpa TV
- `robot_dance({ action: 1-93 })` — dispara dança
- `robot_color({ color: 1-7 })` — muda cor dos olhos

## Fases

| Fase | Escopo | Duração |
|---|---|---|
| **0** | Scaffold + contratos compartilhados | 1 dia |
| **1** | `robot-protocol` + API base (auth + CRUD) | 2 dias |
| **2** | Bridge conectando cloud ↔ Robert + Admin enviando comandos manuais | 3 dias |
| **3** | Proxy OpenAI Realtime + sessão com áudio bidirecional + animação | 4 dias |
| **4** | TV display + tool-calling + biblioteca | 3 dias |
| **5** | Polimento: histórico, preview voz, transcrições | 2 dias |

## Execução paralela

Fase 0 feita manualmente (scaffolding + contratos). Depois 4 agentes em paralelo:

- **Agente A**: `packages/robot-protocol` (portar do Python, só funções puras)
- **Agente B**: `apps/api` (Fastify, auth, CRUD, WS hub, OpenAI proxy)
- **Agente C**: `apps/bridge` (noble BLE, WS client, audio I/O)
- **Agente D**: `apps/web` (admin CRUD + página TV + shell sessão)

Cada um trabalha contra os contratos de `packages/shared` — sem colisão.
