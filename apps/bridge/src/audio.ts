/**
 * Audio I/O for the bridge daemon.
 *
 * Capture uses the `mic` npm module (→ `sox`/`rec` or `arecord`). Playback
 * is delegated to the browser UI via WebSocket: the Realtime response audio
 * is forwarded as base64 PCM chunks over `/ws/audio`, and the page plays
 * them through the Web Audio API at native 24 kHz — the same approach that
 * worked in the legacy Python prototype (`legacy/robert_realtime.py`).
 *
 * Streaming raw PCM through sox/play on macOS produced unavoidable clicks
 * from CoreAudio's on-the-fly resampling; the browser's AudioContext at
 * `sampleRate: 24000` plays cleanly.
 *
 * Native install requirement:
 *   - `brew install sox` on macOS (for mic capture)
 *   - On Linux: `apt-get install sox alsa-utils`
 */
import { EventEmitter } from "node:events";
import { logger } from "./logger.js";

export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_BIT_DEPTH = 16;

/**
 * Bytes per ~40 ms of PCM16 mono @ 24 kHz.
 *   24000 samples/s * 0.04 s * 2 bytes/sample = 1920 bytes
 */
const FRAME_BYTES =
  (AUDIO_SAMPLE_RATE * AUDIO_BIT_DEPTH * AUDIO_CHANNELS) / 8 / 25;

export type AudioChunkHandler = (pcm: Buffer) => void;

// --- Minimal inline types for `mic` (no @types available) ------------------

interface MicInstance {
  getAudioStream(): NodeJS.ReadableStream;
  start(): void;
  stop(): void;
}

interface MicOptions {
  rate: string;
  channels: string;
  bitwidth: string;
  encoding: string;
  endian: string;
  device?: string;
  debug?: boolean;
}

type MicFactory = (opts: MicOptions) => MicInstance;

async function loadModule<T>(name: string): Promise<T | null> {
  try {
    const mod = (await import(name)) as unknown as {
      default?: T;
    };
    if (mod && typeof mod === "object" && "default" in mod && mod.default) {
      return mod.default;
    }
    return mod as unknown as T;
  } catch (err) {
    logger.warn(
      `[audio] failed to load native module '${name}': ${(err as Error).message}`,
    );
    return null;
  }
}

function* sliceFrames(buf: Buffer, frameSize: number): Generator<Buffer> {
  if (buf.length <= frameSize) {
    yield buf;
    return;
  }
  for (let off = 0; off < buf.length; off += frameSize) {
    yield buf.subarray(off, Math.min(off + frameSize, buf.length));
  }
}

// --- Audio class -----------------------------------------------------------

/**
 * Emits:
 *   - `outChunk` (pcm: Buffer) — each realtime response audio delta
 *   - `outEnd` ()              — signalled when OpenAI fires `audio.done`
 *
 * The HTTP layer forwards these over `/ws/audio` to the browser, which
 * plays them via Web Audio API.
 */
export class Audio extends EventEmitter {
  private micInstance: MicInstance | null = null;
  private recording = false;

  /** Push a PCM16 chunk from the Realtime response to output listeners. */
  playChunk(pcm: Buffer): void {
    if (!pcm || pcm.length === 0) return;
    this.emit("outChunk", pcm);
  }

  /** Signal end of the current response. Listeners may flush UI state. */
  endPlayback(): void {
    this.emit("outEnd");
  }

  /** Tell listeners (browser) to stop anything still playing — used when a
   *  new response starts before the previous one finished draining. */
  resetPlayback(): void {
    this.emit("outReset");
  }

  /** No-op close — browser drains its own queue. */
  close(): void {
    /* nothing to tear down */
  }

  closeSpeaker(): void {
    this.close();
  }

  // --- Mic capture ---------------------------------------------------------

