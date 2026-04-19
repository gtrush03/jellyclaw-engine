import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, message, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center p-10 rounded-lg glass",
        className,
      )}
    >
      {icon && <div className="mb-3 text-[color:var(--color-gold)] opacity-70">{icon}</div>}
      <h3 className="text-sm font-semibold text-[color:var(--color-gold-bright)] mb-1">{title}</h3>
      {message && (
        <p className="text-xs text-[color:var(--color-text-muted)] max-w-sm">{message}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
