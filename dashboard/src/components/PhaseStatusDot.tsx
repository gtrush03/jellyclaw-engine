import type { CSSProperties, ReactElement } from "react";

export type PhaseStatus = "not-started" | "in-progress" | "complete";

export interface PhaseStatusDotProps {
  status: PhaseStatus;
  /** Optional aria label override */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_LABELS: Record<PhaseStatus, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  complete: "Complete",
};

/**
 * PhaseStatusDot — 12x12 status indicator.
 *   not-started: muted dot
 *   in-progress: pulsing gold dot with glow
 *   complete:    solid gold dot with embedded check mark
 */
export function PhaseStatusDot({
  status,
  label,
  className = "",
  style,
}: PhaseStatusDotProps): ReactElement {
  const ariaLabel = label ?? DEFAULT_LABELS[status];

  if (status === "complete") {
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        className={`inline-flex h-3 w-3 items-center justify-center rounded-full ${className}`}
        style={{
          background: "#928466",
          boxShadow: "0 0 6px rgba(146, 132, 102, 0.55)",
          ...style,
        }}
      >
        <svg
          viewBox="0 0 10 10"
          width="8"
          height="8"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 5.2 L4.2 7.4 L8 3"
            stroke="#050505"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (status === "in-progress") {
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        className={`phase-dot-pulse inline-block h-3 w-3 rounded-full ${className}`}
        style={{
          background: "#928466",
          ...style,
        }}
      >
        <style>{`
          @keyframes phase-dot-pulse-kf {
            0%,100% {
              box-shadow: 0 0 0 0 rgba(146,132,102,0.55),
                          0 0 6px 0 rgba(146,132,102,0.5);
              transform: scale(1);
            }
            50% {
              box-shadow: 0 0 0 4px rgba(146,132,102,0),
                          0 0 10px 0 rgba(146,132,102,0.7);
              transform: scale(1.08);
            }
          }
          .phase-dot-pulse {
            animation: phase-dot-pulse-kf 1.8s ease-in-out infinite;
          }
        `}</style>
      </span>
    );
  }

  // not-started
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={`inline-block h-3 w-3 rounded-full ${className}`}
      style={{
        background: "rgba(146, 132, 102, 0.3)",
        ...style,
      }}
    />
  );
}

export default PhaseStatusDot;
