import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'gold';

interface StatusBadgeProps {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

const toneStyles: Record<Tone, string> = {
  neutral:
    'text-[color:var(--color-text-muted)] border-[color:var(--color-gold-subtle)] bg-transparent',
  gold:
    'text-[color:var(--color-gold-bright)] border-[color:var(--color-gold-subtle)] bg-[color:var(--color-gold-faint)]',
  success:
    'text-[color:var(--color-success)] border-[color:var(--color-success)]/40 bg-[color:var(--color-success)]/10',
  warning:
    'text-[color:var(--color-warning)] border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10',
  danger:
    'text-[color:var(--color-danger)] border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10',
};

export function StatusBadge({ tone = 'neutral', icon, children, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium tracking-tight font-mono',
        toneStyles[tone],
        className,
      )}
    >
      {icon && <span className="inline-flex shrink-0">{icon}</span>}
      {children}
    </span>
  );
}
