import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { BridgeDownMsg, BridgeUpMsg } from "@robot/shared";
import { BRIDGE_VERSION } from "./config.js";
import { logger } from "./logger.js";

export interface WSClientOptions {
  url: string;
  token: string;
  /** Initial reconnect delay in ms. */
  initialBackoffMs?: number;
  /** Max reconnect delay in ms. */
  maxBackoffMs?: number;
}

export type WSClientEvents = {
  message: [msg: BridgeDownMsg];
  open: [];
  close: [code: number, reason: string];
  error: [err: Error];
};

/**
 * Persistent WebSocket client for the bridge ↔ API link.
 *
 * - Appends `?token=` on the URL and also sends a `hello` on open.
 * - Auto-reconnects with exponential backoff capped at `maxBackoffMs`.
 * - Responds to `ping` with `pong` automatically.
 * - Surfaces every other `BridgeDownMsg` via the `message` event.
 */
export class WSClient extends EventEmitter {
  private readonly url: string;
  private readonly token: string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private currentBackoffMs: number;
  private closedByUser = false;

  constructor(opts: WSClientOptions) {
    super();
    this.url = opts.url;
    this.token = opts.token;
    this.initialBackoffMs = opts.initialBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.currentBackoffMs = this.initialBackoffMs;
  }

  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "client shutting down");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Sends a typed Bridge→API message. Silently drops when socket is not open. */
  send(msg: BridgeUpMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`[ws] drop send, socket not open (type=${msg.type})`);
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      logger.error(`[ws] send error: ${(err as Error).message}`);
      return false;
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private buildUrl(): string {
    const sep = this.url.includes("?") ? "&" : "?";
    return `${this.url}${sep}token=${encodeURIComponent(this.token)}`;
  }

  private connect(): void {
    const fullUrl = this.buildUrl();
    logger.info(`[ws] connecting ${this.redactUrl(fullUrl)}`);

    const ws = new WebSocket(fullUrl);
    this.ws = ws;

    ws.on("open", () => {
      logger.info("[ws] connected");
      this.currentBackoffMs = this.initialBackoffMs;
      const hello: BridgeUpMsg = {
        type: "hello",
        token: this.token,
        version: BRIDGE_VERSION,
      };
      ws.send(JSON.stringify(hello));
      this.emit("open");
    });

    ws.on("message", (data) => {
      let parsed: BridgeDownMsg;
      try {
        parsed = JSON.parse(data.toString("utf8")) as BridgeDownMsg;
      } catch (err) {
        logger.warn(`[ws] invalid JSON from server: ${(err as Error).message}`);
        return;
      }
      // Auto-handle ping so handlers don't need to care.
      if (parsed.type === "ping") {
        this.send({ type: "pong" });
        return;
      }
      this.emit("message", parsed);
    });

    ws.on("error", (err) => {
      logger.error(`[ws] error: ${err.message}`);
      this.emit("error", err);
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString("utf8");
      logger.warn(`[ws] closed code=${code} reason=${reason || "(none)"}`);
      this.emit("close", code, reason);
      this.ws = null;
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    const delay = this.currentBackoffMs;
    logger.info(`[ws] reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Exponential backoff, capped.
    this.currentBackoffMs = Math.min(
      this.currentBackoffMs * 2,
      this.maxBackoffMs,
    );
  }

  private redactUrl(url: string): string {
    return url.replace(/token=[^&]+/, "token=***");
  }
}
