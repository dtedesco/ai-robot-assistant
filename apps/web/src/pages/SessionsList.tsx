import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { AgentDTO, BridgeDTO, SessionDTO } from "@robot/shared";
import { api } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { SkeletonRow } from "@/components/Skeleton";
import EmptyState, { MessageSquareIcon } from "@/components/EmptyState";
import StatusBadge from "@/components/StatusBadge";

export default function SessionsList() {
  const sessionsQuery = useQuery<SessionDTO[]>({
    queryKey: ["sessions"],
    queryFn: () => api.get<SessionDTO[]>("/api/sessions"),
    refetchInterval: 5000,
  });

  const agentsQuery = useQuery<AgentDTO[]>({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentDTO[]>("/api/agents"),
  });

  const bridgesQuery = useQuery<BridgeDTO[]>({
    queryKey: ["bridges"],
    queryFn: () => api.get<BridgeDTO[]>("/api/bridges"),
  });

  const agentById = new Map(
    (agentsQuery.data ?? []).map((a) => [a.id, a]),
  );
  const bridgeById = new Map(
    (bridgesQuery.data ?? []).map((b) => [b.id, b]),
  );

  return (
    <div>
      <PageHeader
        title="Sessões"
        subtitle="Histórico e sessões ao vivo."
        actions={
          <Link to="/connect" className="btn-primary">
            Nova sessão
          </Link>
        }
      />

      <div className="card overflow-hidden">
        {sessionsQuery.isLoading ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Agente</th>
                <th>Bridge</th>
                <th>Início</th>
                <th>Fim</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonRow key={i} cols={5} />
              ))}
            </tbody>
          </table>
        ) : sessionsQuery.error ? (
          <div className="p-8 flex flex-col items-center gap-3 text-sm">
            <div className="text-danger">
              Erro ao carregar sessões:{" "}
              {sessionsQuery.error instanceof Error
                ? sessionsQuery.error.message
                : "desconhecido"}
            </div>
            <button
              type="button"
              onClick={() => sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
              className="btn-secondary"
            >
              {sessionsQuery.isFetching ? "Tentando..." : "Tentar novamente"}
            </button>
          </div>
        ) : !sessionsQuery.data || sessionsQuery.data.length === 0 ? (
          <EmptyState
            icon={<MessageSquareIcon />}
            title="Nenhuma sessão registrada"
            description="Inicie uma sessão conectando o robô via uma bridge para vê-la aqui."
            action={
              <Link to="/connect" className="btn-primary">
                Iniciar sessão
              </Link>
            }
          />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Agente</th>
                <th>Bridge</th>
                <th>Início</th>
                <th>Fim</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sessionsQuery.data.map((s) => {
                const live = s.endedAt == null;
                return (
                  <tr key={s.id}>
                    <td>
                      <Link
                        to={`/sessions/${s.id}`}
                        className="text-fg hover:text-accent"
                      >
                        {agentById.get(s.agentId)?.name ?? s.agentId}
                      </Link>
                    </td>
                    <td className="text-fg-muted">
                      {bridgeById.get(s.bridgeId)?.name ?? s.bridgeId}
                    </td>
                    <td className="text-xs text-fg-muted">
                      {new Date(s.startedAt).toLocaleString()}
                    </td>
                    <td className="text-xs text-fg-muted">
                      {s.endedAt
                        ? new Date(s.endedAt).toLocaleString()
                        : "-"}
                    </td>
                    <td>
                      <StatusBadge kind={live ? "running" : "ended"} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
