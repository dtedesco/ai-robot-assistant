import { fromHex } from "@robot/protocol";
import type {
  BridgeAgentSummary,
  BridgeDownMsg,
  BridgeUpMsg,
} from "@robot/shared";
import { Audio } from "./audio.js";
import { BLEAutoConnect } from "./auto-connect.js";
import { BLEManager } from "./ble-manager.js";
import { BRIDGE_VERSION, loadConfig } from "./config.js";
import { startLocalHttp } from "./http.js";
import { logger, setLogLevel } from "./logger.js";
import { RealtimeClient } from "./realtime.js";
import { TvController } from "./tv-controller.js";
import { WSClient } from "./ws-client.js";

function toBase64(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function fromBase64(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  logger.info(
    `bridge starting version=${BRIDGE_VERSION} name=${config.BRIDGE_NAME}`,
  );

  const ws = new WSClient({
    url: config.API_WS_URL,
    token: config.BRIDGE_TOKEN,
  });
  const ble = new BLEManager();
  const audio = new Audio();
  const autoConnect = new BLEAutoConnect(ble, {
    intervalMs: config.BLE_AUTO_INTERVAL_MS,
  });

  const realtime = new RealtimeClient(audio);
  realtime.setMicGain(config.MIC_GAIN);

  /** Agent catalogue pushed by the API on welcome. User picks one from the UI. */
  const agentStore: { list: BridgeAgentSummary[] } = { list: [] };

  /** TV controller — bridgeId arrives on welcome, so start with a placeholder
   *  and update once we know our id. */
  const apiHttpBase = config.API_WS_URL
    .replace(/^ws/, "http")
    .replace(/\/ws\/bridge.*$/, "");
  const tv = new TvController(
    {
      apiBaseUrl: apiHttpBase,
      bridgeId: "",
      bridgeToken: config.BRIDGE_TOKEN,
    },
    "",
  );
  realtime.setTvController(tv);

  // --- BLE → WS: surface events as BridgeUpMsg ----------------------------
  ble.on("connected", (address: string) => {
    ws.send({ type: "ble:connected", address });
  });

  ble.on("disconnected", (reason?: string) => {
    ws.send({ type: "ble:disconnected", reason });
  });

  ble.on("notification", (_data: Buffer) => {
    // Robert's notifications are mostly status echoes. We log at debug level
    // rather than forwarding — the cloud doesn't consume them today.
    logger.debug(`[ble] notify ${_data.toString("hex")}`);
  });

  ble.on("error", (err: Error) => {
    logger.error(`[ble] ${err.message}`);
    ws.send({ type: "ble:error", message: err.message });
  });

  // --- WS → handlers ------------------------------------------------------
  ws.on("message", async (msg: BridgeDownMsg) => {
    logger.debug(`[ws] recv ${msg.type}`);
    try {
      await handleDownMsg(msg, {
        ws,
        ble,
        audio,
        realtime,
        agentStore,
        tv,
        autoStartRealtime: config.REALTIME_AUTO_START,
      });
    } catch (err) {
      const e = err as Error;
      logger.error(`[handler] ${msg.type}: ${e.message}`);
      // Map BLE-ish failures back to the cloud so the admin sees them.
      if (msg.type.startsWith("ble:")) {
        ws.send({ type: "ble:error", message: e.message });
      }
    }
  });

  ws.start();

  const tokenMasked =
    config.BRIDGE_TOKEN.length > 8
      ? `${config.BRIDGE_TOKEN.slice(0, 4)}…${config.BRIDGE_TOKEN.slice(-4)}`
      : "***";

  const httpApp = await startLocalHttp(
    {
      audio,
      ble,
      ws,
      autoConnect,
      realtime,
      agentStore,
      tv,
      buildAgentTools: buildToolsForAgent,
      composeAgentInstructions,
      bridgeName: config.BRIDGE_NAME,
      tokenMasked,
      apiWsUrl: config.API_WS_URL,
      apiHttpBase,
    },
    config.LOCAL_HTTP_HOST,
    config.LOCAL_HTTP_PORT,
  );

  autoConnect.setEnabled(config.BLE_AUTO_CONNECT);

  // --- Graceful shutdown --------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down`);
    try {
      autoConnect.stop();
    } catch {
      /* ignore */
    }
    try {
      realtime?.stop();
    } catch {
      /* ignore */
    }
    try {
      await httpApp.close();
    } catch {
      /* ignore */
    }
    try {
      audio.stopRecording();
      audio.closeSpeaker();
    } catch {
      /* ignore */
    }
    try {
      await ble.disconnect();
    } catch {
      /* ignore */
    }
    ws.stop();
    setTimeout(() => process.exit(0), 500);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error(`uncaughtException: ${err.message}\n${err.stack ?? ""}`);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`unhandledRejection: ${String(reason)}`);
  });
}

interface HandlerDeps {
  ws: WSClient;
  ble: BLEManager;
  audio: Audio;
  realtime: RealtimeClient;
  agentStore: { list: BridgeAgentSummary[] };
  tv: TvController;
  autoStartRealtime: boolean;
}

