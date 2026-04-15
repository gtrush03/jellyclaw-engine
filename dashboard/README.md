# jellyclaw-engine dashboard

A local-only operator console for building the jellyclaw engine one prompt at a time. Reads the prompts on disk, assembles the full copy-paste payload (startup preamble + body + completion template), and watches the completion log so you always see live progress without refreshing.

Designed in **Obsidian & Gold** — dark canvas, warm accents, glass panels. Optimized for the workflow of "open a fresh Claude Code session, paste a prompt, watch it finish, move to the next one."

## What it is

- A React SPA that lists every prompt in `prompts/phase-XX/*.md`, grouped by phase.
- One click assembles the **full** payload (startup boilerplate + prompt body + completion-log instructions) and copies it to your clipboard.
- A Hono backend watches `COMPLETION-LOG.md` in real time; when the last session finishes and writes a new row, the UI updates live via Server-Sent Events.
- Runs entirely on `127.0.0.1`. Nothing leaves your machine. No accounts, no telemetry, no cloud dependency.

## Screenshots

> Populate after first run: `dashboard/docs/screenshots/{home.png,prompt-detail.png,progress.png}`. Once captured, they render inline here.

- `docs/screenshots/home.png` — phase grid + progress bar.
- `docs/screenshots/prompt-detail.png` — assembled prompt preview with copy button.
- `docs/screenshots/progress.png` — live completion log with SSE-pushed rows.

## Architecture at a glance

```
React SPA (5173)  ── fetch / SSE ──▶  Hono API (5174)  ── chokidar ──▶  jellyclaw-engine/
     ▲                                      │                             ├── prompts/**/*.md
     │                                      │                             ├── COMPLETION-LOG.md
     └────────── Vite proxy /api, /sse ─────┘                             └── MASTER-PLAN.md
```

