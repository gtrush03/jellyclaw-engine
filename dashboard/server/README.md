# @jellyclaw/dashboard-server

Local-only HTTP + SSE server for the jellyclaw-engine dashboard. Reads prompt
files and status logs from the repo root, assembles copy-pasteable prompts, and
streams file-change events to the React SPA.

## Run

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard/server
npm install
npm run dev
```

Defaults:

- Bound to `127.0.0.1:5174` (local-only — refuses to bind `0.0.0.0`).
- CORS allow-list: `http://127.0.0.1:5173`, `http://localhost:5173`.
- Rate limit: 100 requests / minute / IP.

## API

| Method | Path                              | Description |
|--------|-----------------------------------|-------------|
| GET    | `/healthz`                        | Liveness probe. |
| GET    | `/api/prompts`                    | List every prompt under `prompts/phase-*/`. |
| GET    | `/api/prompts/:phase/:slug`       | One prompt with fully-assembled body (copy-paste ready). |
| GET    | `/api/prompts/:phase/:slug/raw`   | Raw markdown of the prompt file. |
| GET    | `/api/phases`                     | All 21 phases (0–19 + 10.5) + metadata + per-phase prompt counts. |
| GET    | `/api/phases/:phase`              | Full phase detail incl. body + prompts. |
| GET    | `/api/status`                     | Derived snapshot of `COMPLETION-LOG.md` + `STATUS.md`. |
| GET    | `/api/events`                     | SSE stream (`completion-log-changed`, `status-changed`, `prompt-added`, `prompt-changed`, `heartbeat`). |

## Build for production

```bash
npm run build   # emits dist/index.js via tsup
npm start       # node dist/index.js
```

When run after a dashboard frontend build (sibling `../dist`), the server serves
the built SPA at `/`.

## Security posture

- 127.0.0.1 bind only — `HOST` env var override is rejected at boot.
- No auth — local-only.
- Path-traversal guard: every file access is clamped inside `REPO_ROOT`.
- Rate limit applied before routing.
- CORS allow-list only — no `*`.

## Layout

```
src/
  index.ts                     server entry
  types.ts                     shared types with frontend
  lib/
    paths.ts                   absolute-path constants + traversal guard
    prompt-parser.ts           prompt walking, metadata scrape, assembly
    log-parser.ts              COMPLETION-LOG + STATUS parsers
  routes/
    prompts.ts                 /api/prompts
    phases.ts                  /api/phases
    status.ts                  /api/status
    events.ts                  /api/events (SSE) + chokidar watchers
```
