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

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-8">
      <section className="card p-6 space-y-5">
        <div className="text-sm font-semibold">Identidade</div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Nome</label>
            <input className="input" {...register("name")} />
            {errors.name && (
              <p className="mt-1 text-xs text-danger">{errors.name.message}</p>
            )}
          </div>
          <div>
            <label className="label">Idioma</label>
            <input className="input" {...register("language")} />
          </div>
        </div>

        <div>
          <label className="label">Personalidade (descrição curta)</label>
          <textarea
            rows={2}
            className="input"
            {...register("personality")}
          />
          {errors.personality && (
            <p className="mt-1 text-xs text-danger">
              {errors.personality.message}
            </p>
          )}
        </div>

        <div>
          <label className="label">System prompt</label>
          <textarea
            rows={10}
            className="input font-mono text-xs"
            {...register("systemPrompt")}
          />
          {errors.systemPrompt && (
            <p className="mt-1 text-xs text-danger">
              {errors.systemPrompt.message}
            </p>
          )}
        </div>

        <div>
          <label className="label">Saudação inicial (opcional)</label>
          <textarea rows={2} className="input" {...register("greeting")} />
        </div>
      </section>

      <section className="card p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Voz</div>
          {onTestVoice && (
            <button
              type="button"
              onClick={() => onTestVoice()}
              className="btn-secondary"
              disabled={testVoiceDisabled}
            >
              Testar voz
            </button>
          )}
        </div>

        <div>
          <label className="label">Voz OpenAI</label>
          <select className="input" {...register("voice")}>
            {VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="card p-6 space-y-5">
        <div className="text-sm font-semibold">Mapa de emoções → cor</div>
        <p className="text-xs text-fg-muted">
          Cada emoção mapeia para uma cor dos olhos (1 a 7).
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {EMOTIONS.map((emotion) => {
            const value = emotionMap[emotion] ?? 2;
            return (
              <div
                key={emotion}
                className="border border-border rounded-md p-3 bg-bg-muted/40"
              >
                <div className="text-xs text-fg-muted capitalize mb-2">
                  {emotion}
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {[1, 2, 3, 4, 5, 6, 7].map((c) => {
                    const active = value === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        title={`${c} - ${COLOR_NAMES[c]}`}
                        onClick={() =>
                          setValue(`emotionColorMap.${emotion}`, c, {
                            shouldDirty: true,
                          })
                        }
                        className={[
                          "h-7 w-7 rounded-full border-2 transition-all",
                          active
                            ? "border-fg scale-110"
                            : "border-border hover:border-fg-muted",
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

      <section className="card p-6 space-y-4">
        <div className="text-sm font-semibold">Tools habilitadas</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(
            [
              ["showOnTv", "Mostrar na TV (livre)"],
              ["showFromLibrary", "Mostrar da biblioteca"],
              ["clearTv", "Limpar TV"],
              ["robotDance", "Dança do robô"],
              ["robotColor", "Cor dos olhos"],
            ] as Array<[keyof AgentToolsConfig, string]>
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-3 border border-border rounded-md px-3 py-2 bg-bg-muted/40 cursor-pointer"
            >
              <input
                type="checkbox"
                {...register(`tools.${key}`)}
                className="h-4 w-4 accent-accent"
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="card p-6 space-y-4">
        <div>
          <div className="text-sm font-semibold">Background da TV (ocioso)</div>
          <div className="text-xs text-fg-muted mb-2">
            URL de imagem ou vídeo (mp4/webm) exibido na TV quando não há
            conteúdo ativo. Vazio → cenário futurista padrão.
          </div>
          <input
            type="text"
            placeholder="https://… (deixe em branco para o padrão)"
            className="input w-full"
            {...register("tvIdleBackgroundUrl")}
          />
        </div>
      </section>

      <section className="card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Biblioteca de TV</div>
            <div className="text-xs text-fg-muted">
              Itens que o agente pode exibir por tópico.
            </div>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              append({ topic: "", kind: "youtube", url: "", title: "" })
            }
          >
            Adicionar item
          </button>
        </div>

        {fields.length === 0 && (
          <p className="text-xs text-fg-subtle italic">
            Nenhum item cadastrado.
          </p>
        )}

        <div className="space-y-3">
          {fields.map((field, index) => {
            const kind = watch(`tvLibrary.${index}.kind`);
            const libErrors = errors.tvLibrary?.[index];
            return (
              <div
                key={field.id}
                className="border border-border rounded-md p-4 bg-bg-muted/30 space-y-3"
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="label">Tópico</label>
                    <input
                      className="input"
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
                      <option value="webpage">Página web</option>
                      <option value="text">Texto</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Título (opcional)</label>
                    <input
                      className="input"
                      {...register(`tvLibrary.${index}.title`)}
                    />
                  </div>
                </div>

                {kind === "text" ? (
                  <div>
                    <label className="label">Texto</label>
                    <textarea
                      rows={2}
                      className="input"
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

                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn-ghost text-danger hover:text-danger"
                    onClick={() => remove(index)}
                  >
                    Remover
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex justify-end items-center gap-3">
        {initial && isDirty && !submitting && (
          <span className="text-xs text-fg-muted">Alterações não salvas</span>
        )}
        <button
          type="submit"
          disabled={submitting || (!!initial && !isDirty)}
          className="btn-primary"
        >
          {submitting ? (
            <Spinner label="Salvando..." />
          ) : !initial ? (
            "Criar agente"
          ) : isDirty ? (
            "Salvar alterações"
          ) : (
            "Salvo"
          )}
        </button>
      </div>
    </form>
  );
}
