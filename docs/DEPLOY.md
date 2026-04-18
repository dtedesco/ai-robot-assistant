# Deploy

Como publicar a plataforma em produção. A topologia não é uma aplicação monolítica: parte roda em nuvem e parte roda obrigatoriamente perto do robô.

## Arquitetura de deploy

```
┌─ CLOUD (Fly.io, VPS, etc.) ─────────────┐
│  apps/api         (Fastify + WS hub)    │
│  apps/web         (build estático)      │◀────── admin + /tv/:sessionId
│  Postgres 16      (Fly PG / Supabase)   │
└─────────────────▲───────────────────────┘
                  │ WSS
                  │
┌─ LOCAL (junto ao robô) ─────────────────┐    ┌─ TV ────────────────┐
│  apps/bridge     (Node daemon)          │    │  Chromecast / Smart │
│   └─ noble (BLE) + mic/speaker          │    │  TV / Fire Stick    │
└─────────────────────────────────────────┘    └─────────────────────┘
```

- **Cloud**: stateless (API) + banco gerenciado. Escala horizontal sem problema (desde que haja afinidade do WebSocket ou um broadcaster externo — veja Trade-offs em `docs/ARCHITECTURE.md`).
- **Bridge**: obrigatória no mesmo ambiente físico do Robert RS01 (o BLE é de curto alcance; o A2DP precisa de pareamento local). Um Raspberry Pi 4 ou Mac mini serve bem.
- **TV**: apenas um browser moderno. Chromecast aceita URL via `Google Home → Cast tab`. Fire Stick/Android TV via Silk Browser.

## Opção 1: Fly.io

