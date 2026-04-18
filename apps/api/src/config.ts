import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_MODEL: z
    .string()
    .default("gpt-4o-realtime-preview"),
  OPENAI_VOICE: z.string().default("shimmer"),
  BRIDGE_REALTIME_INSTRUCTIONS: z
    .string()
    .default(
      "Você é Robert, um robô amigo muito simpático, divertido e curioso. Fale em português brasileiro de forma natural, animada e conversacional. Respostas curtas e diretas.",
    ),
  ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  ADMIN_PASSWORD: z.string().min(1).default("change-me"),
  PUBLIC_BASE_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default("*"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadConfig(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Build a public TV URL for a given session. */
export function buildTvUrl(sessionId: string): string {
  const cfg = loadConfig();
  const base = cfg.PUBLIC_BASE_URL ?? `http://localhost:${cfg.PORT}`;
  return `${base.replace(/\/$/, "")}/tv/${sessionId}`;
}
