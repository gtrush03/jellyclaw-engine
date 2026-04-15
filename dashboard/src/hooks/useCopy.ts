import { useCallback, useState } from 'react';
import { toast } from 'sonner';

type CopyState = 'idle' | 'copying' | 'copied' | 'error';

export function useCopy(resetMs = 1600) {
  const [state, setState] = useState<CopyState>('idle');

  const copy = useCallback(
    async (text: string, successMessage?: string) => {
      setState('copying');
      try {
        if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(text);
        setState('copied');
        toast.success(successMessage ?? 'Copied to clipboard');
        window.setTimeout(() => setState('idle'), resetMs);
        return true;
      } catch (err) {
        setState('error');
        toast.error(`Copy failed: ${(err as Error).message}`);
        window.setTimeout(() => setState('idle'), resetMs);
        return false;
      }
    },
    [resetMs],
  );

  return { state, copy };
}
