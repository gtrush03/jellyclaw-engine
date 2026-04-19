import { Check, X } from "lucide-react";
import type { RunRecord } from "@/types";
import { cn } from "@/lib/cn";

interface SelfCheckBadgeProps {
  selfCheck: RunRecord["self_check"];
  className?: string;
}

/**
 * Compact badge summarising the rig's mid-run self-check gate.
 *   - null      → nothing rendered (gate hasn't fired yet)
 *   - continue  → gold check
 *   - escalate  → red X
 * Hovering reveals the decision reason and the cost at the gate.
 */
export function SelfCheckBadge({ selfCheck, className }: SelfCheckBadgeProps) {
  if (!selfCheck) return null;

  const isContinue = selfCheck.decision === "continue";
  const title = `self-check: ${selfCheck.decision} — ${selfCheck.reason} · $${selfCheck.cost_at_gate.toFixed(2)} at gate`;

  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-mono",
        isContinue
          ? "text-[color:var(--color-gold-bright)] border-[color:var(--color-gold-subtle)] bg-[color:var(--color-gold-faint)]"
          : "text-[color:var(--color-danger)] border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10",
        className,
      )}
    >
      {isContinue ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      <span className="uppercase tracking-wider">gate</span>
    </span>
  );
}
