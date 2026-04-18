# Setup local de desenvolvimento

Guia passo a passo para rodar api, web e bridge na sua máquina. Alvo: desenvolvedor sentado em um Mac ou Linux.

## Pré-requisitos

| Requisito | Versão | Observação |
|---|---|---|
| Node.js | 20.11+ | Declarado em `package.json` (engines) |
| pnpm | 9+ | `corepack enable && corepack prepare pnpm@9.12.0 --activate` |
| Docker Desktop | qualquer recente | Usado apenas para Postgres local |
| OpenAI API key | qualquer conta paga | Realtime API (gpt-4o-realtime-preview) |
| macOS | 13+ | Para testar BLE no laptop direto |
| Linux | kernel com bluez | Alternativa ao Mac, ideal em Raspberry Pi |

Opcionais (necessários quando a bridge rodar nesta máquina):

- macOS: `brew install sox` (captura de microfone).
- Linux: `sudo apt-get install sox libasound2-dev bluez libbluetooth-dev libudev-dev`.

## Instalação local

### 1. Clone e instale dependências

```bash
git clone <repo-url> ai-robot-assistant
cd ai-robot-assistant
pnpm install
```

O `pnpm install` também compila os pacotes workspace (`@robot/shared`, `@robot/protocol`) se necessário via scripts `prepare`.

### 2. Arquivo `.env`

```bash
cp .env.example .env
```

Preencha no mínimo:

```bash
OPENAI_API_KEY=sk-...
JWT_SECRET=<pelo menos 16 chars aleatórios, use `openssl rand -hex 32`>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<senha forte>
```

Variáveis adicionais aceitas pelo `apps/api/src/config.ts`:

- `DATABASE_URL` (default do compose: `postgresql://postgres:postgres@localhost:5432/robot?schema=public`)
- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)
- `OPENAI_REALTIME_MODEL` (default `gpt-4o-realtime-preview`)
- `PUBLIC_BASE_URL` (usado na montagem do link `/tv/:sessionId`)
- `CORS_ORIGIN` (default `*`, aceita lista separada por vírgula)

Variáveis do frontend (`apps/web`):

- `VITE_API_URL=http://localhost:3000`
- `VITE_WS_URL=ws://localhost:3000`

Variáveis da bridge (`apps/bridge`):

- `BRIDGE_TOKEN` — gerado ao criar bridge no admin
- `API_WS_URL=ws://localhost:3000/ws/bridge`
- `BRIDGE_NAME=my-bridge`

### 3. Subir Postgres

```bash
docker compose up -d postgres
```

Aguarde `docker compose ps` mostrar `healthy` (ou apenas `running` na imagem `postgres:16-alpine`). Para encerrar:

```bash
docker compose down
```

Os dados persistem no volume `pgdata`.

### 4. Gerar o Prisma Client

```bash
pnpm --filter @robot/api prisma:generate
```

Executa `prisma generate` e cria o client tipado a partir de `apps/api/prisma/schema.prisma`.

### 5. Aplicar migrações

```bash
pnpm --filter @robot/api prisma:migrate dev
```

Na primeira vez, crie a migração inicial com um nome:

```bash
pnpm --filter @robot/api prisma migrate dev --name init
```

### 6. Bootstrap do usuário admin

Não há script `seed` separado. A API expõe um endpoint idempotente que cria o primeiro admin a partir de `ADMIN_EMAIL` / `ADMIN_PASSWORD`:

```bash
# (Em outro terminal) rode a API sozinha
pnpm --filter @robot/api dev
```

```bash
# Em um terceiro terminal
curl -X POST http://localhost:3000/api/auth/bootstrap
# → 201 com { id, email }
# (chamar de novo retorna 409 AlreadyBootstrapped)
```

### 7. Login e obtenção do JWT

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"admin@example.com","password":"<senha>"}'
# → { "token": "eyJ...", "user": { ... } }
```

Guarde o `token` para chamadas subsequentes em `-H "authorization: Bearer $TOKEN"`.

### 8. Subir tudo junto

```bash
pnpm dev
```

Turbo dispara em paralelo:

- `@robot/api` em `http://localhost:3000` (REST + WebSocket)
- `@robot/web` em `http://localhost:5173`
- `@robot/bridge` (falha até você definir `BRIDGE_TOKEN`; veja abaixo)

## Rodando cada app isoladamente

### API apenas

```bash
pnpm --filter @robot/api dev
```

`tsx watch src/server.ts`. Reinicia a cada alteração em `apps/api/src/**`.

### Web apenas

```bash
pnpm --filter @robot/web dev
```

Vite dev server em `http://localhost:5173` com HMR.

### Bridge apenas

