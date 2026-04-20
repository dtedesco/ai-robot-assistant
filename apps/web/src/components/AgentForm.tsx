import { useState } from "react";
import { useFieldArray, useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_EMOTION_COLOR_MAP,
  EMOTIONS,
  type AgentDTO,
  type AgentToolsConfig,
  type CreateAgentInput,
  type OpenAIVoice,
  type TvLibraryItem,
} from "@robot/shared";
import Spinner from "@/components/Spinner";

const VOICES: OpenAIVoice[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

const COLOR_SWATCHES: Record<number, string> = {
  1: "#ffffff",
  2: "#3b82f6",
  3: "#22c55e",
  4: "#eab308",
  5: "#ef4444",
  6: "#a855f7",
  7: "#06b6d4",
};

const COLOR_NAMES: Record<number, string> = {
  1: "branco",
  2: "azul",
  3: "verde",
  4: "amarelo",
  5: "vermelho",
  6: "roxo",
  7: "ciano",
};

const tvLibrarySchema = z
  .object({
    topic: z.string().min(1, "tópico é obrigatório"),
    kind: z.enum(["youtube", "image", "webpage", "text"]),
    url: z.string().optional(),
    text: z.string().optional(),
    title: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "text") {
      if (!val.text || val.text.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["text"],
          message: "texto é obrigatório",
        });
      }
    } else {
      if (!val.url || val.url.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "URL é obrigatória",
        });
      } else {
        try {
          new URL(val.url);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["url"],
            message: "URL inválida",
          });
        }
      }
    }
  });

