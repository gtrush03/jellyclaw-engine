import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';

interface CommitShaLinkProps {
  sha: string | null;
  className?: string;
}

/**
 * Monospace 7-char SHA with click-to-copy. Falls back to a dash when the run
 * hasn't produced a commit yet (e.g. in-flight or failed before a commit).
 */
export function CommitShaLink({ sha, className }: CommitShaLinkProps) {
  const [copied, setCopied] = useState(false);

  if (!sha) {
    return (
      <span
        className={cn(
          'inline-flex items-center font-mono text-[11px] text-[color:var(--color-text-muted)]',
          className,
        )}
        aria-label="no commit yet"
      >
        —
      </span>
    );
  }

  const short = sha.slice(0, 7);

  const onClick = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(sha).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${sha} · click to copy`}
      aria-label={`copy commit sha ${sha}`}
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[11px] tabular-nums rounded px-1 py-0.5',
        'text-[color:var(--color-gold-bright)] hover:bg-[color:var(--color-gold-faint)] transition-colors',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--color-gold)]',
        className,
      )}
    >
      <span>{short}</span>
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3 opacity-60" />}
    </button>
  );
}
