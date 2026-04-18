/**
 * Local HTTP/Admin UI for the bridge daemon.
 *
 * Bound to 127.0.0.1 by default so it's only reachable from the same machine
 * (override with LOCAL_HTTP_HOST=0.0.0.0 to expose on the LAN — useful for a
 * headless Raspberry Pi). No auth — localhost-only trust boundary.
 */
import { utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildActionPacket,
  buildColorPacket,
  buildMovePacket,
  buildStopPacket,
} from "@robot/protocol";
import type { BridgeAgentSummary } from "@robot/shared";
import type { Audio } from "./audio.js";
import type { BLEAutoConnect } from "./auto-connect.js";
import type { BLEManager } from "./ble-manager.js";
import { BRIDGE_VERSION } from "./config.js";
import { logger } from "./logger.js";
import type { RealtimeClient, RealtimeTool } from "./realtime.js";
import type { TvController } from "./tv-controller.js";
import type { WSClient } from "./ws-client.js";

export interface LocalHttpDeps {
  audio: Audio;
  ble: BLEManager;
  ws: WSClient;
  autoConnect: BLEAutoConnect;
  realtime: RealtimeClient;
  agentStore: { list: BridgeAgentSummary[] };
  tv: TvController;
  /** Rebuilds the OpenAI tool schema for the given agent (topics enum etc.). */
  buildAgentTools: (agent: BridgeAgentSummary) => RealtimeTool[];
  /** Composes the `instructions` string (authored + auto-generated TV block). */
  composeAgentInstructions: (agent: BridgeAgentSummary) => string;
  bridgeName: string;
  tokenMasked: string;
  apiWsUrl: string;
  apiHttpBase: string;
}

const ScanBody = z.object({ durationMs: z.number().int().positive().max(20_000).optional() });
const ConnectBody = z.object({ address: z.string().min(1) });

const CommandBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    direction: z.enum(["up", "down", "left", "right"]),
    speedLevel: z.number().int().min(0).max(3).optional(),
    color: z.number().int().min(1).max(7).optional(),
  }),
  z.object({
    type: z.literal("action"),
    action: z.number().int().min(1).max(255),
    speedLevel: z.number().int().min(0).max(3).optional(),
    color: z.number().int().min(1).max(7).optional(),
  }),
  z.object({ type: z.literal("color"), color: z.number().int().min(1).max(7) }),
  z.object({ type: z.literal("stop") }),
]);

const ToneBody = z.object({
  frequencyHz: z.number().positive().max(8000).optional(),
  durationMs: z.number().int().positive().max(5000).optional(),
});

const MicBody = z.object({
  durationMs: z.number().int().positive().max(10_000).optional(),
});

const AutoBody = z.object({ enabled: z.boolean() });

const SelectAgentBody = z.object({ agentId: z.string().min(1) });

