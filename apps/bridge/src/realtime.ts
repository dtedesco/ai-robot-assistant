/**
 * OpenAI Realtime client for the bridge.
 *
 * Connects straight to `wss://api.openai.com/v1/realtime` (no API-cloud hop
 * in between) to minimise round-trip latency. The mic streams PCM16 mono @
 * 24 kHz into `input_audio_buffer.append`, and the server's `audio.delta`
 * events are base64-decoded and piped into `Audio.playChunk`.
 *
 * Turn detection is server-VAD — OpenAI decides when the user stopped
 * talking and triggers a response automatically. We don't need to juggle
 * `response.create`.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Audio } from "./audio.js";
import { logger } from "./logger.js";
import type { TvController } from "./tv-controller.js";

export type RealtimePhase = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface RealtimeStatus {
  enabled: boolean;
  configured: boolean;
  phase: RealtimePhase;
  connected: boolean;
  lastError: string | null;
  lastUserText: string | null;
  lastAssistantText: string | null;
  currentAgentId: string | null;
  updatedAt: string;
}

export interface RealtimeOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
}

/** OpenAI Realtime tool definition (function-calling). */
export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ActiveFunctionCall {
  name: string;
  callId: string;
  itemId: string;
  argsBuffer: string;
}

/**
 * Apply a linear gain factor to PCM16 mono little-endian audio in-place.
 * Samples exceeding int16 range are clipped (saturating rather than wrapping).
 */
function applyGain(pcm: Buffer, factor: number): Buffer {
  if (factor === 1) return pcm;
  const out = Buffer.allocUnsafe(pcm.length);
  const len = pcm.length - (pcm.length % 2);
  for (let i = 0; i < len; i += 2) {
    const s = pcm.readInt16LE(i);
    const boosted = Math.round(s * factor);
    const clipped = boosted > 32767 ? 32767 : boosted < -32768 ? -32768 : boosted;
    out.writeInt16LE(clipped, i);
  }
  return out;
}

