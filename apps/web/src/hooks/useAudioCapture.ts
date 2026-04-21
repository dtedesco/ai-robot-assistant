/**
 * Hook for capturing audio from the microphone.
 *
 * Uses Web Audio API to capture PCM16 mono @ 24kHz,
 * which is the format expected by OpenAI Realtime.
 */
import { useEffect, useRef, useState, useCallback } from "react";

const TARGET_SAMPLE_RATE = 24000;
const BUFFER_SIZE = 4096;

export interface AudioCaptureState {
  isCapturing: boolean;
  hasPermission: boolean;
  error: string | null;
}

/**
 * Convert Float32 audio samples to PCM16 base64.
 */
function float32ToPcm16Base64(float32: Float32Array): string {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Resample audio from source rate to target rate.
 */
function resample(
  input: Float32Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
    const t = srcIndex - srcIndexFloor;
    output[i] = input[srcIndexFloor]! * (1 - t) + input[srcIndexCeil]! * t;
  }
  return output;
}

export function useAudioCapture(
  onAudioChunk: (pcmBase64: string) => void,
  options: {
    enabled?: boolean;
    gain?: number;
    deviceId?: string;
  } = {},
): AudioCaptureState {
  const { enabled = true, gain = 1.0, deviceId } = options;

  const [isCapturing, setIsCapturing] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const onAudioChunkRef = useRef(onAudioChunk);
  onAudioChunkRef.current = onAudioChunk;

  const startCapture = useCallback(async () => {
    try {
      // Build audio constraints
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: TARGET_SAMPLE_RATE,
      };

      // Add device ID if specified
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId };
      }

      // Get microphone access (with fallback if device not found)
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
      } catch (err) {
        if (deviceId) {
          console.warn("[audio] Device not found, trying without deviceId constraint");
          delete audioConstraints.deviceId;
          stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
          });
        } else {
          throw err;
        }
      }

      streamRef.current = stream;
      setHasPermission(true);

      // Create audio context
      const audioContext = new AudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
      });
      audioContextRef.current = audioContext;

      // Create source from stream
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Create gain node
      const gainNode = audioContext.createGain();
      gainNode.gain.value = gain;
      gainNodeRef.current = gainNode;

      // Use ScriptProcessor for compatibility (AudioWorklet requires HTTPS)
      const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);

        // Resample if needed
        const resampled =
          audioContext.sampleRate !== TARGET_SAMPLE_RATE
            ? resample(inputData, audioContext.sampleRate, TARGET_SAMPLE_RATE)
            : inputData;

        // Apply gain
        const gained = new Float32Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const boosted = resampled[i]! * gain;
          gained[i] = Math.max(-1, Math.min(1, boosted));
        }

        // Convert to PCM16 base64
        const pcmBase64 = float32ToPcm16Base64(gained);
        onAudioChunkRef.current(pcmBase64);
      };

      // Connect: source -> gain -> processor -> destination
      source.connect(gainNode);
      gainNode.connect(processor);
      processor.connect(audioContext.destination);

      setIsCapturing(true);
      setError(null);
      console.log("[audio] capture started", deviceId ? `on device ${deviceId}` : "");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[audio] capture error:", message);
      setError(message);
      setIsCapturing(false);
    }
  }, [gain, deviceId]);

  const stopCapture = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (gainNodeRef.current) {
      gainNodeRef.current.disconnect();
      gainNodeRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCapturing(false);
    console.log("[audio] capture stopped");
  }, []);

  // Track if capture is active
  const isActiveRef = useRef(false);

  // Start/stop based on enabled - only restart if enabled changes
  useEffect(() => {
    if (enabled && !isActiveRef.current) {
      isActiveRef.current = true;
      void startCapture();
    } else if (!enabled && isActiveRef.current) {
      isActiveRef.current = false;
      stopCapture();
    }

    return () => {
      if (isActiveRef.current) {
        isActiveRef.current = false;
        stopCapture();
      }
    };
  }, [enabled]); // Only depend on enabled, not startCapture/stopCapture

  // Update gain dynamically
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = gain;
    }
  }, [gain]);

  return {
    isCapturing,
    hasPermission,
    error,
  };
}
