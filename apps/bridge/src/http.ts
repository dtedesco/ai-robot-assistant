/**
 * Local HTTP/Admin UI for the bridge daemon.
 *
 * Simplified: only BLE control endpoints.
 * Audio and OpenAI Realtime are handled in the browser (RealtimeDisplay).
 */
import { utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildActionPacket,
  buildColorPacket,
  buildMovePacket,
  buildStopPacket,
} from "@robot/protocol";
import type { BLEAutoConnect } from "./auto-connect.js";
import type { BLEManager } from "./ble-manager.js";
import { BRIDGE_VERSION } from "./config.js";
import { logger } from "./logger.js";
import type { WSClient } from "./ws-client.js";

export interface LocalHttpDeps {
  ble: BLEManager;
  ws: WSClient;
  autoConnect: BLEAutoConnect;
  bridgeName: string;
  tokenMasked: string;
  apiWsUrl: string;
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

const AutoBody = z.object({ enabled: z.boolean() });

function errPayload(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

export async function buildLocalHttp(deps: LocalHttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(here, "..", "public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" });

  // Serve admin.html at /admin without extension
  app.get("/admin", async (_req, reply) => {
    return reply.sendFile("admin.html");
  });

  // --- Status endpoint -----------------------------------------------------
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
  }));

  // --- Restart endpoint ----------------------------------------------------
  app.post("/api/admin/restart", async (_req, reply) => {
    reply.send({ ok: true });
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

  // --- BLE endpoints -------------------------------------------------------
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

  // --- Robot command endpoint ----------------------------------------------
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

  return app;
}

export async function startLocalHttp(
  deps: LocalHttpDeps,
  host: string,
  port: number,
): Promise<FastifyInstance> {
  const app = await buildLocalHttp(deps);
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
