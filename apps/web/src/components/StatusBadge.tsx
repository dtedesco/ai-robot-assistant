export type StatusKind = "online" | "offline" | "running" | "ended";

export interface StatusBadgeProps {
  kind: StatusKind;
  label?: string;
  className?: string;
}

const CONFIG: Record<
  StatusKind,
  { dot: string; text: string; defaultLabel: string; pulse?: boolean }
> = {
  online: {
    dot: "bg-success",
    text: "text-success",
    defaultLabel: "online",
  },
  running: {
    dot: "bg-success",
    text: "text-success",
    defaultLabel: "ao vivo",
    pulse: true,
  },
  offline: {
    dot: "bg-fg-subtle",
    text: "text-fg-subtle",
    defaultLabel: "offline",
  },
  ended: {
    dot: "bg-fg-subtle",
    text: "text-fg-subtle",
    defaultLabel: "encerrada",
  },
};

export default function StatusBadge({
  kind,
  label,
  className = "",
}: StatusBadgeProps) {
  const cfg = CONFIG[kind];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${cfg.text} ${className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${cfg.dot} ${
          cfg.pulse ? "animate-pulse" : ""
        }`}
      />
      {label ?? cfg.defaultLabel}
    </span>
  );
}
