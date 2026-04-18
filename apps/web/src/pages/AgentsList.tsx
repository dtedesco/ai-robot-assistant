import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentDTO } from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { SkeletonRow } from "@/components/Skeleton";
import EmptyState, { UsersIcon } from "@/components/EmptyState";
import { useToast } from "@/hooks/useToast";

export default function AgentsList() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, error, refetch, isFetching } = useQuery<AgentDTO[]>({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentDTO[]>("/api/agents"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Agente removido.");
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Falha ao remover";
      toast.error(msg);
    },
  });

  function onDelete(agent: AgentDTO) {
    if (!confirm(`Remover agente "${agent.name}"?`)) return;
    deleteMutation.mutate(agent.id);
  }

  return (
    <div>
      <PageHeader
        title="Agentes"
        subtitle="Personalidades configuráveis do robô."
        actions={
          <Link to="/agents/new" className="btn-primary">
            Novo agente
          </Link>
        }
      />

      <div className="card overflow-hidden">
        {isLoading ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Voz</th>
                <th>Idioma</th>
                <th>Atualizado</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonRow key={i} cols={5} />
              ))}
            </tbody>
          </table>
        ) : error ? (
          <div className="p-8 flex flex-col items-center gap-3 text-sm">
            <div className="text-danger">
              Erro ao carregar agentes: {error instanceof Error ? error.message : "desconhecido"}
            </div>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="btn-secondary"
            >
              {isFetching ? "Tentando..." : "Tentar novamente"}
            </button>
          </div>
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={<UsersIcon />}
            title="Nenhum agente cadastrado"
            description="Crie um agente para definir a personalidade, voz e comportamento do robô."
            action={
              <Link to="/agents/new" className="btn-primary">
                Criar primeiro agente
              </Link>
            }
          />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Voz</th>
                <th>Idioma</th>
                <th>Atualizado</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link
                      to={`/agents/${a.id}`}
                      className="text-fg hover:text-accent"
                    >
                      {a.name}
                    </Link>
                    <div className="text-xs text-fg-muted line-clamp-1">
                      {a.personality}
                    </div>
                  </td>
                  <td className="text-fg-muted">{a.voice}</td>
                  <td className="text-fg-muted">{a.language}</td>
                  <td className="text-fg-muted text-xs">
                    {new Date(a.updatedAt).toLocaleString()}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => onDelete(a)}
                      disabled={deleteMutation.isPending}
                      className="text-xs text-danger hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Remover
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
