/**
 * Hook for playing audio from OpenAI Realtime.
 *
 * Uses Web Audio API to play PCM16 mono @ 24kHz chunks
 * with seamless queueing for continuous playback.
 */
import { useEffect, useRef, useState, useCallback } from "react";

const SAMPLE_RATE = 24000;

export interface AudioPlaybackState {
  isPlaying: boolean;
  volume: number;
}

/**
 * Convert PCM16 base64 to Float32 audio samples.
 */
function pcm16Base64ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const pcm16 = new Int16Array(buffer);
  const outBuffer = new ArrayBuffer(pcm16.length * 4);
  const float32 = new Float32Array(outBuffer);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i]! / 0x8000;
  }
  return float32;
}

export function useAudioPlayback(options: {
  volume?: number;
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
} = {}): {
  state: AudioPlaybackState;
  playChunk: (pcmBase64: string) => void;
  endPlayback: () => void;
  resetPlayback: () => void;
  setVolume: (vol: number) => void;
} {
  const { volume: initialVolume = 1.0, onPlaybackStart, onPlaybackEnd } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolumeState] = useState(initialVolume);

  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const queueRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartTimeRef = useRef<number>(0);
  const isPlayingRef = useRef(false);

  // Initialize audio context lazily (must be triggered by user interaction)
  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = ctx;

      const gain = ctx.createGain();
      gain.gain.value = volume;
      gain.connect(ctx.destination);
      gainNodeRef.current = gain;
    }

    // Resume if suspended (browser autoplay policy)
    if (audioContextRef.current.state === "suspended") {
      void audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }, [volume]);

  const playChunk = useCallback((pcmBase64: string) => {
    const ctx = ensureAudioContext();
    const samples = pcm16Base64ToFloat32(pcmBase64);

    // Create buffer
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    // Create source
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNodeRef.current!);

    // Schedule playback
    const now = ctx.currentTime;
    const startTime = Math.max(now, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + buffer.duration;

    // Track playing state
    if (!isPlayingRef.current) {
      isPlayingRef.current = true;
      setIsPlaying(true);
      onPlaybackStart?.();
    }

    // Clean up when done
    source.onended = () => {
      const idx = queueRef.current.indexOf(source);
      if (idx !== -1) queueRef.current.splice(idx, 1);

      // Check if all done
      if (queueRef.current.length === 0 && ctx.currentTime >= nextStartTimeRef.current - 0.01) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        onPlaybackEnd?.();
      }
    };

    queueRef.current.push(source);
  }, [ensureAudioContext, onPlaybackStart, onPlaybackEnd]);

  const endPlayback = useCallback(() => {
    // Let current audio finish naturally
    // Just mark that no more chunks are coming
  }, []);

  const resetPlayback = useCallback(() => {
    // Stop all queued audio immediately
    for (const source of queueRef.current) {
      try {
        source.stop();
      } catch {
        // ignore
      }
    }
    queueRef.current = [];
    nextStartTimeRef.current = 0;
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, []);

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = clamped;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      resetPlayback();
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [resetPlayback]);

  return {
    state: { isPlaying, volume },
    playChunk,
    endPlayback,
    resetPlayback,
    setVolume,
  };
}
