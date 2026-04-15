import { Check, CircleDashed, Loader2, Terminal } from 'lucide-react';
import type { Prompt } from '@/types';
import { cn } from '@/lib/cn';
import { StatusBadge } from './StatusBadge';

interface PromptCardProps {
  prompt: Prompt;
  active: boolean;
  onClick: () => void;
}

export function PromptCard({ prompt, active, onClick }: PromptCardProps) {
  const statusIcon =
    prompt.status === 'complete' ? (
      <Check className="w-3.5 h-3.5 text-[color:var(--color-success)]" />
    ) : prompt.status === 'in-progress' ? (
      <Loader2 className="w-3.5 h-3.5 animate-spin text-[color:var(--color-warning)]" />
    ) : (
      <CircleDashed className="w-3.5 h-3.5 text-[color:var(--color-text-muted)]" />
    );

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left group rounded-lg p-4 border transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)]',
        active
          ? 'glass gold-glow border-[color:var(--color-gold)]/60'
          : 'glass hover:border-[color:var(--color-gold-subtle)] hairline hover:-translate-y-px',
      )}
      aria-pressed={active}
    >
      <div className="flex items-center gap-2 mb-2">
        <StatusBadge tone="gold">
          P{String(prompt.phase).padStart(2, '0')} · {prompt.subPrompt}
        </StatusBadge>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-[color:var(--color-text-muted)] font-mono">
          {statusIcon}
          <span>{prompt.status}</span>
        </div>
      </div>
      <h3 className="text-[15px] font-medium text-[color:var(--color-text)] leading-snug mb-2 group-hover:text-[color:var(--color-gold-bright)] transition-colors">
        {prompt.title}
      </h3>
      <div className="flex items-center gap-3 text-[11px] text-[color:var(--color-text-muted)] font-mono">
        <span className="inline-flex items-center gap-1">
          <Terminal className="w-3 h-3" />
          {prompt.model}
        </span>
        <span>·</span>
        <span>{prompt.duration}</span>
        {prompt.newSession && (
          <>
            <span>·</span>
            <span className="text-[color:var(--color-gold)]">new session</span>
          </>
        )}
      </div>
    </button>
  );
}
