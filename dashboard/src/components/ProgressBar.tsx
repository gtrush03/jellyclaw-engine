import { cn } from "@/lib/cn";

interface ProgressBarProps {
  value: number; // 0-100
  className?: string;
  label?: string;
}

export function ProgressBar({ value, className, label }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("w-full", className)} aria-label={label ?? "progress"}>
      <div className="h-[3px] w-full bg-[color:var(--color-gold-faint)] rounded-full overflow-hidden relative">
        <div
          className="h-full bg-[color:var(--color-gold)] transition-[width] duration-500 ease-out gold-glow"
          style={{ width: `${clamped}%` }}
          role="progressbar"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
