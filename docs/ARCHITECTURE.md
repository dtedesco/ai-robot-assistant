# Arquitetura

Documento de referência técnica. Para a visão executiva, veja [`PLAN.md`](../PLAN.md); para rodar localmente, [`docs/SETUP.md`](SETUP.md).

## Topologia dos três barramentos WebSocket

A API hospeda três endpoints WebSocket distintos, cada um com sua política de autenticação e direcionalidade:

```
                            ┌──────────────────────────────────────────┐
                            │                API (Fastify)             │
                            │                                          │
                            │   ┌──────────────┐      ┌────────────┐   │
                            │   │  SessionHub  │◀────▶│ OpenAI RT  │   │
                            │   │  (in-memory) │      │   proxy    │   │
                            │   └──────┬───────┘      └────────────┘   │
                            │          │                               │
                            │  ┌───────┼───────┬───────────────┐       │
                            │  ▼       ▼       ▼               ▼       │
                            │ /ws/   /ws/    /ws/tv/          REST     │
                            │ bridge admin   :sessionId      /api/*    │
                            └──┬───────┬─────────┬──────────────┬──────┘
                               │       │         │              │
   auth = token da             │       │         │              │
   tabela Bridge (hello)       │       │         │              │
                               │       │         │              │
           ┌───────────────────▼┐   ┌──▼──────┐ ┌▼─────────┐   ┌▼────────┐
           │  Bridge (Pi / Mac) │   │ Admin   │ │ TV       │   │ Admin   │
           │  - noble BLE       │   │ (React  │ │ (/tv/... │   │ (React  │
           │  - mic / speaker   │   │  admin) │ │  browser)│   │  admin) │
           └────────────────────┘   └─────────┘ └──────────┘   └─────────┘
             bidir                   bidir, JWT    só-leitura    HTTP+JWT
```

- `/ws/bridge` — autenticado por `{ type: "hello", token }` cruzado com `Bridge.token`. Bidirecional. Única origem de eventos BLE / áudio do robô.
- `/ws/admin` — autenticado por JWT (query `?token=` ou header). Bidirecional. Canal de controle do operador humano.
- `/ws/tv/:sessionId` — público, só-leitura. Qualquer dispositivo com o `sessionId` recebe `display`/`clear`. Modelo de segurança: o ID é um cuid não enumerável.

## Endpoints REST

Todos sob o prefixo `/api`. Rotas protegidas exigem `authorization: Bearer <JWT>` via hook `onRequest` (`app.authenticate`).

| Método | Rota | Auth | Origem | Descrição |
|---|---|---|---|---|
| `POST` | `/api/auth/bootstrap` | — | `routes/auth.ts` | Cria o primeiro admin se `User` estiver vazio (idempotente: 409 se já existe). |
| `POST` | `/api/auth/login` | — | `routes/auth.ts` | Valida email/senha e devolve `{ token, user }` com JWT expirando em 7 dias. |
| `GET` | `/api/agents` | JWT | `routes/agents.ts` | Lista todos os agentes (DTO completo). |
| `GET` | `/api/agents/:id` | JWT | `routes/agents.ts` | Busca um agente. |
| `POST` | `/api/agents` | JWT | `routes/agents.ts` | Cria agente. Zod valida voice enum, emoção→cor e tools. |
| `PATCH` | `/api/agents/:id` | JWT | `routes/agents.ts` | Atualização parcial. |
| `DELETE` | `/api/agents/:id` | JWT | `routes/agents.ts` | Remove agente. |
| `GET` | `/api/bridges` | JWT | `routes/bridges.ts` | Lista bridges (sem token). |
| `POST` | `/api/bridges` | JWT | `routes/bridges.ts` | Cria bridge, retorna `token` em plaintext **uma vez**. |
| `DELETE` | `/api/bridges/:id` | JWT | `routes/bridges.ts` | Remove bridge (também rotaciona: crie outra). |
| `GET` | `/api/sessions` | JWT | `routes/sessions.ts` | Últimas 100 sessões. |
| `GET` | `/api/sessions/:id` | JWT | `routes/sessions.ts` | Busca sessão. |
| `POST` | `/api/sessions` | JWT | `routes/sessions.ts` | Inicia sessão `{ agentId, bridgeId }`. Aciona `SessionHub.startSession` que envia `session:start` à bridge e abre o Realtime upstream. Retorna `{ ...session, tvUrl }`. |
| `POST` | `/api/sessions/:id/end` | JWT | `routes/sessions.ts` | Encerra sessão (idempotente). |
| `GET` | `/healthz` | — | `server.ts` | Liveness. |

## Mensagens WebSocket

Todas tipadas em `packages/shared/src/messages.ts`. Fonte única de verdade; tanto API quanto clientes importam daí.