Recomendada pela simplicidade. Há `Dockerfile` em cada app (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/bridge/Dockerfile`).

**TODO**: os arquivos `fly.api.toml`, `fly.web.toml` ainda não foram commitados. Os comandos abaixo assumem os nomes esperados; ajuste conforme forem adicionados.

### Postgres

Opções:

```bash
# Fly Postgres
fly postgres create --name robot-db --region gru
fly postgres attach --app robot-api robot-db
```

ou use [Supabase](https://supabase.com) / [Neon](https://neon.tech) / RDS. Copie a `DATABASE_URL` resultante.

### API

```bash
# Primeira vez
cd apps/api
fly launch --name robot-api --no-deploy
# Ou, se o fly.api.toml já existir na raiz:
fly launch --config fly.api.toml --no-deploy
```

Secrets:

```bash
fly secrets set \
  JWT_SECRET=$(openssl rand -hex 32) \
  OPENAI_API_KEY=sk-... \
  ADMIN_EMAIL=admin@example.com \
  ADMIN_PASSWORD=<senha-forte> \
  DATABASE_URL='postgresql://...' \
  PUBLIC_BASE_URL=https://robot-api.fly.dev \
  CORS_ORIGIN=https://robot-web.fly.dev \
  --app robot-api
```

Deploy:

```bash
fly deploy --config fly.api.toml
```

Rode migrações uma vez após o deploy:

```bash
fly ssh console -a robot-api -C "pnpm --filter @robot/api prisma migrate deploy"
curl -X POST https://robot-api.fly.dev/api/auth/bootstrap
```

### Web

Build estático servido por um container Nginx minimalista (ou Fly static). Variáveis precisam ser injetadas em build-time:

```bash
cd apps/web
VITE_API_URL=https://robot-api.fly.dev \
VITE_WS_URL=wss://robot-api.fly.dev \
pnpm build
fly deploy --config fly.web.toml
```

### Bridge (opcional, cloud)

A bridge pode rodar na nuvem **apenas** se houver um tunnel BLE entre a cloud e o robô — o que não é suportado. Deixe a bridge para o site físico (veja abaixo).

## Opção 2: Docker Compose em VPS

Para uma VPS dedicada (DigitalOcean, Hetzner):

**TODO**: `docker-compose.prod.yml` ainda não existe. A estrutura alvo:

```yaml
# docker-compose.prod.yml (proposto)
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: robot
    volumes: [pgdata:/var/lib/postgresql/data]
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    env_file: .env.prod
    depends_on: [postgres]
    ports: ["3000:3000"]
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    ports: ["8080:80"]
volumes:
  pgdata:
```

Deploy:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api \
  pnpm --filter @robot/api prisma migrate deploy
```

Coloque um reverse proxy (Caddy, Traefik) na frente para TLS.

## Bridge em Raspberry Pi

Hardware testável: Raspberry Pi 4 (4 GB) com Raspberry Pi OS 64-bit, USB speaker + USB mic (ou o próprio áudio do Robert via A2DP).

### 1. Dependências

```bash
sudo apt-get update
sudo apt-get install -y bluez libbluetooth-dev libudev-dev sox libasound2-dev
curl -fsSL https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-arm64.tar.xz | sudo tar -xJ -C /opt
sudo ln -s /opt/node-v20.11.1-linux-arm64/bin/{node,npm,npx} /usr/local/bin/
sudo corepack enable && corepack prepare pnpm@9.12.0 --activate
```

### 2. Clonar e buildar apenas a bridge

```bash
git clone <repo-url> /opt/robot
cd /opt/robot
pnpm install --filter @robot/bridge...
pnpm --filter @robot/bridge build
```

### 3. Permissão BLE no Node

```bash
sudo setcap cap_net_raw+eip $(readlink -f $(which node))
```

### 4. Unit systemd

`/etc/systemd/system/robot-bridge.service`:

```ini
[Unit]
Description=Robot BLE/Audio bridge
After=network-online.target bluetooth.target
Wants=network-online.target bluetooth.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/robot/apps/bridge
Environment=NODE_ENV=production
Environment=API_WS_URL=wss://robot-api.fly.dev/ws/bridge
Environment=BRIDGE_TOKEN=<cole-aqui>
Environment=BRIDGE_NAME=livingroom-pi
ExecStart=/usr/local/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now robot-bridge
sudo journalctl -u robot-bridge -f
```

### 5. Alternativa: Docker na Pi

```bash
docker build -t robot-bridge -f apps/bridge/Dockerfile .
docker run -d --name robot-bridge \
  --net=host --cap-add=NET_ADMIN --cap-add=NET_RAW \
  -v /var/run/dbus:/var/run/dbus \
  -e API_WS_URL=wss://robot-api.fly.dev/ws/bridge \
  -e BRIDGE_TOKEN=... \
  -e BRIDGE_NAME=livingroom-pi \
  --device /dev/snd \
  robot-bridge
```

`--net=host` é necessário para BLE + mDNS do bluez funcionarem no container.

## TV

Nenhum deploy. É apenas um URL:

```
https://robot-api.fly.dev/tv/<sessionId>
```

O servidor web (`apps/web`) expõe a rota `/tv/:sessionId`. Em dispositivos sem browser embutido, use Chromecast (cast tab no Chrome) ou Fire Stick com Silk Browser. A página abre o WebSocket `/ws/tv/:sessionId` (público, só-leitura) e aguarda `display`/`clear`.

## Rotação de secrets

- **`JWT_SECRET`**: rotacione com `fly secrets set JWT_SECRET=...` ou editando o `.env`. **Invalida todos os JWTs emitidos** — usuários precisam logar de novo.
- **`BRIDGE_TOKEN`**: cada bridge tem um token único armazenado em Postgres. Para rotacionar:
  1. Delete a bridge no admin (`DELETE /api/bridges/:id`).
  2. Crie uma nova com o mesmo nome — o endpoint `POST /api/bridges` retorna o novo token em plaintext uma única vez.
  3. Atualize a variável `BRIDGE_TOKEN` no systemd/Docker da bridge e reinicie o serviço.
- **`OPENAI_API_KEY`**: gire no dashboard da OpenAI, depois `fly secrets set OPENAI_API_KEY=...`.
- **`ADMIN_PASSWORD`**: troque via SQL/Prisma Studio (`bcrypt` hash) ou criando outro usuário e deletando o antigo.

## Monitoramento

### Logs

```bash
# Fly.io
fly logs -a robot-api
fly logs -a robot-web

# Docker
docker logs -f robot-bridge
docker compose -f docker-compose.prod.yml logs -f api

# Raspberry Pi
sudo journalctl -u robot-bridge -f
```

### Health check

A API expõe `GET /healthz` → `{ ok: true }`. Configure seu orquestrador (Fly autocheck, k8s liveness) apontando para essa rota.

### Status de bridge

O admin recebe eventos `bridge:status` via WebSocket (`/ws/admin`). Um monitor simples consome esse stream e dispara alertas quando `online=false` por mais de N minutos.

### Métricas de sessão

Não há Prometheus nativo ainda. O campo `Session.transcript` acumula o histórico completo da conversa em JSON; consulte via Prisma Studio:

```bash
pnpm --filter @robot/api prisma studio
```
