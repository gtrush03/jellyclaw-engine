# Smoke Test — jellyclaw-engine dashboard

Run this the first time on a fresh machine, or after any change that touches the
launcher, the API shapes, or the SSE wiring.

## Prerequisites

```bash
node --version   # expect v20.6.0 or newer
git --version    # any reasonably recent version
ls /Users/gtrush/Downloads/jellyclaw-engine/.git  # repo is cloned
```

If `node` is older than 20.6, install via `nvm install 20 && nvm use 20`.

## First-run sequence

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./start.sh
```

The launcher will:

1. Verify prereqs (Node version, package manager).
2. Check ports 5173 and 5174 are free.
3. Install `node_modules/` in both `dashboard/` and `dashboard/server/` if missing
   (first run only — takes 30–90 s).
4. Start the backend on 5174 (Hono via `tsx watch`).
5. Start the frontend on 5173 (Vite dev server).
6. Open the browser to `http://127.0.0.1:5173` after ~3 s.

## What healthy looks like

- Terminal shows two stream prefixes: blue `[server]` and gold `[ui]`.
- `[server]` logs: `Listening on 0.0.0.0:5174` (or similar Hono startup line).
- `[ui]` logs: `VITE v6.x  ready in ~XXX ms` and `Local: http://127.0.0.1:5173/`.
- Browser tab title: "jellyclaw · dashboard" (or whatever `index.html` sets).
- Sidebar: a scrollable list of 21 phases (0–19 + 10.5), each with a status dot.
- Main pane: a grid of prompt cards, ~67 visible once all 21 phases are expanded.
- Header: a `LIVE` badge glowing gold when SSE is connected.
- DevTools → Network → `events` request: status `200`, type `eventsource`, open
  indefinitely, receiving a `heartbeat` event every 30 s.

*(Screenshot placeholders — capture and commit once agents align on drift:)*

- `docs/screenshots/smoke-01-sidebar.png`
- `docs/screenshots/smoke-02-prompt-card.png`
- `docs/screenshots/smoke-03-assembled.png`
- `docs/screenshots/smoke-04-live-update.png`

## Failure modes and diagnosis

| Symptom | Likely cause | Fix / check |
| --- | --- | --- |
| `./start.sh: Permission denied` | script not executable | `chmod +x start.sh stop.sh` |
| `port 5173 already in use` | old Vite or another dev server | `./stop.sh`, or `lsof -ti:5173,5174 \| xargs kill -9` |
| Backend exits with `ENOENT COMPLETION-LOG.md` | repo moved or paths.ts stale | check `dashboard/server/src/lib/paths.ts`, update `REPO_ROOT` |
| Sidebar empty / "0 phases" | backend `/api/phases` returning envelope vs array mismatch | see INTEGRATION-CHECKLIST.md §1.1 |
| Center says "0 prompts" | prompts dir empty or not readable | `ls /Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-*/*.md \| wc -l` → expect 60+ |
| Prompt card click → right pane shows error | URL encoding drift for `/prompts/:phase/:slug` | see INTEGRATION-CHECKLIST.md §1.1 |
| LIVE badge stays gray | SSE never connected — see DevTools Network for 5xx on `/api/events` | check `[server]` logs |
| LIVE badge green but COMPLETION-LOG edit does nothing | SSE event name mismatch | see INTEGRATION-CHECKLIST.md §1.2 |
| UI looks unstyled (serif fonts, no gold) | Tailwind v4 plugin not loaded | check `vite.config.ts` has `@tailwindcss/vite` plugin |
| Copy button fails silently on Safari | Clipboard API requires user gesture | our button is click-triggered, so this should already work; check browser console |

## When to escalate

- **Backend crash loop (`[server]` exits repeatedly):** paste `dashboard/server/src/`
  errors + the last 20 lines of `[server]` output.
- **Frontend blank white page:** open DevTools Console, copy the stack trace. Most
  likely a Zod parse error from `src/lib/api-validation.ts` (means the backend shape
  drifted further — the thrown error will name the failing field).
- **Prompts parse but some are missing:** check `dashboard/server/src/lib/prompt-parser.ts`
  logs — it logs each failed parse. The file naming regex excludes `DEPENDENCY-GRAPH.md`
  and `README.md` on purpose.
- **`./stop.sh` leaves a zombie:** `ps aux | grep -E "(tsx|vite)"`, then
  `kill -9 <pid>`.

Once smoke test passes end-to-end, tick off the "Verified by" section in `README.md`.
