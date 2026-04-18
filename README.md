# AI Robot Assistant

Plataforma cloud para criar agentes com personalidade que conversam através do robô Robert RS01 (BLE), com TV sincronizada exibindo conteúdo durante o diálogo.

## Arquitetura resumida

```
┌─ CLOUD ────────────────────┐      ┌─ LOCAL ─────────────────┐      ┌─ TV ──────────┐
│  apps/api  (Fastify + WS)  │◀────▶│  apps/bridge  (noble)   │      │  Browser      │
│  apps/web  (admin + /tv)   │  WS  │   BLE → Robert RS01     │      │  /tv/:id      │
│  Postgres  (Prisma)        │      │   mic + speaker         │      └──────▲────────┘
└────────────────────────────┘      └─────────────────────────┘             │ WS
           │                                                                │
           └────────────────────────────────────────────────────────────────┘
```

Três processos, três barramentos WebSocket (`/ws/bridge`, `/ws/admin`, `/ws/tv/:sessionId`). A API faz proxy do OpenAI Realtime; a bridge empurra áudio BLE/mic; a TV só renderiza.

## Quickstart

1. Clone o repositório e entre na pasta.
   ```bash
   git clone <repo-url> ai-robot-assistant && cd ai-robot-assistant
   ```
2. Instale dependências (pnpm 9+, Node 20+).
   ```bash
   pnpm install
   ```
3. Configure variáveis de ambiente.
   ```bash
   cp .env.example .env
   # edite: OPENAI_API_KEY, JWT_SECRET (>=16 chars), ADMIN_EMAIL, ADMIN_PASSWORD
   ```
4. Suba o Postgres via Docker Compose.
   ```bash
   docker compose up -d postgres
   ```
5. Rode migrações e crie o admin.
   ```bash
   pnpm --filter @robot/api prisma:generate
   pnpm --filter @robot/api prisma:migrate dev
   curl -X POST http://localhost:3000/api/auth/bootstrap
   ```
6. Suba tudo em modo dev.
   ```bash
   pnpm dev
   ```

Admin em `http://localhost:5173`. Detalhes completos em [`docs/SETUP.md`](docs/SETUP.md).

## Estrutura do monorepo

```
ai-robot-assistant/
├── apps/
│   ├── api/            Fastify + Prisma + WebSocket hub + OpenAI proxy
│   ├── bridge/         Daemon Node local (BLE noble + mic/speaker)
│   └── web/            React + Vite (admin e página /tv/:sessionId)
├── packages/
│   ├── shared/         Tipos compartilhados (mensagens WS, DTOs)
│   └── robot-protocol/ Codec puro do protocolo Robert RS01
├── legacy/             Scripts Python originais e ROBERT_RS01_PROTOCOL.md
├── docker-compose.yml  Postgres para desenvolvimento
├── turbo.json          Pipeline de build/dev
└── pnpm-workspace.yaml
```

## Comandos úteis

| Comando | O que faz |
|---|---|
| `pnpm dev` | Sobe api, web e bridge em paralelo (turbo) |
| `pnpm build` | Build de todos os pacotes e apps |
| `pnpm typecheck` | `tsc --noEmit` em tudo |
| `pnpm test` | Roda testes em cada workspace |
| `pnpm lint` | Lint em tudo |
| `pnpm --filter @robot/api dev` | Sobe apenas a API |
| `pnpm --filter @robot/web dev` | Sobe apenas o frontend |
| `pnpm --filter @robot/bridge dev` | Sobe apenas a bridge local |
| `pnpm --filter @robot/api prisma:migrate dev` | Cria/aplica migração |
| `pnpm --filter @robot/api prisma:generate` | Gera o Prisma Client |

## Documentação

- [`docs/SETUP.md`](docs/SETUP.md) — instalação local, permissões BLE/áudio, teste end-to-end
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deploy em nuvem (Fly.io, Docker), Raspberry Pi, secrets
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — endpoints REST, contratos WS, ciclo de sessão, tool-calling, trade-offs

## Stack

TypeScript em todos os processos. Backend Fastify 5 com `@fastify/websocket`, Prisma ORM sobre Postgres 16, autenticação JWT via `@fastify/jwt`. Frontend React 18 + Vite + Tailwind + React Query + React Router. Bridge usa `@abandonware/noble` (BLE central), `mic` e `speaker`. Comunicação com OpenAI via Realtime API (gpt-4o-realtime-preview) em PCM16 @ 24 kHz. Monorepo gerenciado por pnpm workspaces e turbo. Deploy via Dockerfile por app.

---

Status: WIP / agentes em desenvolvimento ativo.
