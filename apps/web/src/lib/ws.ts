import { WS_URL } from "./api";
import { getToken } from "./auth";

export function wsUrl(path: string): string {
  const base = WS_URL.replace(/\/$/, "");
  if (path.startsWith("/")) return `${base}${path}`;
  return `${base}/${path}`;
}

export interface JsonWebSocketOptions {
  onOpen?: (ws: WebSocket) => void;
  onMessage?: (data: unknown, ws: WebSocket) => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: Event) => void;
  /**
   * If true, auto-reconnects with exponential backoff.
   */
  reconnect?: boolean;
  maxBackoffMs?: number;
}

export interface JsonWebSocketHandle {
  send(msg: unknown): void;
  close(): void;
  get readyState(): number;
}

/**
 * Minimal JSON WebSocket wrapper with optional reconnect.
 */
export function openJsonWs(
  url: string,
  opts: JsonWebSocketOptions = {},
): JsonWebSocketHandle {
  const {
    onOpen,
    onMessage,
    onClose,
    onError,
    reconnect = false,
    maxBackoffMs = 15_000,
  } = opts;

  let ws: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const sendQueue: string[] = [];

  function connect(): void {
    if (closed) return;
    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      attempts = 0;
      while (sendQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        const next = sendQueue.shift();
        if (next !== undefined) ws.send(next);
      }
      onOpen?.(ws!);
    });

    ws.addEventListener("message", (ev) => {
      try {
        const data =
          typeof ev.data === "string"
            ? JSON.parse(ev.data)
            : ev.data;
        onMessage?.(data, ws!);
      } catch (err) {
        console.error("ws: invalid JSON", err, ev.data);
      }
    });

    ws.addEventListener("error", (ev) => {
      onError?.(ev);
    });

    ws.addEventListener("close", (ev) => {
      onClose?.(ev);
      ws = null;
      if (!closed && reconnect) {
        attempts += 1;
        const delay = Math.min(maxBackoffMs, 500 * 2 ** Math.min(attempts, 6));
        reconnectTimer = setTimeout(connect, delay);
      }
    });
  }

  connect();

  return {
    send(msg: unknown) {
      const payload = JSON.stringify(msg);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else {
        sendQueue.push(payload);
      }
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    },
    get readyState() {
      return ws ? ws.readyState : WebSocket.CLOSED;
    },
  };
}

/**
 * Builds admin WS URL with JWT in query (since WebSocket API has no headers).
 * Backend reads token from `?token=` query param.
 */
export function adminWsUrl(): string {
  const token = getToken();
  const base = wsUrl("/ws/admin");
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function tvWsUrl(sessionId: string): string {
  return wsUrl(`/ws/tv/${encodeURIComponent(sessionId)}`);
}
