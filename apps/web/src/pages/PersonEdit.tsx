import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersonDTO, Gender } from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { useToast } from "@/hooks/useToast";

interface ConversationItem {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

interface VisitWithConversations {
  id: string;
  personId: string;
  agentId: string | null;
  startedAt: string;
  endedAt: string | null;
  person: { id: string; name: string; photoUrl: string | null };
  agent: { id: string; name: string } | null;
  conversations?: ConversationItem[];
}

interface VisitsResponse {
  items: VisitWithConversations[];
  total: number;
}

type TabId = "profile" | "context" | "preferences" | "history";

const TABS: { id: TabId; label: string }[] = [
  { id: "profile", label: "Perfil" },
  { id: "context", label: "Contexto IA" },
  { id: "preferences", label: "Preferências" },
  { id: "history", label: "Histórico" },
];

const GENDER_OPTIONS: { value: Gender | ""; label: string }[] = [
  { value: "", label: "Não informado" },
  { value: "male", label: "Masculino" },
  { value: "female", label: "Feminino" },
  { value: "other", label: "Outro" },
];

export default function PersonEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<TabId>("profile");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<Gender | "">("");
  const [context, setContext] = useState("");
  const [preferences, setPreferences] = useState<string[]>([]);
  const [newPreference, setNewPreference] = useState("");
  const [expandedVisits, setExpandedVisits] = useState<Set<string>>(new Set());

  const { data: person, isLoading } = useQuery<PersonDTO>({
    queryKey: ["person", id],
    queryFn: () => api.get<PersonDTO>(`/api/persons/${id}`),
    enabled: !!id,
  });

  const { data: visitsData } = useQuery<VisitsResponse>({
    queryKey: ["visits", { personId: id, includeConversations: true }],
    queryFn: () =>
      api.get<VisitsResponse>(
        `/api/visits?personId=${id}&includeConversations=true&limit=50`
      ),
    enabled: !!id,
  });

  useEffect(() => {
    if (person) {
      setName(person.name);
      setPhone(person.phone ?? "");
      setGender(person.gender ?? "");
      setContext(person.context ?? "");
      setPreferences(person.preferences ?? []);
    }
  }, [person]);

