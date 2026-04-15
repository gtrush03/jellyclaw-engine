# Phase 15 — Desktop App MVP — Prompt 03: SSE consumer + state machine

**When to run:** After prompt 02 is marked ✅ in Phase 15 Notes; `engine_status` returns a live URL + auth token in the window.
**Estimated duration:** 5–7 hours
**New session?** Yes — start a fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `15` and `<name>` with `desktop-mvp`.

---

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §3 (Event schema — the 15-variant discriminated union), §10 (HTTP routes: `POST /v1/sessions`, `GET /v1/sessions/:id`, `GET /events/:id` SSE, `POST /v1/sessions/:id/steer`, `POST /v1/sessions/:id/cancel`).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/shared/src/events.ts` — the source of truth for event types the UI consumes.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md` for the state-machine shape.
4. WebFetch:
   - `https://zustand.docs.pmnd.rs/getting-started/introduction` — v5 slice pattern + `subscribeWithSelector`
   - `https://stately.ai/docs/xstate` — XState v5 actor API, `setup`, typed events
   - `https://tanstack.com/query/latest/docs/framework/react/overview` — v5 `useQuery` + `queryKey` structure + mutations
   - `https://github.com/Azure/fetch-event-source` (the `@microsoft/fetch-event-source` README) — `fetchEventSource`, `onopen`, `onmessage`, reconnect strategy, `signal`
   - `https://react.dev/blog/2024/12/05/react-19` — `useTransition`, `useOptimistic`, Action API (optional for optimistic steer)
5. Context7: resolve `pmndrs/zustand`, `statelyai/xstate`, `tanstack/query` and fetch latest v5 snippets.
6. Re-read the Rust `commands.rs` from prompt 02 to confirm the return shape of `get_engine_url`.

## Implementation task

Implement the full frontend event-stream pipeline: engine URL bootstrap → SSE subscription with auto-reconnect → dispatch into an XState v5 wish machine → persist events into a Zustand store (ring-buffered) → expose a `useWish(sessionId)` hook. Add TanStack Query for the REST calls (create session, list sessions, get history, steer, cancel). No UI yet — that's prompt 04.

### Files to create/modify

- `desktop/src/lib/tauri.ts` — thin wrapper around `invoke()` for our 4 commands
- `desktop/src/lib/sse.ts` — SSE client (fetchEventSource + AbortController + backoff + heartbeat)
- `desktop/src/lib/queryClient.ts` — TanStack QueryClient singleton
- `desktop/src/lib/api.ts` — typed REST client (createSession / listSessions / getHistory / steer / cancel)
- `desktop/src/state/useEngineStore.ts` — Zustand: sessions Map, activeWishId, events ring buffer, cost totals
- `desktop/src/state/wishMachine.ts` — XState v5 machine
- `desktop/src/hooks/useWish.ts` — actor + SSE subscription
- `desktop/src/hooks/useEngineUrl.ts` — polls `get_engine_url` until available
- `desktop/src/App.tsx` — wrap in `QueryClientProvider`, smoke-test the hook

### Prerequisites check

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm ls zustand xstate @xstate/react @tanstack/react-query @microsoft/fetch-event-source
# all present from prompt 01; otherwise `pnpm add` them
pnpm tauri dev &     # engine must be live
sleep 10
curl -s http://127.0.0.1:<port>/v1/health    # 200 OK
```

### Step-by-step implementation

1. **Bootstrap the engine URL** (`hooks/useEngineUrl.ts`): call `invoke("get_engine_url")` every 500ms until it resolves, then cache.
2. **Build the SSE client** (`lib/sse.ts`) using `@microsoft/fetch-event-source` — it preserves the `Authorization: Bearer <token>` header (native `EventSource` can't).
3. **Implement the XState wish machine** (`state/wishMachine.ts`).
4. **Implement the Zustand store** with a ring-buffered events array (cap 10k) and a sessions Map keyed by sessionId.
5. **Wire TanStack Query** for mutations/queries.
6. **Expose `useWish(sessionId)`** that starts the actor, opens SSE, and returns `{ state, send, events }`.
7. **Smoke test in `App.tsx`**: on mount, call `createSession` then `dispatchWish("hello")`, render raw JSON of events.

### Key code (TypeScript — not stubs)

`desktop/src/lib/tauri.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export type EngineInfo   = { url: string; authToken: string };
export type EngineStatus = {
  state: "starting" | "running" | "crashed" | "stopped";
  uptime_ms: number; restarts: number;
  last_restart_iso: string | null; pid: number | null; port: number | null;
};

