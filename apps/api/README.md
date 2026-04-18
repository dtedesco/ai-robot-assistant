# @robot/api

Fastify + Prisma backend for the AI Robot Assistant.

## Setup

```bash
# from repo root
pnpm install
cp .env.example .env   # edit DATABASE_URL, JWT_SECRET, OPENAI_API_KEY, ADMIN_*

# generate Prisma client + apply migrations
pnpm --filter @robot/api prisma:generate
pnpm --filter @robot/api prisma:migrate

# seed admin user + 3 example agents (Sofia, Professor Hugo, Contador)
pnpm --filter @robot/api seed

# dev server (tsx watch on :3000)
pnpm --filter @robot/api dev
```

## Bootstrap admin via HTTP (alternative to seed)

```bash
curl -X POST http://localhost:3000/api/auth/bootstrap
```

Uses `ADMIN_EMAIL` / `ADMIN_PASSWORD` from env (defaults: `admin@example.com` / `change-me`).

## Quick login test

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"change-me"}'
```

Response: `{ "token": "...", "user": { "id": "...", "email": "..." } }`. Use the token as `Authorization: Bearer <token>` for all `/api/*` routes (except `/auth/*`, `/agents/:id/public`, `/sessions/:id/public`).
