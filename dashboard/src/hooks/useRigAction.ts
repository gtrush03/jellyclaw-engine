import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

export type RigAction = "abort" | "approve" | "retry" | "skip" | "approve-anyway";

interface RigActionArgs {
  runId: string;
  action: RigAction;
  body?: Record<string, unknown>;
}

/**
 * Wraps `POST /api/runs/:id/action` in a TanStack mutation. Shows a Sonner
 * toast on success/error and invalidates the `runs` query so the card re-renders
 * with the new state before the next SSE tick even arrives.
 */
export function useRigAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, action, body }: RigActionArgs) => api.runAction(runId, action, body),
    onSuccess: (_data, vars) => {
      toast.success(`${actionLabel(vars.action)} sent`, {
        description: vars.runId,
      });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err, vars) => {
      toast.error(`${actionLabel(vars.action)} failed`, {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
}

function actionLabel(a: RigAction): string {
  switch (a) {
    case "abort":
      return "Abort";
    case "approve":
      return "Approve";
    case "retry":
      return "Retry";
    case "skip":
      return "Skip";
    case "approve-anyway":
      return "Approve anyway";
  }
}