1. No admin web (logado), crie uma bridge em **Bridges → Nova**. A API retorna o token em plaintext **uma única vez**.
2. Exporte o token e inicie:
   ```bash
   export BRIDGE_TOKEN=<token-copiado-do-admin>
   export API_WS_URL=ws://localhost:3000/ws/bridge
   export BRIDGE_NAME=dev-mac
   pnpm --filter @robot/bridge dev
   ```
3. Verifique no admin que a bridge aparece como `online`.

## Permissões BLE

A bridge usa `@abandonware/noble`, que conversa com o stack Bluetooth nativo.

### macOS

- System Settings → Privacy & Security → Bluetooth → marque o Terminal, iTerm ou qualquer processo que for rodar `node` (inclusive VS Code se for rodar pelo debugger).
- **Desparear o Robert do app do celular antes de conectar.** A conexão BLE do RS01 é single-client. Se o app `Robertt` estiver conectado, o `noble` vai listar o periférico mas falhar em `connect()`.
- Se aparecer `No compatible USB Bluetooth 4.0 device found`, rode `noble.reset()` (o `ble-manager.ts` documenta isso em TODO) ou reinicie a interface: `sudo pkill bluetoothd`.

### Linux

Duas opções para dar `CAP_NET_RAW` ao binário do Node:

```bash
# Opção 1: capability persistente no binário Node (recomendado)
sudo setcap cap_net_raw+eip $(readlink -f $(which node))

# Opção 2: rodar como root (dev-only)
sudo -E pnpm --filter @robot/bridge dev
```

Pré-requisitos de sistema:

```bash
sudo apt-get install bluez libbluetooth-dev libudev-dev
sudo systemctl enable --now bluetooth
```

Verifique o adapter com `hciconfig` ou `bluetoothctl show`.

## Permissões de áudio

A bridge também captura microfone (via `mic` → `sox`) e toca áudio do agente (via `speaker` → ALSA/CoreAudio).

### macOS

```bash
brew install sox
```

System Settings → Privacy & Security → Microphone → marque o terminal.

### Linux

```bash
sudo apt-get install sox libasound2-dev
```

Garanta que `sox -d` (microphone) e `aplay` funcionam antes de rodar a bridge. Se rodar em headless (Raspberry Pi), defina `ALSA_PCM_CARD` / `AUDIODEV` conforme o hardware.

## Testando o fluxo completo

1. **Criar agente**: no admin (`http://localhost:5173/agents`), crie um agente com `name`, `personality`, `systemPrompt`, `voice` (ex: `alloy`) e `greeting`. Os defaults de `emotionColorMap` e `tools` são preenchidos automaticamente pela API se omitidos.
2. **Criar bridge**: em **Bridges → Nova**, informe um nome. Copie o `token` retornado.
3. **Rodar a bridge**: `export BRIDGE_TOKEN=... && pnpm --filter @robot/bridge dev`. No admin, a bridge deve ficar `online` em poucos segundos.
4. **Conectar ao robô**: abra `http://localhost:5173/connect`, dispare `scan`, selecione `Robert_ble`, clique `connect`. A bridge executa o BLE connect e responde `ble:connected`.
5. **Iniciar sessão**: em **Sessions → Nova**, escolha agente + bridge. A API retorna `{ id, tvUrl }`.
6. **Abrir TV**: em uma segunda janela (ou Chromecast/Fire Stick), abra `tvUrl` — algo como `http://localhost:3000/tv/<sessionId>` (ou o domínio apontado por `PUBLIC_BASE_URL`).
7. **Conversar**: fale ao microfone conectado à bridge. A fala vai para a OpenAI Realtime via proxy da API, a resposta volta por `audio:out` (bridge toca) e por eventos de tool (`show_on_tv`, `robot_color`, etc.) que refletem na TV e no robô.
8. **Encerrar**: clique `End` no admin ou feche a sessão via `POST /api/sessions/:id/end`.

## Troubleshooting rápido

| Sintoma | Onde olhar |
|---|---|
| `Invalid environment configuration: JWT_SECRET must be at least 16 chars` | Seu `.env` na raiz — API lê via `dotenv`/`process.env`. |
| Bridge fica em `connecting...` infinito | Token errado ou `API_WS_URL` fora do ar. Veja logs do processo bridge. |
| `peripheral ... not found` no scan | Robert desligado, fora de alcance, ou pareado com celular. |
| Áudio do agente cortado/glitchy | Verifique taxa de amostragem do speaker (PCM16 @ 24000 Hz esperado). |
| TV não recebe conteúdo | Conferir se `sessionId` na URL bate e se o WS `/ws/tv/:sessionId` conectou (DevTools → Network → WS). |
