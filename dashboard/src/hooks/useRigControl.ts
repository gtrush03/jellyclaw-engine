import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Mutations for the three rig-process control endpoints — Start / Stop / Tick.
 * Each pops a Sonner toast on success/error and invalidates both `['runs']`
 * and `['rig', 'running']` so the UI updates immediately without waiting for
 * the next SSE fan-out.
 *
 * The Start mutation intentionally swallows the `409 Conflict` case (rig is
 * already running) into an informational toast rather than an error toast —
 * double-clicking Start shouldn't feel like a failure.
 */
export function useRigControl() {
  const queryClient = useQueryClient();

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
    void queryClient.invalidateQueries({ queryKey: ["rig", "running"] });
  };

  const start = useMutation({
    mutationFn: () => api.rigStart(),
    onSuccess: (data) => {
      toast.success("Rig started", {
        description: data.pid ? `pid ${data.pid}` : undefined,
      });
      invalidateAll();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409")) {
        toast.info("Rig is already running");
        invalidateAll();
        return;
      }
      toast.error("Failed to start rig", { description: msg });
    },
  });

  const stop = useMutation({
    mutationFn: () => api.rigStop(),
    onSuccess: () => {
      toast.success("Rig stopped");
      invalidateAll();
    },
    onError: (err) => {
      toast.error("Failed to stop rig", {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const tick = useMutation({
    mutationFn: () => api.rigTick(),
    onSuccess: () => {
      toast.success("Scheduler ticked");
      invalidateAll();
    },
    onError: (err) => {
      toast.error("Tick failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  return { start, stop, tick };
}