export const getEngineUrl    = () => invoke<EngineInfo>("get_engine_url");
export const restartEngine   = () => invoke<void>("restart_engine");
export const engineStatus    = () => invoke<EngineStatus>("engine_status");
export const getEngineLogs   = (lines = 200) => invoke<string[]>("get_engine_logs", { lines });
```

`desktop/src/lib/sse.ts`:

```ts
import { fetchEventSource, type EventSourceMessage } from "@microsoft/fetch-event-source";
import type { AgentEvent } from "@jellyclaw/shared";

export type SSEOpts = {
  url: string; token: string; sessionId: string;
  onEvent: (e: AgentEvent) => void;
  onConnect?: () => void;
  onError?: (err: unknown) => void;
};

class RetryError extends Error {}   // fetchEventSource retries on throw

export function openSSE(opts: SSEOpts): () => void {
  const ctrl = new AbortController();
  let backoff = 1000;
  let lastEventAt = Date.now();

  // Heartbeat watchdog — reconnect if no events for 30s
  const hb = setInterval(() => {
    if (Date.now() - lastEventAt > 30_000) ctrl.abort("heartbeat-timeout");
  }, 5000);

  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        await fetchEventSource(`${opts.url}/events/${opts.sessionId}`, {
          signal: ctrl.signal,
          headers: { Authorization: `Bearer ${opts.token}`, Accept: "text/event-stream" },
          openWhenHidden: true,
          async onopen(res) {
            if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) {
              backoff = 1000; opts.onConnect?.(); return;
            }
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
              throw new Error(`fatal ${res.status}`);
            }
            throw new RetryError(`retry ${res.status}`);
          },
          onmessage(msg: EventSourceMessage) {
            lastEventAt = Date.now();
            if (!msg.data) return;
            try {
              const parsed = JSON.parse(msg.data) as AgentEvent;
              opts.onEvent(parsed);
            } catch (e) { opts.onError?.(e); }
          },
          onclose() { throw new RetryError("server-closed"); },
          onerror(err) {
            opts.onError?.(err);
            if (err instanceof Error && err.message.startsWith("fatal")) throw err; // stop
            // else throw to retry with backoff
            throw new RetryError(String(err));
          },
        });
      } catch (err) {
        if (ctrl.signal.aborted) break;
        const jitter = Math.random() * 500;
        await new Promise(r => setTimeout(r, Math.min(30_000, backoff) + jitter));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  })();

  return () => { clearInterval(hb); ctrl.abort(); };
}
```

`desktop/src/state/wishMachine.ts`:

```ts
import { setup, assign } from "xstate";
import type { AgentEvent } from "@jellyclaw/shared";

