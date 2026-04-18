import type { CSSProperties } from "react";

const BASE = "animate-pulse rounded-md bg-bg-muted/70";

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className = "", style }: SkeletonProps) {
  return <div className={`${BASE} ${className}`} style={style} />;
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

export function SkeletonText({ lines = 3, className = "" }: SkeletonTextProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={`${BASE} h-3`}
          style={{ width: `${90 - i * 8}%` }}
        />
      ))}
    </div>
  );
}

export interface SkeletonRowProps {
  cols?: number;
  className?: string;
}

/**
 * A single row of a table — renders <tr><td>... cells.
 * Must be used inside a <tbody>.
 */
export function SkeletonRow({ cols = 4, className = "" }: SkeletonRowProps) {
  return (
    <tr className={className}>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i}>
          <div className={`${BASE} h-3`} style={{ width: i === 0 ? "70%" : "45%" }} />
        </td>
      ))}
    </tr>
  );
}

export interface SkeletonTableProps {
  rows?: number;
  cols?: number;
}

/**
 * A plain (non-table) skeleton block sized for a list view, used when we
 * cannot render a <tbody> in-place (no <table> wrapper).
 */
export function SkeletonTable({ rows = 4, cols = 4 }: SkeletonTableProps) {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className={`${BASE} h-3`}
              style={{ flex: c === 0 ? 2 : 1 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface SkeletonCardProps {
  className?: string;
  lines?: number;
}

export function SkeletonCard({ className = "", lines = 3 }: SkeletonCardProps) {
  return (
    <div className={`card p-5 space-y-3 ${className}`}>
      <div className={`${BASE} h-4 w-1/3`} />
      <SkeletonText lines={lines} />
    </div>
  );
}
