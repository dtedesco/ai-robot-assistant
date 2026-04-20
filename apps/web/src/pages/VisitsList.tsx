import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { VisitDTO } from "@robot/shared";
import { api } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { SkeletonRow } from "@/components/Skeleton";
import EmptyState from "@/components/EmptyState";

function CalendarIcon() {
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
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

interface VisitsResponse {
  items: VisitDTO[];
  total: number;
  limit: number;
  offset: number;
}

export default function VisitsList() {
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data, isLoading, error, refetch, isFetching } =
    useQuery<VisitsResponse>({
      queryKey: ["visits", { page }],
      queryFn: () =>
        api.get<VisitsResponse>(`/api/visits?limit=${limit}&offset=${page * limit}`),
    });

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDuration(start: string, end: string | null): string {
    if (!end) return "Em andamento";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}min`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}min`;
  }

  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  return (
    <div>
      <PageHeader
        title="Log de Visitas"
        subtitle="Registro de todas as visitas detectadas."
      />

      <div className="card overflow-hidden">
        {isLoading ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>Agente</th>
                <th>Início</th>
                <th>Duração</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} cols={4} />
              ))}
            </tbody>
          </table>
        ) : error ? (
          <div className="p-8 flex flex-col items-center gap-3 text-sm">
            <div className="text-danger">
              Erro ao carregar:{" "}
              {error instanceof Error ? error.message : "desconhecido"}
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
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            icon={<CalendarIcon />}
            title="Nenhuma visita registrada"
            description="As visitas aparecem aqui quando pessoas são detectadas pela câmera."
          />
        ) : (
          <>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th>Agente</th>
                  <th>Início</th>
                  <th>Duração</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        {v.person.photoUrl ? (
                          <img
                            src={v.person.photoUrl}
                            alt={v.person.name}
                            className="w-8 h-8 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-bg-muted flex items-center justify-center text-fg-muted text-sm font-medium">
                            {v.person.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <Link
                          to={`/admin/persons/${v.personId}`}
                          className="text-fg hover:text-accent"
                        >
                          {v.person.name}
                        </Link>
                      </div>
                    </td>
                    <td className="text-fg-muted">
                      {v.agent?.name ?? "-"}
                    </td>
                    <td className="text-fg-muted text-xs">
                      {formatDate(v.startedAt)}
                    </td>
                    <td className="text-fg-muted text-xs">
                      <span
                        className={
                          !v.endedAt
                            ? "text-green-400 animate-pulse"
                            : ""
                        }
                      >
                        {formatDuration(v.startedAt, v.endedAt)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-border flex items-center justify-between">
                <div className="text-xs text-fg-muted">
                  {data.total} visitas total
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="btn-ghost text-xs px-2 py-1"
                  >
                    Anterior
                  </button>
                  <span className="text-xs text-fg-muted py-1">
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={page >= totalPages - 1}
                    className="btn-ghost text-xs px-2 py-1"
                  >
                    Próxima
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
