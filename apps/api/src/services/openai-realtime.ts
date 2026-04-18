import WebSocket from "ws";
import type { TranscriptEntry } from "@robot/shared";
import type { RealtimeToolSchema } from "./realtime-tools.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface OpenAIRealtimeOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  greeting?: string | null;
  tools: RealtimeToolSchema[];
  onAudioOut: (pcmBase64: string) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onToolCall: (call: ToolCall) => void;
  onError: (msg: string) => void;
}

interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Thin WebSocket client for the OpenAI Realtime API.
 *
 * Responsibilities:
 *   - Connect and configure the session with the agent's instructions, voice,
 *     and tool schemas.
 *   - Forward audio in (bridge mic -> openai) and audio out (openai -> bridge
 *     speaker) via the `onAudioOut` callback.
 *   - Parse `response.function_call_arguments.done` events (and tool-like
 *     output items) and surface them as `ToolCall` objects to the hub.
 *   - Emit assistant transcript deltas as `TranscriptEntry`s.
 *
 * NOTE: Realtime event names have shifted between OpenAI API versions; the
 * handlers below are defensive (tolerant of unknown event types) so the
 * skeleton keeps working across minor updates.
 */
export class OpenAIRealtimeClient {
  private ws: WebSocket | null = null;
  private closed = false;
  /** Accumulator for streaming assistant text (delta -> done). */
  private assistantTextBuffers = new Map<string, string>();
  /** Accumulator for streaming function_call arguments. */
  private functionCallBuffers = new Map<
    string,
    { name: string; args: string }
  >();

  constructor(private readonly opts: OpenAIRealtimeOptions) {}

  async connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      this.opts.model,
    )}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error("ws not constructed"));
      const onOpen = () => {
        this.ws?.off("error", onErr);
        resolve();
      };
      const onErr = (err: Error) => {
        this.ws?.off("open", onOpen);
        reject(err);
      };
      this.ws.once("open", onOpen);
      this.ws.once("error", onErr);
    });

    this.ws!.on("message", (raw) => this.handleMessage(raw));
    this.ws!.on("close", () => {
      this.closed = true;
    });
    this.ws!.on("error", (err) => {
      this.opts.onError(`openai ws error: ${err.message}`);
    });

    this.sendRaw({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: this.opts.voice,
        instructions: this.opts.instructions,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        tools: this.opts.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        tool_choice: "auto",
      },
    });

    if (this.opts.greeting) {
      // Ask the assistant to speak the greeting first.
      this.sendRaw({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Greet the user now: ${this.opts.greeting}`,
        },
      });
    }
  }

  /** Forward base64 PCM16 audio from the bridge microphone to OpenAI. */
  sendAudioIn(pcmBase64: string): void {
    if (!this.ws || this.closed) return;
    this.sendRaw({
      type: "input_audio_buffer.append",
      audio: pcmBase64,
    });
  }

  /** Inject a user text message (e.g. admin "sendText"). */
  sendUserText(text: string): void {
    if (!this.ws || this.closed) return;
    this.sendRaw({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.sendRaw({ type: "response.create" });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }

  private sendRaw(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let evt: RealtimeEvent;
    try {
      evt = JSON.parse(raw.toString()) as RealtimeEvent;
    } catch {
      return;
    }
    switch (evt.type) {
      case "response.audio.delta": {
        const delta = typeof evt.delta === "string" ? evt.delta : "";
        if (delta) this.opts.onAudioOut(delta);
        break;
      }
      case "response.audio_transcript.delta": {
        const id = String(evt.response_id ?? evt.item_id ?? "current");
        const prev = this.assistantTextBuffers.get(id) ?? "";
        this.assistantTextBuffers.set(
          id,
          prev + (typeof evt.delta === "string" ? evt.delta : ""),
        );
        break;
      }
      case "response.audio_transcript.done":
      case "response.text.done": {
        const id = String(evt.response_id ?? evt.item_id ?? "current");
        const buffered = this.assistantTextBuffers.get(id) ?? "";
        const transcript =
          typeof evt.transcript === "string" && evt.transcript.length > 0
            ? evt.transcript
            : buffered;
        this.assistantTextBuffers.delete(id);
        if (transcript) {
          this.opts.onTranscript({
            role: "assistant",
            text: transcript,
            ts: new Date().toISOString(),
          });
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text =
          typeof evt.transcript === "string" ? evt.transcript : "";
        if (text) {
          this.opts.onTranscript({
            role: "user",
            text,
            ts: new Date().toISOString(),
          });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const id = String(evt.call_id ?? evt.item_id ?? "current");
        const existing = this.functionCallBuffers.get(id) ?? {
          name: String(evt.name ?? ""),
          args: "",
        };
        existing.args += typeof evt.delta === "string" ? evt.delta : "";
        if (!existing.name && typeof evt.name === "string") {
          existing.name = evt.name;
        }
        this.functionCallBuffers.set(id, existing);
        break;
      }
      case "response.function_call_arguments.done": {
        const id = String(evt.call_id ?? evt.item_id ?? "current");
        const buffered = this.functionCallBuffers.get(id);
        this.functionCallBuffers.delete(id);
        const name =
          (typeof evt.name === "string" ? evt.name : buffered?.name) ?? "";
        const argsRaw =
          (typeof evt.arguments === "string"
            ? evt.arguments
            : buffered?.args) ?? "{}";
        if (!name) break;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsRaw) as Record<string, unknown>;
        } catch {
          args = {};
        }
        this.opts.onToolCall({
          id,
          name,
          arguments: args,
        });
        break;
      }
      case "error": {
        const msg =
          typeof evt.error === "object" && evt.error !== null
            ? JSON.stringify(evt.error)
            : String(evt.error ?? "unknown");
        this.opts.onError(`openai error: ${msg}`);
        break;
      }
      default:
        // Ignored: session.created, response.done, rate_limits.updated, etc.
        break;
    }
  }
}
