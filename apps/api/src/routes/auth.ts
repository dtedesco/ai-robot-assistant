import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword, verifyPassword } from "../plugins/auth.js";
import { loadConfig } from "../config.js";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post("/auth/login", async (req, reply) => {
    const { email, password } = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return reply.status(401).send({ error: "InvalidCredentials" });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return reply.status(401).send({ error: "InvalidCredentials" });
    }
    const token = app.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: "7d" },
    );
    return { token, user: { id: user.id, email: user.email } };
  });

  /**
   * Idempotent bootstrap: creates the first admin using ADMIN_EMAIL /
   * ADMIN_PASSWORD env vars if the User table is empty. Safe to call any time.
   */
  app.post("/auth/bootstrap", async (_req, reply) => {
    const cfg = loadConfig();
    const count = await prisma.user.count();
    if (count > 0) {
      return reply.status(409).send({
        error: "AlreadyBootstrapped",
        message: "Admin user already exists",
      });
    }
    const passwordHash = await hashPassword(cfg.ADMIN_PASSWORD);
    const user = await prisma.user.create({
      data: { email: cfg.ADMIN_EMAIL, passwordHash },
    });
    return reply.status(201).send({
      id: user.id,
      email: user.email,
    });
  });
};
