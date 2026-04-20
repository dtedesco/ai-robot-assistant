import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentDTO,
  SessionDTO,
  SessionEvent,
  TranscriptEntry,
  TvContent,
} from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import { useAdminWs } from "@/hooks/useAdminWs";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import PageHeader from "@/components/PageHeader";
import { SkeletonCard } from "@/components/Skeleton";
import StatusBadge from "@/components/StatusBadge";
import Spinner from "@/components/Spinner";
import { useToast } from "@/hooks/useToast";

const COLOR_SWATCHES: Record<number, string> = {
  1: "#ffffff",
  2: "#3b82f6",
  3: "#22c55e",
  4: "#eab308",
  5: "#ef4444",
  6: "#a855f7",
  7: "#06b6d4",
};

interface SessionLiveState {
  transcript: TranscriptEntry[];
  lastEmotion: string | null;
  lastColor: number | null;
  lastTvContent: TvContent | null;
  ended: boolean;
}

function reduceEvents(events: SessionEvent[]): SessionLiveState {
  const state: SessionLiveState = {
    transcript: [],
    lastEmotion: null,
    lastColor: null,
    lastTvContent: null,
    ended: false,
  };
  for (const ev of events) {
    switch (ev.type) {
      case "transcript":
        state.transcript.push(ev.entry);
        break;
      case "emotion":
        state.lastEmotion = ev.emotion;
        break;
      case "robot:color":
        state.lastColor = ev.color;
        break;
      case "tv":
        if (ev.msg.type === "display") state.lastTvContent = ev.msg.content;
        else if (ev.msg.type === "clear") state.lastTvContent = null;
        break;
      case "ended":
        state.ended = true;
        break;
    }
  }
  return state;
}