  // Auto-expand first visit
  useEffect(() => {
    const firstVisit = visitsData?.items[0];
    if (firstVisit && expandedVisits.size === 0) {
      setExpandedVisits(new Set([firstVisit.id]));
    }
  }, [visitsData, expandedVisits.size]);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<PersonDTO>) =>
      api.patch<PersonDTO>(`/api/persons/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["persons"] });
      qc.invalidateQueries({ queryKey: ["person", id] });
      toast.success("Pessoa atualizada.");
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Falha ao atualizar";
      toast.error(msg);
    },
  });

  function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    updateMutation.mutate({
      name: name.trim(),
      phone: phone.trim() || null,
      gender: gender || null,
    });
  }

  function saveContext(e: React.FormEvent) {
    e.preventDefault();
    updateMutation.mutate({ context: context.trim() || null });
  }

  function addPreference(e: React.FormEvent) {
    e.preventDefault();
    if (!newPreference.trim()) return;
    const updated = [...preferences, newPreference.trim()];
    setPreferences(updated);
    setNewPreference("");
    updateMutation.mutate({ preferences: updated });
  }

  function removePreference(index: number) {
    const updated = preferences.filter((_, i) => i !== index);
    setPreferences(updated);
    updateMutation.mutate({ preferences: updated });
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDuration(start: string, end: string | null): string {
    if (!end) return "Em andamento";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "< 1 min";
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}min`;
  }

  function toggleVisit(visitId: string) {
    setExpandedVisits((prev) => {
      const next = new Set(prev);
      if (next.has(visitId)) {
        next.delete(visitId);
      } else {
        next.add(visitId);
      }
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="animate-pulse">
        <div className="h-8 bg-bg-muted rounded w-48 mb-4" />
        <div className="h-4 bg-bg-muted rounded w-64 mb-8" />
        <div className="card p-6 space-y-4">
          <div className="h-10 bg-bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (!person) {
    return (
      <div className="text-center py-12">
        <p className="text-fg-muted">Pessoa não encontrada</p>
        <button
          type="button"
          onClick={() => navigate("/admin/persons")}
          className="btn-secondary mt-4"
        >
          Voltar
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title={person.name}
        subtitle={`Cadastrado em ${formatDate(person.createdAt)}`}
        actions={
          <button
            type="button"
            onClick={() => navigate("/admin/persons")}
            className="btn-ghost"
          >
            Voltar
          </button>
        }
      />

      {/* Profile Summary Card */}
      <div className="card p-6 mb-6">
        <div className="flex items-start gap-6">
          {/* Photo */}
          <div className="shrink-0">
            {person.photoUrl ? (
              <img
                src={person.photoUrl}
                alt={person.name}
                className="w-24 h-24 rounded-xl object-cover border-2 border-border"
              />
            ) : (
              <div className="w-24 h-24 rounded-xl bg-bg-muted flex items-center justify-center border-2 border-border">
                <span className="text-3xl font-bold text-fg-muted">
                  {person.name.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-semibold">{person.name}</h2>
            <div className="mt-2 space-y-1 text-sm text-fg-muted">
              {person.phone && <p>Tel: {person.phone}</p>}
              {person.gender && (
                <p>
                  {person.gender === "male"
                    ? "Masculino"
                    : person.gender === "female"
                    ? "Feminino"
                    : "Outro"}
                </p>
              )}
              {person.lastVisit && (
                <p>Última visita: {formatDate(person.lastVisit)}</p>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="shrink-0 flex gap-3">
            <div className="p-3 bg-bg-muted rounded-lg text-center min-w-[70px]">
              <div className="text-xl font-bold">{person.visitCount ?? 0}</div>
              <div className="text-xs text-fg-muted">Visitas</div>
            </div>
            <div className="p-3 bg-bg-muted rounded-lg text-center min-w-[70px]">
              <div className="text-xl font-bold">
                {person.conversationCount ?? 0}
              </div>
              <div className="text-xs text-fg-muted">Mensagens</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="card overflow-hidden">
        {/* Tab Headers */}
        <div className="flex border-b border-border">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "text-accent border-b-2 border-accent -mb-px"
                  : "text-fg-muted hover:text-fg"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {/* Profile Tab */}
          {activeTab === "profile" && (
            <form onSubmit={saveProfile} className="space-y-4 max-w-md">
              <div>
                <label htmlFor="name" className="label">
                  Nome
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input w-full"
                  placeholder="Nome da pessoa"
                />
              </div>

              <div>
                <label htmlFor="phone" className="label">
                  Telefone
                </label>
                <input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="input w-full"
                  placeholder="(11) 99999-9999"
                />
              </div>

              <div>
                <label htmlFor="gender" className="label">
                  Sexo
                </label>
                <select
                  id="gender"
                  value={gender}
                  onChange={(e) => setGender(e.target.value as Gender | "")}
                  className="input w-full"
                >
                  {GENDER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={updateMutation.isPending || !name.trim()}
                className="btn-primary"
              >
                {updateMutation.isPending ? "Salvando..." : "Salvar Perfil"}
              </button>
            </form>
          )}

          {/* Context Tab */}
          {activeTab === "context" && (
            <form onSubmit={saveContext} className="space-y-4">
              <div>
                <label htmlFor="context" className="label">
                  Contexto para a IA
                </label>
                <p className="text-xs text-fg-muted mb-2">
                  Informações que a Sofia deve saber sobre esta pessoa. Exemplo:
                  alérgico a amendoim, prefere ser chamado de apelido, tem
                  mobilidade reduzida, etc.
                </p>
                <textarea
                  id="context"
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  className="input w-full h-48 resize-none"
                  placeholder="Escreva aqui informações importantes sobre a pessoa que a IA deve considerar durante as conversas..."
                />
              </div>

              <button
                type="submit"
                disabled={updateMutation.isPending}
                className="btn-primary"
              >
                {updateMutation.isPending ? "Salvando..." : "Salvar Contexto"}
              </button>
            </form>
          )}

          {/* Preferences Tab */}
          {activeTab === "preferences" && (
            <div className="space-y-4">
              <div>
                <label className="label">Preferências</label>
                <p className="text-xs text-fg-muted mb-4">
                  Tags de preferências da pessoa. Exemplo: vegetariano, café sem
                  açúcar, música clássica, etc.
                </p>
              </div>

              {/* Existing preferences */}
              <div className="flex flex-wrap gap-2">
                {preferences.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    Nenhuma preferência cadastrada
                  </p>
                ) : (
                  preferences.map((pref, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center gap-1 px-3 py-1 bg-accent/20 text-accent rounded-full text-sm"
                    >
                      {pref}
                      <button
                        type="button"
                        onClick={() => removePreference(index)}
                        className="hover:text-red-400 ml-1"
                        title="Remover"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </span>
                  ))
                )}
              </div>

              {/* Add new preference */}
              <form onSubmit={addPreference} className="flex gap-2 max-w-md">
                <input
                  type="text"
                  value={newPreference}
                  onChange={(e) => setNewPreference(e.target.value)}
                  className="input flex-1"
                  placeholder="Nova preferência..."
                />
                <button
                  type="submit"
                  disabled={updateMutation.isPending || !newPreference.trim()}
                  className="btn-primary"
                >
                  Adicionar
                </button>
              </form>
            </div>
          )}

          {/* History Tab */}
          {activeTab === "history" && (
            <div className="-mx-6 -mb-6">
              {!visitsData || visitsData.items.length === 0 ? (
                <div className="p-6 text-sm text-fg-muted text-center">
                  Nenhuma visita registrada
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {visitsData.items.map((visit) => {
                    const isExpanded = expandedVisits.has(visit.id);
                    const conversationCount = visit.conversations?.length ?? 0;

                    return (
                      <div key={visit.id} className="bg-bg">
                        {/* Visit Header - Clickable */}
                        <button
                          type="button"
                          onClick={() => toggleVisit(visit.id)}
                          className="w-full px-6 py-4 flex items-center justify-between hover:bg-bg-muted/50 transition-colors text-left"
                        >
                          <div className="flex items-center gap-4">
                            {/* Expand/Collapse Icon */}
                            <div
                              className={`w-5 h-5 flex items-center justify-center text-fg-muted transition-transform ${
                                isExpanded ? "rotate-90" : ""
                              }`}
                            >
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M9 5l7 7-7 7"
                                />
                              </svg>
                            </div>

                            {/* Visit Info */}
                            <div>
                              <div className="font-medium text-sm">
                                {formatDate(visit.startedAt)}
                              </div>
                              <div className="text-xs text-fg-muted">
                                {visit.agent?.name ?? "Agente desconhecido"}
                              </div>
                            </div>
                          </div>

                          {/* Right side info */}
                          <div className="flex items-center gap-4">
                            <div className="text-xs text-fg-muted">
                              {conversationCount} mensagens
                            </div>
                            <div
                              className={`text-xs px-2 py-1 rounded ${
                                visit.endedAt
                                  ? "bg-bg-muted text-fg-muted"
                                  : "bg-green-500/20 text-green-400"
                              }`}
                            >
                              {formatDuration(visit.startedAt, visit.endedAt)}
                            </div>
                          </div>
                        </button>

                        {/* Conversations - Expandable */}
                        {isExpanded && visit.conversations && (
                          <div className="px-6 pb-4">
                            <div className="ml-9 border-l-2 border-border pl-4 space-y-3">
                              {visit.conversations.length === 0 ? (
                                <p className="text-xs text-fg-muted py-2">
                                  Nenhuma mensagem nesta visita
                                </p>
                              ) : (
                                visit.conversations.map((msg) => (
                                  <div
                                    key={msg.id}
                                    className={`rounded-lg p-3 ${
                                      msg.role === "user"
                                        ? "bg-blue-500/10 border border-blue-500/20"
                                        : "bg-green-500/10 border border-green-500/20"
                                    }`}
                                  >
                                    <div className="flex items-center gap-2 mb-1">
                                      <span
                                        className={`text-xs font-medium ${
                                          msg.role === "user"
                                            ? "text-blue-400"
                                            : "text-green-400"
                                        }`}
                                      >
                                        {msg.role === "user"
                                          ? "Usuário"
                                          : "Assistente"}
                                      </span>
                                      <span className="text-xs text-fg-muted">
                                        {formatTime(msg.timestamp)}
                                      </span>
                                    </div>
                                    <p className="text-sm text-fg">
                                      {msg.content}
                                    </p>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
