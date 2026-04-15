# Changelog — jellyclaw-engine dashboard

All notable changes. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [0.1.0] — 2026-04-15

Initial release. Built in parallel by four specialised agents:

- **backend agent** — Hono server, file watchers, prompt/phase/log parsers.
- **frontend agent** — React 19 SPA, React Query, Zustand, SSE client.
- **launcher agent** — `start.sh`, `stop.sh`, PID management, cross-OS browser open.
- **polish agent** — Obsidian & Gold theme, Shiki highlighting, Sonner toasts,
  copy button, empty/error/skeleton states.
- **QA agent** — integration audit, Zod validation, test suites, this document.

### Added

- **Local Hono backend on `:5174`** with five endpoints:
  - `GET /api/prompts` → list of ~63 prompts with status from `COMPLETION-LOG.md`
  - `GET /api/prompts/:phase/:slug` → fully-assembled copy-pasteable prompt
  - `GET /api/prompts/:phase/:slug/raw` → raw markdown
  - `GET /api/phases` → 20 phases with dependency graph metadata
  - `GET /api/status` → aggregate StatusSnapshot
  - `GET /api/events` → SSE channel (`completion-log-changed`, `status-changed`,
    `prompt-added`, `prompt-changed`, `heartbeat`)
- **React 19 SPA on `:5173`** — sidebar of phases, grid of prompt cards, detail pane
  with assembled prompt, LIVE indicator, progress bar, Sonner toasts.
- **`start.sh` / `stop.sh`** — one-command launch + teardown, with port checks, prereq
  validation (Node ≥ 20), color-prefixed streams, and a PID file for clean shutdown.
- **Obsidian & Gold theme** — custom Shiki theme, Tailwind v4 tokens, glass panels.
- **File watching** via chokidar with `awaitWriteFinish` for editor atomic saves.
- **Path traversal guard** (`assertInsideRepo`) on every filesystem read.
- **Zod runtime validation** for every API response (`src/lib/api-validation.ts`).
- **Test suites**: vitest unit + integration, Playwright E2E smoke test.
- **Docs**: `ORCHESTRATION.md` (narrative), `INTEGRATION-CHECKLIST.md` (drift audit),
  `SMOKE-TEST.md`, `HEALTHCHECK.md`, `FAQ.md`, `SCRIPTS.md`.

### Known integration drift (tracked in INTEGRATION-CHECKLIST.md)

- `GET /api/prompts` and `GET /api/phases` return `{ items, count }` envelopes;
  frontend client expects bare arrays. Either unwrap server-side or update client.
- `GET /api/prompts/:phase/:slug` expects two path segments; frontend client
  `encodeURIComponent("phase-NN/slug")` collapses them into one. Fix: split before
  building the URL.
- SSE event names mismatch between backend emitters and frontend handlers (zero
  overlap). Backend uses `completion-log-changed` / `status-changed` / `prompt-added`
  / `prompt-changed` / `heartbeat`; frontend listens for `log-changed` /
  `status-updated` / `phase-completed` / `prompt-completed` / `ping`. Align on the
  backend's set.
- `StatusSnapshot` shape mismatch between backend (`progressPercent`, `testsPassing`,
  `testsFailing`, `burnRateTotal`, `phaseStatus`, snake_case deps) and frontend
  (`progress`, `testsCount`, `burnRate`, `phaseChecks`, camelCase deps).

These do NOT block `./start.sh` — the launcher and both processes come up cleanly —
but they do block a green end-to-end smoke test. Owning agents should resolve in
their next pass.

### Pseudo-commit log (what-built-what)

```
feat(backend):  scaffold Hono server on :5174 with /api/prompts, /api/phases
feat(backend):  add chokidar-based SSE at /api/events with heartbeat
feat(frontend): render sidebar + prompt grid + detail pane with React 19 + RQ + Zustand
feat(launcher): add start.sh / stop.sh with port checks, PID file, cross-OS browser open
feat(polish):   Obsidian & Gold theme, Shiki highlighting, Sonner toasts, copy button
test(qa):       vitest unit + integration + Playwright E2E, Zod runtime validation
docs(qa):       ORCHESTRATION + INTEGRATION-CHECKLIST + SMOKE-TEST + FAQ + HEALTHCHECK
```

[0.1.0]: ./CHANGELOG.md
