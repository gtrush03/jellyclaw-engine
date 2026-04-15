import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PromptDetail } from '@/types';

export function usePrompt(id: string | null) {
  return useQuery<PromptDetail>({
    queryKey: ['prompt', id],
    queryFn: () => {
      if (!id) throw new Error('No prompt id');
      return api.prompt(id);
    },
    enabled: !!id,
    staleTime: 60_000,
  });
}
