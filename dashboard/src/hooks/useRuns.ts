import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { RigState } from '@/types';

/**
 * Fetches the whole rig snapshot (`GET /api/runs`). Staleness is kept deliberately
 * short (10s) because `useSSE` will invalidate the `runs` query whenever the
 * backend emits a `run-*` event — the staleTime is only the worst-case bound.
 */
export function useRuns() {
  return useQuery<RigState>({
    queryKey: ['runs'],
    queryFn: api.runs,
    staleTime: 10_000,
    // A missing endpoint on an older server should not spam retries — one is enough.
    retry: 1,
  });
}
