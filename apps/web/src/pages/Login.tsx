import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ApiError } from "@/lib/api";
import Spinner from "@/components/Spinner";
import { useToast } from "@/hooks/useToast";

const schema = z.object({
  email: z.string().email("email inválido"),
  password: z.string().min(1, "obrigatório"),
});
type FormValues = z.infer<typeof schema>;

export default function Login() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  if (isAuthenticated) {
    return <Navigate to="/admin/agents" replace />;
  }

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.email, values.password);
      toast.success("Bem-vindo!");
      navigate("/admin/agents", { replace: true });
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao autenticar";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">Robot Assistant</div>
          <div className="text-sm text-fg-muted mt-1">
            Entre para acessar o painel
          </div>
        </div>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="card p-6 space-y-4"
          noValidate
        >
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              autoComplete="email"
              className="input"
              disabled={submitting}
              {...register("email")}
            />
            {errors.email && (
              <p className="mt-1 text-xs text-danger">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label className="label">Senha</label>
            <input
              type="password"
              autoComplete="current-password"
              className="input"
              disabled={submitting}
              {...register("password")}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-danger">
                {errors.password.message}
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-md bg-danger/10 border border-danger/30 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-full"
          >
            {submitting ? <Spinner label="Entrando..." /> : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
