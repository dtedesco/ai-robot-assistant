# GitHub Actions workflows

Three workflows live here.

## Workflows

### `ci.yml`
Runs on every push to `main` and every pull request targeting `main`.

Pipeline stages (sequential):
1. **typecheck** — `pnpm install`, generates the Prisma client, runs `pnpm -r typecheck`.
2. **build** — `pnpm -r build` (depends on typecheck).
3. **test** — `pnpm --filter @robot/protocol test` (depends on build).

Only `@robot/protocol` has tests today. Add more filters here as new test suites land.

### `deploy-api.yml`
Deploys the Fastify API to Fly.io.

- Triggers: `workflow_dispatch` (manual) and pushes to `main` that touch `apps/api/**`, `packages/shared/**`, `packages/robot-protocol/**`, `fly.api.toml`, or this workflow.
- Uses `fly.api.toml` at the repo root.
- Build happens remotely on Fly (`--remote-only`), so the runner does not need Docker.

### `deploy-web.yml`
Deploys the React admin/TV app to Fly.io.

- Triggers: `workflow_dispatch` and pushes to `main` touching `apps/web/**`, `packages/shared/**`, `fly.web.toml`, or this workflow.
- Passes `VITE_API_URL` and `VITE_WS_URL` as build args (they are inlined by Vite at build time).

## Required secrets

Configure these at **Settings → Secrets and variables → Actions** on GitHub.

| Secret | Used by | Description |
|---|---|---|
| `FLY_API_TOKEN` | `deploy-api`, `deploy-web` | Fly.io deploy token. Create with `flyctl tokens create deploy`. |
| `VITE_API_URL` | `deploy-web` | Public API URL the web app should call (e.g. `https://robot-api.fly.dev`). |
| `VITE_WS_URL` | `deploy-web` | Public WebSocket URL (e.g. `wss://robot-api.fly.dev`). |

Fly.io runtime secrets (set via `flyctl secrets set ... --app robot-api`, NOT GitHub secrets):
`DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CORS_ORIGIN`.

For `robot-web` on Fly, the only runtime secret that matters is `API_UPSTREAM` (defaults to `robot-api.internal:3000` via `fly.web.toml`).
