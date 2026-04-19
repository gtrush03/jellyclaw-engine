import { useEffect, useState } from "react";
import type { ReactElement } from "react";

export type LiveStatus = "connected" | "disconnected" | "reconnecting";

export interface LiveIndicatorProps {
  status: LiveStatus;
  /** ISO timestamp or Date of last SSE event received */
  lastUpdate?: Date | string | null;
  className?: string;
}

function formatRelative(d: Date): string {
  const now = Date.now();
  const delta = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return d.toLocaleString();
}

/**
 * LiveIndicator — small "LIVE" badge with pulsing gold dot when SSE is connected.
 * Greys out with a spinner on disconnect / reconnect.
 */
export function LiveIndicator({
  status,
  lastUpdate = null,
  className = "",
}: LiveIndicatorProps): ReactElement {
  const [, force] = useState<number>(0);

  // Tick once a second so the tooltip stays fresh
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const date = lastUpdate instanceof Date ? lastUpdate : lastUpdate ? new Date(lastUpdate) : null;
  const tooltip = date
    ? `Last update: ${formatRelative(date)}`
    : status === "connected"
      ? "Live stream connected"
      : "Live stream offline";

  const isConnected = status === "connected";
  const isReconnecting = status === "reconnecting";

  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      role="status"
      className={`live-indicator inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ${className}`}
      style={{
        background: isConnected ? "rgba(146,132,102,0.08)" : "rgba(146,132,102,0.03)",
        border: `1px solid ${isConnected ? "rgba(146,132,102,0.45)" : "rgba(146,132,102,0.18)"}`,
        color: isConnected ? "#d4bf8f" : "rgba(232,230,225,0.45)",
        transition: "background 300ms ease, border-color 300ms ease, color 300ms ease",
        fontFamily: "Inter, ui-sans-serif",
      }}
    >
      {isConnected ? (
        <span
          className="live-indicator-dot inline-block h-1.5 w-1.5 rounded-full"
          aria-hidden="true"
          style={{ background: "#928466" }}
        />
      ) : isReconnecting ? (
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          aria-hidden="true"
          className="live-indicator-spin"
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="rgba(146,132,102,0.25)"
            strokeWidth="1.5"
          />
          <path
            d="M14 8 A6 6 0 0 0 8 2"
            fill="none"
            stroke="#928466"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "rgba(146,132,102,0.3)" }}
        />
      )}
      <span>{isConnected ? "Live" : isReconnecting ? "Reconnecting" : "Offline"}</span>

      <style>{`
        @keyframes live-indicator-pulse {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(146,132,102,0.55);
            transform: scale(1);
          }
          50% {
            box-shadow: 0 0 0 4px rgba(146,132,102,0);
            transform: scale(1.25);
          }
        }
        .live-indicator-dot {
          animation: live-indicator-pulse 1.6s ease-in-out infinite;
        }
        @keyframes live-indicator-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        .live-indicator-spin {
          animation: live-indicator-spin 0.9s linear infinite;
          transform-origin: 50% 50%;
        }
        @media (prefers-reduced-motion: reduce) {
          .live-indicator-dot, .live-indicator-spin {
            animation: none !important;
          }
        }
      `}</style>
    </span>
  );
}

export default LiveIndicator;