function errPayload(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

export async function buildLocalHttp(deps: LocalHttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const here = dirname(fileURLToPath(import.meta.url));
  // In dev (tsx): here = apps/bridge/src → public is ../public
  // In build (tsc out): here = apps/bridge/dist → public is ../public
  const publicDir = resolve(here, "..", "public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" });
  await app.register(fastifyWebsocket);

  // --- Browser audio output stream ----------------------------------------
  // The bridge forwards realtime response PCM to connected browser tabs,
  // which play via Web Audio API at native 24kHz. This replaces local
  // sox/play because CoreAudio on-the-fly resampling was causing clicks.
  type AudioWsClient = { send: (data: string | Buffer) => void };
  const audioClients = new Set<AudioWsClient>();

  deps.audio.on("outChunk", (pcm: Buffer) => {
    if (audioClients.size === 0) return;
    // Send raw bytes — lower overhead than base64 JSON.
    for (const client of audioClients) {
      try { client.send(pcm); } catch { /* socket likely closed */ }
    }
  });
  deps.audio.on("outEnd", () => {
    if (audioClients.size === 0) return;
    for (const client of audioClients) {
      try { client.send(JSON.stringify({ type: "end" })); } catch { /* ignore */ }
    }
  });
  deps.audio.on("outReset", () => {
    if (audioClients.size === 0) return;
    for (const client of audioClients) {
      try { client.send(JSON.stringify({ type: "reset" })); } catch { /* ignore */ }
    }
  });

  app.get("/ws/audio", { websocket: true }, (socket) => {
    const client: AudioWsClient = { send: (data) => socket.send(data) };
    audioClients.add(client);
    logger.info(`[ws] /ws/audio client connected (total=${audioClients.size})`);

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Binary frame from browser = mic PCM16 chunk. Forward to OpenAI.
        deps.realtime.ingestMicChunk(raw);
        return;
      }
      // Text frames are control messages from the browser.
      try {
        const msg = JSON.parse(raw.toString("utf8")) as { type?: string };
        if (msg.type === "idle") {
          // Browser's Web Audio queue drained — actual playback ended.
          deps.audio.emit("playbackIdle");
        }
      } catch {
        /* ignore non-JSON */
      }
    });

    socket.on("close", () => {
      audioClients.delete(client);
      logger.info(`[ws] /ws/audio client disconnected (total=${audioClients.size})`);
    });
    socket.on("error", () => audioClients.delete(client));
  });

  app.get("/api/status", () => ({
    bridge: {
      name: deps.bridgeName,
      version: BRIDGE_VERSION,
      token: deps.tokenMasked,
    },
    ws: {
      url: deps.apiWsUrl,
      connected: deps.ws.isOpen(),
    },
    ble: {
      connected: deps.ble.isConnected(),
    },
    autoConnect: deps.autoConnect.status(),
    realtime: deps.realtime.status(),
    audio: {
      recording: deps.audio.isRecording(),
    },
  }));

  app.post("/api/realtime/start", async (_req, reply) => {
    if (!deps.realtime.isConfigured()) {
      return reply.status(409).send({
        error: "Realtime not configured — API cloud did not push OpenAI key (is OPENAI_API_KEY set on the API?)",
      });
    }
    deps.realtime.start();
    return deps.realtime.status();
  });

  app.post("/api/realtime/stop", async (_req, reply) => {
    deps.realtime.stop();
    return reply.send(deps.realtime.status());
  });

  app.get("/api/agents", () => {
    return {
      currentAgentId: deps.realtime.getCurrentAgentId(),
      agents: deps.agentStore.list.map((a) => ({
        id: a.id,
        name: a.name,
        voice: a.voice,
      })),
    };
  });

  app.post("/api/admin/restart", async (_req, reply) => {
    reply.send({ ok: true });
    // Only restart the bridge process — touches a watched source so tsx-watch
    // respawns. The cloud API (:3000) is NOT touched. In prod the fallback
    // process.exit lets a supervisor respawn.
    setTimeout(async () => {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        const target = resolve(here, "index.ts");
        const now = new Date();
        await utimes(target, now, now);
        logger.info("[http] bridge restart triggered via source-file touch");
      } catch (err) {
        logger.warn(`[http] bridge restart touch failed: ${(err as Error).message}`);
      }
      setTimeout(() => {
        logger.info("[http] bridge restart: process.exit fallback");
        process.exit(0);
      }, 1000);
    }, 100);
    return reply;
  });

  app.post("/api/realtime/agent", async (req, reply) => {
    const { agentId } = SelectAgentBody.parse(req.body);
    const agent = deps.agentStore.list.find((a) => a.id === agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    deps.tv.setLibrary(agent.tvLibrary);
    deps.realtime.setTools(deps.buildAgentTools(agent));
    deps.realtime.setAgent(
      agent.id,
      agent.voice,
      deps.composeAgentInstructions(agent),
    );
    void deps.tv.setIdleBackground(agent.tvIdleBackgroundUrl);
    return deps.realtime.status();
  });

  // --- TV control ---------------------------------------------------------

  app.get("/api/tv", () => {
    const state = deps.tv.getState();
    const bridgeId = deps.tv.getBridgeId();
    // Convention: web admin runs on :5173 in dev, same host as API.
    const webBase = deps.apiHttpBase.replace(/:\d+$/, ":5173");
    return {
      ...state,
      bridgeId,
      displayUrl: bridgeId ? `${webBase}/tv/bridge/${bridgeId}` : null,
    };
  });

  app.post<{ Body: { topic: string } }>("/api/tv/show-topic", async (req, reply) => {
    const topic = String((req.body ?? {}).topic ?? "");
    if (!topic) return reply.status(400).send({ error: "topic required" });
    const r = await deps.tv.showTopic(topic);
    return reply.status(r.ok ? 200 : 502).send(r);
  });

  app.post<{ Body: { url: string; title?: string } }>("/api/tv/show-url", async (req, reply) => {
    const url = String((req.body ?? {}).url ?? "");
    if (!url) return reply.status(400).send({ error: "url required" });
    const title = typeof (req.body as { title?: unknown })?.title === "string"
      ? (req.body as { title: string }).title
      : undefined;
    const r = await deps.tv.showUrl(url, title);
    return reply.status(r.ok ? 200 : 502).send(r);
  });

  app.post("/api/tv/clear", async (_req, reply) => {
    const r = await deps.tv.clear();
    return reply.status(r.ok ? 200 : 502).send(r);
  });

  app.post("/api/ble/auto", async (req, reply) => {
    const body = AutoBody.parse(req.body);
    try {
      deps.autoConnect.setEnabled(body.enabled);
      return deps.autoConnect.status();
    } catch (err) {
      return reply.status(500).send(errPayload(err));
    }
  });

  app.post("/api/ble/scan", async (req, reply) => {
    const body = ScanBody.parse(req.body ?? {});
    try {
      const devices = await deps.ble.scan(body.durationMs ?? 5000);
      return { devices };
    } catch (err) {
      return reply.status(500).send(errPayload(err));
    }
  });

  app.post("/api/ble/connect", async (req, reply) => {
    const body = ConnectBody.parse(req.body ?? {});
    try {
      await deps.ble.connect(body.address);
      return { ok: true as const };
    } catch (err) {
      return reply.status(500).send(errPayload(err));
    }
  });

  app.post("/api/ble/disconnect", async (_req, reply) => {
    try {
      await deps.ble.disconnect();
      return { ok: true as const };
    } catch (err) {
      return reply.status(500).send(errPayload(err));
    }
  });

  app.post("/api/robot/command", async (req, reply) => {
    if (!deps.ble.isConnected()) {
      return reply.status(409).send({ error: "BLE not connected" });
    }
    const cmd = CommandBody.parse(req.body);
    try {
      let packet: Uint8Array;
      switch (cmd.type) {
        case "move":
          packet = buildMovePacket(cmd.direction, cmd.speedLevel ?? 0, cmd.color ?? 2);
          break;
        case "action":
          packet = buildActionPacket({
            action: cmd.action,
            speedLevel: cmd.speedLevel ?? 0,
            color: cmd.color ?? 2,
          });
          break;
        case "color":
          packet = buildColorPacket(cmd.color);
          break;
        case "stop":
          packet = buildStopPacket();
          break;
      }
      await deps.ble.write(packet);
      return { ok: true as const, bytes: packet.length };
    } catch (err) {
      return reply.status(500).send(errPayload(err));
    }
  });

  app.post("/api/audio/tone", async (req, reply) => {
    const body = ToneBody.parse(req.body ?? {});
    try {
      await deps.audio.playTone(body.frequencyHz ?? 440, body.durationMs ?? 800);
      return { ok: true as const };
    } catch (err) {
      return reply.status(500).send(errPayload(err));
    }
  });

  app.post("/api/audio/mic", async (req, reply) => {
    const body = MicBody.parse(req.body ?? {});
    try {
      const result = await deps.audio.recordOnce(body.durationMs ?? 2000);
      if (!result) {
        return reply.status(500).send({ error: "mic unavailable" });
      }
      return result;
    } catch (err) {
      return reply.status(500).send(errPayload(err));
    }
  });

  return app;
}

export async function startLocalHttp(
  deps: LocalHttpDeps,
  host: string,
  port: number,
): Promise<FastifyInstance> {
  const app = await buildLocalHttp(deps);
  // Retry listen on EADDRINUSE — tsx-watch restarts spawn the new process
  // before the old one has fully released the TCP listen socket (the
  // graceful shutdown takes ~500ms). Without this retry, the new bridge
  // dies on startup and the user has to re-run `pnpm dev`.
  const MAX_RETRIES = 15;
  const RETRY_MS = 300;
  for (let attempt = 1; ; attempt++) {
    try {
      await app.listen({ host, port });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt >= MAX_RETRIES) throw err;
      logger.warn(
        `[http] port ${port} busy (EADDRINUSE), retrying in ${RETRY_MS}ms (${attempt}/${MAX_RETRIES})`,
      );
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  logger.info(`[http] local UI listening on http://${host}:${port}`);
  return app;
}
