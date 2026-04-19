import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Prompt } from "@/types";

export function usePrompts() {
  return useQuery<Prompt[]>({
    queryKey: ["prompts"],
    queryFn: api.prompts,
    staleTime: 30_000,
  });
}