export const wishMachine = setup({
  types: {
    context: {} as {
      sessionId: string | null;
      turnsUsed: number; turnsMax: number;
      costUsd: number;   costMaxUsd: number;
      tokenUsage: { input: number; output: number; cache_read: number };
      lastError: string | null;
    },
    events: {} as
      | { type: "DISPATCH"; sessionId: string; turnsMax: number; costMaxUsd: number }
      | { type: "TOOL_CALL_START"; event: AgentEvent }
      | { type: "TOOL_CALL_END";   event: AgentEvent }
      | { type: "TEXT_DELTA";      event: AgentEvent }
      | { type: "COMPLETED";       totalCost: number; turnsUsed: number }
      | { type: "ERRORED";         error: string }
      | { type: "CANCEL" } | { type: "STEER"; text: string } | { type: "RESUME" },
  },
  actions: {
    setSession:    assign(({ event }) => event.type === "DISPATCH"
      ? { sessionId: event.sessionId, turnsMax: event.turnsMax, costMaxUsd: event.costMaxUsd }
      : {}),
    recordCompletion: assign(({ event }) => event.type === "COMPLETED"
      ? { costUsd: event.totalCost, turnsUsed: event.turnsUsed } : {}),
    recordError: assign(({ event }) => event.type === "ERRORED" ? { lastError: event.error } : {}),
  },
}).createMachine({
  id: "wish",
  initial: "idle",
  context: {
    sessionId: null, turnsUsed: 0, turnsMax: 20,
    costUsd: 0, costMaxUsd: 5, tokenUsage: { input: 0, output: 0, cache_read: 0 },
    lastError: null,
  },
  states: {
    idle:       { on: { DISPATCH: { target: "dispatched", actions: "setSession" } } },
    dispatched: { on: { TEXT_DELTA: "running", TOOL_CALL_START: "toolCalling",
                        COMPLETED: "completed", ERRORED: "errored", CANCEL: "cancelled" } },
    running:    { on: { TEXT_DELTA: "running", TOOL_CALL_START: "toolCalling",
                        COMPLETED: "completing", ERRORED: "errored", CANCEL: "cancelled",
                        STEER: "running" } },
    toolCalling:{ on: { TOOL_CALL_END: "running", ERRORED: "errored", CANCEL: "cancelled" } },
    completing: { on: { COMPLETED: { target: "completed", actions: "recordCompletion" } } },
    completed:  { on: { RESUME: "dispatched" } },
    errored:    { entry: "recordError", on: { RESUME: "dispatched" } },
    cancelled:  { on: { RESUME: "dispatched" } },
  },
});
```

`desktop/src/state/useEngineStore.ts`:

```ts
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AgentEvent } from "@jellyclaw/shared";

const RING_CAP = 10_000;

type SessionMeta = { id: string; createdAt: number; costUsd: number; turns: number };

interface State {
  engineUrl: string | null;
  authToken: string | null;
  sessions: Map<string, SessionMeta>;
  activeWishId: string | null;
  events: AgentEvent[];                         // ring buffer
  totalCostUsd: number;
  setEngine: (url: string, token: string) => void;
  setActive: (id: string | null) => void;
  upsertSession: (s: SessionMeta) => void;
  pushEvent: (e: AgentEvent) => void;
  addCost: (delta: number) => void;
  reset: () => void;
}

export const useEngineStore = create<State>()(subscribeWithSelector((set) => ({
  engineUrl: null, authToken: null,
  sessions: new Map(), activeWishId: null,
  events: [], totalCostUsd: 0,
  setEngine: (url, token) => set({ engineUrl: url, authToken: token }),
  setActive: (id) => set({ activeWishId: id }),
  upsertSession: (s) => set((st) => {
    const next = new Map(st.sessions); next.set(s.id, s); return { sessions: next };
  }),
  pushEvent: (e) => set((st) => {
    const next = st.events.length >= RING_CAP ? st.events.slice(-RING_CAP + 1) : st.events.slice();
    next.push(e); return { events: next };
  }),
  addCost: (d) => set((st) => ({ totalCostUsd: st.totalCostUsd + d })),
  reset: () => set({ sessions: new Map(), activeWishId: null, events: [], totalCostUsd: 0 }),
})));
```

`desktop/src/lib/api.ts`:

```ts
import type { AgentEvent } from "@jellyclaw/shared";

export type CreateSessionReq  = { prompt: string; turnsMax?: number; costMaxUsd?: number; permissionMode?: "ask" | "allow" | "deny" };
export type CreateSessionResp = { id: string; createdAt: string };

const H = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });

