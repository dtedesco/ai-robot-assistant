/**
 * Minimal leveled logger. Intentionally dependency-free so the daemon stays
 * small. Swap for pino/winston later if needed.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

function ts(): string {
  return new Date().toISOString();
}

function log(level: Level, msg: string): void {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} [${level.toUpperCase()}] ${msg}`;
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
