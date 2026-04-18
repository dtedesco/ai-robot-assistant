import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AgentToolsConfig,
  BridgeDownMsg,
  BridgeUpMsg,
  EmotionColorMap,
  OpenAIVoice,
  SessionEvent,
  TvDownMsg,
  TvLibraryItem,
} from "@robot/shared";
import { buildEnabledTools } from "./realtime-tools.js";
import {
  OpenAIRealtimeClient,
  type ToolCall,
} from "./openai-realtime.js";
import { buildActionPacket, buildColorPacket, toHex } from "@robot/protocol";
import { prisma } from "../db.js";
import { loadConfig } from "../config.js";

export interface AgentRecord {
  id: string;
  name: string;
  systemPrompt: string;
  voice: string;
  language: string;
  greeting: string | null;
  emotionColorMap: unknown;
  tools: unknown;
  tvLibrary: unknown;
}

export interface BridgeRecord {
  id: string;
  name: string;
}

/** A bridge WS connection registered with the hub. */
export interface BridgeConnection {
  bridgeId: string;
  send: (msg: BridgeDownMsg) => void;
  close: () => void;
}

interface ActiveSession {
  sessionId: string;
  agentId: string;
  bridgeId: string;
  agent: AgentRecord;
  openai: OpenAIRealtimeClient | null;
  /** Admin sockets subscribed to this session's events. */
  adminSubscribers: Set<(ev: SessionEvent) => void>;
  /** TV viewers for this session (receive TvDownMsg). */
  tvSubscribers: Set<(msg: TvDownMsg) => void>;
}

export interface SessionHubEvents {
  "bridge:status": (bridgeId: string, online: boolean) => void;
}

/**
 * Central in-memory coordinator for active sessions.
 *
 * - Tracks live sessions and their connected bridge/openai/admin/tv subscribers.
 * - Exposes publishEvent() so any producer (openai proxy, bridge, admin) can
 *   fan out SessionEvents to admin subscribers and TV viewers.
 * - Holds the map of connected bridges (indexed by bridgeId) so routes/ws can
 *   send BridgeDownMsgs.
 */
/**
 * A request awaiting a matching reply from the bridge.
 *
 * The hub holds these between sending an outgoing BridgeDownMsg and receiving
 * a matching BridgeUpMsg (matched by the caller-provided `matcher`). On match,
 * the pending is resolved with the message; on timeout or bridge disconnect,
 * it is rejected.
 */
