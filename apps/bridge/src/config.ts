import { z } from "zod";
import os from "node:os";

const ConfigSchema = z.object({
  API_WS_URL: z.string().url(),
  BRIDGE_TOKEN: z.string().min(1),
  BRIDGE_NAME: z.string().min(1).default(os.hostname()),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOCAL_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  LOCAL_HTTP_PORT: z.coerce.number().int().positive().default(3100),
  BLE_AUTO_CONNECT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  BLE_AUTO_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  REALTIME_AUTO_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Software gain applied to mic PCM before sending to OpenAI (linear factor).
   *  4.0 ≈ +12dB. Raise if your mic/device captures at low levels (peak < 0.15). */
  MIC_GAIN: z.coerce.number().positive().default(4.0),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    API_WS_URL: process.env.API_WS_URL,
    BRIDGE_TOKEN: process.env.BRIDGE_TOKEN,
    BRIDGE_NAME: process.env.BRIDGE_NAME,
    LOG_LEVEL: process.env.LOG_LEVEL,
    LOCAL_HTTP_HOST: process.env.LOCAL_HTTP_HOST,
    LOCAL_HTTP_PORT: process.env.LOCAL_HTTP_PORT,
    BLE_AUTO_CONNECT: process.env.BLE_AUTO_CONNECT,
    BLE_AUTO_INTERVAL_MS: process.env.BLE_AUTO_INTERVAL_MS,
    REALTIME_AUTO_START: process.env.REALTIME_AUTO_START,
    MIC_GAIN: process.env.MIC_GAIN,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid bridge config:\n${issues}`);
    process.exit(1);
  }

  return parsed.data;
}

export const BRIDGE_VERSION = "0.1.0";
