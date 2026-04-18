export interface SpinnerProps {
  className?: string;
  label?: string;
}

/**
 * Inline SVG spinner, intended for use inside buttons and small surfaces.
 */
export default function Spinner({ className = "h-4 w-4", label }: SpinnerProps) {
  return (
    <span className="inline-flex items-center gap-2" role="status" aria-live="polite">
      <svg
        className={`animate-spin ${className}`}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="3"
        />
        <path
          d="M22 12a10 10 0 0 1-10 10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {label && <span>{label}</span>}
    </span>
  );
}