export default function SessionView() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const ws = useAdminWs();
  const toast = useToast();
  const { events, connected } = useSessionEvents(id);
  const [textInput, setTextInput] = useState("");
  const [copied, setCopied] = useState(false);

  const sessionQuery = useQuery<SessionDTO>({
    queryKey: ["sessions", id],
    queryFn: () => api.get<SessionDTO>(`/api/sessions/${id}`),
    enabled: Boolean(id),
  });

  const session = sessionQuery.data;

  const agentQuery = useQuery<AgentDTO>({
    queryKey: ["agents", session?.agentId],
    queryFn: () => api.get<AgentDTO>(`/api/agents/${session!.agentId}`),
    enabled: Boolean(session?.agentId),
  });

  const endMutation = useMutation({
    mutationFn: () => api.post<void>(`/api/sessions/${id}/end`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["sessions", id] });
      toast.success("Sessão encerrada.");
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao encerrar";
      toast.error(msg);
    },
  });

  const live = useMemo(() => reduceEvents(events), [events]);

  const tvUrl = useMemo(() => {
    if (!id) return "";
    return `${window.location.origin}/tv/${id}`;
  }, [id]);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [live.transcript.length]);

  // Show a reconnecting banner if WS drops while the session is still live.
  // Delay a bit to avoid flashing on transient state flips.
  const ended = Boolean(session?.endedAt) || live.ended;
  const [showReconnect, setShowReconnect] = useState(false);
  useEffect(() => {
    if (connected || ended) {
      setShowReconnect(false);
      return;
    }
    const t = setTimeout(() => setShowReconnect(true), 800);
    return () => clearTimeout(t);
  }, [connected, ended]);

  function onEnd() {
    if (!confirm("Encerrar sessão?")) return;
    endMutation.mutate();
  }

  function onSendText(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !textInput.trim()) return;
    ws.send({ type: "sendText", sessionId: id, text: textInput.trim() });
    setTextInput("");
  }

  async function copyTvUrl() {
    try {
      await navigator.clipboard.writeText(tvUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Falha ao copiar URL");
    }
  }

  if (sessionQuery.isLoading) {
    return (
      <div>
        <PageHeader
          title="Sessão"
          breadcrumbs={[{ label: "Sessões", to: "/admin/sessions" }, { label: "Carregando" }]}
        />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <SkeletonCard lines={5} />
          </div>
          <div className="space-y-6">
            <SkeletonCard lines={1} />
            <SkeletonCard lines={2} />
          </div>
        </div>
      </div>
    );
  }
  if (sessionQuery.error || !session) {
    return (
      <div>
        <PageHeader
          title="Sessão"
          breadcrumbs={[{ label: "Sessões", to: "/admin/sessions" }, { label: "Não encontrada" }]}
        />
        <div className="card p-8 text-sm text-danger text-center">
          Sessão não encontrada.
        </div>
      </div>
    );
  }

  return (
    <div>
      {showReconnect && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger flex items-center gap-2"
        >
          <Spinner className="h-3.5 w-3.5" />
          <span>Conexão perdida — reconectando...</span>
        </div>
      )}

      <PageHeader
        title={agentQuery.data?.name ?? "Sessão"}
        breadcrumbs={[
          { label: "Sessões", to: "/admin/sessions" },
          { label: agentQuery.data?.name ?? "Detalhes" },
        ]}
        subtitle={
          <span className="inline-flex items-center gap-3">
            <StatusBadge
              kind={connected ? "online" : "offline"}
              label={`WS ${connected ? "ligado" : "desligado"}`}
            />
            <StatusBadge kind={ended ? "ended" : "running"} />
          </span>
        }
        actions={
          !ended ? (
            <button
              type="button"
              onClick={onEnd}
              disabled={endMutation.isPending}
              className="btn-danger"
            >
              {endMutation.isPending ? (
                <Spinner label="Encerrando..." />
              ) : (
                "Encerrar"
              )}
            </button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 card p-5 flex flex-col min-h-[420px]">
          <div className="text-sm font-semibold mb-3">Transcrição</div>
          <div
            ref={transcriptRef}
            className="flex-1 overflow-auto space-y-3 pr-1"
          >
            {live.transcript.length === 0 ? (
              <div className="text-xs text-fg-subtle italic">
                Aguardando áudio...
              </div>
            ) : (
              live.transcript.map((t, i) => (
                <div
                  key={i}
                  className={
                    t.role === "assistant"
                      ? "bg-accent/10 border border-accent/20 rounded-md px-3 py-2"
                      : "bg-bg-muted/60 border border-border rounded-md px-3 py-2"
                  }
                >
                  <div className="text-[10px] uppercase tracking-wide text-fg-muted flex justify-between">
                    <span>{t.role}</span>
                    <span>{new Date(t.ts).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-sm mt-1 whitespace-pre-wrap">
                    {t.text}
                  </div>
                </div>
              ))
            )}
          </div>

          <form onSubmit={onSendText} className="mt-3 flex gap-2">
            <input
              className="input flex-1"
              placeholder="Enviar mensagem (fallback sem microfone)"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              disabled={ended}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={ended || !textInput.trim()}
            >
              Enviar
            </button>
          </form>
        </section>

        <div className="space-y-6">
          <section className="card p-5">
            <div className="text-sm font-semibold mb-3">Olhos</div>
            <div className="flex items-center gap-3">
              <div
                className="h-12 w-12 rounded-full border-2 border-border transition-colors"
                style={{
                  backgroundColor:
                    live.lastColor != null
                      ? COLOR_SWATCHES[live.lastColor]
                      : "#2a2f38",
                }}
              />
              <div className="text-xs text-fg-muted">
                <div>cor: {live.lastColor ?? "-"}</div>
                <div>emoção: {live.lastEmotion ?? "-"}</div>
              </div>
            </div>
          </section>

          <section className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold">TV</div>
              <a
                href={tvUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent hover:underline"
              >
                Abrir em nova tela
              </a>
            </div>

            <div className="aspect-video bg-black rounded-md overflow-hidden border border-border">
              {id && (
                <iframe
                  src={`/tv/${id}`}
                  title="TV preview"
                  className="w-full h-full"
                />
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <input
                readOnly
                value={tvUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="input text-xs font-mono"
              />
              <button
                type="button"
                onClick={copyTvUrl}
                className={copied ? "btn-primary" : "btn-secondary"}
              >
                {copied ? "Copiado!" : "Copiar"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
