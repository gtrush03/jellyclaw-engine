import type { CSSProperties, ReactElement } from "react";

export interface DashboardSkeletonProps {
  /** Number of phase placeholder rows in the sidebar */
  phaseCount?: number;
  className?: string;
}

function shimmerStyle(): CSSProperties {
  return {
    background:
      "linear-gradient(90deg, rgba(146,132,102,0.06) 0%, rgba(146,132,102,0.18) 50%, rgba(146,132,102,0.06) 100%)",
    backgroundSize: "200% 100%",
    animation: "dash-shimmer 1.6s linear infinite",
  };
}

/**
 * DashboardSkeleton — shimmer placeholders that match the real dashboard layout:
 * header strip + progress bar + 3-column (sidebar / phase list / prompt view).
 */
export function DashboardSkeleton({
  phaseCount = 8,
  className = "",
}: DashboardSkeletonProps): ReactElement {
  return (
    <div
      className={`flex h-full w-full flex-col gap-4 p-4 ${className}`}
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading dashboard"
    >
      {/* header */}
      <div className="flex items-center justify-between">
        <div
          className="h-6 w-40 rounded-md"
          style={shimmerStyle()}
        />
        <div
          className="h-6 w-24 rounded-full"
          style={shimmerStyle()}
        />
      </div>

      {/* progress bar placeholder */}
      <div
        className="h-[6px] w-full rounded-full"
        style={shimmerStyle()}
      />

      {/* 3-column grid */}
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_minmax(0,1.6fr)] gap-4">
        {/* sidebar: phases */}
        <div
          className="flex flex-col gap-2 rounded-xl p-3"
          style={{
            background: "rgba(146,132,102,0.03)",
            border: "1px solid rgba(146,132,102,0.08)",
          }}
        >
          <div
            className="mb-2 h-3 w-20 rounded"
            style={shimmerStyle()}
          />
          {Array.from({ length: phaseCount }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div
                className="h-3 w-3 flex-none rounded-full"
                style={shimmerStyle()}
              />
              <div
                className="h-3 flex-1 rounded"
                style={{
                  ...shimmerStyle(),
                  animationDelay: `${i * 60}ms`,
                  opacity: 0.9 - i * 0.05,
                }}
              />
            </div>
          ))}
        </div>

        {/* prompt list */}
        <div
          className="flex flex-col gap-2 rounded-xl p-3"
          style={{
            background: "rgba(146,132,102,0.03)",
            border: "1px solid rgba(146,132,102,0.08)",
          }}
        >
          <div className="h-7 w-full rounded-md" style={shimmerStyle()} />
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col gap-1.5 rounded-lg p-2.5"
              style={{
                background: "rgba(146,132,102,0.02)",
                border: "1px solid rgba(146,132,102,0.06)",
              }}
            >
              <div
                className="h-3 w-3/4 rounded"
                style={{ ...shimmerStyle(), animationDelay: `${i * 80}ms` }}
              />
              <div
                className="h-2.5 w-1/2 rounded"
                style={{
                  ...shimmerStyle(),
                  animationDelay: `${i * 80 + 40}ms`,
                  opacity: 0.6,
                }}
              />
            </div>
          ))}
        </div>

        {/* prompt detail */}
        <div
          className="flex flex-col gap-3 rounded-xl p-4"
          style={{
            background: "rgba(146,132,102,0.03)",
            border: "1px solid rgba(146,132,102,0.08)",
          }}
        >
          <div className="h-4 w-1/2 rounded" style={shimmerStyle()} />
          <div
            className="h-3 w-1/3 rounded"
            style={{ ...shimmerStyle(), opacity: 0.6 }}
          />
          <div className="mt-2 flex flex-col gap-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="h-3 rounded"
                style={{
                  ...shimmerStyle(),
                  animationDelay: `${i * 50}ms`,
                  width: `${60 + ((i * 13) % 38)}%`,
                  opacity: 0.8 - i * 0.04,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes dash-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [aria-busy="true"] * {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}

export default DashboardSkeleton;
