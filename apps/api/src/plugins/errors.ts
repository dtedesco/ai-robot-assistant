import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";

const errorsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "ValidationError",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const e = err as { statusCode?: number; name?: string; message?: string };
    const statusCode =
      typeof e.statusCode === "number" && e.statusCode >= 400
        ? e.statusCode
        : 500;
    req.log.error({ err }, "Request failed");
    return reply.status(statusCode).send({
      error: e.name ?? "InternalServerError",
      message: e.message ?? "Unexpected error",
    });
  });
};

export default fp(errorsPlugin, { name: "errors" });
