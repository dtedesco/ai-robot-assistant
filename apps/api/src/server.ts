import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import { loadConfig } from "./config.js";
import authPlugin from "./plugins/auth.js";
import errorsPlugin from "./plugins/errors.js";
import { authRoutes } from "./routes/auth.js";
import { agentRoutes } from "./routes/agents.js";
import { bridgeRoutes } from "./routes/bridges.js";
import { bridgeTvRoutes } from "./routes/bridge-tv.js";
import { sessionRoutes } from "./routes/sessions.js";
import { SessionHub } from "./services/session-hub.js";
import { TvHub } from "./services/tv-hub.js";
import { registerBridgeWs } from "./ws/bridge.js";
import { registerBridgeTvWs } from "./ws/bridge-tv.js";
import { registerAdminWs } from "./ws/admin.js";
import { registerTvWs } from "./ws/tv.js";

export async function buildServer() {
  const cfg = loadConfig();

  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await app.register(fastifyCors, {
    origin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(","),
    credentials: true,
  });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 4 * 1024 * 1024 },
  });
  await app.register(errorsPlugin);
  await app.register(authPlugin);

  // Shared in-memory coordinator for sessions / bridges.
  const hub = new SessionHub();
  // Independent pubsub for bridge-driven TV display (no session needed).
  const tvHub = new TvHub();

  // REST routes (prefix /api).
  await app.register(
    async (instance) => {
      await instance.register(authRoutes);
      await instance.register(agentRoutes);
      await instance.register(bridgeRoutes(hub));
      await instance.register(sessionRoutes(hub));
      await instance.register(bridgeTvRoutes(tvHub));
    },
    { prefix: "/api" },
  );

  // WebSocket endpoints (no /api prefix).
  registerBridgeWs(app, hub);
  registerAdminWs(app, hub);
  registerTvWs(app, hub);
  registerBridgeTvWs(app, tvHub);

  app.get("/healthz", async () => ({ ok: true }));

  /**
   * Dev restart endpoint: touching server.ts makes tsx-watch respawn the
   * API process. Localhost-only so anyone on the LAN can't kill us. In
   * prod (no tsx watch) the fallback process.exit lets a supervisor
   * respawn. Mirrors the bridge's /api/admin/restart pattern so the
   * local UI can cycle both processes with one click.
   */
  app.post("/api/admin/restart", async (req, reply) => {
    const ip = req.ip;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      return reply.status(403).send({ error: "localhost only" });
    }
    reply.send({ ok: true });
    setTimeout(async () => {
      try {
        const { utimes } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const { dirname, resolve } = await import("node:path");
        const here = dirname(fileURLToPath(import.meta.url));
        const target = resolve(here, "server.ts");
        const now = new Date();
        await utimes(target, now, now);
        app.log.info("[admin] restart triggered via source-file touch");
      } catch (err) {
        app.log.warn({ err }, "[admin] restart touch failed");
      }
      setTimeout(() => {
        app.log.info("[admin] restart: process.exit fallback");
        process.exit(0);
      }, 1000);
    }, 100);
    return reply;
  });

  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildServer();
  try {
    await app.listen({ host: cfg.HOST, port: cfg.PORT });
    app.log.info(`api listening on http://${cfg.HOST}:${cfg.PORT}`);
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Run when invoked directly (tsx / node). Safe to import buildServer for tests.
const isDirect = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return (
      entry.endsWith("server.ts") ||
      entry.endsWith("server.js") ||
      entry.endsWith("dist/server.js")
    );
  } catch {
    return false;
  }
})();

if (isDirect) {
  void main();
}
