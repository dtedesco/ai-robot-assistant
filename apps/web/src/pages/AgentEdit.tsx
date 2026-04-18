import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentDTO, CreateAgentInput } from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import AgentForm from "@/components/AgentForm";
import PageHeader from "@/components/PageHeader";
import { SkeletonCard } from "@/components/Skeleton";
import { useToast } from "@/hooks/useToast";

export default function AgentEdit() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const query = useQuery<AgentDTO>({
    queryKey: ["agents", id],
    queryFn: () => api.get<AgentDTO>(`/api/agents/${id}`),
    enabled: !isNew,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateAgentInput) =>
      api.post<AgentDTO>("/api/agents", input),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success(`Agente "${agent.name}" criado.`);
      navigate(`/agents/${agent.id}`, { replace: true });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao criar agente";
      toast.error(msg);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: CreateAgentInput) =>
      api.patch<AgentDTO>(`/api/agents/${id}`, input),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.setQueryData(["agents", agent.id], agent);
      toast.success("Agente salvo.");
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao salvar agente";
      toast.error(msg);
    },
  });

  // TODO: backend endpoint POST /api/agents/:id/test-voice is optional.
  async function onTestVoice() {
    if (isNew || !id) return;
    try {
      await api.post<void>(`/api/agents/${id}/test-voice`);
      toast.success("Teste de voz enviado.");
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao testar voz";
      toast.error(`Teste de voz: ${msg}`);
    }
  }

  async function onSubmit(input: CreateAgentInput) {
    if (isNew) {
      await createMutation.mutateAsync(input);
    } else {
      await updateMutation.mutateAsync(input);
    }
  }

  const breadcrumbs = isNew
    ? [{ label: "Agentes", to: "/agents" }, { label: "Novo" }]
    : [{ label: "Agentes", to: "/agents" }, { label: "Editar" }];

  if (!isNew && query.isLoading) {
    return (
      <div>
        <PageHeader
          title="Editar agente"
          breadcrumbs={[{ label: "Agentes", to: "/agents" }, { label: "Editar" }]}
        />
        <div className="space-y-6">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
        </div>
      </div>
    );
  }

  if (!isNew && query.error) {
    return (
      <div>
        <PageHeader
          title="Editar agente"
          breadcrumbs={[{ label: "Agentes", to: "/agents" }, { label: "Editar" }]}
        />
        <div className="card p-8 flex flex-col items-center gap-3 text-sm">
          <div className="text-danger">
            Erro ao carregar agente:{" "}
            {query.error instanceof Error ? query.error.message : "desconhecido"}
          </div>
          <button
            type="button"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            className="btn-secondary"
          >
            {query.isFetching ? "Tentando..." : "Tentar novamente"}
          </button>
        </div>
      </div>
    );
  }

  const submitting = createMutation.isPending || updateMutation.isPending;

  return (
    <div>
      <PageHeader
        title={isNew ? "Novo agente" : query.data?.name ?? "Editar agente"}
        breadcrumbs={breadcrumbs}
      />

      <AgentForm
        initial={isNew ? undefined : query.data}
        submitting={submitting}
        onSubmit={onSubmit}
        onTestVoice={isNew ? undefined : onTestVoice}
        testVoiceDisabled={isNew}
      />
    </div>
  );
}