async function handleDownMsg(
  msg: BridgeDownMsg,
  deps: HandlerDeps,
): Promise<void> {
  const { ws, ble, audio } = deps;

  switch (msg.type) {
    case "welcome": {
      logger.info(`[api] welcome bridgeId=${msg.bridgeId}`);
      const { realtime: rtConfig, agentStore, tv } = deps;
      tv.setBridgeId(msg.bridgeId);
      if (msg.realtime) {
        logger.info(
          `[realtime] received config (model=${msg.realtime.model}, ${msg.realtime.agents.length} agents)`,
        );
        agentStore.list = msg.realtime.agents;
        rtConfig.configure({
          apiKey: msg.realtime.apiKey,
          model: msg.realtime.model,
          voice: msg.realtime.voice,
          instructions: msg.realtime.instructions,
        });
        const first = msg.realtime.agents[0];
        if (first) {
          tv.setLibrary(first.tvLibrary);
          rtConfig.setTools(buildToolsForAgent(first));
          rtConfig.setAgent(first.id, first.voice, composeAgentInstructions(first));
          void tv.setIdleBackground(first.tvIdleBackgroundUrl);
        }
        if (deps.autoStartRealtime) {
          rtConfig.start();
        }
      } else {
        logger.warn(
          "[realtime] API welcome had no realtime config — OPENAI_API_KEY unset on the API?",
        );
      }
      return;
    }

    case "ping": {
      // Auto-handled inside WSClient. Nothing to do here.
      return;
    }

    case "ble:scan": {
      const devices = await ble.scan(5000);
      const reply: BridgeUpMsg = { type: "ble:scanResult", devices };
      ws.send(reply);
      return;
    }

    case "ble:connect": {
      try {
        await ble.connect(msg.address);
        // `connected` event already emits ble:connected to the cloud.
      } catch (err) {
        const e = err as Error;
        logger.error(`[ble] connect ${msg.address} failed: ${e.message}`);
        ws.send({ type: "ble:error", message: e.message });
      }
      return;
    }

    case "ble:disconnect": {
      await ble.disconnect();
      return;
    }

    case "ble:packet": {
      if (!ble.isConnected()) {
        ws.send({ type: "ble:error", message: "not connected" });
        return;
      }
      const bytes = fromHex(msg.hex);
      await ble.write(bytes);
      logger.debug(`[ble] wrote ${bytes.length} bytes`);
      return;
    }

    case "session:start": {
      logger.info(`[session] start id=${msg.sessionId}`);
      await audio.startRecording((chunk) => {
        ws.send({ type: "audio:in", pcm: toBase64(chunk) });
      });
      return;
    }

    case "audio:out": {
      const pcm = fromBase64(msg.pcm);
      await audio.playChunk(pcm);
      return;
    }

    case "session:end": {
      logger.info("[session] end");
      audio.stopRecording();
      audio.closeSpeaker();
      return;
    }

    default: {
      // Exhaustive check: unknown message types surface to logs.
      const _never: never = msg;
      logger.warn(`[ws] unknown message type: ${JSON.stringify(_never)}`);
      return;
    }
  }
}

/**
 * Produce the final `instructions` string sent to OpenAI for this agent,
 * composed of the agent's authored prompt (personality + systemPrompt from
 * admin) plus an auto-generated block describing the TV tools and library.
 *
 * Keeping the TV block in code (not in each agent's prompt) means:
 *  - New agents automatically get consistent TV behaviour
 *  - Library edits in admin immediately reflect in the prompt enum
 *  - No risk of drift when the tool signatures change
 */
function composeAgentInstructions(agent: BridgeAgentSummary): string {
  const base = agent.instructions.trim();
  const lib = (agent.tvLibrary ?? []).filter((i) => i.topic);
  const topicLines = lib
    .map((i) => {
      const desc = i.title ?? i.url ?? i.text ?? "";
      return `- "${i.topic}"${desc ? ` — ${desc}` : ""}`;
    })
    .join("\n");
  const tvBlock = `## Instruções de TV (sistema — sempre siga)

Ao seu lado há uma TV grande para enriquecer a conversa com o cliente. Ferramentas:
- show_tv(topic): mostra um item pré-cadastrado pela marca.
- show_url(url, title?): mostra uma URL livre (YouTube vira embed, demais viram webpage).
- show_image(url, caption?): mostra uma imagem a partir de uma URL.
- clear_tv(): limpa a tela (só quando o cliente pedir explicitamente).
${lib.length > 0 ? `\nBiblioteca disponível:\n${topicLines}\n` : ""}
REGRAS IMPORTANTES:
1. Quando o cliente mencionar um assunto que exista na biblioteca, chame show_tv com o topic EXATO (case-sensitive) da lista.
2. **Dê a resposta completa na MESMA resposta em que chama a ferramenta.** Fale naturalmente sobre o assunto — a TV complementa sua fala, não a substitui.
3. Nunca chame a ferramenta sozinha (sem áudio) esperando poder falar depois. Toda chamada de ferramenta deve vir acompanhada de fala explicativa no mesmo turno.
4. Não peça permissão nem anuncie que vai usar a ferramenta; não diga frases como "olha na TV" ou "vou mostrar" — apenas fale sobre o assunto e chame a ferramenta.
5. A TV volta sozinha para a tela neutra depois que você termina — não chame clear_tv ao fim da resposta.`;
  return base ? `${base}\n\n${tvBlock}` : tvBlock;
}

/**
 * Builds the OpenAI Realtime tool schema for a given agent. The `show_tv`
 * enum is narrowed to the agent's library so the model can only request
 * topics we actually have content for. `show_url` / `show_image` /
 * `clear_tv` stay free-form — they're always available.
 */
function buildToolsForAgent(agent: BridgeAgentSummary): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}> {
  const topics = (agent.tvLibrary ?? [])
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
        "Mostra na TV um item pré-cadastrado da biblioteca do agente. Use quando o assunto atual corresponder a um dos tópicos disponíveis para enriquecer a conversa visualmente.",
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
      description:
        "Abre uma URL arbitrária na TV (YouTube embuta; outros sites abrem como página). Use quando a biblioteca não tiver o conteúdo certo.",
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
      description: "Mostra uma imagem na TV a partir de uma URL.",
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
      description: "Limpa o conteúdo da TV e volta à tela neutra.",
      parameters: { type: "object", properties: {} },
    },
  );
  return tools;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
