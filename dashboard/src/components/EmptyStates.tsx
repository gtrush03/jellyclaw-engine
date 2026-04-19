import type { ReactElement, ReactNode } from "react";

export type EmptyStateVariant = "no-prompt-selected" | "no-phases" | "error";

export interface EmptyStateProps {
  variant: EmptyStateVariant;
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

const GOLD = "#928466";
const GOLD_MUTED = "rgba(146, 132, 102, 0.35)";
const FG = "#e8e6e1";

function Frame({ children }: { children: ReactNode }): ReactElement {
  // ASCII-style gold frame, rendered as SVG so it scales crisply.
  return (
    <svg viewBox="0 0 220 140" width="220" height="140" role="img" aria-hidden="true">
      {/* corners */}
      <g stroke={GOLD} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 22 V10 H22" />
        <path d="M198 10 H210 V22" />
        <path d="M210 118 V130 H198" />
        <path d="M22 130 H10 V118" />
        {/* dashed sides */}
        <path d="M30 10 H190" strokeDasharray="2 4" opacity="0.7" />
        <path d="M30 130 H190" strokeDasharray="2 4" opacity="0.7" />
        <path d="M10 30 V110" strokeDasharray="2 4" opacity="0.7" />
        <path d="M210 30 V110" strokeDasharray="2 4" opacity="0.7" />
      </g>
      {children}
    </svg>
  );
}

function NoPromptSvg(): ReactElement {
  return (
    <Frame>
      {/* stacked "cards" hinting at a list */}
      <g stroke={GOLD} strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <rect x="40" y="40" width="60" height="14" rx="2" opacity="0.9" />
        <rect x="40" y="60" width="60" height="14" rx="2" opacity="0.6" />
        <rect x="40" y="80" width="60" height="14" rx="2" opacity="0.35" />
      </g>
      {/* arrow pointing from list to detail panel */}
      <g stroke={GOLD} strokeWidth="1" fill="none" strokeLinecap="round">
        <path d="M108 67 L128 67" />
        <path d="M124 63 L128 67 L124 71" />
      </g>
      {/* detail placeholder */}
      <rect
        x="134"
        y="44"
        width="56"
        height="52"
        rx="3"
        fill="none"
        stroke={GOLD_MUTED}
        strokeDasharray="3 3"
      />
      <text
        x="162"
        y="74"
        textAnchor="middle"
        fontSize="9"
        fill={GOLD}
        fontFamily="ui-monospace, monospace"
      >
        ?
      </text>
    </Frame>
  );
}

function NoPhasesSvg(): ReactElement {
  return (
    <Frame>
      <g stroke={GOLD} strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* empty grid */}
        <line x1="40" y1="50" x2="180" y2="50" strokeDasharray="2 4" />
        <line x1="40" y1="72" x2="180" y2="72" strokeDasharray="2 4" />
        <line x1="40" y1="94" x2="180" y2="94" strokeDasharray="2 4" />
        <line x1="70" y1="38" x2="70" y2="106" strokeDasharray="2 4" />
        <line x1="110" y1="38" x2="110" y2="106" strokeDasharray="2 4" />
        <line x1="150" y1="38" x2="150" y2="106" strokeDasharray="2 4" />
      </g>
      {/* single dot hinting emptiness */}
      <circle cx="110" cy="72" r="2.5" fill={GOLD} />
    </Frame>
  );
}

function ErrorSvg(): ReactElement {
  return (
    <Frame>
      <g
        stroke="#d66a5b"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="110" cy="70" r="26" />
        <path d="M110 58 V74" />
        <circle cx="110" cy="82" r="1.4" fill="#d66a5b" />
      </g>
      <g stroke={GOLD} strokeWidth="0.8" fill="none" opacity="0.5">
        <path d="M68 120 L152 120" strokeDasharray="2 3" />
      </g>
    </Frame>
  );
}

const DEFAULTS: Record<
  EmptyStateVariant,
  { title: string; description: string; svg: () => ReactElement }
> = {
  "no-prompt-selected": {
    title: "Select a prompt",
    description:
      "Pick a phase from the left, then choose a prompt to see the full text and copy it into your session.",
    svg: NoPromptSvg,
  },
  "no-phases": {
    title: "No phases yet",
    description:
      "Run the engine or reload the spec. Phases will appear here as soon as the backend streams them.",
    svg: NoPhasesSvg,
  },
  error: {
    title: "Something broke",
    description:
      "The dashboard couldn't load this view. Check the engine terminal for logs, then retry.",
    svg: ErrorSvg,
  },
};

export function EmptyState({
  variant,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps): ReactElement {
  const d = DEFAULTS[variant];
  const Svg = d.svg;
  return (
    <div
      className={`flex flex-col items-center justify-center gap-4 px-8 py-12 text-center ${className}`}
      style={{ color: FG }}
    >
      <Svg />
      <div className="flex flex-col gap-1">
        <h3
          className="text-sm font-medium tracking-wide"
          style={{ color: "#d4bf8f", fontFamily: "Inter, ui-sans-serif" }}
        >
          {title ?? d.title}
        </h3>
        <p
          className="max-w-sm text-xs leading-relaxed"
          style={{ color: "rgba(232, 230, 225, 0.7)" }}
        >
          {description ?? d.description}
        </p>
      </div>
      {action}
    </div>
  );
}

export default EmptyState;
