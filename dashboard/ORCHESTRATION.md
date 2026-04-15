# ORCHESTRATION — jellyclaw-engine dashboard

> The 5-minute explainer. If you have 5 minutes and you want to understand the whole
> dashboard — what it is, why it exists, how the pieces fit together, and how you use
> it on a daily basis — read this top to bottom.

---

## 1. What this is

The jellyclaw-engine dashboard is a **local-only, two-process web app** that makes it
trivial to step through the 20-phase build plan for jellyclaw. One process is a Hono
backend listening on port 5174 that reads `prompts/`, `phases/`, and `COMPLETION-LOG.md`
from disk and exposes them over a small JSON + SSE API. The other is a React 19 single-
page app served by Vite on port 5173 that proxies `/api` to the backend and renders the
whole plan as a sidebar of phases, a grid of prompt cards, and a detail pane with the
fully-assembled, copy-pasteable prompt.

It does not call any LLM, does not hit any external network, and stores no state of its
own. Every piece of data it shows lives in the repo — the dashboard is a read-only
projection over those files that happens to update in real time when the files change on
disk.

The repo's convention is that each prompt is a markdown file under `prompts/phase-NN/`.
When you want to run a prompt, you open the dashboard, click the card, hit
**Copy Full Prompt**, paste it into a fresh Claude Code session, and go. When Claude
finishes and updates `COMPLETION-LOG.md`, the dashboard reacts within a couple of seconds:
progress advances, the phase's status dot turns green, and a Sonner toast confirms what
changed. Then you pick the next prompt. That's the loop.

---

## 2. Why we built it

Without a dashboard, the workflow is: open Finder, dig into `prompts/phase-NN/XX-foo.md`,
remember which one is next by checking `COMPLETION-LOG.md` manually, concat the startup
template + the prompt body + the closeout template by hand, paste into Claude, come back
to Finder, check off the box, repeat. In practice what that means is you lose your place
every other session, you forget to apply the startup template, you forget to run the
closeout, and you end up in the wrong phase. The phase plan is a tree with real
`depends_on` constraints — the repo already encodes this — but you have no visual
surface for it.

The dashboard makes the plan legible. The sidebar tells you what's done and what's next.
The cards tell you what each prompt is for. The detail pane already did the template
assembly for you. The SSE channel keeps the whole surface honest: every time
`COMPLETION-LOG.md` changes, the UI reflects it. You can leave the dashboard open in a
second monitor and trust it.

---

## 3. How it works

```
     ┌──────────────────────────────────────────────────────────────────────┐
     │  jellyclaw-engine repo                                               │
     │  ┌───────────────┐  ┌──────────────────┐  ┌────────────────────┐     │
     │  │ prompts/*.md  │  │ phases/*.md      │  │ COMPLETION-LOG.md  │     │
     │  └───────┬───────┘  └──────────┬───────┘  └─────────┬──────────┘     │
     └──────────┼─────────────────────┼────────────────────┼────────────────┘
                │ fs.readdir()        │ fs.readFile()      │ chokidar.watch()
                ▼                     ▼                    ▼
     ┌──────────────────────────────────────────────────────────────────────┐
     │  Hono backend  (:5174)                                               │
     │    GET /api/prompts      → PromptSummary[]                           │
     │    GET /api/prompts/:p/:s → PromptDetail (assembled)                 │
     │    GET /api/phases       → PhaseSummary[]                            │
     │    GET /api/status       → StatusSnapshot                            │
     │    GET /api/events       → SSE (completion-log-changed, …)           │
     └──────────────────────────────┬───────────────────────────────────────┘
                                    │  Vite proxy (/api → :5174)
                                    ▼
     ┌──────────────────────────────────────────────────────────────────────┐
     │  React 19 SPA  (:5173, Vite)                                         │
     │    Sidebar ──────────┐                                               │
     │    Prompt grid ──────┤  React Query cache (prompts/phases/status)    │
     │    Detail pane ──────┤  Zustand store (selected id, sseConnected)    │
     │    LIVE badge ───────┤  @microsoft/fetch-event-source (SSE)          │
     │    Copy button ──────┘  navigator.clipboard.writeText()              │
     └──────────────────────────────┬───────────────────────────────────────┘
                                    │ user clicks Copy, pastes into Claude
                                    ▼
                       ┌─────────────────────────────┐
                       │ fresh Claude Code session   │
                       │ does the work               │
                       │ appends to COMPLETION-LOG   │
                       └──────────────┬──────────────┘
                                      │ chokidar fires
                                      ▼
                            dashboard updates in ≤2s
```

