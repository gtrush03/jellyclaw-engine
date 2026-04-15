import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Status } from '@/types';

export function useStatus() {
  return useQuery<Status>({
    queryKey: ['status'],
    queryFn: api.status,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
