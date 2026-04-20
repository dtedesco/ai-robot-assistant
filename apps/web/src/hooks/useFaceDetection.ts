import * as faceapi from "face-api.js";
import { useEffect, useRef, useState, useCallback } from "react";

export interface FaceDetectionConfig {
  /** Whether face detection is enabled */
  enabled: boolean;
  /** Interval between detection attempts (ms) */
  detectionIntervalMs: number;
  /** Time with stable face before triggering idle (ms) */
  idleTimeoutMs: number;
  /** Minimum confidence score for detection */
  minConfidence: number;
}

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceDetectionState {
  /** Whether models are loaded and ready */
  isReady: boolean;
  /** Whether a face is currently detected */
  hasDetection: boolean;
  /** Bounding box of detected face (relative to video) */
  faceBox: FaceBox | null;
  /** Error message if any */
  error: string | null;
}

const DEFAULT_CONFIG: FaceDetectionConfig = {
  enabled: true,
  detectionIntervalMs: 500,
  idleTimeoutMs: 3000,
  minConfidence: 0.5,
};

/**
 * Hook for face detection using face-api.js.
 *
 * Loads TinyFaceDetector, FaceLandmark68, and FaceRecognition models,
 * then runs continuous detection on the provided video element.
 *
 * @param videoRef - Ref to the video element showing camera feed
 * @param config - Detection configuration
 * @param onFaceDetected - Called when a face is detected with 128-dim descriptor
 * @param onFaceIdle - Called when face has been stable for idleTimeoutMs
 * @param onFaceLost - Called when face leaves the frame
 */
export function useFaceDetection(
  videoRef: React.RefObject<HTMLVideoElement>,
  config: Partial<FaceDetectionConfig>,
  onFaceDetected: (descriptor: number[]) => void,
  onFaceIdle: () => void,
  onFaceLost: () => void,
): FaceDetectionState {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  const [isReady, setIsReady] = useState(false);
  const [hasDetection, setHasDetection] = useState(false);
  const [faceBox, setFaceBox] = useState<FaceBox | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track last detection time for idle detection
  const lastDetectionTime = useRef<number>(0);
  const lastDescriptor = useRef<number[] | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectionLoop = useRef<ReturnType<typeof setInterval> | null>(null);
  const hadFace = useRef(false);

  // Load models on mount
  useEffect(() => {
    let mounted = true;

    async function loadModels() {
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
          faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
          faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
        ]);
        if (mounted) {
          setIsReady(true);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(`Failed to load face detection models: ${err}`);
        }
      }
    }

    loadModels();

    return () => {
      mounted = false;
    };
  }, []);

  // Detection function
  const detectFace = useCallback(async () => {
    if (!videoRef.current || !fullConfig.enabled || !isReady) return;

    const video = videoRef.current;

    // Ensure video is ready
    if (video.readyState < 2) return;

    try {
      const detection = await faceapi
        .detectSingleFace(
          video,
          new faceapi.TinyFaceDetectorOptions({
            inputSize: 320,
            scoreThreshold: fullConfig.minConfidence,
          }),
        )
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection) {
        const descriptor = Array.from(detection.descriptor);
        const box = detection.detection.box;

        setHasDetection(true);
        setFaceBox({
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        });

        const wasNewFace = !hadFace.current;
        hadFace.current = true;
        lastDetectionTime.current = Date.now();
        lastDescriptor.current = descriptor;

        // Call onFaceDetected on every detection (for matching)
        onFaceDetected(descriptor);

        // Start idle timer only when face FIRST appears (not on every detection)
        if (wasNewFace && !idleTimer.current) {
          idleTimer.current = setTimeout(() => {
            idleTimer.current = null;
            onFaceIdle();
          }, fullConfig.idleTimeoutMs);
        }
      } else {
        // No face detected
        if (hadFace.current) {
          setHasDetection(false);
          setFaceBox(null);
          hadFace.current = false;
          lastDescriptor.current = null;

          // Clear idle timer
          if (idleTimer.current) {
            clearTimeout(idleTimer.current);
            idleTimer.current = null;
          }

          onFaceLost();
        }
      }
    } catch (err) {
      console.error("Face detection error:", err);
    }
  }, [videoRef, fullConfig, isReady, onFaceDetected, onFaceIdle, onFaceLost]);

  // Start/stop detection loop based on config
  useEffect(() => {
    if (!isReady || !fullConfig.enabled) {
      if (detectionLoop.current) {
        clearInterval(detectionLoop.current);
        detectionLoop.current = null;
      }
      return;
    }

    detectionLoop.current = setInterval(detectFace, fullConfig.detectionIntervalMs);

    return () => {
      if (detectionLoop.current) {
        clearInterval(detectionLoop.current);
        detectionLoop.current = null;
      }
      if (idleTimer.current) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    };
  }, [isReady, fullConfig.enabled, fullConfig.detectionIntervalMs, detectFace]);

  return {
    isReady,
    hasDetection,
    faceBox,
    error,
  };
}
