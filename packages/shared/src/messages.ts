import type { BLEDevice } from "./ble.js";
import type { OpenAIVoice, TranscriptEntry } from "./agent.js";

// ---------- TV ----------
export type TvContent =
  | { kind: "youtube"; url: string; title?: string }
  | { kind: "image"; url: string; caption?: string }
  | { kind: "webpage"; url: string }
  | { kind: "text"; text: string };

export type TvDownMsg =
  | { type: "display"; content: TvContent }
  | { type: "clear" }
  | { type: "hello"; sessionId: string }
  /** Pushes the idle-state background configuration (shown when no active
   *  `display` content). `backgroundUrl` is null → use the built-in scene. */
  | { type: "idle-config"; backgroundUrl: string | null };

// ---------- Session events (broadcast to admin & tv subscribers) ----------
export type SessionEvent =
  | { type: "started"; agentId: string; bridgeId: string }
  | { type: "ended"; reason?: string }
  | { type: "transcript"; entry: TranscriptEntry }
  | { type: "emotion"; emotion: string }
  | { type: "tv"; msg: TvDownMsg }
  | { type: "robot:action"; action: number }
  | { type: "robot:color"; color: number }
  | { type: "error"; message: string };

// ---------- Bridge ↔ API ----------
export interface BridgeHelloMsg {
  type: "hello";
  token: string;
  version: string;
}

export type BridgeUpMsg =
  | BridgeHelloMsg
  | { type: "ble:scanResult"; devices: BLEDevice[] }
  | { type: "ble:connected"; address: string }
  | { type: "ble:disconnected"; reason?: string }
  | { type: "ble:error"; message: string }
  | { type: "audio:in"; pcm: string }
  | { type: "pong" };

export interface RealtimeConfig {
  model: string;
  voice: OpenAIVoice;
  instructions: string;
  greeting?: string | null;
  tools: Array<{ name: string; description: string; parameters: unknown }>;
}

/**
 * A cloud-defined agent, surfaced to the bridge so the user can pick which
 * persona to converse with. Instructions and voice feed directly into the
 * OpenAI Realtime `session.update` message.
 */
export interface BridgeAgentSummary {
  id: string;
  name: string;
  voice: OpenAIVoice;
  instructions: string;
  greeting: string | null;
  /** Items the AI can show on TV via tool calls (populated from Agent.tvLibrary). */
  tvLibrary: Array<{
    topic: string;
    kind: "youtube" | "image" | "webpage" | "text";
    url?: string;
    text?: string;
    title?: string;
  }>;
  /** Pushed to the TV as the idle background when this agent is active. */
  tvIdleBackgroundUrl: string | null;
}

/**
 * OpenAI Realtime config pushed down to the bridge on welcome.
 * Lets the bridge talk directly to OpenAI (low-latency path) without keeping
 * its own API key — the cloud API is the single source of truth for both
 * credentials and the agent catalogue.
 */
export interface BridgeRealtimeConfig {
  apiKey: string;
  model: string;
  voice: OpenAIVoice;
  instructions: string;
  agents: BridgeAgentSummary[];
}

export type BridgeDownMsg =
  | { type: "welcome"; bridgeId: string; realtime?: BridgeRealtimeConfig }
  | { type: "ble:scan" }
  | { type: "ble:connect"; address: string }
  | { type: "ble:disconnect" }
  | { type: "ble:packet"; hex: string }
  | { type: "audio:out"; pcm: string }
  | { type: "session:start"; sessionId: string; realtime: RealtimeConfig }
  | { type: "session:end" }
  | { type: "ping" };

// ---------- Admin ↔ API ----------
export type AdminUpMsg =
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "sendText"; sessionId: string; text: string };

export type AdminDownMsg =
  | { type: "session:event"; sessionId: string; event: SessionEvent }
  | { type: "bridge:status"; bridgeId: string; online: boolean }
  | { type: "error"; message: string };
