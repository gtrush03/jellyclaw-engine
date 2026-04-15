import { useEffect, useRef, useState } from "react";

/**
 * ProgressBarPremium — thin gold bar with animated shimmer while progressing,
 * milestone markers at 25/50/75, and a brief pulse on value change.
 *
 * Obsidian & Gold. Pure CSS animations, no framer-motion dependency.
 */
export interface ProgressBarPremiumProps {
  /** 0–100 */
  value: number;
  /** Optional: sections completed (for darker gold segmented background) */
  completedSections?: number;
  /** Optional: total sections (defaults to 4 quadrants at 25/50/75/100) */
  totalSections?: number;
  /** Optional aria label */
  label?: string;
  /** Optional className for outer container */
  className?: string;
}

export function ProgressBarPremium({
  value,
  completedSections = 0,
  totalSections = 4,
  label = "Progress",
  className = "",
}: ProgressBarPremiumProps): JSX.Element {
  const clamped = Math.max(0, Math.min(100, value));
  const [pulseKey, setPulseKey] = useState<number>(0);
  const prev = useRef<number>(clamped);

  useEffect(() => {
    if (prev.current !== clamped) {
      prev.current = clamped;
      setPulseKey((k) => k + 1);
    }
  }, [clamped]);

  const sectionPct = 100 / totalSections;
  const isMoving = clamped > 0 && clamped < 100;

  return (
    <div
      className={`relative ${className}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      {/* track */}
      <div className="relative h-[6px] w-full overflow-hidden rounded-full bg-white/5">
        {/* dark-gold segmented background for completed sections */}
        {Array.from({ length: totalSections }).map((_, i) => {
          const filled = i < completedSections;
          return (
            <div
              key={i}
              className="absolute top-0 h-full"
              style={{
                left: `${i * sectionPct}%`,
                width: `calc(${sectionPct}% - 2px)`,
                background: filled
                  ? "rgba(146, 132, 102, 0.18)"
                  : "transparent",
              }}
            />
          );
        })}

        {/* fill */}
        <div
          key={pulseKey}
          className="progressbar-premium-fill absolute top-0 left-0 h-full origin-left rounded-full"
          style={{
            width: `${clamped}%`,
            background:
              "linear-gradient(90deg, #6b6146 0%, #928466 50%, #d4bf8f 100%)",
            boxShadow: "0 0 12px rgba(146, 132, 102, 0.35)",
          }}
        >
          {isMoving && (
            <div
              className="progressbar-premium-shimmer absolute inset-0 rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(232, 230, 225, 0.25) 50%, transparent 100%)",
                backgroundSize: "200% 100%",
              }}
            />
          )}
        </div>

        {/* milestone markers at 25/50/75 */}
        {[25, 50, 75].map((m) => (
          <span
            key={m}
            className="absolute top-1/2 -translate-y-1/2"
            style={{ left: `calc(${m}% - 2px)` }}
            aria-hidden="true"
          >
            <span
              className="block h-[4px] w-[4px] rounded-full"
              style={{
                background:
                  clamped >= m
                    ? "#d4bf8f"
                    : "rgba(146, 132, 102, 0.35)",
                boxShadow:
                  clamped >= m
                    ? "0 0 6px rgba(212, 191, 143, 0.7)"
                    : "none",
                transition: "background 300ms ease, box-shadow 300ms ease",
              }}
            />
          </span>
        ))}
      </div>

      <style>{`
        @keyframes progressbar-premium-pulse {
          0%   { transform: scaleY(1); }
          40%  { transform: scaleY(1.5); }
          100% { transform: scaleY(1); }
        }
        @keyframes progressbar-premium-shimmer {
          0%   { background-position: -100% 0; }
          100% { background-position: 200% 0; }
        }
        .progressbar-premium-fill {
          animation: progressbar-premium-pulse 400ms ease-out;
          transition: width 500ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .progressbar-premium-shimmer {
          animation: progressbar-premium-shimmer 1.6s linear infinite;
        }
      `}</style>
    </div>
  );
}

export default ProgressBarPremium;
