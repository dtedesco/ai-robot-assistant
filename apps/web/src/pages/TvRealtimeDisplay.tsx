/**
 * TV Display for Realtime Agent sessions.
 *
 * This is a pure display - no camera, no mic, no interaction.
 * It connects to the API WebSocket and shows whatever content
 * the RealtimeDisplay (agent screen) sends.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { TvContent, TvDownMsg } from "@robot/shared";
import { openJsonWs, wsUrl } from "@/lib/ws";
import TvContentView from "@/components/TvContent";

export default function TvRealtimeDisplay() {
  const { agentId } = useParams<{ agentId: string }>();
  const [content, setContent] = useState<TvContent | null>(null);
  const [idleBackground, setIdleBackground] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!agentId) return;

    const handle = openJsonWs(wsUrl(`/ws/tv/realtime/${agentId}`), {
      reconnect: true,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
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
          // Other message types are not used in this display
        }
      },
    });

    return () => handle.close();
  }, [agentId]);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      {/* Connection indicator (subtle, top-right) */}
      <div className="absolute top-4 right-4 z-50">
        <div
          className={`w-2 h-2 rounded-full ${
            connected ? "bg-green-500" : "bg-red-500 animate-pulse"
          }`}
          title={connected ? "Connected" : "Connecting..."}
        />
      </div>

      {content ? (
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
      <style>{`
        .orb {
          position: absolute;
          width: 45vmin;
          height: 45vmin;
          border-radius: 50%;
          filter: blur(60px);
          mix-blend-mode: screen;
          opacity: 0.65;
        }
        .orb-a { background: radial-gradient(circle, #4c7bff 0%, transparent 70%); top: -10%; left: 10%; animation: drift-a 18s ease-in-out infinite; }
        .orb-b { background: radial-gradient(circle, #b844ff 0%, transparent 70%); bottom: -15%; right: 5%; animation: drift-b 22s ease-in-out infinite; }
        .orb-c { background: radial-gradient(circle, #00d7c9 0%, transparent 70%); top: 40%; left: 45%; animation: drift-c 26s ease-in-out infinite; }
        @keyframes drift-a {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(30vw, 35vh) scale(1.25); }
        }
        @keyframes drift-b {
          0%, 100% { transform: translate(0, 0) scale(1.1); }
          50% { transform: translate(-35vw, -30vh) scale(0.85); }
        }
        @keyframes drift-c {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.5; }
          50% { transform: translate(-20vw, -15vh) scale(1.4); opacity: 0.75; }
        }
        .grid-overlay {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
          background-size: 60px 60px;
          mask-image: radial-gradient(ellipse at center, #000 30%, transparent 80%);
        }
      `}</style>
    </div>
  );
}
