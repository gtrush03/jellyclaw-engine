import { ChevronDown, ChevronRight } from "lucide-react";
import type { Phase } from "@/types";
import { cn } from "@/lib/cn";

interface PhaseItemProps {
  phase: Phase;
  collapsed: boolean;
  active: boolean;
  onToggleCollapsed: () => void;
  onClick: () => void;
}

function statusIndicator(status: Phase["status"]): string {
  if (status === "complete") return "✅";
  if (status === "in-progress") return "🔄";
  return "⏳";
}

export function PhaseItem({
  phase,
  collapsed,
  active,
  onToggleCollapsed,
  onClick,
}: PhaseItemProps) {
  const pct = phase.promptCount === 0 ? 0 : (phase.promptsCompleted / phase.promptCount) * 100;
  const label = `Phase ${String(phase.phase).padStart(2, "0")}`;

  return (
    <div
      className={cn(
        "group px-3 py-2 cursor-pointer border-l-2 transition-colors",
        active
          ? "border-[color:var(--color-gold)] bg-[color:var(--color-gold-faint)]"
          : "border-transparent hover:bg-[color:var(--color-gold-faint)]",
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapsed();
          }}
          className="text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] transition-colors"
          aria-label={collapsed ? "expand" : "collapse"}
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        <span className="text-sm leading-none" aria-hidden="true">
          {statusIndicator(phase.status)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] text-[color:var(--color-text-muted)] tracking-wider">
              {label}
            </span>
            <span className="font-mono text-[10px] text-[color:var(--color-gold)] ml-auto tabular-nums">
              {phase.promptsCompleted}/{phase.promptCount}
            </span>
          </div>
          <div
            className="text-[13px] text-[color:var(--color-text)] truncate mt-0.5"
            title={phase.name}
          >
            {phase.name}
          </div>
          <div className="mt-1.5 h-[2px] bg-[color:var(--color-gold-faint)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[color:var(--color-gold)] transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
