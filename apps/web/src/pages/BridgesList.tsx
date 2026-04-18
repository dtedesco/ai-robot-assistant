import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BridgeDTO } from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import BridgeTokenModal from "@/components/BridgeTokenModal";
import PageHeader from "@/components/PageHeader";
import { SkeletonRow } from "@/components/Skeleton";
import EmptyState, { RadioIcon } from "@/components/EmptyState";
import StatusBadge from "@/components/StatusBadge";
import Spinner from "@/components/Spinner";
import { useToast } from "@/hooks/useToast";

interface CreateBridgeResponse extends BridgeDTO {
  token: string;
}

export default function BridgesList() {
  const qc = useQueryClient();
  const toast = useToast();
  const [showModal, setShowModal] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const { data, isLoading, error: listError, refetch, isFetching } =
    useQuery<BridgeDTO[]>({
      queryKey: ["bridges"],
      queryFn: () => api.get<BridgeDTO[]>("/api/bridges"),
      refetchInterval: 5000,
    });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<CreateBridgeResponse>("/api/bridges", { name }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["bridges"] });
      setShowModal({ name: res.name, token: res.token });
      setNewName("");
      setCreating(false);
      toast.success(`Bridge "${res.name}" criada.`);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao criar bridge";
      toast.error(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/bridges/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bridges"] });
      toast.success("Bridge removida.");
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao remover bridge";
      toast.error(msg);
    },
  });

  function onCreate() {
    if (!newName.trim()) {
      setNameError("Informe um nome");
      return;
    }
    setNameError(null);
    createMutation.mutate(newName.trim());
  }

  function onDelete(b: BridgeDTO) {
    if (!confirm(`Remover bridge "${b.name}"?`)) return;
    deleteMutation.mutate(b.id);
  }

  return (
    <div>
      <PageHeader
        title="Bridges"
        subtitle="Daemons locais que fazem a ponte BLE com o robô."
        actions={
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setNameError(null);
            }}
            className="btn-primary"
          >
            Nova bridge
          </button>
        }
      />

      {creating && (
        <div className="card p-4 mb-6 flex gap-3 items-end">
          <div className="flex-1">
            <label className="label">Nome</label>
            <input
              className="input"
              placeholder="ex.: pi-sala"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                  setNameError(null);
                }
              }}
              autoFocus
            />
            {nameError && (
              <p className="mt-1 text-xs text-danger">{nameError}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onCreate}
            disabled={createMutation.isPending}
            className="btn-primary"
          >
            {createMutation.isPending ? <Spinner label="Criando..." /> : "Criar"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName("");
              setNameError(null);
            }}
            className="btn-ghost"
          >
            Cancelar
          </button>
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Status</th>
                <th>Último contato</th>
                <th>Criada em</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonRow key={i} cols={5} />
              ))}
            </tbody>
          </table>
        ) : listError ? (
          <div className="p-8 flex flex-col items-center gap-3 text-sm">
            <div className="text-danger">
              Erro ao carregar bridges:{" "}
              {listError instanceof Error ? listError.message : "desconhecido"}
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
            icon={<RadioIcon />}
            title="Nenhuma bridge cadastrada"
            description="Cadastre uma bridge para autenticar um daemon local que falará com o robô via BLE."
            action={
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="btn-primary"
              >
                Criar primeira bridge
              </button>
            }
          />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Status</th>
                <th>Último contato</th>
                <th>Criada em</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>
                    <StatusBadge
                      kind={b.status === "online" ? "online" : "offline"}
                      label={b.status}
                    />
                  </td>
                  <td className="text-fg-muted text-xs">
                    {b.lastSeenAt
                      ? new Date(b.lastSeenAt).toLocaleString()
                      : "-"}
                  </td>
                  <td className="text-fg-muted text-xs">
                    {new Date(b.createdAt).toLocaleString()}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => onDelete(b)}
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

      {showModal && (
        <BridgeTokenModal
          bridgeName={showModal.name}
          token={showModal.token}
          onClose={() => setShowModal(null)}
        />
      )}
    </div>
  );
}
