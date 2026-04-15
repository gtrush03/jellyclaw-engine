import { useEffect, useRef } from 'react';
import { fetchEventSource, type EventSourceMessage } from '@microsoft/fetch-event-source';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useDashboardStore } from '@/store/dashboard';
import { SSE_URL } from '@/lib/api';

class RetriableError extends Error {}

export function useSSE() {
  const queryClient = useQueryClient();
  const setSseConnected = useDashboardStore((s) => s.setSseConnected);
  const setLastLogUpdate = useDashboardStore((s) => s.setLastLogUpdate);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    let backoff = 1000;
    const maxBackoff = 30_000;

    fetchEventSource(SSE_URL, {
      signal: ctrl.signal,
      openWhenHidden: true,

      onopen: async (res) => {
        if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
          setSseConnected(true);
          backoff = 1000;
          return;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`SSE fatal ${res.status}`);
        }
        throw new RetriableError();
      },

      onmessage: (msg: EventSourceMessage) => {
        try {
          handleEvent(msg, { queryClient, setLastLogUpdate });
        } catch (err) {
          console.warn('SSE message parse error', err);
        }
      },

      onerror: (err) => {
        setSseConnected(false);
        if (err instanceof RetriableError) {
          const wait = backoff;
          backoff = Math.min(backoff * 2, maxBackoff);
          return wait;
        }
        const wait = backoff;
        backoff = Math.min(backoff * 2, maxBackoff);
        return wait;
      },

      onclose: () => {
        setSseConnected(false);
        throw new RetriableError();
      },
    }).catch(() => {
      setSseConnected(false);
    });

    return () => {
      ctrl.abort();
      setSseConnected(false);
    };
  }, [queryClient, setSseConnected, setLastLogUpdate]);
}

interface HandlerCtx {
  queryClient: ReturnType<typeof useQueryClient>;
  setLastLogUpdate: (d: Date) => void;
}

/**
 * Backend emits these five event names (see `dashboard/server/src/routes/events.ts`):
 *   - completion-log-changed: COMPLETION-LOG.md changed on disk → everything recomputes
 *   - status-changed:         cheaper status-only recompute
 *   - prompt-added:           a new .md file appeared under prompts/
 *   - prompt-changed:         existing prompt file was edited
 *   - heartbeat:              keepalive every 30s so we know the stream is alive
 */
function handleEvent(msg: EventSourceMessage, { queryClient, setLastLogUpdate }: HandlerCtx) {
  const event = msg.event || 'message';
  let payload: unknown = null;
  if (msg.data) {
    try {
      payload = JSON.parse(msg.data);
    } catch {
      payload = msg.data;
    }
  }

  switch (event) {
    case 'heartbeat':
      // Heartbeat proves the connection is alive — update the indicator timestamp.
      setLastLogUpdate(new Date());
      return;

    case 'completion-log-changed':
      setLastLogUpdate(new Date());
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      void queryClient.invalidateQueries({ queryKey: ['phases'] });
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
      toast.success('Progress updated');
      return;

    case 'status-changed':
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      return;

    case 'prompt-added':
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
      toast.success('New prompt added');
      return;

    case 'prompt-changed': {
      const id = extractPromptId(payload);
      if (id) {
        void queryClient.invalidateQueries({ queryKey: ['prompt', id] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['prompts'] });
      }
      return;
    }

    default:
      return;
  }
}

function extractPromptId(p: unknown): string | null {
  if (p && typeof p === 'object') {
    // Backend event payloads include a `path` field; treat it as a prompt id
    // if it matches the `phase-NN/slug` shape.
    if ('id' in p) {
      const v = (p as { id: unknown }).id;
      if (typeof v === 'string') return v;
    }
    if ('path' in p) {
      const v = (p as { path: unknown }).path;
      if (typeof v === 'string' && /^phase-\d{2}(?:\.\d+)?\/[a-z0-9-]+$/i.test(v)) return v;
    }
  }
  return null;
}
