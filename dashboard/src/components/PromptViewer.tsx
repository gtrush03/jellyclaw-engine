import { useEffect, useMemo, useRef } from 'react';
import {
  ArrowRight,
  Clipboard,
  Clock,
  ExternalLink,
  FileText,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { usePrompt } from '@/hooks/usePrompt';
import { usePrompts } from '@/hooks/usePrompts';
import { useDashboardStore } from '@/store/dashboard';
import { useCopy } from '@/hooks/useCopy';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';
import { StatusBadge } from './StatusBadge';
import { cn } from '@/lib/cn';

export function PromptViewer() {
  const selectedPromptId = useDashboardStore((s) => s.selectedPromptId);
  const setSelectedPromptId = useDashboardStore((s) => s.setSelectedPromptId);
  const closeViewer = useDashboardStore((s) => s.closeViewer);

  const { data, isLoading, error, refetch, isFetching } = usePrompt(selectedPromptId);
  const { data: prompts } = usePrompts();
  const copy = useCopy();
  const containerRef = useRef<HTMLDivElement>(null);

  const nextPromptId = useMemo(() => {
    if (!prompts || !selectedPromptId) return null;
    const idx = prompts.findIndex((p) => p.id === selectedPromptId);
    if (idx < 0 || idx >= prompts.length - 1) return null;
    return prompts[idx + 1]?.id ?? null;
  }, [prompts, selectedPromptId]);

  // ⌘-C on pane focus
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const selection = window.getSelection()?.toString();
        if (selection && selection.length > 0) return; // allow native copy of highlighted text
        if (data?.body) {
          e.preventDefault();
          void copy.copy(data.body, 'Full prompt copied');
        }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [data, copy]);

  if (!selectedPromptId) {
    return (
      <div className="p-6 h-full">
        <EmptyState
          icon={<Sparkles className="w-6 h-6" />}
          title="No prompt selected"
          message="Click a prompt card to see its fully-assembled copy-pasteable body."
          className="h-full"
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="h-full flex flex-col outline-none"
      aria-label="prompt viewer"
    >
      <div className="flex items-start justify-between p-4 border-b hairline">
        <div className="min-w-0 pr-2">
          {isLoading || !data ? (
            <>
              <Skeleton className="h-4 w-24 mb-2" />
              <Skeleton className="h-6 w-80" />
            </>
          ) : (
            <>
              <div className="font-mono text-[10px] tracking-widest text-[color:var(--color-text-muted)] mb-1">
                PHASE {String(data.phase).padStart(2, '0')} · {data.subPrompt}
              </div>
              <h1 className="text-lg font-semibold text-[color:var(--color-gold-bright)] leading-tight">
                {data.title}
              </h1>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="refresh"
            className={cn(
              'p-1.5 rounded text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] hover:bg-[color:var(--color-gold-faint)] transition-colors',
              isFetching && 'animate-spin',
            )}
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={closeViewer}
            aria-label="close viewer"
            className="p-1.5 rounded text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] hover:bg-[color:var(--color-gold-faint)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="p-6">
          <EmptyState
            icon={<FileText className="w-6 h-6" />}
            title="Failed to load prompt"
            message={(error as Error).message}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-4">
            {/* Metadata pills */}
            <div className="flex flex-wrap gap-1.5">
              {data ? (
                <>
                  <StatusBadge tone="gold" icon={<Clock className="w-3 h-3" />}>
                    when: {data.whenToRun}
                  </StatusBadge>
                  <StatusBadge tone="gold">duration: {data.duration}</StatusBadge>
                  <StatusBadge tone={data.newSession ? 'warning' : 'neutral'}>
                    {data.newSession ? 'new session' : 'same session'}
                  </StatusBadge>
                  <StatusBadge tone="neutral">model: {data.model}</StatusBadge>
                </>
              ) : (
                Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-6 w-28 rounded-full" />
                ))
              )}
            </div>

            {/* Primary copy button */}
            <button
              type="button"
              onClick={() => {
                if (data?.body) void copy.copy(data.body, 'Full prompt copied');
              }}
              disabled={!data?.body}
              className={cn(
                'w-full h-12 flex items-center justify-center gap-2 rounded-md font-medium tracking-wide text-sm',
                'bg-[color:var(--color-gold)] text-[#0a0a0a] hover:bg-[color:var(--color-gold-bright)] transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-gold)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-bg)]',
                copy.state === 'copied' && 'gold-glow',
              )}
              title="Copy full prompt (⌘C)"
            >
              <Clipboard className="w-4 h-4" />
              {copy.state === 'copied' ? 'Copied!' : 'Copy Full Prompt'}
              <span className="ml-2 font-mono text-[10px] opacity-70">⌘C</span>
            </button>

            {/* Rendered body */}
            <div className="rounded-lg border hairline bg-[color:var(--color-gold-faint)]/40 p-4 max-h-[70vh] overflow-y-auto">
              {isLoading || !data ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ) : (
                <MarkdownRenderer content={data.body} />
              )}
            </div>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t hairline p-3 flex items-center justify-between gap-2">
        {data?.filePath ? (
          <a
            href={`warp://action/open_file?path=${encodeURIComponent(data.filePath)}`}
            className="inline-flex items-center gap-1.5 text-xs font-mono text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] transition-colors"
            title={data.filePath}
          >
            <ExternalLink className="w-3 h-3" />
            View raw on disk
          </a>
        ) : (
          <span />
        )}
        {nextPromptId && (
          <button
            type="button"
            onClick={() => setSelectedPromptId(nextPromptId)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border hairline text-xs text-[color:var(--color-gold-bright)] hover:bg-[color:var(--color-gold-faint)] transition-colors"
          >
            Next prompt
            <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
