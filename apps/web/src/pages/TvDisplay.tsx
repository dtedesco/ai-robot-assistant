import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type {
  AgentDTO,
  SessionDTO,
  SessionEvent,
  TvContent,
  TvDownMsg,
} from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import { openJsonWs, tvWsUrl } from "@/lib/ws";
import TvContentView from "@/components/TvContent";

type Status = "connecting" | "listening" | "speaking" | "ended" | "error";

interface TvPayload {
  content: TvContent | null;
  status: Status;
  agentName: string | null;
  errorMessage: string | null;
}

const NAME_FALLBACK_MS = 3000;

export default function TvDisplay() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [state, setState] = useState<TvPayload>({
    content: null,
    status: "connecting",
    agentName: null,
    errorMessage: null,
  });
  // If agent name does not arrive within 3s, switch to the generic "Pronto"
  // label with a soft fade-in (avoids the ugly hard-coded "Robot" flash).
  const [nameTimedOut, setNameTimedOut] = useState(false);

  useEffect(() => {
    if (state.agentName) {
      setNameTimedOut(false);
      return;
    }
    const t = setTimeout(() => setNameTimedOut(true), NAME_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [state.agentName]);

  // Public endpoint to get public info (agent name). We rely on a public GET
  // /api/sessions/:id/public — backend may or may not have it; if not, we
  // degrade gracefully and just show "Pronto".
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await api.get<SessionDTO>(
          `/api/sessions/${sessionId}/public`,
          { auth: false },
        );
        if (cancelled) return;
        try {
          const a = await api.get<AgentDTO>(
            `/api/agents/${s.agentId}/public`,
            { auth: false },
          );
          if (!cancelled) {
            setState((prev) => ({ ...prev, agentName: a.name }));
          }
        } catch {
          // ignore
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // public endpoints not implemented — silently ignore
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    const h = openJsonWs(tvWsUrl(sessionId), {
      reconnect: true,
      onOpen: () =>
        setState((prev) => ({
          ...prev,
          status: prev.status === "ended" ? prev.status : "listening",
          errorMessage: null,
        })),
      onClose: () =>
        setState((prev) =>
          prev.status === "ended"
            ? prev
            : { ...prev, status: "connecting" },
        ),
      onMessage: (data) => {
        const msg = data as TvDownMsg | { type: "session:event"; event: SessionEvent };
        if ("type" in msg && msg.type === "display") {
          setState((prev) => ({
            ...prev,
            content: msg.content,
            status: "speaking",
          }));
        } else if ("type" in msg && msg.type === "clear") {
          setState((prev) => ({
            ...prev,
            content: null,
            status: "listening",
          }));
        } else if ("type" in msg && msg.type === "session:event") {
          // some backends may forward session events through the TV channel.
          const ev = msg.event;
          if (ev.type === "ended") {
            setState((prev) => ({ ...prev, status: "ended", content: null }));
          } else if (ev.type === "tv") {
            if (ev.msg.type === "display") {
              setState((prev) => ({
                ...prev,
                content: ev.msg.type === "display" ? ev.msg.content : null,
                status: "speaking",
              }));
            } else if (ev.msg.type === "clear") {
              setState((prev) => ({
                ...prev,
                content: null,
                status: "listening",
              }));
            }
          }
        }
      },
    });

    return () => h.close();
  }, [sessionId]);

  const badge = useMemo(() => {
    switch (state.status) {
      case "listening":
        return { label: "ouvindo", dot: "bg-success" };
      case "speaking":
        return { label: "falando", dot: "bg-accent" };
      case "connecting":
        return { label: "conectando", dot: "bg-fg-muted" };
      case "ended":
        return { label: "encerrada", dot: "bg-fg-subtle" };
      case "error":
        return { label: "erro", dot: "bg-danger" };
    }
  }, [state.status]);

  // Resolve title to show on idle screen. If agent name is loaded, use it.
  // Otherwise, only show "Pronto" after the timeout (fades in).
  const idleTitle = state.agentName ?? (nameTimedOut ? "Pronto" : "");
  const showIdleTitle = idleTitle.length > 0;

  return (
    <div className="fixed inset-0 bg-black text-white overflow-hidden">
      {state.content ? (
        <div className="absolute inset-0">
          <TvContentView content={state.content} />
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black">
          <div
            className={`text-7xl md:text-8xl font-semibold tracking-tight transition-opacity duration-700 ease-out ${
              showIdleTitle ? "opacity-100" : "opacity-0"
            }`}
          >
            {idleTitle || "\u00A0"}
          </div>
          <div
            className={`mt-4 text-lg md:text-xl text-white/50 transition-opacity duration-700 ease-out ${
              showIdleTitle ? "opacity-100" : "opacity-0"
            }`}
          >
            {state.status === "ended"
              ? "Sessão encerrada"
              : state.status === "connecting"
                ? "Conectando"
                : state.agentName
                  ? "Pronto para conversar"
                  : "Aguardando sessão"}
          </div>
        </div>
      )}

      <div className="absolute top-4 right-4 z-10 flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded-full px-3 py-1.5 text-xs text-white/80">
        <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
        {state.agentName && <span className="text-white/90">{state.agentName}</span>}
        <span className="text-white/50">· {badge.label}</span>
      </div>
    </div>
  );
}
