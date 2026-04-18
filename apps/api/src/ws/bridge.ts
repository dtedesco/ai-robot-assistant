import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type {
  BridgeDownMsg,
  BridgeRealtimeConfig,
  BridgeUpMsg,
  OpenAIVoice,
  SessionEvent,
} from "@robot/shared";
import { loadConfig } from "../config.js";
import { prisma } from "../db.js";
import type { SessionHub } from "../services/session-hub.js";

async function buildRealtimeWelcome(): Promise<BridgeRealtimeConfig | undefined> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) return undefined;

  const agents = await prisma.agent.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      voice: true,
      personality: true,
      systemPrompt: true,
      greeting: true,
      tvLibrary: true,
      tvIdleBackgroundUrl: true,
    },
  });

  return {
    apiKey: cfg.OPENAI_API_KEY,
    model: cfg.OPENAI_REALTIME_MODEL,
    voice: cfg.OPENAI_VOICE as OpenAIVoice,
    instructions: cfg.BRIDGE_REALTIME_INSTRUCTIONS,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      voice: a.voice as OpenAIVoice,
      instructions: combineInstructions(a.personality, a.systemPrompt),
      greeting: a.greeting,
      tvLibrary: normalizeTvLibrary(a.tvLibrary),
      tvIdleBackgroundUrl: a.tvIdleBackgroundUrl ?? null,
    })),
  };
}

function normalizeTvLibrary(raw: unknown): Array<{
  topic: string;
  kind: "youtube" | "image" | "webpage" | "text";
  url?: string;
  text?: string;
  title?: string;
}> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => x != null && typeof x === "object")
    .map((x) => ({
      topic: String(x.topic ?? ""),
      kind: (x.kind === "image" || x.kind === "webpage" || x.kind === "text"
        ? x.kind
        : "youtube") as "youtube" | "image" | "webpage" | "text",
      url: typeof x.url === "string" ? x.url : undefined,
      text: typeof x.text === "string" ? x.text : undefined,
      title: typeof x.title === "string" ? x.title : undefined,
    }))
    .filter((x) => x.topic);
}

function combineInstructions(personality: string, systemPrompt: string): string {
  const p = personality.trim();
  const s = systemPrompt.trim();
  if (!p) return s;
  if (!s) return p;
  return `Personalidade:\n${p}\n\n${s}`;
}

function send(socket: WebSocket, msg: BridgeDownMsg): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* socket may already be closed */
  }
}

function parseMsg(raw: string): BridgeUpMsg | null {
  try {
    const obj = JSON.parse(raw) as BridgeUpMsg;
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

/** Extract token from query string (?token=...) or `x-bridge-token` header. */
function extractToken(req: FastifyRequest): string | null {
  const q = (req.query ?? {}) as Record<string, unknown>;
  if (typeof q.token === "string" && q.token) return q.token;
  const header = req.headers["x-bridge-token"];
  if (typeof header === "string" && header) return header;
  return null;
}

export function registerBridgeWs(
  app: FastifyInstance,
  hub: SessionHub,
): void {
  app.get("/ws/bridge", { websocket: true }, async (socket, req) => {
    const token = extractToken(req);
    if (!token) {
      send(socket, {
        type: "welcome",
        bridgeId: "",
      });
      socket.close(4401, "missing token");
      return;
    }
    const bridge = await prisma.bridge.findUnique({ where: { token } });
    if (!bridge) {
      socket.close(4403, "invalid token");
      return;
    }

    const bridgeId = bridge.id;
    // Tracks whether this socket is the currently-registered one for this
    // bridge. If a newer connection evicts us, we skip `unregisterBridge` on
    // close (otherwise we'd remove the new connection's registration).
    let active = true;

    // Register this socket on the hub. Only one connection per bridge at a
    // time: registerBridge kicks out the old one.
    hub.registerBridge({
      bridgeId,
      send: (msg) => send(socket, msg),
      close: () => {
        active = false;
        try {
          socket.close();
        } catch {
          /* noop */
        }
      },
    });

    // Mark bridge online.
    await prisma.bridge.update({
      where: { id: bridgeId },
      data: { status: "online", lastSeenAt: new Date() },
    });

    send(socket, {
      type: "welcome",
      bridgeId,
      realtime: await buildRealtimeWelcome(),
    });

    // Heartbeat: send ping every 30s.
    const ping = setInterval(() => {
      send(socket, { type: "ping" });
    }, 30_000);

    socket.on("message", async (raw) => {
      const msg = parseMsg(raw.toString());
      if (!msg) return;

      // Keep lastSeenAt fresh on any traffic. Throttled: update at most every
      // 10s via a quick in-memory check would be nicer, but simpler is fine.
      prisma.bridge
        .update({
          where: { id: bridgeId },
          data: { lastSeenAt: new Date() },
        })
        .catch(() => {});

      // Resolve any pending request/response promises waiting for this kind of
      // reply (e.g. /api/bridges/:id/scan, /api/bridges/:id/connect-ble).
      hub.deliverBridgeMessage(bridgeId, msg);

      switch (msg.type) {
        case "hello":
          // Already authenticated via token in URL; hello is informational.
          break;
        case "audio:in": {
          // Find an active session for this bridge and forward audio.
          const sessionId = hub.findSessionIdByBridge(bridgeId);
          if (sessionId) hub.forwardAudioIn(sessionId, msg.pcm);
          break;
        }
        case "ble:scanResult":
        case "ble:connected":
        case "ble:disconnected":
        case "ble:error": {
          // Turn into a generic session error event for admin visibility, if a
          // session is active. Otherwise drop quietly.
          const sessionId = hub.findSessionIdByBridge(bridgeId);
          if (!sessionId) break;
          let event: SessionEvent | null = null;
          if (msg.type === "ble:error") {
            event = { type: "error", message: `ble: ${msg.message}` };
          } else if (msg.type === "ble:disconnected") {
            event = {
              type: "error",
              message: `ble disconnected${msg.reason ? `: ${msg.reason}` : ""}`,
            };
          }
          if (event) hub.publishEvent(sessionId, event);
          break;
        }
        case "pong":
          break;
        default:
          // unknown type — ignore for forward compat
          break;
      }
    });

    socket.on("close", async () => {
      clearInterval(ping);
      if (active) {
        hub.unregisterBridge(bridgeId);
        await prisma.bridge
          .update({
            where: { id: bridgeId },
            data: { status: "offline", lastSeenAt: new Date() },
          })
          .catch(() => {});
      }
    });
  });
}