Full architecture notes live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Rationale for every technology pick lives in [`DECISIONS.md`](DECISIONS.md). Production + auto-start notes live in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Start

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./start.sh
```

On first run the launcher installs deps in both `dashboard/` and `dashboard/server/` (pnpm if you have it, otherwise npm), boots the backend on :5174, boots the Vite dev server on :5173, and opens your browser after 3s.

## Stop

```bash
./stop.sh
```

…or just hit `Ctrl-C` in the terminal where `start.sh` is running. The launcher installs an `EXIT/INT/TERM` trap that kills the backend via its pid file, so there are no orphaned processes.

## How it works

- **Prompt source.** The backend globs `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-*/*.md` and parses frontmatter (phase number, title, dependencies, estimated duration).
- **Assembly.** When you click *Copy full prompt*, the frontend posts the prompt id to `/api/prompts/:id/render`; the server concatenates (a) the shared startup preamble, (b) the raw prompt body, and (c) the completion-log template pre-filled with the prompt id. The result lands on your clipboard via the Clipboard API.
- **Live progress.** chokidar watches `COMPLETION-LOG.md`. Every change emits an SSE event on `/sse`. The React client's `useSSE` hook dispatches that event into `queryClient.invalidateQueries({ queryKey: ['progress'] })`, and TanStack Query silently refetches — you see the new row appear without a reload.
- **Ports.** Frontend on `5173`, backend on `5174`. Both `127.0.0.1` only.

## Security

- Backend binds `127.0.0.1` exclusively. Remote hosts cannot connect.
- No auth — and none is needed on loopback. If you ever tunnel this beyond localhost, read [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) first.
- CORS is restricted to `http://127.0.0.1:5173` (dev) and the same-origin case (prod bundle).
- The filesystem reader is scoped to `prompts/` and a handful of known doc files at the repo root. It does not accept arbitrary paths from the client.
- The Clipboard API works without HTTPS on `localhost` / `127.0.0.1` — no certificate setup required.

## Troubleshooting

- **Port 5173 or 5174 already in use.** `start.sh` detects this before launching and tells you which port is busy. Diagnose with `lsof -i :5173` (or `:5174`). Most often it's a stale previous run — `./stop.sh` clears it.
- **SSE "disconnected" badge.** The backend crashed, the laptop slept, or the network stack recycled the socket. Refresh the UI; if it doesn't reconnect within 10s, check the backend logs (`[server]` lines in the start terminal) for a stack trace.
- **No prompts in the list.** Verify they exist on disk: `ls /Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-*/*.md`. If the path is right but the UI is empty, the glob matched zero files — check that files end in `.md`, not `.markdown`.
- **Copy button does nothing.** Browser clipboard permissions. Chrome prompts on first click; Firefox needs `dom.events.asyncClipboard.clipboardItem = true` in rare cases. Localhost is treated as a secure context, so HTTPS isn't the issue.
- **"backend failed to start" right after launch.** Usually a dep resolution problem in `server/`. Run `cd server && pnpm install` (or `npm install`) manually and read the output. If `tsx` can't find a TypeScript file, the backend agent's code isn't in place yet.
- **Dashboard opens but is blank.** Vite compile error — check `[ui]` lines in the terminal. Most common cause: `src/` files missing or a missing env var declared in `vite.config.ts`.

## Keyboard shortcuts

| Keys         | Action                                   |
|--------------|------------------------------------------|
| `⌘K` / `Ctrl K` | Open the command palette               |
| `/`          | Focus the prompt search input            |
| `j` / `k`    | Next / previous prompt in the list       |
| `Enter`      | Open the selected prompt                 |
| `c`          | Copy the fully-assembled prompt          |
| `g` then `p` | Jump to prompts view                     |
| `g` then `l` | Jump to completion log view              |
| `?`          | Show the shortcut cheatsheet             |
| `Esc`        | Close any modal / palette                |

> These are wired on the frontend. If one doesn't work, the frontend agent hasn't bound it yet — grep `src/` for `useHotkeys`.

## How progress sync works

1. The user (or Claude in a separate session) appends a row to `COMPLETION-LOG.md`.
2. chokidar emits `change` on the watched path.
3. The Hono SSE bridge pushes `event: progress` with a payload summary.
4. `@microsoft/fetch-event-source` in the browser receives it.
5. The client calls `queryClient.invalidateQueries({ queryKey: ['progress'] })`.
6. TanStack Query refetches `/api/progress`, diffs the new response against the cache, and notifies subscribed components.
7. React re-renders exactly the rows and progress bars whose data changed. No flash, no full reload.

End-to-end latency on a warm laptop is typically 50–150ms from file write to rendered update.

## FAQ

**Does the dashboard modify any files in `jellyclaw-engine/`?** No. It reads `prompts/`, `COMPLETION-LOG.md`, `STATUS.md`, `MASTER-PLAN.md`. There are no write routes.

**Do I need pnpm?** No. `start.sh` prefers `pnpm` if present and falls back to `npm`. Both work.

**Can I run this under Bun?** The backend is Hono and runs under Bun unchanged — `cd server && bun install && bun run src/index.ts`. The frontend is Vite; Vite supports Bun but the ecosystem is still Node-first, so pnpm/npm is the path of least resistance.

**Why does the browser open after 3 seconds instead of immediately?** The backend needs a moment to bind and Vite needs a moment to compile the first chunk. Opening immediately gives you a flash of "connection refused." 3s is the sweet spot.

**What if I want to use a different port?** Edit `FRONTEND_PORT` and `BACKEND_PORT` at the top of both `start.sh` and `stop.sh`, and update the proxy target in `vite.config.ts`.

**Is there an auto-start?** Yes, optional, macOS only — see [`launchd/com.jellyclaw.dashboard.plist`](launchd/com.jellyclaw.dashboard.plist) and the install block at the top of that file.

## Warp-clickable links

- [`dashboard/README.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/dashboard/README.md) — this file
- [`dashboard/ROOT.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/dashboard/ROOT.md) — directory layout reference
- [`dashboard/DECISIONS.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/dashboard/DECISIONS.md) — architecture rationale
- [`dashboard/docs/ARCHITECTURE.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/dashboard/docs/ARCHITECTURE.md) — internal data flow
- [`dashboard/docs/DEPLOYMENT.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/dashboard/docs/DEPLOYMENT.md) — prod bundle + launchd + remote access
- [`MASTER-PLAN.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md) — engine build master plan
- [`COMPLETION-LOG.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md) — live build log
- [`WARP-LINKS.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/WARP-LINKS.md) — all Warp shortcuts for this repo
- [`prompts/README.md`](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/README.md) — how the prompts are organized

---

Built local. Runs local. Stays local.

---

## Verified by

Integration audit performed by the QA agent on 2026-04-15. Results:

- **PASS** — repo paths exist (20 phase dirs, 67 prompts, both session-starter templates, COMPLETION-LOG.md, STATUS.md)
- **PASS** — launcher `start.sh` / `stop.sh` syntax, port checks (5173/5174), prereq validation
- **PASS** — Vite `/api` proxy wiring, strict port, same-origin CORS
- **PASS** — backend route handlers, path traversal guard (`assertInsideRepo`), Zod input validation
- **PASS** — chokidar watchers with `awaitWriteFinish`, `better-sse` SSE channel + heartbeat
- **DRIFT** — API response envelopes (`{ prompts, count }` vs bare `Prompt[]`); see `INTEGRATION-CHECKLIST.md` §1.1
- **DRIFT** — prompt-detail URL encoding (`encodeURIComponent("phase-NN/slug")` breaks route); §1.1
- **DRIFT** — SSE event names disagree between backend and frontend (zero overlap); §1.2
- **DRIFT** — `StatusSnapshot` shape mismatch (backend `progressPercent` vs frontend `progress`, etc.); §1.1

See:
- `ORCHESTRATION.md` — full system narrative + diagram
- `INTEGRATION-CHECKLIST.md` — audit detail
- `SMOKE-TEST.md` — post-install verification
- `HEALTHCHECK.md` — "is it working?" runbook
- `FAQ.md` — failure modes
- `SCRIPTS.md` — npm cheat sheet
- `CHANGELOG.md` — v0.1.0 release notes
- `tests/` — vitest unit + integration, Playwright E2E

Drift items should be resolved by the owning agents in their next pass; the QA agent
deliberately did not modify files outside `dashboard/tests/`, `dashboard/src/lib/api-validation.ts`,
or the root-level docs listed above.
