import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { loadConfig } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

const authPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const cfg = loadConfig();

  await app.register(fastifyJwt, {
    secret: cfg.JWT_SECRET,
  });

  app.decorate("authenticate", async (req: FastifyRequest) => {
    await req.jwtVerify();
  });
};

export default fp(authPlugin, { name: "auth" });
