import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export interface Breadcrumb {
  label: string;
  to?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
  className?: string;
}

export default function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
  className = "",
}: PageHeaderProps) {
  return (
    <div className={`mb-6 flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="text-xs text-fg-muted mb-1" aria-label="Breadcrumb">
            {breadcrumbs.map((b, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <span key={i}>
                  {b.to && !isLast ? (
                    <Link to={b.to} className="hover:text-fg transition-colors">
                      {b.label}
                    </Link>
                  ) : (
                    <span className={isLast ? "text-fg-muted" : ""}>
                      {b.label}
                    </span>
                  )}
                  {!isLast && <span className="mx-1.5 text-fg-subtle">/</span>}
                </span>
              );
            })}
          </nav>
        )}
        <h1 className="text-xl font-semibold truncate">{title}</h1>
        {subtitle && (
          <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {actions && <div className="shrink-0 flex gap-2">{actions}</div>}
    </div>
  );
}
