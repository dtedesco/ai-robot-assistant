/**
 * OpenAI Realtime client for the browser.
 *
 * Connects directly to wss://api.openai.com/v1/realtime with minimal latency.
 * Handles audio streaming, tool calls, and conversation management.
 */

export type RealtimePhase = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface RealtimeConfig {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  tools?: RealtimeTool[];
}

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

export interface RealtimeEvents {
  onPhaseChange?: (phase: RealtimePhase) => void;
  onAudioDelta?: (pcmBase64: string, responseId: string) => void;
  onAudioDone?: () => void;
  onUserTranscript?: (text: string) => void;
  onAssistantTranscript?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
  onError?: (error: string) => void;
}

const OPENAI_WS = "wss://api.openai.com/v1/realtime";

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private config: RealtimeConfig | null = null;
  private events: RealtimeEvents = {};
  private phase: RealtimePhase = "idle";
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1500;
  private enabled = false;

  // Tool call state
  private activeCall: {
    name: string;
    callId: string;
    itemId: string;
    argsBuffer: string;
  } | null = null;

  // Transcript buffer
  private assistantBuffer = "";
  private lastResponseId: string | null = null;
  private thinkingTimeout: number | null = null;

  configure(config: RealtimeConfig, events: RealtimeEvents): void {
    this.config = config;
    this.events = events;
  }

  start(): void {
    if (!this.config) {
      console.error("[realtime] not configured");
      return;
    }
    if (this.enabled) return;
    this.enabled = true;
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
        // ignore
      }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getPhase(): RealtimePhase {
    return this.phase;
  }

  /**
   * Send PCM16 audio chunk to OpenAI.
   * Audio should be base64-encoded PCM16 mono @ 24kHz.
   */
  sendAudio(pcmBase64: string): void {
    if (!this.isConnected()) return;
    this.sendJson({
      type: "input_audio_buffer.append",
      audio: pcmBase64,
    });
  }

  /**
   * Inject a system message into the conversation.
   * Used for triggering greetings when a face is detected.
   */
  injectSystemMessage(text: string): void {
    if (!this.isConnected()) {
      console.warn("[realtime] cannot inject - not connected");
      return;
    }
    console.log("[realtime] injecting system message");
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[SISTEMA]: ${text}` }],
      },
    });
  }

  /**
   * Trigger an AI response without waiting for user audio.
   */
  triggerResponse(): void {
    if (!this.isConnected()) return;
    console.log("[realtime] triggering response");
    this.sendJson({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
      },
    });
  }

  /**
   * Clear the audio input buffer.
   */
  clearAudioBuffer(): void {
    if (!this.isConnected()) return;
    this.sendJson({ type: "input_audio_buffer.clear" });
  }

  /**
   * Reset the conversation (reconnect to get fresh session).
   */
  resetConversation(): void {
    if (!this.enabled) return;
    console.log("[realtime] resetting conversation");
    if (this.ws) {
      try {
        this.ws.close(1000, "reset");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    setTimeout(() => {
      if (this.enabled) this.connect();
    }, 500);
  }

  private setPhase(phase: RealtimePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.events.onPhaseChange?.(phase);

    // Clear any existing thinking timeout
    if (this.thinkingTimeout) {
      clearTimeout(this.thinkingTimeout);
      this.thinkingTimeout = null;
    }

    // Set a safety timeout for "thinking" phase - max 15 seconds
    if (phase === "thinking") {
      this.thinkingTimeout = window.setTimeout(() => {
        if (this.phase === "thinking") {
          console.warn("[realtime] thinking timeout - forcing back to listening");
          this.setPhase("listening");
        }
      }, 15000);
    }
  }

  private connect(): void {
    if (!this.config) return;
    const { apiKey, model } = this.config;

    const url = `${OPENAI_WS}?model=${encodeURIComponent(model)}`;
    this.setPhase("connecting");
    console.log("[realtime] connecting...");

    const ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${apiKey}`,
      "openai-beta.realtime-v1",
    ]);

    this.ws = ws;

    ws.onopen = () => {
      console.log("[realtime] connected");
      this.reconnectDelay = 1500;
      this.sendSessionUpdate();
      this.setPhase("listening");
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type?: string; [k: string]: unknown };
        this.handleMessage(msg);
      } catch (err) {
        console.error("[realtime] parse error", err);
      }
    };

    ws.onerror = (ev) => {
      console.error("[realtime] error", ev);
      this.events.onError?.("WebSocket error");
    };

    ws.onclose = (ev) => {
      console.log("[realtime] closed", ev.code, ev.reason);
      this.ws = null;
      if (this.enabled) {
        this.setPhase("error");
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
          this.connect();
        }, this.reconnectDelay);
      }
    };
  }

  private sendSessionUpdate(): void {
    if (!this.config || !this.isConnected()) return;
    const { voice, instructions, tools } = this.config;

    this.sendJson({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1", language: "pt" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.4,          // More sensitive to speech
          prefix_padding_ms: 200,  // Less padding before speech
          silence_duration_ms: 300, // Faster end-of-speech detection
        },
        tools: tools ?? [],
        tool_choice: tools && tools.length > 0 ? "auto" : "none",
      },
    });
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      console.warn("[realtime] send error", err);
    }
  }

  private handleMessage(msg: { type?: string; [k: string]: unknown }): void {
    const type = msg.type ?? "";

    // Log important events for debugging
    if (type.startsWith("input_audio") || type.startsWith("response.")) {
      console.log("[realtime]", type);
    }

    switch (type) {
      case "session.created":
      case "session.updated":
        this.reconnectDelay = 1500;
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
          this.events.onUserTranscript?.(t);
        }
        return;
      }

      case "response.audio.delta": {
        const delta = msg.delta;
        const respId = typeof msg.response_id === "string" ? msg.response_id : null;
        if (typeof delta === "string" && delta.length > 0) {
          const isNewResponse = respId !== null && respId !== this.lastResponseId;
          if (isNewResponse) {
            this.lastResponseId = respId;
          }
          this.setPhase("speaking");
          this.events.onAudioDelta?.(delta, respId ?? "");
        }
        return;
      }

      case "response.audio.done":
        this.events.onAudioDone?.();
        // Don't clear audio buffer - let VAD handle it
        // Transition back to listening immediately
        if (this.phase !== "listening") this.setPhase("listening");
        return;

      // Tool calling
      case "response.output_item.added": {
        const item = msg.item as { type?: string; name?: string; call_id?: string; id?: string } | undefined;
        if (item?.type === "function_call" && item.name && item.call_id && item.id) {
          console.log("[realtime] tool call started:", item.name);
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
        void this.handleToolCall(call.name, call.callId, argsStr);
        return;
      }

      case "response.audio_transcript.delta": {
        const d = msg.delta;
        if (typeof d === "string") this.assistantBuffer += d;
        return;
      }

      case "response.created": {
        // Response started - we're thinking/generating
        if (this.phase !== "speaking") {
          this.setPhase("thinking");
        }
        return;
      }

      case "response.done": {
        if (this.assistantBuffer.trim()) {
          this.events.onAssistantTranscript?.(this.assistantBuffer);
        }
        this.assistantBuffer = "";
        // Make sure we go back to listening after response is done
        setTimeout(() => {
          if (this.phase === "thinking") {
            this.setPhase("listening");
          }
        }, 500);
        return;
      }

      case "error": {
        const errMsg = (msg.error as { message?: string })?.message ?? "Unknown error";
        console.error("[realtime] error:", errMsg);
        this.events.onError?.(errMsg);
        return;
      }
    }
  }

  private async handleToolCall(name: string, callId: string, argsStr: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsStr) as Record<string, unknown>;
    } catch {
      console.warn("[realtime] bad JSON args:", argsStr);
    }

    console.log("[realtime] tool call:", name, args);

    let result: unknown = { ok: false, reason: "no handler" };
    if (this.events.onToolCall) {
      try {
        result = await this.events.onToolCall(name, args, callId);
      } catch (err) {
        result = { ok: false, reason: (err as Error).message };
      }
    }

    // Send tool result back to OpenAI
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });

    // Trigger a new response after tool call to continue the conversation
    this.sendJson({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
      },
    });
  }
}

// Singleton instance
export const realtimeClient = new RealtimeClient();