### `/ws/bridge`

Bridge → API (`BridgeUpMsg` em `packages/shared/src/messages.ts:34`):

| `type` | Payload | Semântica |
|---|---|---|
| `hello` | `{ token, version }` | Handshake inicial. API valida contra `Bridge.token` e responde `welcome`. |
| `ble:scanResult` | `{ devices: BLEDevice[] }` | Resultado do scan pedido pelo admin. |
| `ble:connected` | `{ address }` | BLE central conectado ao Robert. |
| `ble:disconnected` | `{ reason? }` | Desconexão (peripheral drop, manual, timeout). |
| `ble:error` | `{ message }` | Erro do stack BLE (permissões, adapter off). |
| `audio:in` | `{ pcm }` | PCM16 @ 24kHz em base64, capturado do microfone. Encaminhado à OpenAI Realtime. |
| `pong` | `{}` | Resposta ao `ping` de keepalive. |

API → Bridge (`BridgeDownMsg` em `packages/shared/src/messages.ts:51`):

| `type` | Payload | Semântica |
|---|---|---|
| `welcome` | `{ bridgeId }` | Handshake aceito. |
| `ble:scan` | `{}` | Pede scan (duração ~5s). |
| `ble:connect` | `{ address }` | Conecta ao periférico descoberto. |
| `ble:disconnect` | `{}` | Desconecta do Robert. |
| `ble:packet` | `{ hex }` | Pacote do protocolo Robert RS01 (ver abaixo) pronto para `write`. |
| `audio:out` | `{ pcm }` | Áudio do agente (PCM16@24kHz base64) para tocar no speaker. |
| `session:start` | `{ sessionId, realtime: RealtimeConfig }` | Ativa modo sessão: bridge começa a enviar `audio:in`. |
| `session:end` | `{}` | Encerra sessão. |
| `ping` | `{}` | Keepalive. |

`RealtimeConfig` inclui `model`, `voice`, `instructions` (system prompt concatenado com a personalidade), `greeting` opcional e o array de `tools`.

### `/ws/admin`

Admin → API (`AdminUpMsg`):

| `type` | Payload | Semântica |
|---|---|---|
| `subscribe` | `{ sessionId }` | Solicita eventos da sessão. |
| `unsubscribe` | `{ sessionId }` | Para de receber. |
| `sendText` | `{ sessionId, text }` | Injeta texto como se o usuário tivesse falado (útil para demo). |

API → Admin (`AdminDownMsg`):

| `type` | Payload | Semântica |
|---|---|---|
| `session:event` | `{ sessionId, event: SessionEvent }` | Eventos compostos: transcript, emoção, tv, robô, erro. |
| `bridge:status` | `{ bridgeId, online }` | Notificação de bridge up/down. |
| `error` | `{ message }` | Erro de protocolo. |

`SessionEvent` variantes: `started`, `ended`, `transcript`, `emotion`, `tv`, `robot:action`, `robot:color`, `error`.

### `/ws/tv/:sessionId`

API → TV (`TvDownMsg`):

| `type` | Payload | Semântica |
|---|---|---|
| `hello` | `{ sessionId }` | Primeiro frame ao conectar. |
| `display` | `{ content: TvContent }` | Mostrar mídia. `TvContent` é union: `youtube`, `image`, `webpage`, `text`. |
| `clear` | `{}` | Limpa a TV. |

A TV não envia mensagens — é só sink. Qualquer comando vem do admin ou de tool-calls do agente.

## Ciclo de vida da sessão

Sequência desde o click em "Iniciar Sessão" até a primeira resposta de áudio do agente:

```
1.  Admin (browser)    POST /api/sessions {agentId, bridgeId}        ──▶ API
2.  API                Persiste Session (Prisma)
3.  API                SessionHub.startSession(session, agent, bridge)
4.  API                Abre WS upstream com OpenAI Realtime
                       (session.create: voice, instructions, tools)
5.  API ──▶ Bridge     {type:"session:start", sessionId, realtime}    via /ws/bridge
6.  Bridge             Liga captura de microfone (mic → PCM16 24kHz)
7.  Bridge ──▶ API     {type:"audio:in", pcm:<b64>}                   (loop contínuo)
8.  API ──▶ OpenAI     input_audio_buffer.append                      (encaminha)
9.  OpenAI ──▶ API     response.audio.delta (PCM16 24kHz)
10. API ──▶ Bridge     {type:"audio:out", pcm:<b64>}
11. Bridge             speaker.write(decode(pcm))                     (agente fala)
12. API ──▶ Admin+TV   session:event {transcript, tv, emotion, ...}   (paralelo)
```

Encerramento: `POST /api/sessions/:id/end` → `SessionHub.endSession` → fecha WS OpenAI + envia `session:end` à bridge + marca `Session.endedAt` + emite `session:event { type:"ended" }`.

