import { cn } from "@/lib/cn";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "bg-[color:var(--color-gold-faint)] border hairline rounded animate-pulse",
        className,
      )}
    />
  );
}
