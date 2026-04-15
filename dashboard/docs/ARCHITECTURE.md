# Dashboard architecture

## Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         your browser (127.0.0.1)                     │
│                                                                      │
│   ┌─────────────── React SPA ────────────────┐                       │
│   │  components/           hooks/            │                       │
│   │    PromptList            useProgress()   │                       │
│   │    PromptDetail          usePrompts()    │                       │
│   │    ProgressBar           useSSE()        │                       │
│   │  ──────────────────────────────────────  │                       │
│   │  TanStack Query cache  ← invalidate()    │                       │
│   │  Zustand (UI state)                      │                       │
│   └──────────────┬────────────────┬──────────┘                       │
│                  │ GET /api/*     │ fetch-event-source /sse          │
└──────────────────┼────────────────┼──────────────────────────────────┘
                   │ Vite dev proxy │ (5173 → 5174)
┌──────────────────┼────────────────┼──────────────────────────────────┐
│                  ▼                ▼                                  │
│            ┌─────────────── Hono (5174) ──────────────┐              │
│            │  routes/                                  │              │
│            │    /api/prompts     → filesystem reader  │              │
│            │    /api/progress    → COMPLETION-LOG     │              │
│            │    /sse             → chokidar bridge    │              │
│            │  cors: 127.0.0.1:5173 only               │              │
│            └──────────────┬───────────────────────────┘              │
│                           │                                          │
│            ┌──────────────▼────────────────┐                         │
│            │  chokidar watcher             │                         │
│            │    prompts/**/*.md            │                         │
│            │    COMPLETION-LOG.md          │                         │
│            │    STATUS.md                  │                         │
│            └──────────────┬────────────────┘                         │
│                           │ fs events                                │
│            ┌──────────────▼────────────────┐                         │
│            │  jellyclaw-engine/ (repo)     │                         │
│            │    prompts/phase-XX/*.md      │                         │
│            │    COMPLETION-LOG.md          │                         │
│            │    MASTER-PLAN.md             │                         │
│            └───────────────────────────────┘                         │
└──────────────────────────────────────────────────────────────────────┘
```

## Data flow

1. **Boot.** `start.sh` spawns the Hono server on :5174 and the Vite dev server on :5173. Vite's `server.proxy` config forwards `/api` and `/sse` to the backend, so the browser only ever talks to one origin.
2. **Initial fetch.** On mount, each React hook (`usePrompts`, `useProgress`) fires a `fetch()` through TanStack Query. Hono reads from disk — prompts by globbing `prompts/phase-*/*.md`, progress by parsing `COMPLETION-LOG.md` — and returns JSON. Query caches everything under stable keys.
3. **File change.** A prompt file changes on disk (or `COMPLETION-LOG.md` gets a new row). chokidar's `add | change | unlink` handler publishes a typed event onto the in-memory pub/sub inside Hono.
4. **SSE push.** The `/sse` handler holds open a streaming response; for each pub/sub event it writes `event: <kind>\ndata: <json>\n\n`. `@microsoft/fetch-event-source` on the client reads the stream, dispatches into a thin adapter, and the adapter calls `queryClient.invalidateQueries({ queryKey: [...] })`.
5. **Render.** TanStack Query sees an invalidation, refetches the affected endpoint in the background, and React re-renders only the components subscribed to that query key. The user sees progress bars tick without a page reload.

## Why each piece

- **Hono** — tiny (~14kB gzipped runtime), Fetch-API native, runs under Node/Bun/Workers unchanged. We need four routes and an SSE stream; Express would be overkill.
- **chokidar** — the battle-tested cross-platform fs watcher. Handles editor atomic-save patterns (rename-then-replace) that naive `fs.watch` trips on.
- **TanStack Query** — turns "did the data change?" into a one-line `invalidateQueries`. Gives us background refetch, retry, and stale-while-revalidate for free.
- **Zustand** — 1kB client state store with no boilerplate. Redux Toolkit or Context+useReducer would both be heavier for the handful of UI flags we need.
- **@microsoft/fetch-event-source** — SSE with custom headers, abort support, and configurable reconnect. Native `EventSource` reconnects silently and can't send auth headers.

## Extension points

- **New API route.** Add a file under `server/src/routes/`, export a Hono sub-app, mount it in `server/src/index.ts` under `/api/<name>`. Add a matching `use<Name>` hook in `src/hooks/` wrapping `useQuery`.
- **New SSE event kind.** Emit `controller.emit({ kind: 'my-event', payload })` from the backend. On the client, extend the switch in `src/lib/sse.ts` to map that kind to the right `invalidateQueries` call.
- **New UI panel.** Drop a component into `src/components/`, compose it in `src/App.tsx`. If it needs server data, add a hook; if it needs client state, add a Zustand slice in `src/stores/`.
- **Swap the backend runtime to Bun.** `cd server && bun install && bun run src/index.ts`. Hono is already Bun-native — no code changes needed.
