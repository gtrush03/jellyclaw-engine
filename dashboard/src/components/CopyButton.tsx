import { Check, Copy, Loader2, X } from 'lucide-react';
import { useCopy } from '@/hooks/useCopy';
import { cn } from '@/lib/cn';

interface CopyButtonProps {
  text: string;
  label?: string;
  variant?: 'primary' | 'ghost' | 'inline';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  successMessage?: string;
}

export function CopyButton({
  text,
  label = 'Copy',
  variant = 'ghost',
  size = 'md',
  className,
  successMessage,
}: CopyButtonProps) {
  const { state, copy } = useCopy();

  const icon =
    state === 'copying' ? (
      <Loader2 className="w-4 h-4 animate-spin" />
    ) : state === 'copied' ? (
      <Check className="w-4 h-4" />
    ) : state === 'error' ? (
      <X className="w-4 h-4" />
    ) : (
      <Copy className="w-4 h-4" />
    );

  const display = state === 'copied' ? 'Copied' : state === 'error' ? 'Failed' : label;

  return (
    <button
      type="button"
      onClick={() => void copy(text, successMessage)}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-bg)]',
        variant === 'primary' &&
          'bg-[color:var(--color-gold)] text-[#0a0a0a] hover:bg-[color:var(--color-gold-bright)] rounded-md',
        variant === 'ghost' &&
          'border hairline text-[color:var(--color-gold-bright)] hover:bg-[color:var(--color-gold-faint)] rounded-md',
        variant === 'inline' &&
          'text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)]',
        size === 'sm' && 'px-2 py-1 text-xs',
        size === 'md' && 'px-3 py-2 text-sm',
        size === 'lg' && 'px-4 h-12 text-sm tracking-wide',
        state === 'copied' && 'gold-glow',
        className,
      )}
    >
      {icon}
      <span>{display}</span>
    </button>
  );
}