export const api = {
  createSession: async (base: string, token: string, body: CreateSessionReq) =>
    (await fetch(`${base}/v1/sessions`, { method: "POST", headers: H(token), body: JSON.stringify(body) })).json() as Promise<CreateSessionResp>,
  listSessions:  async (base: string, token: string) =>
    (await fetch(`${base}/v1/sessions`, { headers: H(token) })).json() as Promise<CreateSessionResp[]>,
  getHistory:    async (base: string, token: string, id: string) =>
    (await fetch(`${base}/v1/sessions/${id}`, { headers: H(token) })).json() as Promise<{ events: AgentEvent[] }>,
  steer:  (base: string, token: string, id: string, text: string) =>
    fetch(`${base}/v1/sessions/${id}/steer`,  { method: "POST", headers: H(token), body: JSON.stringify({ text }) }),
  cancel: (base: string, token: string, id: string) =>
    fetch(`${base}/v1/sessions/${id}/cancel`, { method: "POST", headers: H(token) }),
};
```

`desktop/src/lib/queryClient.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";
export const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false } },
});
// Query keys:
//   ['engine','url']
//   ['sessions']
//   ['sessions', id]
//   ['sessions', id, 'events']
```

`desktop/src/hooks/useWish.ts`:

```ts
import { useActor } from "@xstate/react";
import { useEffect } from "react";
import { wishMachine } from "@/state/wishMachine";
import { useEngineStore } from "@/state/useEngineStore";
import { openSSE } from "@/lib/sse";
import type { AgentEvent } from "@jellyclaw/shared";

export function useWish(sessionId: string | null) {
  const [state, send, actor] = useActor(wishMachine);
  const { engineUrl, authToken, pushEvent, addCost } = useEngineStore();

  useEffect(() => {
    if (!sessionId || !engineUrl || !authToken) return;
    const close = openSSE({
      url: engineUrl, token: authToken, sessionId,
      onEvent: (e: AgentEvent) => {
        pushEvent(e);
        switch (e.type) {
          case "text_delta":       send({ type: "TEXT_DELTA", event: e }); break;
          case "tool_call_start":  send({ type: "TOOL_CALL_START", event: e }); break;
          case "tool_call_end":    send({ type: "TOOL_CALL_END", event: e }); break;
          case "completed":        send({ type: "COMPLETED", totalCost: e.cost_usd, turnsUsed: e.turns_used });
                                   addCost(e.cost_usd); break;
          case "error":            send({ type: "ERRORED", error: e.message }); break;
        }
      },
      onError: (err) => console.warn("sse error", err),
    });
    return close;
  }, [sessionId, engineUrl, authToken]);

  return { state, send, actor };
}
```

### Tests to add

- `desktop/src/state/wishMachine.test.ts` — drive transitions via `createActor(wishMachine).start()`, assert state graph.
- `desktop/src/state/useEngineStore.test.ts` — ring buffer caps at 10k, `addCost` accumulates, reset clears.
- `desktop/src/lib/sse.test.ts` — mock `fetchEventSource` with MSW, assert reconnect with exponential backoff.
- `desktop/src/hooks/useWish.test.tsx` — RTL + `createActor`, feed fake events, assert state machine transitions.

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm typecheck      # 0 errors
pnpm test           # all green

# End-to-end smoke with real engine
pnpm tauri dev &
# In the app: DevTools → Console should log
#   "sse connected" and a stream of AgentEvent JSON after a dispatch
```

### Common pitfalls

- **Native `EventSource` cannot attach `Authorization` headers** — this is why we use `@microsoft/fetch-event-source`. Don't regress to `new EventSource(...)`.
- **XState v5 renamed `createMachine({...}, {actions})` → `setup({actions}).createMachine({...})`.** Old tutorials are stale; use `setup`.
- **Zustand store + Map values won't trigger re-renders with shallow compare.** Always create a *new* Map in setters — we do that in `upsertSession`.
- **Ring buffer must `slice()` not mutate** — React won't see the change if you `.push()` the original array reference.
- **StrictMode double-subscribes in dev** — the SSE close fn in `useEffect` cleanup handles the extra subscription.
- **TanStack Query v5 removes `useQuery({onSuccess})`.** Use `useEffect` keyed on `data` instead.
- **Heartbeat timer must be cleared in the returned cleanup** or it leaks across re-renders.

### Why this matters

Every UI pane in prompt 04 subscribes to this pipeline. If the SSE reconnect is flaky, users watch their timeline freeze mid-wish. If the state machine has an unreachable state, the UI gets stuck in "running" forever. If the ring buffer grows unbounded, memory balloons past 1GB during long sessions. This prompt is the spine that the UI hangs off.

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md` with `<NN>` = `15`, sub-prompt = `03-sse-consumer-and-state`.

Only `05-macos-dmg-build-and-sign.md` marks Phase 15 ✅. Update Notes with `03-sse-consumer-and-state ✅`.