const formSchema = z.object({
  name: z.string().min(1, "nome é obrigatório"),
  personality: z.string().min(1, "descreva a personalidade"),
  systemPrompt: z.string().min(1, "system prompt é obrigatório"),
  voice: z.enum([
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
  ]),
  language: z.string().min(1, "idioma é obrigatório"),
  greeting: z.string().optional(),
  emotionColorMap: z.record(z.number().int().min(1).max(7)),
  tools: z.object({
    showOnTv: z.boolean(),
    showFromLibrary: z.boolean(),
    clearTv: z.boolean(),
    robotDance: z.boolean(),
    robotColor: z.boolean(),
  }),
  tvLibrary: z.array(tvLibrarySchema),
  tvIdleBackgroundUrl: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export interface AgentFormProps {
  initial?: AgentDTO;
  submitting?: boolean;
  onSubmit: (data: CreateAgentInput) => void | Promise<void>;
  onTestVoice?: () => void | Promise<void>;
  testVoiceDisabled?: boolean;
}

function toDefaults(initial?: AgentDTO): FormValues {
  if (!initial) {
    return {
      name: "",
      personality: "",
      systemPrompt: "",
      voice: "alloy",
      language: "pt-BR",
      greeting: "",
      emotionColorMap: { ...DEFAULT_EMOTION_COLOR_MAP },
      tools: { ...DEFAULT_AGENT_TOOLS },
      tvLibrary: [],
      tvIdleBackgroundUrl: "",
    };
  }
  return {
    name: initial.name,
    personality: initial.personality,
    systemPrompt: initial.systemPrompt,
    voice: initial.voice,
    language: initial.language,
    greeting: initial.greeting ?? "",
    emotionColorMap: { ...initial.emotionColorMap },
    tools: { ...initial.tools },
    tvLibrary: initial.tvLibrary.map((i) => ({ ...i })),
    tvIdleBackgroundUrl: initial.tvIdleBackgroundUrl ?? "",
  };
}

export default function AgentForm({
  initial,
  submitting,
  onSubmit,
  onTestVoice,
  testVoiceDisabled,
}: AgentFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toDefaults(initial),
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "tvLibrary",
  });

  const emotionMap = watch("emotionColorMap");

  const submit: SubmitHandler<FormValues> = (values) => {
    const payload: CreateAgentInput = {
      name: values.name.trim(),
      personality: values.personality,
      systemPrompt: values.systemPrompt,
      voice: values.voice,
      language: values.language,
      greeting: values.greeting?.trim() ? values.greeting : null,
      emotionColorMap: values.emotionColorMap as AgentDTO["emotionColorMap"],
      tools: values.tools as AgentToolsConfig,
      tvLibrary: values.tvLibrary as TvLibraryItem[],
      tvIdleBackgroundUrl: values.tvIdleBackgroundUrl?.trim()
        ? values.tvIdleBackgroundUrl.trim()
        : null,
    };
    return onSubmit(payload);
  };

  const [showAdvanced, setShowAdvanced] = useState(
    initial ? (initial.tvLibrary.length > 0 || initial.tvIdleBackgroundUrl) : false
  );

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      {/* Basic Info */}
      <section className="card p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Informações Básicas</h2>
          <p className="text-sm text-fg-muted mt-1">
            Nome e configuração de voz do agente
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="label">Nome do Agente</label>
            <input
              className="input text-lg"
              placeholder="Ex: Sofia, Robert, Max..."
              {...register("name")}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-danger">{errors.name.message}</p>
            )}
          </div>
          <div>
            <label className="label">Idioma</label>
            <input
              className="input"
              placeholder="pt-BR"
              {...register("language")}
            />
          </div>
        </div>

        {initial?.slug && (
          <div className="bg-bg-muted/50 border border-border rounded-lg p-4">
            <label className="label">URL do Agente</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm bg-bg px-3 py-2 rounded border border-border overflow-x-auto">
                /realtime/{initial.slug}
              </code>
              <button
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}/realtime/${initial.slug}`;
                  navigator.clipboard.writeText(url);
                }}
                className="btn-secondary shrink-0"
                title="Copiar URL"
              >
                Copiar
              </button>
            </div>
            <p className="mt-2 text-xs text-fg-muted">
              Use esta URL para acessar o agente diretamente
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Voz</label>
            <div className="flex gap-2">
              <select className="input flex-1" {...register("voice")}>
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </option>
                ))}
              </select>
              {onTestVoice && (
                <button
                  type="button"
                  onClick={() => onTestVoice()}
                  className="btn-secondary shrink-0"
                  disabled={testVoiceDisabled}
                >
                  Ouvir
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              Clique em "Ouvir" para testar a voz selecionada
            </p>
          </div>
          <div>
            <label className="label">Saudação Inicial</label>
            <input
              className="input"
              placeholder="Olá! Como posso ajudar?"
              {...register("greeting")}
            />
            <p className="mt-1 text-xs text-fg-muted">
              Primeira frase ao iniciar a conversa (opcional)
            </p>
          </div>
        </div>
      </section>

      {/* Personality & Prompt */}
      <section className="card p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Personalidade</h2>
          <p className="text-sm text-fg-muted mt-1">
            Defina como o agente se comporta e responde
          </p>
        </div>

        <div>
          <label className="label">Descrição da Personalidade</label>
          <textarea
            rows={2}
            className="input"
            placeholder="Descreva em poucas palavras: amigável, divertido, profissional..."
            {...register("personality")}
          />
          {errors.personality && (
            <p className="mt-1 text-xs text-danger">
              {errors.personality.message}
            </p>
          )}
          <p className="mt-1 text-xs text-fg-muted">
            Descrição curta usada para identificar o agente
          </p>
        </div>

        <div>
          <label className="label">Instruções do Sistema (System Prompt)</label>
          <textarea
            rows={12}
            className="input font-mono text-sm"
            placeholder="Você é um assistente virtual chamado..."
            {...register("systemPrompt")}
          />
          {errors.systemPrompt && (
            <p className="mt-1 text-xs text-danger">
              {errors.systemPrompt.message}
            </p>
          )}
          <p className="mt-1 text-xs text-fg-muted">
            Instruções detalhadas sobre como o agente deve agir, o que pode e não pode fazer
          </p>
        </div>
      </section>

      {/* Capabilities */}
      <section className="card p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Capacidades</h2>
          <p className="text-sm text-fg-muted mt-1">
            O que o agente pode fazer durante a conversa
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(
            [
              ["robotDance", "Dançar", "O agente pode fazer o robô dançar"],
              ["robotColor", "Mudar Cor", "Alterar a cor dos olhos do robô"],
              ["showOnTv", "Mostrar na TV", "Exibir conteúdo livre na TV"],
              ["showFromLibrary", "Biblioteca TV", "Mostrar itens pré-cadastrados"],
              ["clearTv", "Limpar TV", "Remover conteúdo da TV"],
            ] as Array<[keyof AgentToolsConfig, string, string]>
          ).map(([key, label, desc]) => (
            <label
              key={key}
              className="flex items-start gap-3 border border-border rounded-lg p-4 bg-bg-muted/30 cursor-pointer hover:bg-bg-muted/50 transition-colors"
            >
              <input
                type="checkbox"
                {...register(`tools.${key}`)}
                className="h-5 w-5 accent-accent mt-0.5"
              />
              <div>
                <span className="text-sm font-medium block">{label}</span>
                <span className="text-xs text-fg-muted">{desc}</span>
              </div>
            </label>
          ))}
        </div>
      </section>

      {/* Emotion Colors */}
      <section className="card p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Cores das Emoções</h2>
          <p className="text-sm text-fg-muted mt-1">
            Cor dos olhos do robô para cada estado emocional
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {EMOTIONS.map((emotion) => {
            const value = emotionMap[emotion] ?? 2;
            const emotionLabels: Record<string, string> = {
              neutral: "Neutro",
              happy: "Feliz",
              sad: "Triste",
              angry: "Bravo",
              surprised: "Surpreso",
              thinking: "Pensando",
              listening: "Ouvindo",
            };
            return (
              <div
                key={emotion}
                className="border border-border rounded-lg p-3 bg-bg-muted/30"
              >
                <div className="text-sm font-medium mb-2">
                  {emotionLabels[emotion] || emotion}
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {[1, 2, 3, 4, 5, 6, 7].map((c) => {
                    const active = value === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        title={COLOR_NAMES[c]}
                        onClick={() =>
                          setValue(`emotionColorMap.${emotion}`, c, {
                            shouldDirty: true,
                          })
                        }
                        className={[
                          "h-8 w-8 rounded-full border-2 transition-all",
                          active
                            ? "border-fg ring-2 ring-accent ring-offset-2 ring-offset-bg"
                            : "border-border/50 hover:border-fg-muted hover:scale-105",
                        ].join(" ")}
                        style={{ backgroundColor: COLOR_SWATCHES[c] }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Advanced Settings Toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="w-full flex items-center justify-between px-6 py-4 bg-bg-muted/30 border border-border rounded-lg hover:bg-bg-muted/50 transition-colors"
      >
        <div className="text-left">
          <span className="text-sm font-medium">Configurações Avançadas</span>
          <p className="text-xs text-fg-muted">
            Biblioteca de TV e background personalizado
          </p>
        </div>
        <span className="text-fg-muted text-lg">
          {showAdvanced ? "−" : "+"}
        </span>
      </button>

      {showAdvanced && (
        <>
          {/* TV Background */}
          <section className="card p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Background da TV</h2>
              <p className="text-sm text-fg-muted mt-1">
                Imagem ou vídeo exibido quando não há conteúdo ativo
              </p>
            </div>
            <input
              type="text"
              placeholder="https://... (deixe vazio para usar o padrão)"
              className="input w-full"
              {...register("tvIdleBackgroundUrl")}
            />
          </section>

          {/* TV Library */}
          <section className="card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Biblioteca de TV</h2>
                <p className="text-sm text-fg-muted mt-1">
                  Conteúdos que o agente pode exibir por comando
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  append({ topic: "", kind: "youtube", url: "", title: "" })
                }
              >
                + Adicionar
              </button>
            </div>

            {fields.length === 0 && (
              <div className="text-center py-8 border border-dashed border-border rounded-lg">
                <p className="text-fg-muted">Nenhum item cadastrado</p>
                <p className="text-xs text-fg-subtle mt-1">
                  Adicione vídeos, imagens ou textos para o agente exibir
                </p>
              </div>
            )}

            <div className="space-y-3">
              {fields.map((field, index) => {
                const kind = watch(`tvLibrary.${index}.kind`);
                const libErrors = errors.tvLibrary?.[index];
                return (
                  <div
                    key={field.id}
                    className="border border-border rounded-lg p-4 bg-bg-muted/20 space-y-3"
                  >
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div>
                        <label className="label">Comando</label>
                        <input
                          className="input"
                          placeholder="Ex: musica"
                          {...register(`tvLibrary.${index}.topic`)}
                        />
                        {libErrors?.topic && (
                          <p className="mt-1 text-xs text-danger">
                            {libErrors.topic.message}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="label">Tipo</label>
                        <select
                          className="input"
                          {...register(`tvLibrary.${index}.kind`)}
                        >
                          <option value="youtube">YouTube</option>
                          <option value="image">Imagem</option>
                          <option value="webpage">Página Web</option>
                          <option value="text">Texto</option>
                        </select>
                      </div>
                      <div className="md:col-span-2">
                        <label className="label">Título</label>
                        <input
                          className="input"
                          placeholder="Descrição do conteúdo"
                          {...register(`tvLibrary.${index}.title`)}
                        />
                      </div>
                    </div>

                    {kind === "text" ? (
                      <div>
                        <label className="label">Texto para exibir</label>
                        <textarea
                          rows={2}
                          className="input"
                          placeholder="Texto que aparecerá na TV..."
                          {...register(`tvLibrary.${index}.text`)}
                        />
                        {libErrors?.text && (
                          <p className="mt-1 text-xs text-danger">
                            {libErrors.text.message}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div>
                        <label className="label">URL</label>
                        <input
                          className="input"
                          placeholder={
                            kind === "youtube"
                              ? "https://youtube.com/watch?v=..."
                              : "https://..."
                          }
                          {...register(`tvLibrary.${index}.url`)}
                        />
                        {libErrors?.url && (
                          <p className="mt-1 text-xs text-danger">
                            {libErrors.url.message}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex justify-end pt-2 border-t border-border/50">
                      <button
                        type="button"
                        className="text-sm text-danger hover:underline"
                        onClick={() => remove(index)}
                      >
                        Remover item
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Submit */}
      <div className="flex justify-between items-center sticky bottom-0 bg-bg py-4 border-t border-border -mx-8 px-8 mt-8">
        <div>
          {initial && isDirty && !submitting && (
            <span className="text-sm text-fg-muted">
              Alterações não salvas
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={submitting || (!!initial && !isDirty)}
          className="btn-primary px-8"
        >
          {submitting ? (
            <Spinner label="Salvando..." />
          ) : !initial ? (
            "Criar Agente"
          ) : isDirty ? (
            "Salvar Alterações"
          ) : (
            "Salvo"
          )}
        </button>
      </div>
    </form>
  );
}