const OPENAI_WS = "wss://api.openai.com/v1/realtime";

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private enabled = false;
  private phase: RealtimePhase = "idle";
  private lastError: string | null = null;
  private lastUserText: string | null = null;
  private lastAssistantText: string | null = null;
  private assistantBuffer = "";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1500;
  private opts: RealtimeOptions | null = null;
  private currentAgentId: string | null = null;
  private micGain = 1.0;
  private tools: RealtimeTool[] = [];
  private tvController: TvController | null = null;
  private activeCall: ActiveFunctionCall | null = null;
  private tvResetTimer: NodeJS.Timeout | null = null;
  /** Fallback reset — only fires if the browser never signals playback idle
   *  (e.g., UI tab closed). Primary path is `playbackIdle` from the browser. */
  private readonly TV_RESET_DELAY_MS = 15_000;
  /** Tool-call side-effects queued to run when the AI actually starts speaking,
   *  so the TV updates line up with the voice ("Olha na TV!") instead of
   *  popping in before the first audible word. */
  private pendingVisuals: Array<() => Promise<void>> = [];
  /** Response ID of the audio we're currently playing. Any time a new id
   *  shows up in `response.audio.delta` we treat it as a fresh response and
   *  flush the browser playback queue — this is what prevents hearing the
   *  tail of response A followed by the start of response B (perceived as
   *  "the voice changing mid-sentence"). */
  private lastResponseId: string | null = null;

  constructor(private readonly audio: Audio) {
    super();
    // The browser signals when its Web Audio queue drains — that's the true
    // end of playback (vs `response.audio.done` which is stream-end, often
    // seconds earlier). We use this to time the TV clear precisely.
    audio.on("playbackIdle", () => this.onPlaybackIdle());
  }

  private onPlaybackIdle(): void {
    // Only act if we're back in listening (AI truly finished), and there's
    // no new response already in flight.
    if (this.phase !== "listening") return;
    if (this.tvResetTimer) {
      clearTimeout(this.tvResetTimer);
      this.tvResetTimer = null;
    }
    if (this.tvController) {
      void this.tvController.clear();
    }
  }

  /** Wire the TV controller — tool calls from OpenAI are dispatched through it. */
  setTvController(tv: TvController): void {
    this.tvController = tv;
  }

  /** Rebuild the tool schema from the currently-selected agent's library.
   *  Called whenever the agent changes, so tool enums reflect the new set
   *  of topics. Takes effect on the NEXT session.update / reconnect. */
  setTools(tools: RealtimeTool[]): void {
    this.tools = tools;
  }

  /** Linear gain applied to mic PCM before upload. 1.0 = no change. */
  setMicGain(factor: number): void {
    this.micGain = Math.max(0.1, factor);
  }

  /**
   * Provide (or replace) the connection config. If already running with a
   * different config, caller should stop() first — configure() does not
   * forcibly restart the socket.
   */
  configure(opts: RealtimeOptions): void {
    this.opts = opts;
    this.lastError = null;
  }

  isConfigured(): boolean {
    return this.opts !== null;
  }

  /**
   * Swap the active agent. Updates voice + instructions and, if the session
   * is already live, tears it down so the next session picks up the new
   * persona (voice cannot be changed mid-connection on OpenAI Realtime).
   */
  setAgent(agentId: string, voice: string, instructions: string): void {
    if (!this.opts) {
      this.lastError = "cannot set agent — realtime not configured";
      return;
    }
    const sameAgent = this.currentAgentId === agentId;
    const sameConfig =
      sameAgent &&
      this.opts.voice === voice &&
      this.opts.instructions === instructions;
    // Idempotent: if nothing effectively changed (e.g., duplicate welcome
    // from an API WS reconnect), don't tear down OpenAI. Reconnecting
    // mid-response re-issues session.update and re-primes TTS, which
    // shows up audibly as a "voice glitch" mid-speech.
    if (sameConfig && this.ws?.readyState === WebSocket.OPEN) {
      logger.debug(`[realtime] setAgent(${agentId}) no-op (same config, connected)`);
      return;
    }
    this.currentAgentId = agentId;
    this.opts = { ...this.opts, voice, instructions };
    const wasEnabled = this.enabled;
    if (this.ws) {
      logger.info(
        `[realtime] ${sameAgent ? "reconfiguring same agent" : `swapping agent id=${agentId}`} — reopening socket`,
      );
      try {
        this.ws.close(1000, sameAgent ? "reconfigure" : "agent-changed");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (wasEnabled) {
      this.enabled = false;
      this.start();
    }
  }

  getCurrentAgentId(): string | null {
    return this.currentAgentId;
  }

  status(): RealtimeStatus {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      phase: this.phase,
      connected: this.ws?.readyState === WebSocket.OPEN,
      lastError: this.lastError,
      lastUserText: this.lastUserText,
      lastAssistantText: this.lastAssistantText,
      currentAgentId: this.currentAgentId,
      updatedAt: new Date().toISOString(),
    };
  }

  start(): void {
    if (!this.opts) {
      this.lastError = "not configured (waiting for API welcome)";
      logger.warn("[realtime] start() ignored — not configured yet");
      return;
    }
    if (this.enabled) return;
    this.enabled = true;
    this.lastError = null;
    this.connect();
  }

  stop(): void {
    this.enabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setPhase("idle");
    if (this.ws) {
      try {
        this.ws.close(1000, "stopped");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    // Stop mic if we own it.
    if (this.audio.isRecording()) {
      this.audio.stopRecording();
    }
  }

  private setPhase(p: RealtimePhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.emit("phase", p);
  }

  private connect(): void {
    const opts = this.opts;
    if (!opts) return;
    const url = `${OPENAI_WS}?model=${encodeURIComponent(opts.model)}`;
    this.setPhase("connecting");
    logger.info(`[realtime] connecting model=${opts.model}`);

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      logger.info(
        `[realtime] connected (tools=${this.tools.length}: ${this.tools.map((t) => t.name).join(",")})`,
      );
      this.sendJson({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: opts.instructions,
          voice: opts.voice,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          // Explicit language hint — without this, Whisper auto-detects and
          // mislabels low-SNR / short utterances as English. ISO-639-1 "pt"
          // matches the persona instructions (PT-BR).
          input_audio_transcription: { model: "whisper-1", language: "pt" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
          tools: this.tools,
          tool_choice: this.tools.length > 0 ? "auto" : "none",
        },
      });
      void this.startMic();
      this.setPhase("listening");
    });

    ws.on("message", (raw) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString("utf8")) as typeof msg;
      } catch (err) {
        logger.warn(`[realtime] invalid JSON: ${(err as Error).message}`);
        return;
      }
      this.handleMessage(msg);
    });

    ws.on("error", (err) => {
      logger.error(`[realtime] ws error: ${err.message}`);
      this.lastError = err.message;
      this.setPhase("error");
    });

    ws.on("close", (code, reason) => {
      logger.warn(`[realtime] closed code=${code} reason=${reason.toString() || "(none)"}`);
      this.ws = null;
      if (this.audio.isRecording()) this.audio.stopRecording();
      if (this.enabled) {
        this.scheduleReconnect();
      } else {
        this.setPhase("idle");
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    logger.info(`[realtime] reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled) this.connect();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  private async startMic(): Promise<void> {
    // Mic capture is delegated to the browser (Web Audio + getUserMedia with
    // echoCancellation). The browser forwards PCM16 chunks over /ws/audio
    // and http.ts routes them here via `ingestMicChunk`. This gives us
    // hardware AEC — sox has no echo canceller, which was the source of
    // the feedback loop where the AI interrupted itself via speaker echo.
    logger.info("[realtime] mic is browser-sourced (getUserMedia AEC)");
  }

  /** Forward a browser-sourced PCM16 mic chunk to OpenAI.
   *  Half-duplex fallback: drop chunks while the AI is speaking — even with
   *  browser AEC, loud speaker output can leak. Drops also prevent OpenAI
   *  from interpreting our own echo as user speech and cancelling the
   *  response mid-sentence. */
  ingestMicChunk(pcm: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.phase !== "listening") return;
    this.sendJson({
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    });
  }

  private async handleFunctionCall(name: string, callId: string, argsStr: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsStr) as Record<string, unknown>;
    } catch {
      logger.warn(`[realtime] bad JSON args for ${name}: ${argsStr}`);
    }
    const tv = this.tvController;
    logger.info(`[realtime] tool call ${name} args=${JSON.stringify(args).slice(0, 140)}`);

    // Build the action. TV side-effects are deferred to `flushPendingVisuals`
    // so they fire at the start of the audio (lines up with "Olha na TV!"
    // instead of popping in before the voice even starts). We respond to
    // OpenAI optimistically so it keeps generating the voice turn.
    let action: (() => Promise<{ ok: boolean; reason?: string }>) | null = null;
    let isTv = false;
    if (!tv) {
      // no-op
    } else if (name === "show_tv") {
      const topic = typeof args.topic === "string" ? args.topic : "";
      if (topic) { action = () => tv.showTopic(topic); isTv = true; }
    } else if (name === "show_url") {
      const url = typeof args.url === "string" ? args.url : "";
      const title = typeof args.title === "string" ? args.title : undefined;
      if (url) { action = () => tv.showUrl(url, title); isTv = true; }
    } else if (name === "show_image") {
      const url = typeof args.url === "string" ? args.url : "";
      const caption = typeof args.caption === "string" ? args.caption : undefined;
      if (url) { action = () => tv.showImage(url, caption); isTv = true; }
    } else if (name === "clear_tv") {
      action = () => tv.clear(); isTv = true;
    }

    let resultPayload: { ok: boolean; reason?: string };
    if (isTv && action) {
      // Defer until audio starts — push into the visual queue.
      this.pendingVisuals.push(async () => {
        const r = await action!();
        if (!r.ok) logger.warn(`[realtime] deferred ${name} failed: ${r.reason}`);
      });
      resultPayload = { ok: true };
    } else if (action) {
      try {
        resultPayload = await action();
      } catch (err) {
        resultPayload = { ok: false, reason: (err as Error).message };
      }
    } else {
      resultPayload = { ok: false, reason: `unknown or invalid tool '${name}'` };
    }

    // Only register the output in the conversation state; we deliberately
    // DO NOT send `response.create` here. OpenAI would otherwise generate a
    // second audible response right after the first, which the user perceives
    // as the voice switching mid-sentence (two independent TTS passes don't
    // match in prosody). The model is instructed (see composeAgentInstructions)
    // to speak its full answer alongside the tool call in a single response.
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(resultPayload),
      },
    });
  }

  /** Fire all queued visual tool actions now. Called at the first audio
   *  delta of a response (sync with speech start) and as a fallback on
   *  response.done so they don't get orphaned on text-only turns. */
  private flushPendingVisuals(): void {
    if (this.pendingVisuals.length === 0) return;
    const actions = this.pendingVisuals;
    this.pendingVisuals = [];
    for (const a of actions) void a().catch(() => { /* logged inside */ });
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      logger.warn(`[realtime] send error: ${(err as Error).message}`);
    }
  }

  private handleMessage(msg: { type?: string; [k: string]: unknown }): void {
    const type = msg.type ?? "";
    switch (type) {
      case "session.created":
      case "session.updated":
        this.reconnectDelayMs = 1500;
        return;

      case "input_audio_buffer.speech_started":
        this.setPhase("listening");
        return;

      case "input_audio_buffer.speech_stopped":
        this.setPhase("thinking");
        return;

      case "conversation.item.input_audio_transcription.completed": {
        const t = msg.transcript;
        if (typeof t === "string" && t.trim()) {
          this.lastUserText = t;
          this.emit("userTranscript", t);
        }
        return;
      }

      case "response.audio.delta": {
        const delta = msg.delta;
        const respId =
          typeof msg.response_id === "string" ? msg.response_id : null;
        if (typeof delta === "string" && delta.length > 0) {
          const isNewResponse = respId !== null && respId !== this.lastResponseId;
          if (isNewResponse) {
            logger.info(
              `[realtime] new response_id=${respId} (prev=${this.lastResponseId ?? "none"})`,
            );
            // Cancel any pending TV reset so this new response's visuals
            // aren't wiped prematurely.
            if (this.tvResetTimer) {
              clearTimeout(this.tvResetTimer);
              this.tvResetTimer = null;
            }
            // Fire visuals queued since the last response.
            this.flushPendingVisuals();
            this.lastResponseId = respId;
            // NOTE: previously we reset the browser playback queue here.
            // That caused audible cuts when OpenAI auto-continues after a
            // tool call (response 2 right after response 1). Now we let
            // chunks queue end-to-end — same voice config, so continuous.
          }
          this.setPhase("speaking");
          void this.audio.playChunk(Buffer.from(delta, "base64"));
        }
        return;
      }

      case "response.cancelled":
        logger.info("[realtime] response cancelled by server");
        this.audio.resetPlayback();
        return;

      // --- Tool calling (function calls) ---------------------------------
      case "response.output_item.added": {
        const item = msg.item as { type?: string; name?: string; call_id?: string; id?: string } | undefined;
        if (item?.type === "function_call" && item.name && item.call_id && item.id) {
          logger.info(`[realtime] function_call started name=${item.name}`);
          this.activeCall = {
            name: item.name,
            callId: item.call_id,
            itemId: item.id,
            argsBuffer: "",
          };
        }
        return;
      }

      case "response.function_call_arguments.delta": {
        if (this.activeCall && typeof msg.delta === "string") {
          this.activeCall.argsBuffer += msg.delta;
        }
        return;
      }

      case "response.function_call_arguments.done": {
        const call = this.activeCall;
        this.activeCall = null;
        if (!call) return;
        const argsStr = (typeof msg.arguments === "string" ? msg.arguments : call.argsBuffer) || "{}";
        void this.handleFunctionCall(call.name, call.callId, argsStr);
        return;
      }

      case "response.audio_transcript.delta": {
        const d = msg.delta;
        if (typeof d === "string") this.assistantBuffer += d;
        return;
      }

      case "response.audio.done":
        this.audio.endPlayback();
        this.sendJson({ type: "input_audio_buffer.clear" });
        setTimeout(() => {
          if (this.phase !== "listening") this.setPhase("listening");
        }, 400);
        // Reset the TV back to neutral shortly after the AI finishes.
        // Cancelled automatically if a new response starts before it fires
        // (see `response.audio.delta` handler).
        if (this.tvController) {
          if (this.tvResetTimer) clearTimeout(this.tvResetTimer);
          const tv = this.tvController;
          this.tvResetTimer = setTimeout(() => {
            this.tvResetTimer = null;
            void tv.clear();
          }, this.TV_RESET_DELAY_MS);
        }
        return;

      case "response.done": {
        const respId =
          (msg.response as { id?: string } | undefined)?.id ?? "?";
        const status =
          (msg.response as { status?: string } | undefined)?.status ?? "?";
        logger.info(`[realtime] response.done id=${respId} status=${status}`);
        if (this.assistantBuffer.trim()) {
          this.lastAssistantText = this.assistantBuffer;
          this.emit("assistantTranscript", this.assistantBuffer);
        }
        this.assistantBuffer = "";
        this.flushPendingVisuals();
        return;
      }

      case "error": {
        const e = (msg.error as { message?: string } | undefined)?.message ?? "unknown";
        logger.error(`[realtime] server error: ${e}`);
        this.lastError = e;
        return;
      }

      default:
        logger.debug(`[realtime] ignored event: ${type}`);
        return;
    }
  }
}
