import { useMemo } from 'react';
import { usePrompts } from '@/hooks/usePrompts';
import { useRuns } from '@/hooks/useRuns';
import { enrichPrompt, type EnrichedPrompt } from '@/lib/enrich-prompt';

/**
 * Merge a prompt (from `GET /api/prompts`) with its run record (from
 * `GET /api/runs`) into a single object the card can render. Pure wrapper
 * around `enrichPrompt` so the conflict-resolution logic stays testable.
 */
export function useEnrichedPrompt(promptId: string | null): EnrichedPrompt | null {
  const { data: prompts } = usePrompts();
  const { data: rig } = useRuns();

  return useMemo(() => {
    if (!promptId || !prompts) return null;
    const prompt = prompts.find((p) => p.id === promptId);
    if (!prompt) return null;
    const run = rig?.runs?.[promptId] ?? null;
    return enrichPrompt(prompt, run);
  }, [promptId, prompts, rig]);
}
