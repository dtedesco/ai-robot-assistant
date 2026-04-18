import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  durationMs: number;
  leaving?: boolean;
}

export interface ToastApi {
  success(message: string, opts?: { durationMs?: number }): number;
  error(message: string, opts?: { durationMs?: number }): number;
  info(message: string, opts?: { durationMs?: number }): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_STACK = 4;
const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 8000;
const LEAVE_ANIM_MS = 200;

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const dismiss = useCallback((id: number) => {
    // Mark as leaving so animation plays, then remove after animation
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    );
    const existing = timersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      timersRef.current.delete(id);
    }
    const removeTimer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, LEAVE_ANIM_MS);
    timersRef.current.set(id, removeTimer);
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, durationMs: number) => {
      const id = nextId++;
      setToasts((prev) => {
        const next = [...prev, { id, kind, message, durationMs }];
        if (next.length > MAX_STACK) {
          const overflow = next.length - MAX_STACK;
          const dropped = next.slice(0, overflow);
          for (const t of dropped) {
            const timer = timersRef.current.get(t.id);
            if (timer) {
              clearTimeout(timer);
              timersRef.current.delete(t.id);
            }
          }
          return next.slice(overflow);
        }
        return next;
      });
      const timer = setTimeout(() => dismiss(id), durationMs);
      timersRef.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, opts) =>
        push("success", message, opts?.durationMs ?? DEFAULT_DURATION),
      error: (message, opts) =>
        push("error", message, opts?.durationMs ?? ERROR_DURATION),
      info: (message, opts) =>
        push("info", message, opts?.durationMs ?? DEFAULT_DURATION),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToastContext(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed top-4 right-4 z-[100] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))]"
    >
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastView({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Next tick: switch to "entered" state to trigger slide-in
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const base =
    "pointer-events-auto rounded-md border px-3.5 py-2.5 shadow-lg backdrop-blur-sm text-sm flex items-start gap-2.5 transition-all duration-200 ease-out";
  const visible =
    mounted && !toast.leaving
      ? "translate-x-0 opacity-100"
      : "translate-x-6 opacity-0";

  const palette: Record<ToastKind, string> = {
    success: "bg-success/10 border-success/30 text-success",
    error: "bg-danger/10 border-danger/40 text-danger",
    info: "bg-accent/10 border-accent/30 text-accent",
  };

  return (
    <div
      className={[base, palette[toast.kind], visible].join(" ")}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <ToastIcon kind={toast.kind} />
      <div className="flex-1 text-fg leading-snug">{toast.message}</div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="text-fg-muted hover:text-fg transition-colors -mr-1"
        aria-label="Fechar"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  const common = {
    viewBox: "0 0 24 24",
    className: "h-4 w-4 mt-0.5 shrink-0",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "success") {
    return (
      <svg {...common}>
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}
