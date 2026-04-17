import type { PromptTestSpec, RunRecord } from '@/types';
import { cn } from '@/lib/cn';

interface TestResultBadgeProps {
  /** From the run record — authoritative aggregate counts. */
  tests: RunRecord['tests'];
  /** From the prompt frontmatter — individual test descriptors (used for the tooltip). */
  specs?: PromptTestSpec[];
  className?: string;
}

/**
 * Small `5/5 ✓` or `2/5 ✗` badge. The tooltip lists each test name, kind and
 * status so operators can see what actually failed without opening the log.
 */
export function TestResultBadge({ tests, specs, className }: TestResultBadgeProps) {
  const { total, passed, failed } = tests;
  if (total === 0) return null;

  const allPass = failed === 0 && passed === total;
  const anyFail = failed > 0;

  const tooltip = specs && specs.length > 0
    ? specs
        .map((t) => `${t.name}${t.kind ? ` [${t.kind}]` : ''} — ${t.status ?? 'pending'}`)
        .join('\n')
    : `${passed}/${total} passed, ${failed} failed`;

  const toneClass = allPass
    ? 'text-[color:var(--color-success)] border-[color:var(--color-success)]/40 bg-[color:var(--color-success)]/10'
    : anyFail
      ? 'text-[color:var(--color-danger)] border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10'
      : 'text-[color:var(--color-warning)] border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10';

  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono tabular-nums whitespace-pre-line',
        toneClass,
        className,
      )}
    >
      <span>
        {passed}/{total}
      </span>
      <span aria-hidden>{allPass ? '✓' : anyFail ? '✗' : '…'}</span>
    </span>
  );
}
