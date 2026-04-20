import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import type { TvContent, TvDownMsg, TvUpMsg } from "@robot/shared";
import { openJsonWs, wsUrl, type JsonWebSocketHandle } from "@/lib/ws";
import TvContentView from "@/components/TvContent";
import { useFaceDetection } from "@/hooks/useFaceDetection";

interface IdentifiedPerson {
  personId: string;
  name: string;
}

/**
 * Bridge-scoped TV display. The URL is stable per bridge (admin creates the
 * bridge → gets its id → opens `/tv/bridge/<bridgeId>` on any screen). The
 * bridge drives content directly via its OpenAI tool calls; no session
 * required.
 *
 * Now also includes face detection via camera for personalized greetings.
 */
export default function TvBridgeDisplay() {
  const { bridgeId } = useParams<{ bridgeId: string }>();
  const [content, setContent] = useState<TvContent | null>(null);
  const [idleBackground, setIdleBackground] = useState<string | null>(null);

  // Face detection state
  const [faceEnabled, setFaceEnabled] = useState(true);
  const [identifiedPerson, setIdentifiedPerson] = useState<IdentifiedPerson | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<JsonWebSocketHandle | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Initialize camera
  useEffect(() => {
    if (!faceEnabled) return;

    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraError(null);
      })
      .catch((err) => {
        console.error("Camera error:", err);
        setCameraError(`Camera access denied: ${err.message}`);
      });

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, [faceEnabled]);

  // Send face detection event to server
  const sendFaceEvent = useCallback((msg: TvUpMsg) => {
    wsRef.current?.send(msg);
  }, []);

  // Face detection callbacks
  const handleFaceDetected = useCallback(
    (descriptor: number[]) => {
      sendFaceEvent({ type: "face:detected", descriptor });
    },
    [sendFaceEvent],
  );

  const handleFaceIdle = useCallback(() => {
    sendFaceEvent({ type: "face:idle" });
  }, [sendFaceEvent]);

  const handleFaceLost = useCallback(() => {
    sendFaceEvent({ type: "face:lost" });
    setIdentifiedPerson(null);
  }, [sendFaceEvent]);

  // Face detection hook
  const { isReady: faceReady, hasDetection, error: faceError } = useFaceDetection(
    videoRef,
    {
      enabled: faceEnabled && !cameraError,
      detectionIntervalMs: 500,
      idleTimeoutMs: 3000,
      minConfidence: 0.5,
    },
    handleFaceDetected,
    handleFaceIdle,
    handleFaceLost,
  );

  // WebSocket connection
  useEffect(() => {
    if (!bridgeId) return;
    const handle = openJsonWs(wsUrl(`/ws/tv/bridge/${bridgeId}`), {
      reconnect: true,
      onMessage: (data) => {
        const msg = data as TvDownMsg;
        switch (msg.type) {
          case "display":
            setContent(msg.content);
            break;
          case "clear":
            setContent(null);
            break;
          case "idle-config":
            setIdleBackground(msg.backgroundUrl);
            break;
          case "face:identified":
            setIdentifiedPerson({ personId: msg.personId, name: msg.name });
            break;
          case "face:unknown":
            setIdentifiedPerson(null);
            break;
          case "face:registered":
            setIdentifiedPerson({ personId: msg.personId, name: msg.name });
            break;
          case "face:config":
            setFaceEnabled(msg.enabled);
            break;
          // "hello" is just the handshake; ignore.
        }
      },
    });
    wsRef.current = handle;
    return () => {
      handle.close();
      wsRef.current = null;
    };
  }, [bridgeId]);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      {/* Hidden video for face detection camera */}
      {faceEnabled && (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="absolute opacity-0 pointer-events-none"
          style={{ width: 1, height: 1, top: 0, left: 0 }}
        />
      )}

      {/* Face detection status indicator (small, bottom-right corner) */}
      {faceEnabled && (
        <div className="absolute bottom-4 right-4 z-50 flex items-center gap-2">
          {!faceReady && (
            <span className="text-xs text-gray-500">Loading face detection...</span>
          )}
          {faceError && (
            <span className="text-xs text-red-500">{faceError}</span>
          )}
          {cameraError && (
            <span className="text-xs text-red-500">{cameraError}</span>
          )}
          {faceReady && !cameraError && (
            <div
              className={`w-3 h-3 rounded-full transition-colors ${
                hasDetection ? "bg-green-500" : "bg-gray-600"
              }`}
              title={hasDetection ? "Face detected" : "No face detected"}
            />
          )}
          {identifiedPerson && (
            <span className="text-xs text-green-400">
              {identifiedPerson.name}
            </span>
          )}
        </div>
      )}

      {content ? (
        // `key` forces remount when content changes → animation replays.
        <div key={JSON.stringify(content)} className="w-full h-full tv-in">
          <TvContentView content={content} />
          <style>{`
            @keyframes tv-in-kf {
              0%   { opacity: 0; transform: scale(0.92); filter: blur(8px); }
              60%  { opacity: 1; filter: blur(0); }
              100% { opacity: 1; transform: scale(1); filter: blur(0); }
            }
            .tv-in { animation: tv-in-kf 0.55s cubic-bezier(0.2, 0.7, 0.2, 1); transform-origin: center; }
          `}</style>
        </div>
      ) : (
        <IdleScene backgroundUrl={idleBackground} />
      )}
    </div>
  );
}

