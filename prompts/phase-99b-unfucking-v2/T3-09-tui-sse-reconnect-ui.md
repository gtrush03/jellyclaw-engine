---
id: T3-09-tui-sse-reconnect-ui
tier: 3
title: "Surface SSE disconnects in TUI status bar with exponential-backoff reconnect"
scope:
  - "engine/src/tui/app.tsx"
  - "engine/src/tui/hooks/use-events.ts"
  - "engine/src/tui/hooks/use-reconnect.ts"
  - "engine/src/tui/hooks/use-reconnect.test.ts"
  - "engine/src/tui/components/status-bar.tsx"
  - "engine/src/tui/state/types.ts"
  - "engine/src/tui/state/reducer.ts"
depends_on_fix: []
tests:
  - name: sse-error-sets-reconnecting
    kind: shell
    description: "an error from the SSE stream sets state.connection === 'reconnecting'"
    command: "bun run test engine/src/tui/state/reducer -t sse-error-sets-reconnecting"
    expect_exit: 0
    timeout_sec: 30
  - name: reconnect-uses-exponential-backoff
    kind: shell
    description: "useReconnect schedules retries at 1s, 2s, 4s, 8s, 16s (capped at 30s)"
    command: "bun run test engine/src/tui/hooks/use-reconnect -t exponential-backoff"
    expect_exit: 0
    timeout_sec: 30
  - name: reconnect-restores-connection
    kind: shell
    description: "on successful reopen, state.connection === 'connected' and a green 'reconnected' flash is scheduled"
    command: "bun run test engine/src/tui/state/reducer -t reconnect-restores-connection"
    expect_exit: 0
    timeout_sec: 30
  - name: statusbar-renders-amber-badge
    kind: shell
    description: "StatusBar renders an amber 'reconnecting…' badge when connection === 'reconnecting'"
    command: "bun run test engine/src/tui/components/status-bar -t reconnecting-badge"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 50
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 75
---

# T3-09 — TUI SSE reconnect UI

## Context
`engine/src/tui/app.tsx:89-94` handles SSE errors with `dispatch({ kind: "clear-error" })` — which clears any prior error state but tells the user NOTHING. The server can die, the network can drop, the session can silently stall — and the only symptom is that no more events arrive. Claude Code's TUI shows a visible "reconnecting…" indicator when its stream drops. We have zero such surface.

## Root cause (from audit)
- `engine/src/tui/app.tsx:89-94` — `handleError` is a no-op modulo clearing a flag. Silent failure.
- `engine/src/tui/hooks/use-events.ts` — subscribes to the SSE stream but has no retry logic and no way to surface "currently-retrying" to the reducer.
- `engine/src/tui/state/types.ts` — `UiState` has a `status` field but no connection-health field.

## Fix — exact change needed
1. **Add connection state to `engine/src/tui/state/types.ts`:**
   ```ts
   export type UiConnection =
     | { readonly kind: "connected" }
     | { readonly kind: "reconnecting"; readonly attempt: number; readonly nextRetryMs: number }
     | { readonly kind: "disconnected"; readonly reason: string };
   export interface UiState { ...; readonly connection: UiConnection; }
   ```
   `createInitialState()` seeds `{ kind: "connected" }`.
2. **Reducer actions in `engine/src/tui/state/reducer.ts`:**
   ```ts
   | { kind: "connection-lost"; reason: string }
   | { kind: "reconnecting"; attempt: number; nextRetryMs: number }
   | { kind: "connection-restored" }
   ```
   `connection-restored` sets `{ kind: "connected" }` AND pushes a transient system message `"✓ reconnected"` (echo via existing `system-message` action semantics — last wins, fades on next state change naturally).
3. **New hook `engine/src/tui/hooks/use-reconnect.ts`:**
   ```ts
   export interface UseReconnectArgs {
     readonly onAttempt: (attempt: number, delayMs: number) => void;
     readonly onGiveUp?: (attempts: number) => void;
     readonly trigger: () => Promise<void>; // performs the reconnect; resolves on success, throws on fail
     readonly maxAttempts?: number;  // default Infinity
     readonly baseMs?: number;       // default 1000
     readonly capMs?: number;        // default 30_000
     readonly jitterRatio?: number;  // default 0.2
   }
   export function useReconnect(args: UseReconnectArgs): void;
   ```
   Schedule: `delay = min(capMs, baseMs * 2^(attempt-1)) * (1 + rand(-jitterRatio, +jitterRatio))`. Cancel on unmount.
4. **Rewire `engine/src/tui/app.tsx:86-95`:**
   ```ts
   const handleError = useCallback((err: unknown): void => {
     const reason = err instanceof Error ? err.message : String(err);
     dispatch({ kind: "connection-lost", reason });
   }, []);
   ```
   Add a `useReconnect({ trigger: reopenStream, onAttempt: (attempt, delay) => dispatch({ kind: "reconnecting", attempt, nextRetryMs: delay }) })` block that activates when `state.connection.kind !== "connected"`. `reopenStream` calls `client.resumeSession(state.sessionId)` — on success, dispatch `{ kind: "connection-restored" }`.
5. **StatusBar badge in `engine/src/tui/components/status-bar.tsx`:**
   - Add a new prop `connection: UiConnection`.
   - When `connection.kind === "reconnecting"`: render a right-aligned amber (`brand.gold`) badge `"⟳ reconnecting (attempt {n})"`.
   - When `connection.kind === "connected"`: no badge (silent success).
   - When `connection.kind === "disconnected"`: red (`brand.rust`) badge `"✗ disconnected: {reason}"`.
6. **Update call sites** — `engine/src/tui/app.tsx:285-293` passes `connection={state.connection}` to `<StatusBar>`.
7. **Tests:**
   - `engine/src/tui/state/reducer.test.ts` — `sse-error-sets-reconnecting`, `reconnect-restores-connection`.
   - `engine/src/tui/hooks/use-reconnect.test.ts` — `exponential-backoff` uses fake timers (Vitest `vi.useFakeTimers()`) to assert scheduling hits 1000/2000/4000/8000/16000/30000 caps (within ±jitter window).
   - `engine/src/tui/components/status-bar.test.tsx` — `reconnecting-badge` renders expected string when `connection.kind === "reconnecting"`.

## Acceptance criteria
- Disconnect → amber badge appears (maps to `sse-error-sets-reconnecting`, `statusbar-renders-amber-badge`).
- Retries use capped exponential backoff (maps to `reconnect-uses-exponential-backoff`).
- Reconnect flashes green success + clears badge (maps to `reconnect-restores-connection`).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT change the server-side SSE keepalive frequency — that's a separate server prompt.
- Do NOT add a "manual retry" key binding — auto-retry only.
- Do NOT persist connection health across TUI restarts.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tui/hooks/use-reconnect
bun run test engine/src/tui/state/reducer
bun run test engine/src/tui/components/status-bar
```