The whole system is a single closed reactive loop rooted in the repo's filesystem.
Nothing else.

---

## 4. What's inside

Four agents built this in parallel. Here's what each contributed (file tree is
abridged — scripts, dotfiles, and node_modules omitted):

```
dashboard/
├─ start.sh                 launcher · starts backend + frontend, opens browser
├─ stop.sh                  launcher · kills both, frees ports
├─ index.html               frontend · Vite entrypoint
├─ vite.config.ts           frontend · React + Tailwind v4 + /api proxy
├─ package.json             frontend · React 19, Zustand, React Query, Shiki, Sonner
├─ tsconfig.json            frontend · strict TS
├─ src/
│  ├─ main.tsx              frontend · React root
│  ├─ App.tsx               frontend · layout shell
│  ├─ theme.css             frontend · Obsidian & Gold tokens
│  ├─ types.ts              frontend · API type declarations
│  ├─ components/
│  │  ├─ CopyButton.tsx     polish    · the money button
│  │  ├─ EmptyState.tsx     polish    · 0-results state
│  │  ├─ ErrorBoundary.tsx  polish    · catches render errors
│  │  ├─ ProgressBar.tsx    polish    · overall progress
│  │  ├─ Skeleton.tsx       polish    · loading states
│  │  └─ StatusBadge.tsx    polish    · phase status pill
│  ├─ hooks/
│  │  ├─ useSSE.ts          frontend · subscribes to /api/events
│  │  ├─ useCopy.ts         polish    · clipboard + toast
│  │  └─ use{Prompts,Prompt,Phases,Status}.ts  · React Query hooks
│  ├─ store/dashboard.ts    frontend · Zustand (selection, sse state)
│  ├─ lib/
│  │  ├─ api.ts             frontend · fetch wrapper
│  │  ├─ api-validation.ts  QA       · Zod schemas (runtime validation)
│  │  ├─ cn.ts              frontend · clsx + tailwind-merge
│  │  ├─ shiki.ts           frontend · markdown code highlighting
│  │  └─ obsidian-gold.json polish    · Shiki theme
│  └─ styles/               polish   · Tailwind extensions
├─ server/
│  ├─ package.json          backend · Hono, chokidar, better-sse, gray-matter, zod
│  ├─ tsconfig.json         backend · strict, NodeNext
│  ├─ tsup.config.ts        backend · bundle for production
│  └─ src/
│     ├─ index.ts           backend · Node adapter, route wiring
│     ├─ types.ts           backend · API type declarations
│     ├─ lib/
│     │  ├─ paths.ts        backend · absolute paths + traversal guard
│     │  ├─ prompt-parser.ts backend · parse + assemble prompts
│     │  └─ log-parser.ts   backend · COMPLETION-LOG.md → StatusSnapshot
│     └─ routes/
│        ├─ prompts.ts      backend · /api/prompts, /prompts/:p/:s, .../raw
│        ├─ phases.ts       backend · /api/phases, /phases/:phase
│        ├─ status.ts       backend · /api/status
│        └─ events.ts       backend · /api/events (SSE)
├─ tests/
│  ├─ unit/prompt-parser.test.ts       QA · pure-function coverage
│  ├─ integration/api.test.ts          QA · live backend contract
│  └─ e2e/smoke.spec.ts                QA · Playwright UI flow
├─ vitest.config.ts         QA · coverage + include/exclude
├─ playwright.config.ts     QA · chromium, trace-on-failure
├─ INTEGRATION-CHECKLIST.md QA · drift audit + smoke sequence
├─ SMOKE-TEST.md            QA · fresh-install verification
├─ HEALTHCHECK.md           QA · "is this working?" runbook
├─ FAQ.md                   QA · anticipated failure modes
├─ SCRIPTS.md               QA · npm script cheat sheet
├─ CHANGELOG.md             QA · v0.1.0 initial release entry
└─ ORCHESTRATION.md         QA · this doc
```

