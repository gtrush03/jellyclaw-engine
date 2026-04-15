# Integration Checklist — jellyclaw-engine dashboard

Four agents built this dashboard in parallel (backend, frontend, launcher, polish). This
document is the QA agent's audit of how those pieces fit together, with concrete pass/fail
criteria for each integration point.

Status key: **PASS** (verified), **DRIFT** (shapes diverge between agents — fix before
shipping), **MANUAL** (needs a human to run the smoke test to confirm).

---

## 1. Integration points

### 1.1 Backend routes ↔ Frontend API client

| Check | Status | Notes |
| --- | --- | --- |
| Backend `GET /api/prompts` response shape | **RESOLVED** (2026-04-14) | `api.prompts()` now unwraps `.prompts` from the envelope inside `dashboard/src/lib/api.ts`. Hook signature `usePrompts` → `Prompt[]` preserved. Verify: `curl .../api/prompts \| jq '.count'` returns 63. |
| Backend `GET /api/prompts/:phase/:slug` route params | **RESOLVED** (2026-04-14) | `api.prompt(id)` in `dashboard/src/lib/api.ts` now splits id on `/` and builds `/prompts/${phase}/${slug}` with each segment encoded separately. Verify: `curl .../api/prompts/phase-01/01-research \| jq '.assembled'` returns a string. |
| Backend `GET /api/phases` shape | **RESOLVED** (2026-04-14) | `api.phases()` unwraps `.phases`. Hook signature `usePhases` → `Phase[]` preserved. `depends_on` is also normalized → `dependsOn` in the same call. Verify: `curl .../api/phases \| jq '.count'` returns 20. |
| Backend `GET /api/status` shape | **RESOLVED** (2026-04-14) | `api.status()` now normalizes the backend `StatusSnapshot` into the canonical frontend `Status` (progressPercent, testsPassing, testsFailing, burnRateTotal as number, phaseStatus as `Record<number, PhaseStatus>`). `dashboard/src/types.ts` updated; `Header.tsx` reads `progressPercent` / `burnRateTotal` / `testsPassing` / `testsFailing` directly. Verify: `curl .../api/status \| jq '.progressPercent'` returns a number 0–100. |
| Frontend field casing | **RESOLVED** (2026-04-14) | `api.ts` maps backend `depends_on` → `dependsOn` and `sessionNumber` → `session` during normalization. Components are consistently camelCase. |

Verification once fixed:

```bash
curl -s http://127.0.0.1:5174/api/prompts   | jq '.prompts | length'     # expect 63–67
curl -s http://127.0.0.1:5174/api/phases    | jq '.phases  | length'     # expect 20
curl -s http://127.0.0.1:5174/api/status    | jq 'keys'
curl -s http://127.0.0.1:5174/api/prompts/phase-01/01-research | jq '.assembled | length'
```

All four should return non-empty, non-error payloads.

### 1.2 Backend SSE events ↔ Frontend SSE handler

**Status: RESOLVED (2026-04-14).** `dashboard/src/hooks/useSSE.ts` now listens for the backend's actual vocabulary. Mappings: `completion-log-changed` → invalidate `['status'|'phases'|'prompts']` + toast "Progress updated"; `status-changed` → invalidate `['status']`; `prompt-added` → invalidate `['prompts']` + toast "New prompt added"; `prompt-changed` → invalidate `['prompt', id]` if payload carries path, else `['prompts']`; `heartbeat` → `setLastLogUpdate(new Date())` so the live indicator proves the stream is alive. Original table (historical drift):

| Backend emits (`events.ts`) | Frontend listens for (`useSSE.ts`) |
| --- | --- |
| `completion-log-changed` | `log-changed` |
| `status-changed`         | `status-updated` |
| `prompt-added`           | *(no listener)* |
| `prompt-changed`         | *(no listener)* |
| `heartbeat`              | `ping` |
| *(no emitter)*           | `phase-completed` |
| *(no emitter)*           | `prompt-completed` |

Zero of the frontend handlers will fire with the current backend. Pick one vocabulary and
align both sides. The backend set is more faithful to what actually changes on disk, so
prefer renaming the frontend handlers.

Verify once aligned:

```bash
# terminal 1
curl -N http://127.0.0.1:5174/api/events
# terminal 2
touch /Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md
# expect terminal 1 to print:  event: completion-log-changed  (within ~300ms)
```

### 1.3 Paths referenced by backend exist on disk

| Path | Status |
| --- | --- |
| `/Users/gtrush/Downloads/jellyclaw-engine` | PASS |
| `prompts/` (20 `phase-*/` dirs, 67 `*.md` files) | PASS |
| `phases/` (20 `PHASE-*.md` files) | PASS |
| `COMPLETION-LOG.md` | PASS |
| `STATUS.md` | PASS |
| `prompts/session-starters/STARTUP-TEMPLATE.md` | PASS |
| `prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md` | PASS |

`paths.ts` hardcodes `REPO_ROOT`. Fine for this machine, fragile if the repo moves. Non-
blocking; document in FAQ.

### 1.4 Launcher ↔ port contract

