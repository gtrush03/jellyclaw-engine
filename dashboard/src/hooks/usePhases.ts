import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Phase } from "@/types";

export function usePhases() {
  return useQuery<Phase[]>({
    queryKey: ["phases"],
    queryFn: api.phases,
    staleTime: 15_000,
  });
}
