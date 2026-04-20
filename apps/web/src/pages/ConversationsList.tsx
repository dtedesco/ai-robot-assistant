import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ConversationDTO, PersonDTO } from "@robot/shared";
import { api } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { SkeletonRow } from "@/components/Skeleton";
import EmptyState from "@/components/EmptyState";

function ChatIcon() {
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
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

interface ConversationsResponse {
  items: ConversationDTO[];
  total: number;
  limit: number;
  offset: number;
}

export default function ConversationsList() {
  const [page, setPage] = useState(0);
  const [filterPerson, setFilterPerson] = useState<string>("");
  const limit = 50;

  const { data: persons } = useQuery<PersonDTO[]>({
    queryKey: ["persons"],
    queryFn: () => api.get<PersonDTO[]>("/api/persons"),
  });

  const queryParams = new URLSearchParams();
  queryParams.set("limit", String(limit));
  queryParams.set("offset", String(page * limit));
  if (filterPerson) queryParams.set("personId", filterPerson);

  const { data, isLoading, error, refetch, isFetching } =
    useQuery<ConversationsResponse>({
      queryKey: ["conversations", { page, filterPerson }],
      queryFn: () =>
        api.get<ConversationsResponse>(`/api/conversations?${queryParams}`),
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

  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  return (
    <div>
      <PageHeader
        title="Histórico de Conversas"
        subtitle="Todas as mensagens trocadas com o robô."
      />

      {/* Filters */}
      <div className="mb-4 flex gap-4">
        <select
          value={filterPerson}
          onChange={(e) => {
            setFilterPerson(e.target.value);
            setPage(0);
          }}
          className="input w-48"
        >
          <option value="">Todas as pessoas</option>
          {persons?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>Tipo</th>
                <th>Mensagem</th>
                <th>Data</th>
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
            icon={<ChatIcon />}
            title="Nenhuma conversa registrada"
            description="As conversas aparecem aqui quando pessoas interagem com o robô."
          />
        ) : (
          <>
            <table className="table-base">
              <thead>
                <tr>
                  <th className="w-40">Pessoa</th>
                  <th className="w-24">Tipo</th>
                  <th>Mensagem</th>
                  <th className="w-32">Data</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.person ? (
                        <Link
                          to={`/admin/persons/${c.personId}`}
                          className="text-fg hover:text-accent"
                        >
                          {c.person.name}
                        </Link>
                      ) : (
                        <span className="text-fg-muted">Desconhecido</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded ${
                          c.role === "user"
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-green-500/20 text-green-400"
                        }`}
                      >
                        {c.role === "user" ? "Usuário" : "Robô"}
                      </span>
                    </td>
                    <td>
                      <p className="text-sm text-fg line-clamp-2 max-w-lg">
                        {c.content}
                      </p>
                    </td>
                    <td className="text-fg-muted text-xs">
                      {formatDate(c.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-border flex items-center justify-between">
                <div className="text-xs text-fg-muted">
                  {data.total} mensagens total
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