| Check | Status |
| --- | --- |
| `start.sh` uses 5173 / 5174 | PASS |
| `vite.config.ts` pins 5173 with `strictPort: true` | PASS |
| `vite.config.ts` proxies `/api` → `127.0.0.1:5174` | PASS |
| Backend listens on `PORT` env var | **MANUAL** — confirm `server/src/index.ts` reads `process.env.PORT` (launcher passes `PORT=5174`). |
| CORS | PASS — proxy makes it same-origin, no CORS headers needed. |

### 1.5 Cross-agent tooling

- Frontend has no `test` / `lint` / `test:e2e` scripts in `package.json` — added by this
  agent in `SCRIPTS.md` / a future patch.
- Backend has no test script — same.
- No `vitest` dep on either side yet. Before running `tests/`, add `vitest` +
  `@vitest/coverage-v8` to both `package.json`s and `playwright` +
  `@playwright/test` at the dashboard root.

---

## 2. Common gotchas

- **CORS misconfig.** Works via Vite proxy in dev. If anyone bypasses the proxy by hitting
  `localhost:5174` directly from a `127.0.0.1:5173` page, you will see a CORS error. Always
  fetch `/api/...`, never `http://127.0.0.1:5174/api/...`.
- **SSE framing.** `better-sse` writes `event: X\ndata: {...}\n\n`. If a proxy strips the
  blank line separator, messages coalesce and `@microsoft/fetch-event-source` silently
  drops them. The Vite proxy with `ws: true` is fine.
- **Proxy vs direct fetch.** Playwright tests navigate to `http://127.0.0.1:5173` — they
  go through the Vite proxy. Integration API tests hit `http://127.0.0.1:5174` directly.
  Don't mix them up.
- **Atomic saves.** Some editors (vim with `:w`, VS Code with atomic save on) rename a
  temp file over the target. `chokidar` handles this because the backend sets
  `awaitWriteFinish: true`, but if you see missed events, check the editor's save mode.
- **Tailwind v4.** Requires `@tailwindcss/vite` — already wired in `vite.config.ts`. If
  the UI renders as raw HTML, verify that plugin is loaded and that `theme.css` is
  imported from `main.tsx`.
- **Strict port.** `vite.config.ts` uses `strictPort: true`. If 5173 is taken, Vite
  exits instead of falling back to 5174+. Run `./stop.sh` first.

---

## 3. Manual smoke-test sequence

1. `cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard && ./start.sh`
2. Browser auto-opens `http://127.0.0.1:5173` after ~3 seconds.
3. **Sidebar shows 21 phases** (Phase 00 – Phase 19, plus Phase 10.5 between 10 and 11).
4. **Center shows ~63 prompts** grouped by phase (67 `.md` files, minus READMEs/DEPENDENCY-GRAPH).
5. Click a prompt card → right pane opens with the **assembled prompt** (startup template
   + task body + closeout template, with `<NN>` / `<phase-name>` / `<sub-prompt>`
   substituted).
6. Click **Copy Full Prompt** → clipboard contains the full assembled text; text starts
   with the STARTUP template's opening line.
7. Header shows a **green LIVE indicator** (SSE connected — `sseConnected` state true).
8. Open `COMPLETION-LOG.md` in another window; flip a `[ ]` checkbox to `[x]`; save.
9. Within **≤2 s**, the UI reacts:
   - progress bar advances,
   - the edited phase's status dot turns green,
   - a Sonner toast appears.
10. `./stop.sh` → both processes killed, ports freed. `lsof -i:5173,5174` returns empty.

Any step failing → see FAQ.md for the most likely cause.

---

## 4. Rollback if integration fails

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./stop.sh
rm -rf node_modules server/node_modules
./start.sh
```

If that still fails, clear caches and re-install Node 20+:

```bash
rm -rf node_modules server/node_modules ~/.npm/_cacache
nvm use 20
./start.sh
```

---

## 5. Summary

- **All four drifts RESOLVED (2026-04-14)** by the integration-fix agent. Scope: frontend
  only — backend untouched per task direction ("backend is more faithful to filesystem
  reality").
- Remaining pre-existing `tsc` errors (14) are in polish-agent components
  (`JSX.Element` return-type annotations not compatible with React 19 types) and
  `shiki.ts` / `a11y.ts` — unrelated to API drift. Fix out of scope for this task.
- Everything else (paths, ports, launcher, file watching) is wired correctly.

---

## 6. Smoke test ready

All four drifts are resolved. Run this sequence to verify end-to-end:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./start.sh
# Wait 5 seconds, then in another terminal:
curl http://127.0.0.1:5174/api/prompts | jq '.count'                                  # expect 63
curl http://127.0.0.1:5174/api/phases | jq '.count'                                   # expect 20
curl http://127.0.0.1:5174/api/prompts/phase-01/01-research | jq '.assembled[:200]'   # expect string with "Phase 01"
curl http://127.0.0.1:5174/api/status | jq '.progressPercent'                         # expect number 0-100
# Browser test: http://127.0.0.1:5173 should render sidebar + prompt list
```

SSE verification (optional):

```bash
# terminal 1
curl -N http://127.0.0.1:5174/api/events
# terminal 2
touch /Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md
# expect terminal 1 to print:  event: completion-log-changed   (within ~300ms)
# expect browser toast: "Progress updated"
```