---

## 5. How to use day-to-day

**Morning ritual:**

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./start.sh
# browser opens automatically
```

The landing view tells you:
- which phase is currently in progress (highlighted in the sidebar),
- how far along you are overall (progress bar at the top),
- what blockers are open (listed if any).

Pick the next prompt card. The detail pane on the right shows the assembled prompt.
Click **Copy Full Prompt**. Paste it into a fresh Claude Code session. Do the work.

When Claude finishes, it updates `COMPLETION-LOG.md` (that's part of the closeout
template every prompt ends with). As soon as that file is saved, the dashboard flashes a
Sonner toast, the progress bar advances, and the phase's status dot changes. You don't
need to refresh.

Pick the next prompt. Repeat until the phase is complete.

**End of session:** `./stop.sh` (or `Ctrl-C` in the terminal running `start.sh`). Both
processes exit, both ports are freed, the PID file is removed.

---

## 6. What happens when COMPLETION-LOG updates

1. You (or Claude) save `COMPLETION-LOG.md`.
2. `chokidar` (in the backend) fires a `change` event with `awaitWriteFinish: true`, so
   it debounces editor atomic-saves. 200 ms of stability, then it emits.
3. The backend broadcasts a `completion-log-changed` event on the SSE channel
   (`better-sse`).
4. The frontend's `useSSE` hook receives the event, invalidates the React Query caches
   for `prompts`, `phases`, and `status`, and updates `lastLogUpdate` in the Zustand
   store.
5. React Query refetches the three affected endpoints in parallel.
6. The sidebar and prompt cards re-render with the new `status` fields. The progress bar
   animates to its new value. The `LIVE` badge stays green throughout — it would only
   flicker if the SSE connection itself dropped.
7. A Sonner toast confirms the change.

End-to-end from `Cmd+S` to visible UI change: **under 500 ms** on a quiet machine.

---

## 7. Extending it

**New route on the backend:** add a file under `dashboard/server/src/routes/`, export
a Hono router, wire it in `server/src/index.ts`. Add a matching Zod schema in
`src/lib/api-validation.ts`, then add a React Query hook in `src/hooks/`. Parse every
response with `parseApi(Schema, '/api/foo', json)` — never skip it.

**New UI tab:** add a component under `src/components/`, register a route (we don't
have a router yet — current UI is single-screen; introduce `react-router` when the
second screen arrives, don't roll your own). Wire it to existing React Query hooks.

**New SSE event type:** emit from the backend (`events.ts` `broadcast(...)`). Add the
name to the `ServerEventNameSchema` enum in `api-validation.ts`. Handle it in
`useSSE.ts`. Don't add events that don't correspond to real filesystem state — the
dashboard's contract is "projection over files."

**New data source:** if it's another file in the repo, add it to `paths.ts`, extend
`log-parser.ts` or write a new parser, expose via a route. If it's external
(e.g., GitHub API), stop — that's a different product. The local-only invariant is
load-bearing; it's why this thing is fast and private.

---

## 8. When to NOT use it

If you have exactly one prompt to run and you already know its path:

```bash
cat prompts/phase-05/03-implement.md | pbcopy
```

is faster than spinning up two processes. The dashboard earns its keep once you've got
20+ prompts ahead of you and you're losing track of what's next.

Similarly, the dashboard is read-only. If you're writing a new prompt, edit the file
directly in your editor. The dashboard will pick it up via the `prompt-added` watcher
within a second.

---

That's the whole system.