  async startRecording(onChunk: AudioChunkHandler): Promise<void> {
    if (this.recording) {
      logger.warn("[audio] startRecording called while already recording");
      return;
    }

    const micFactory = await loadModule<MicFactory>("mic");
    if (typeof micFactory !== "function") {
      logger.warn(
        "[audio] mic module unavailable (sox/arecord missing?); recording disabled",
      );
      return;
    }

    let instance: MicInstance;
    try {
      instance = micFactory({
        rate: String(AUDIO_SAMPLE_RATE),
        channels: String(AUDIO_CHANNELS),
        bitwidth: String(AUDIO_BIT_DEPTH),
        encoding: "signed-integer",
        endian: "little",
        debug: false,
      });
    } catch (err) {
      logger.error(
        `[audio] failed to construct mic: ${(err as Error).message}`,
      );
      return;
    }

    let stream: NodeJS.ReadableStream;
    try {
      stream = instance.getAudioStream();
    } catch (err) {
      logger.error(
        `[audio] failed to obtain mic stream: ${(err as Error).message}`,
      );
      return;
    }

    stream.on("data", (chunk: Buffer) => {
      for (const frame of sliceFrames(chunk, FRAME_BYTES)) {
        try {
          onChunk(frame);
        } catch (cbErr) {
          logger.warn(
            `[audio] mic onChunk callback threw: ${(cbErr as Error).message}`,
          );
        }
      }
    });

    stream.on("error", (err: Error) => {
      logger.error(`[audio] mic stream error: ${err.message}`);
    });

    try {
      instance.start();
    } catch (err) {
      logger.error(`[audio] mic.start() failed: ${(err as Error).message}`);
      return;
    }

    this.micInstance = instance;
    this.recording = true;
    logger.info(
      `[audio] recording started (PCM16 ${AUDIO_SAMPLE_RATE}Hz mono)`,
    );
  }

  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Capture the mic for `durationMs` and return the raw PCM buffer plus
   * peak/RMS levels (0-1 scale). Rejects if a long-running session is already
   * recording.
   */
  async recordOnce(
    durationMs: number,
  ): Promise<{ bytes: number; rms: number; peak: number } | null> {
    if (this.recording) {
      throw new Error("mic is busy (session recording in progress)");
    }
    const frames: Buffer[] = [];
    await this.startRecording((chunk) => {
      frames.push(Buffer.from(chunk));
    });
    if (!this.recording) return null;
    await new Promise((r) => setTimeout(r, durationMs));
    this.stopRecording();

    const total = Buffer.concat(frames);
    const samples = total.length / 2;
    if (samples === 0) return { bytes: 0, rms: 0, peak: 0 };
    let sumSquares = 0;
    let peakAbs = 0;
    for (let i = 0; i < total.length; i += 2) {
      const s = total.readInt16LE(i);
      const abs = Math.abs(s);
      if (abs > peakAbs) peakAbs = abs;
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / samples) / 32768;
    const peak = peakAbs / 32768;
    return { bytes: total.length, rms, peak };
  }

  /**
   * Generate and play a sine-wave test tone locally. With the browser-based
   * playback pipeline this now emits via the outChunk event, so only the
   * browser hears it.
   */
  async playTone(frequencyHz: number, durationMs: number): Promise<void> {
    const samples = Math.round((AUDIO_SAMPLE_RATE * durationMs) / 1000);
    const buf = Buffer.alloc(samples * 2);
    const amplitude = 0.3 * 32767;
    for (let i = 0; i < samples; i++) {
      const v = Math.round(
        amplitude *
          Math.sin((2 * Math.PI * frequencyHz * i) / AUDIO_SAMPLE_RATE),
      );
      buf.writeInt16LE(v, i * 2);
    }
    this.playChunk(buf);
    this.endPlayback();
  }

  stopRecording(): void {
    if (!this.recording || !this.micInstance) return;
    try {
      this.micInstance.stop();
    } catch (err) {
      logger.warn(`[audio] mic.stop error: ${(err as Error).message}`);
    }
    this.micInstance = null;
    this.recording = false;
    logger.info("[audio] recording stopped");
  }
}