## Tool-calling

Cinco tools expostas ao agente via Realtime API. Cada tool invocada pela LLM gera uma mensagem no barramento, não uma resposta direta.

| Tool | Argumentos | Tradução no barramento |
|---|---|---|
| `show_on_tv` | `{ kind, url, title? }` ou `{ kind:"text", text }` | `SessionEvent { type:"tv", msg:{ type:"display", content } }` → broadcast admin + TV |
| `show_from_library` | `{ topic }` | Busca item em `Agent.tvLibrary[]`, converte em `TvContent`, dispara o mesmo `tv` event |
| `clear_tv` | `{}` | `SessionEvent { type:"tv", msg:{ type:"clear" } }` |
| `robot_dance` | `{ action: 1-93 }` | `SessionEvent { type:"robot:action", action }` + `BridgeDownMsg { type:"ble:packet", hex }` codificado via `@robot/protocol` |
| `robot_color` | `{ color: 1-7 }` | `SessionEvent { type:"robot:color", color }` + `BridgeDownMsg { type:"ble:packet", hex }` |

O codec BLE vive em `packages/robot-protocol` (puro, sem dependências de noble), consumido tanto pela API (para montar `ble:packet`) quanto pela bridge (para eventual parsing de notificações).

O mapa `Agent.emotionColorMap` permite associar emoções detectadas ao longo da conversa (ex: `feliz → 3` verde) com mudanças automáticas de cor do robô.

## Protocolo Robert RS01 (resumo)

Service UUID `0000ffc0-0000-1000-8000-00805f9b34fb`. Write char `FFC1`, notify char `FFC2`. Pacote:

```
[AA AA CC] [CMD] [COUNT] [action action speed 0 color 0 2 2] [01 01] [55 55]
```

- `CMD`: `0x32` para ação, `0x0C` para stop.
- `action`: 1-93 (danças), 100-110 (braços), 200-235 (pernas), 77 (stop).
- `speed`: `0x08` para ações discretas, `0xFF` para movimento contínuo.
- `color`: 1 azul-escuro, 2 azul, 3 verde, 4 amarelo, 5 vermelho, 6 roxo, 7 branco.
- Write-without-response (fast path, `noble.write(data, true, cb)`).

Detalhes completos com exemplos de bytes e troubleshooting em [`legacy/ROBERT_RS01_PROTOCOL.md`](../legacy/ROBERT_RS01_PROTOCOL.md).

## Trade-offs

**Postgres em vez de SQLite.** O schema inicial poderia caber em SQLite, mas o app é multi-bridge / multi-sessão e eventualmente vai pra Fly/Supabase — migrar schema mais tarde custa caro. Prisma abstrai os dois, então o custo de começar com Postgres é apenas subir um container local.

**Noble em vez de Web Bluetooth / Bleak (Python).** Web Bluetooth exige gesto do usuário e não roda em Chromecast/Fire Stick; Bleak (Python) obrigaria polyglot com IPC. `@abandonware/noble` dá controle central BLE dentro do mesmo runtime Node da bridge, compartilha protocolo com a API via `@robot/protocol` workspace, e roda tanto em macOS (CoreBluetooth) quanto Linux (HCI) com as mesmas APIs. Trade-off: native addon, flaky às vezes (há `noble.reset()` documentado em `apps/bridge/src/ble-manager.ts:22-27`).

**Áudio PCM16 @ 24 kHz.** É o formato nativo do OpenAI Realtime API. Evitamos transcodificação no hot path (mic → WS → cloud → WS → speaker). O custo é que o link WS transporta ~48 kB/s por direção; aceitável em banda larga residencial.

**Bridge local vs. cloud-only.** BLE tem alcance de ~10 m e não atravessa firewall/NAT. O A2DP para áudio do robô também é local. Centralizar a bridge na nuvem exigiria um tunnel BLE USB-over-IP, o que quadruplica a latência do hot path de controle (`robot_color` que deveria ser <100ms viraria ~500ms). Preferimos uma bridge commodity (Raspberry Pi) no site físico, conectada à cloud por WSS persistente.

**SessionHub em memória.** Atualmente `SessionHub` é uma instância local do processo API. Isso implica afinidade: o admin, a bridge e o TV precisam hit no mesmo pod. Para escalar horizontalmente, o hub precisaria virar um broker (Redis pub/sub, ou NATS). Decisão explícita para a Fase 1: manter simples, re-arquitetar quando surgir um segundo pod.

**OpenAI Realtime proxy na API (não direto do browser).** O token `OPENAI_API_KEY` nunca sai do servidor. A API proxya o WS bidirecional. Benefício secundário: podemos logar a conversa em `Session.transcript` sem tocar o cliente.