/**
 * Idle-state scene. If a `backgroundUrl` is provided (configured per agent
 * in the admin), it's rendered full-screen — images as `background-image`,
 * videos looped via `<video>`. Falls back to the pure-CSS futuristic orbs
 * when unset.
 */
function IdleScene({ backgroundUrl }: { backgroundUrl: string | null }) {
  if (backgroundUrl) {
    const isVideo = /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(backgroundUrl);
    if (isVideo) {
      return (
        <div className="w-full h-full bg-black">
          <video
            src={backgroundUrl}
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-full object-cover"
          />
        </div>
      );
    }
    return (
      <div
        className="w-full h-full bg-black"
        style={{
          backgroundImage: `url(${backgroundUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      />
    );
  }

  return (
    <div
      className="w-full h-full relative overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at 30% 20%, #0a1030 0%, #000 60%), radial-gradient(ellipse at 70% 80%, #1a0530 0%, #000 60%)",
      }}
    >
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="orb orb-c" />
      <div className="grid-overlay" />
      <div className="scanline" />
      <style>{`
        .orb {
          position: absolute;
          width: 45vmin;
          height: 45vmin;
          border-radius: 50%;
          filter: blur(60px);
          mix-blend-mode: screen;
          opacity: 0.65;
          will-change: transform, opacity;
        }
        .orb-a { background: radial-gradient(circle, #4c7bff 0%, transparent 70%); top: -10%; left: 10%;  animation: drift-a 18s ease-in-out infinite; }
        .orb-b { background: radial-gradient(circle, #b844ff 0%, transparent 70%); bottom: -15%; right: 5%;  animation: drift-b 22s ease-in-out infinite; }
        .orb-c { background: radial-gradient(circle, #00d7c9 0%, transparent 70%); top: 40%; left: 45%; animation: drift-c 26s ease-in-out infinite; }
        @keyframes drift-a {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50%      { transform: translate(30vw, 35vh) scale(1.25); }
        }
        @keyframes drift-b {
          0%, 100% { transform: translate(0, 0) scale(1.1); }
          50%      { transform: translate(-35vw, -30vh) scale(0.85); }
        }
        @keyframes drift-c {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.5; }
          50%      { transform: translate(-20vw, -15vh) scale(1.4); opacity: 0.75; }
        }
        .grid-overlay {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
          background-size: 60px 60px;
          mask-image: radial-gradient(ellipse at center, #000 30%, transparent 80%);
        }
        .scanline {
          position: absolute; inset: 0;
          background: linear-gradient(to bottom, transparent 0%, rgba(120,200,255,0.12) 50%, transparent 100%);
          height: 20%;
          animation: scan 7s linear infinite;
          pointer-events: none;
        }
        @keyframes scan {
          0%   { transform: translateY(-20%); }
          100% { transform: translateY(500%); }
        }
      `}</style>
    </div>
  );
}
