# Smoke Test

End-to-end sanity check for the `apps/api` cloud service. Exercises the full
admin lifecycle: bootstrap, login, CRUD on agents and bridges, a mocked BLE
scan, session start/end, plus the three WebSocket channels (bridge, admin, TV).

## What it does

1. `GET /healthz`
2. `POST /api/auth/bootstrap` (idempotent — accepts 200/201/409)
3. `POST /api/auth/login` → JWT
4. `GET /api/agents`
5. `POST /api/agents` (create "smoke-agent")
6. `PATCH /api/agents/:id` (rename)
7. `POST /api/bridges` (returns plaintext token once)
8. `WS /ws/bridge` — sends `hello`, awaits `welcome`, then mocks bridge replies
9. `GET /api/bridges` (soft-checks status=online)
10. `POST /api/bridges/:id/scan` (mock bridge returns empty device list)
11. `POST /api/sessions` → SessionDTO + tvUrl
12. `WS /ws/admin` + `{type:"subscribe"}`
13. `WS /ws/tv/:id` → awaits `hello`
14. `POST /api/sessions/:id/end`
15. Cleanup: `DELETE /api/agents/:id`, `DELETE /api/bridges/:id`

Exit 0 if every step passes, 1 otherwise.

## Running

```bash
pnpm install                 # once, if not done
pnpm dev                     # terminal 1 — boots apps/api (plus others)
pnpm smoke                   # terminal 2
```

## Environment variables

| Var              | Default                   | Purpose                           |
| ---------------- | ------------------------- | --------------------------------- |
| `API_URL`        | `http://localhost:3000`   | REST base URL                     |
| `BRIDGE_URL`     | derived from `API_URL`    | WS URL for `/ws/bridge`           |
| `ADMIN_EMAIL`    | `admin@example.com`       | Used for login + bootstrap        |
| `ADMIN_PASSWORD` | `change-me`               | Same                              |

CLI overrides: `--api-url <url>`, `--bridge-url <url>`.

## Limitations

- Does not exercise the OpenAI Realtime proxy (requires a real API key + mic).
- Does not talk to a real BLE peripheral — the bridge is mocked in-process.
- Does not render or validate the TV web display (only the WS hello).