interface PendingBridgeRequest {
  id: string;
  bridgeId: string;
  matcher: (msg: BridgeUpMsg) => boolean;
  resolve: (msg: BridgeUpMsg) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class SessionHub extends EventEmitter {
  private sessions = new Map<string, ActiveSession>();
  private bridges = new Map<string, BridgeConnection>();
  /** Pending request/response promises keyed by request id. */
  private pendingRequests = new Map<string, PendingBridgeRequest>();

  // ---------- bridge registry ----------

  registerBridge(conn: BridgeConnection): void {
    const existing = this.bridges.get(conn.bridgeId);
    if (existing) existing.close();
    this.bridges.set(conn.bridgeId, conn);
    this.emit("bridge:status", conn.bridgeId, true);
  }

  unregisterBridge(bridgeId: string): void {
    const existing = this.bridges.get(bridgeId);
    if (!existing) return;
    this.bridges.delete(bridgeId);
    // Reject any in-flight requests targeted at this bridge.
    for (const [id, pending] of this.pendingRequests) {
      if (pending.bridgeId !== bridgeId) continue;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.reject(new Error("bridge disconnected"));
    }
    this.emit("bridge:status", bridgeId, false);
  }

  isBridgeOnline(bridgeId: string): boolean {
    return this.bridges.has(bridgeId);
  }

  getBridge(bridgeId: string): BridgeConnection | undefined {
    return this.bridges.get(bridgeId);
  }

  sendToBridge(bridgeId: string, msg: BridgeDownMsg): boolean {
    const conn = this.bridges.get(bridgeId);
    if (!conn) return false;
    conn.send(msg);
    return true;
  }

  /**
   * Send a message to the bridge and wait for a matching reply.
   *
   * `matcher` receives every BridgeUpMsg coming from this bridge until either
   * it returns true (resolve), the timeout elapses (reject), or the bridge
   * disconnects (reject). The pending entry is keyed by an internal id; the
   * caller does not need to manage correlation themselves.
   */
  requestFromBridge<T extends BridgeUpMsg = BridgeUpMsg>(
    bridgeId: string,
    outgoing: BridgeDownMsg,
    matcher: (msg: BridgeUpMsg) => boolean,
    timeoutMs: number,
  ): Promise<T> {
    const conn = this.bridges.get(bridgeId);
    if (!conn) {
      return Promise.reject(new Error("bridge not connected"));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error("bridge request timed out"));
        }
      }, timeoutMs);
      // Defensive: don't keep the event loop alive solely for this timer.
      if (typeof timer.unref === "function") timer.unref();
      this.pendingRequests.set(id, {
        id,
        bridgeId,
        matcher,
        resolve: (msg) => resolve(msg as T),
        reject,
        timer,
      });
      try {
        conn.send(outgoing);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Deliver an incoming bridge message to any pending request whose matcher
   * accepts it. Returns true if at least one pending was resolved (so the WS
   * handler can choose to skip its own default handling if desired).
   */
  deliverBridgeMessage(bridgeId: string, msg: BridgeUpMsg): boolean {
    let delivered = false;
    for (const [id, pending] of this.pendingRequests) {
      if (pending.bridgeId !== bridgeId) continue;
      let matched = false;
      try {
        matched = pending.matcher(msg);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.resolve(msg);
      delivered = true;
    }
    return delivered;
  }

  // ---------- sessions ----------

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Returns the active sessionId associated with a bridge, if any. */
  findSessionIdByBridge(bridgeId: string): string | null {
    for (const s of this.sessions.values()) {
      if (s.bridgeId === bridgeId) return s.sessionId;
    }
    return null;
  }

  async startSession(
    sessionId: string,
    agent: AgentRecord,
    bridge: BridgeRecord,
  ): Promise<ActiveSession> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already active`);
    }

    const cfg = loadConfig();
    const agentTools = (agent.tools ?? {}) as AgentToolsConfig;
    const enabledTools = buildEnabledTools(agentTools);

    const session: ActiveSession = {
      sessionId,
      agentId: agent.id,
      bridgeId: bridge.id,
      agent,
      openai: null,
      adminSubscribers: new Set(),
      tvSubscribers: new Set(),
    };
    this.sessions.set(sessionId, session);

    // Notify bridge that a session has started. The bridge should begin
    // streaming mic audio and connecting BLE.
    this.sendToBridge(bridge.id, {
      type: "session:start",
      sessionId,
      realtime: {
        model: cfg.OPENAI_REALTIME_MODEL,
        voice: agent.voice as OpenAIVoice,
        instructions: agent.systemPrompt,
        greeting: agent.greeting,
        tools: enabledTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    });

    // Emit "started" event to any early subscribers.
    this.publishEvent(sessionId, {
      type: "started",
      agentId: agent.id,
      bridgeId: bridge.id,
    });

    // Spin up OpenAI realtime client if we have a key. Failures are logged but
    // non-fatal: the session still exists, admin can send text / bridge can
    // still proxy, and tool-calling is stubbed.
    if (cfg.OPENAI_API_KEY) {
      try {
        const client = new OpenAIRealtimeClient({
          apiKey: cfg.OPENAI_API_KEY,
          model: cfg.OPENAI_REALTIME_MODEL,
          voice: agent.voice,
          instructions: agent.systemPrompt,
          greeting: agent.greeting,
          tools: enabledTools,
          onAudioOut: (pcm) => {
            this.sendToBridge(bridge.id, { type: "audio:out", pcm });
          },
          onTranscript: (entry) => {
            this.publishEvent(sessionId, { type: "transcript", entry });
            // Append to DB transcript asynchronously. Best-effort.
            this.appendTranscript(sessionId, entry).catch(() => {});
          },
          onToolCall: (call) => {
            this.handleToolCall(sessionId, call).catch((err) => {
              this.publishEvent(sessionId, {
                type: "error",
                message: `tool ${call.name} failed: ${String(err)}`,
              });
            });
          },
          onError: (msg) => {
            this.publishEvent(sessionId, { type: "error", message: msg });
          },
        });
        session.openai = client;
        await client.connect();
      } catch (err) {
        this.publishEvent(sessionId, {
          type: "error",
          message: `openai connect failed: ${String(err)}`,
        });
      }
    } else {
      this.publishEvent(sessionId, {
        type: "error",
        message: "OPENAI_API_KEY not configured; running without realtime",
      });
    }

    return session;
  }

  async endSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.openai) {
      try {
        session.openai.close();
      } catch {
        /* noop */
      }
    }
    this.sendToBridge(session.bridgeId, { type: "session:end" });
    this.publishEvent(sessionId, { type: "ended", reason });
    this.sessions.delete(sessionId);
  }

  // ---------- audio passthrough (bridge -> openai) ----------

  forwardAudioIn(sessionId: string, pcmBase64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.openai) return;
    session.openai.sendAudioIn(pcmBase64);
  }

  sendAdminText(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.openai) {
      session.openai.sendUserText(text);
    }
    this.publishEvent(sessionId, {
      type: "transcript",
      entry: { role: "user", text, ts: new Date().toISOString() },
    });
  }

  // ---------- subscribers ----------

  subscribeAdmin(
    sessionId: string,
    fn: (ev: SessionEvent) => void,
  ): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) return () => {};
    session.adminSubscribers.add(fn);
    return () => {
      session.adminSubscribers.delete(fn);
    };
  }

  subscribeTv(
    sessionId: string,
    fn: (msg: TvDownMsg) => void,
  ): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) return () => {};
    session.tvSubscribers.add(fn);
    return () => {
      session.tvSubscribers.delete(fn);
    };
  }

  publishEvent(sessionId: string, event: SessionEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const fn of session.adminSubscribers) {
      try {
        fn(event);
      } catch {
        /* isolated */
      }
    }
    if (event.type === "tv") {
      for (const fn of session.tvSubscribers) {
        try {
          fn(event.msg);
        } catch {
          /* isolated */
        }
      }
    }
  }

  // ---------- tool calls ----------

  private async handleToolCall(
    sessionId: string,
    call: ToolCall,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const args = call.arguments ?? {};
    switch (call.name) {
      case "show_on_tv": {
        const kind = String(args.kind ?? "");
        if (kind === "youtube" || kind === "image" || kind === "webpage") {
          const url = String(args.url ?? "");
          if (!url) throw new Error("url required");
          this.publishEvent(sessionId, {
            type: "tv",
            msg: {
              type: "display",
              content:
                kind === "youtube"
                  ? {
                      kind: "youtube",
                      url,
                      title: args.title ? String(args.title) : undefined,
                    }
                  : kind === "image"
                    ? {
                        kind: "image",
                        url,
                        caption: args.title
                          ? String(args.title)
                          : undefined,
                      }
                    : { kind: "webpage", url },
            },
          });
        } else if (kind === "text") {
          const text = String(args.text ?? "");
          this.publishEvent(sessionId, {
            type: "tv",
            msg: { type: "display", content: { kind: "text", text } },
          });
        } else {
          throw new Error(`unknown tv kind: ${kind}`);
        }
        break;
      }
      case "show_from_library": {
        const topic = String(args.topic ?? "").toLowerCase();
        const library = (session.agent.tvLibrary ?? []) as TvLibraryItem[];
        const item = library.find(
          (li) => li.topic.toLowerCase() === topic,
        );
        if (!item) throw new Error(`library item not found: ${topic}`);
        if (item.kind === "text") {
          this.publishEvent(sessionId, {
            type: "tv",
            msg: {
              type: "display",
              content: { kind: "text", text: item.text ?? "" },
            },
          });
        } else {
          const url = item.url ?? "";
          if (!url) throw new Error("library item missing url");
          this.publishEvent(sessionId, {
            type: "tv",
            msg: {
              type: "display",
              content:
                item.kind === "youtube"
                  ? { kind: "youtube", url, title: item.title }
                  : item.kind === "image"
                    ? { kind: "image", url, caption: item.title }
                    : { kind: "webpage", url },
            },
          });
        }
        break;
      }
      case "clear_tv": {
        this.publishEvent(sessionId, {
          type: "tv",
          msg: { type: "clear" },
        });
        break;
      }
      case "robot_dance": {
        const action = Number(args.action);
        const emotionMap = (session.agent.emotionColorMap ??
          {}) as EmotionColorMap;
        const defaultColor =
          (Object.values(emotionMap)[0] as number | undefined) ?? 2;
        const packet = buildActionPacket({ action, color: defaultColor });
        this.sendToBridge(session.bridgeId, {
          type: "ble:packet",
          hex: toHex(packet),
        });
        this.publishEvent(sessionId, { type: "robot:action", action });
        break;
      }
      case "robot_color": {
        const color = Number(args.color);
        const packet = buildColorPacket(color);
        this.sendToBridge(session.bridgeId, {
          type: "ble:packet",
          hex: toHex(packet),
        });
        this.publishEvent(sessionId, { type: "robot:color", color });
        break;
      }
      default:
        throw new Error(`unknown tool: ${call.name}`);
    }
  }

  // ---------- transcript persistence ----------

  private async appendTranscript(
    sessionId: string,
    entry: { role: "user" | "assistant"; text: string; ts: string },
  ): Promise<void> {
    const row = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { transcript: true },
    });
    if (!row) return;
    const current = Array.isArray(row.transcript)
      ? (row.transcript as unknown as Array<unknown>)
      : [];
    const next = [...current, entry];
    await prisma.session.update({
      where: { id: sessionId },
      data: { transcript: next as unknown as object },
    });
  }
}
