import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { TvContent } from "@robot/shared";
import { prisma } from "../db.js";
import type { TvHub } from "../services/tv-hub.js";
import { registerPendingPerson } from "../ws/bridge-tv.js";

const TvContentSchema: z.ZodType<TvContent> = z.union([
  z.object({ kind: z.literal("youtube"), url: z.string().min(1), title: z.string().optional() }),
  z.object({ kind: z.literal("image"), url: z.string().min(1), caption: z.string().optional() }),
  z.object({ kind: z.literal("webpage"), url: z.string().min(1) }),
  z.object({ kind: z.literal("text"), text: z.string().min(1) }),
]);

const DisplayBody = z.object({ content: TvContentSchema });

const IdleConfigBody = z.object({
  backgroundUrl: z.string().url().nullable(),
});

/**
 * Bridge-auth REST for TV display control.
 *
 * The bridge uses its own token (same as WS auth) in `x-bridge-token`. It
 * must match the bridge identified by the path param. No JWT flow needed —
 * this is a machine-to-machine endpoint.
 */
export function bridgeTvRoutes(hub: TvHub): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.addHook("onRequest", async (req, reply) => {
      const token = req.headers["x-bridge-token"];
      if (!token || typeof token !== "string") {
        return reply.status(401).send({ error: "missing x-bridge-token" });
      }
      const params = req.params as { bridgeId?: string };
      if (!params.bridgeId) {
        return reply.status(400).send({ error: "bridgeId required" });
      }
      const bridge = await prisma.bridge.findUnique({ where: { token } });
      if (!bridge || bridge.id !== params.bridgeId) {
        return reply.status(403).send({ error: "invalid bridge credentials" });
      }
    });

    app.post<{ Params: { bridgeId: string }; Body: unknown }>(
      "/bridge/:bridgeId/tv/display",
      async (req, reply) => {
        const { content } = DisplayBody.parse(req.body);
        const subs = hub.publish(req.params.bridgeId, { type: "display", content });
        return reply.send({ ok: true, subscribers: subs });
      },
    );

    app.post<{ Params: { bridgeId: string } }>(
      "/bridge/:bridgeId/tv/clear",
      async (req, reply) => {
        const subs = hub.publish(req.params.bridgeId, { type: "clear" });
        return reply.send({ ok: true, subscribers: subs });
      },
    );

    app.get<{ Params: { bridgeId: string } }>(
      "/bridge/:bridgeId/tv/current",
      async (req, reply) => {
        const current = hub.currentContent(req.params.bridgeId);
        return reply.send({ current, subscribers: hub.subscriberCount(req.params.bridgeId) });
      },
    );

    app.post<{ Params: { bridgeId: string }; Body: unknown }>(
      "/bridge/:bridgeId/tv/idle-config",
      async (req, reply) => {
        const { backgroundUrl } = IdleConfigBody.parse(req.body);
        const subs = hub.publish(req.params.bridgeId, {
          type: "idle-config",
          backgroundUrl,
        });
        return reply.send({ ok: true, subscribers: subs });
      },
    );

    // Register a new person with the pending face descriptor
    const RegisterPersonBody = z.object({
      name: z.string().min(1).max(100),
    });

    app.post<{ Params: { bridgeId: string }; Body: unknown }>(
      "/bridge/:bridgeId/register-person",
      async (req, reply) => {
        const { name } = RegisterPersonBody.parse(req.body);
        const result = await registerPendingPerson(req.params.bridgeId, name);

        if (!result) {
          return reply.status(400).send({
            error: "NoPendingDescriptor",
            message: "No pending face descriptor for this bridge. Face must be detected first.",
          });
        }

        // Notify TV that person was registered
        hub.publish(req.params.bridgeId, {
          type: "face:registered",
          personId: result.id,
          name: result.name,
        });

        return reply.status(201).send(result);
      },
    );
  };
}
