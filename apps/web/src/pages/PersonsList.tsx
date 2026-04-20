import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersonDTO } from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { SkeletonRow } from "@/components/Skeleton";
import EmptyState from "@/components/EmptyState";
import { useToast } from "@/hooks/useToast";

function PersonIcon() {
  return (
    <svg
      className="w-12 h-12 text-fg-muted"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
      />
    </svg>
  );
}

export default function PersonsList() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, error, refetch, isFetching } = useQuery<PersonDTO[]>(
    {
      queryKey: ["persons"],
      queryFn: () => api.get<PersonDTO[]>("/api/persons"),
    },
  );

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/persons/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["persons"] });
      toast.success("Pessoa removida.");
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Falha ao remover";
      toast.error(msg);
    },
  });

  function onDelete(person: PersonDTO) {
    if (!confirm(`Remover "${person.name}"? Todos os registros de visitas serão excluídos.`)) return;
    deleteMutation.mutate(person.id);
  }

  function formatDate(iso: string | null | undefined): string {
    if (!iso) return "-";
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <div>
      <PageHeader
        title="Pessoas"
        subtitle="Rostos cadastrados para reconhecimento facial."
        actions={
          <Link to="/admin/persons/new" className="btn-primary">
            Nova Pessoa
          </Link>
        }
      />

      <div className="card overflow-hidden">
        {isLoading ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Visitas</th>
                <th>Conversas</th>
                <th>Última visita</th>
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
              Erro ao carregar: {error instanceof Error ? error.message : "desconhecido"}
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
            icon={<PersonIcon />}
            title="Nenhuma pessoa cadastrada"
            description="Pessoas são cadastradas automaticamente durante interações com o robô, ou aparecem aqui ao serem detectadas pela câmera."
          />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Visitas</th>
                <th>Conversas</th>
                <th>Última visita</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      {p.photoUrl ? (
                        <img
                          src={p.photoUrl}
                          alt={p.name}
                          className="w-8 h-8 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-bg-muted flex items-center justify-center text-fg-muted text-sm font-medium">
                          {p.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <Link
                        to={`/admin/persons/${p.id}`}
                        className="text-fg hover:text-accent"
                      >
                        {p.name}
                      </Link>
                    </div>
                  </td>
                  <td className="text-fg-muted">{p.visitCount ?? 0}</td>
                  <td className="text-fg-muted">{p.conversationCount ?? 0}</td>
                  <td className="text-fg-muted text-xs">
                    {formatDate(p.lastVisit)}
                  </td>
                  <td className="text-right space-x-2">
                    <Link
                      to={`/admin/persons/${p.id}`}
                      className="text-xs text-accent hover:underline"
                    >
                      Editar
                    </Link>
                    <button
                      type="button"
                      onClick={() => onDelete(p)}
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
