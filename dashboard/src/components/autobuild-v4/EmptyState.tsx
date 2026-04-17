import { Play } from 'lucide-react';

export interface EmptyStateProps {
  onStart: () => void;
}

/**
 * Centered "Press Start" — rendered only when the rig is offline AND there
 * are zero runs in history. Single primary gold button, nothing else.
 */
export function EmptyState({ onStart }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6">
      <div className="text-center">
        <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-[color:var(--color-text-muted)] mb-2">
          Autobuild
        </div>
        <h2 className="font-sans text-lg font-semibold text-[color:var(--color-text)]">
          Press Start
        </h2>
        <p className="mt-2 text-[12px] text-[color:var(--color-text-muted)] max-w-xs mx-auto leading-relaxed">
          The rig is offline. Starting will spawn the dispatcher daemon and
          begin working the queued fix prompts.
        </p>
      </div>
      <button
        type="button"
        onClick={onStart}
        className="flex items-center gap-2 rounded-md px-5 py-2.5 bg-[color:var(--color-gold)] text-[#0a0a0a] hover:bg-[color:var(--color-gold-bright)] font-mono text-[13px] font-semibold gold-glow transition-colors"
      >
        <Play className="w-3.5 h-3.5" fill="currentColor" />
        Start
      </button>
    </div>
  );
}
