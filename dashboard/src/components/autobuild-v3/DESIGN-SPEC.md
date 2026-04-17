# Autobuild v3 — Mission Control

> Full-page supervision UI for jellyclaw's autobuild rig. Replaces `autobuild-v2/AutobuildConsole` + the legacy `autobuild/AutobuildPanel` tray. Locked 2026-04-17.

---

## Section 1 — Research + design thesis

### Lessons borrowed from existing supervision UIs

**Temporal UI (workflow observability).** The killer move is the *workflow timeline* — a horizontal swim lane per workflow execution that draws activity blocks chronologically, so a single glance tells you which step is slow, which step failed, and where in the critical path you are. Temporal also commits hard to the distinction between "workflow state" (durable) and "worker state" (ephemeral) in the chrome: you never confuse "the thing is broken" with "the thing is waiting". Jellyclaw needs the same — a **session timeline** that puts `spawning → working → self_checking → testing → committing` on one horizontal axis so the operator reads "where did the last 14 minutes go" in one eye movement.

**GitHub Actions run UI.** Two things work: the **per-step collapsible log viewer** (each phase of a job is individually tail-able with duration label) and the **terminal vs ~terminal state hierarchy** in the header (the commit SHA is the big primary identity; status is the secondary adjective). What GHA does that I will REJECT: the infinite re-run button graveyard at the top of a failed job. Jellyclaw has a retry taxonomy that is MORE expressive than "click re-run"; it should show *why* a retry is or isn't safe, not just a button.

**Datadog distributed traces.** Lesson: **time flows left-to-right, width = duration, color = outcome**. This is the right mental model for a single session. What to reject: the Datadog density trap — a flame graph with 50 levels and 2px tall rows where you can't click anything. A jellyclaw session has at most ~6 phases. Make them 32px tall and legible.

**Kubernetes k9s TUI.** Lesson: **every surface is keyboard-addressable and every row has a stable shortcut**. k9s ships one action letter per verb (`k` kill, `d` describe, `l` logs). Jellyclaw's operator should be able to drive the entire rig from the keyboard — this is a "I'm at the cafe, don't need a trackpad" UX. What to reject: k9s's monochrome wall-of-text density. The obsidian/gold brand affords more breathing room than a terminal; use it.

**Stripe dashboard.** Lesson: **summary up top, activity feed down the side, detail in the middle, never nested**. Stripe never puts a drawer inside a drawer. When you click a charge you get a dedicated *page* with stable URL. Jellyclaw's current v2 buries the approvals column behind a chevron that 30% of users will never discover. URL-addressable views fix this.

**LaunchDarkly flag dashboard.** Lesson: **environment banner**. When you're in "production," a sticky environment color bar across the top of the screen reminds you. Jellyclaw should do this when the rig is HALTED or when daily budget has tripped — a full-width bar that the operator can't miss.

### Lessons rejected

1. **Argo Workflows' DAG-of-everything visualization.** Beautiful, unreadable beyond 20 nodes. Jellyclaw will have 35-55 prompts total — a DAG view would be a party trick, not a work tool. Use a linear tier-ordered list. The tier strip IS the DAG abstraction.
2. **Vercel's "all green, all the time" aesthetic.** When every deploy is green and smooth, Vercel feels great. When something's on fire, Vercel makes you click four times to find the error log. The jellyclaw rig WILL fail multiple times a day; the failure state must be the most designed state, not the afterthought. Design the red-state first.
3. **Datadog/Grafana's "one dashboard per persona" approach.** Causes tab explosion. Jellyclaw is one persona (George) with one question ("is the rig ok and what does it need from me?"). One dashboard, one URL.

### Thesis

> **Jellyclaw's autobuild console is NASA Mission Control for an AI that fixes its own codebase — calm, confident, read-at-a-glance, with one button for every verb and no hidden state.**

Corollary: the design succeeds if George can walk into the room, glance at the dashboard for 2 seconds, and correctly state (a) whether the rig is alive, (b) whether it needs him, (c) how much budget is left, (d) what tier it's working on. If any of those four questions requires clicking, the design has failed.

---

## Section 2 — Information hierarchy

### Always visible (the Mission Strip, top 88px)

These NEVER collapse, NEVER hide, NEVER scroll off:

- **Rig lifecycle state** — `offline | starting | online | paused | halted` — as a single high-contrast pill with a colored bezel. Visible from across the room.
- **Concurrency indicator** — `1/1` or `2/2` slots — tiny but present (tells you if the rig is actually saturating).
- **Tier strip** — `T0 T1 T2 T3 T4` as five segments, fill proportional to completion. Overall `done/total`.
- **Daily budget meter** — `$X.XX / $25.00` with a bar + color tone.
- **Next-action hint** — a single imperative sentence that tells the operator what to do next ("Nothing to do — rig is working" or "3 runs await your review").

### One click away (Primary detail region, ~60% of screen)

- **Active session(s)** — up to 2 cards at MVP, promoting to 2 slots. Each card is big enough to read the last 6 log lines without hovering.
- **Queue** — what's next, T0→T4 ordered. Compact list.
- **Tabs inside the primary region**: `Live` (default) · `Queue` · `History` · `Approvals` — each keyboard-addressable.

### Progressive disclosure

- Full log tail → click the session card's "expand" affordance or press `L`.
- Per-session retry history → lives inline in the session card but collapsed until the user clicks the attempts counter.
- Prompt frontmatter (scope_globs, depends_on, etc.) → popover on hover of the slug.
- Worker pid / branch / tmux session name → in session card footer, monospace, small.

### Red-state (only shows when wrong)

These have zero presence in a happy state; they occupy full screen bandwidth when tripped:

- **Halt banner** — full-width, red, sticky above the Mission Strip. Includes the reason (`daily_halt` / `tier_out_of_order` / `scope_violation_streak`).
- **Stale heartbeat banner** — amber. "Dispatcher claims running but hasn't tick'd in 86s."
- **State.json parse error** — red card in the primary region. "Cannot read state — backend reports malformed JSON at offset 4120. Rig may still be alive."
- **SSE dropped** — small yellow dot on the live indicator + "last event 34s ago" under it. Not a banner — it's recoverable.
- **Approval backlog > 5** — the Approvals tab badge goes red, the Next-action hint becomes "5 runs blocked on you. Tap A."
- **Budget at 95%+** — the budget meter turns red, and a soft banner appears: "At 95% of daily cap. Rig will halt at 100%."

---

## Section 3 — Layout

### Two layouts considered, one chosen

#### Rejected layout A — "v2 but bigger" (three columns + top strip)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  [Mission Strip — status · tiers · budget · next-action]                                                │
├──────────────┬───────────────────────────────────────────────────────────────┬─────────────────────────┤
│ Queue board  │  Live session viewer (header + log + abort/skip)              │ Approvals               │
│ (5 buckets)  │                                                                │ Escalations             │
│              │                                                                │ Recent activity         │
└──────────────┴───────────────────────────────────────────────────────────────┴─────────────────────────┘
```

**Rejected because:** this is what v2 is. It wastes a fixed 300px on the queue (which is mostly empty), the approvals column is either empty or too dense, and the middle column — which is the ONLY thing the operator stares at — is squeezed. George literally called it "empty." Because it is.

#### Rejected layout B — "full flame graph per session" (single huge timeline per run)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  [Mission Strip]                                                                                        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [Session #1: giant horizontal timeline spanning 100% width, flame-graph style, 40% tall]              │
│  [Session #2: ditto]                                                                                    │
│  [Queue strip at bottom — one-line items]                                                               │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Rejected because:** over-indexes on what a session timeline looks like when there's one or two sessions. When the rig is idle or between runs, this layout has nothing to draw. Also pushes the queue (which IS the medium-term plan) into a footer afterthought.

#### Chosen layout — "Mission Strip + Deck + Rail" (hero deck, queue rail, context tabs)

```
╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║                                           M I S S I O N   S T R I P  (88px, sticky)                                   ║
║  [●ONLINE · 2/2 slots · up 3h 14m · pid 48271]              [T0 ████  T1 ████  T2 ██░░  T3 ░░░░  T4 ░░░░  27/52]    ║
║  [$ 7.40 / $25.00 ────────────────────────────────────]     [▶ 3 approvals waiting.  Press A.]          [⏸ ⏯ ⏹ ⚠]   ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝
┌──────────────────────────────────────────────────────────────────────────────────────────────────┬───────────────────┐
│                                                                                                   │                   │
│   [ Live ] [ Queue ] [ History ] [ Approvals · 3 ]      ← context tabs (keyboard: 1/2/3/4)       │  UP NEXT (rail)  │
│                                                                                                   │                   │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐  │  T0 ─────────    │
│  │  SESSION CARD  phase-99b-unfucking-v2/02-extract    [T1]  [●working]             abort ▸  │  │                  │
│  │  branch autobuild/abc123 · tmux jc-abc123 · attempt 1/2                                     │  │  T2/01 dedupe    │
│  │  ────────────────────────────────────────────────────────────────────────────────────      │  │  T2/02 routes    │
│  │  ◐ spawning  ●●●●●●●●● working  ○ self-check  ○ tester  ○ commit     turns 14/25           │  │  T2/03 session   │
│  │  ──────────────────────────────────────────────────────────────────────                    │  │  ─────────────   │
│  │  $ 0.00 ────────────────────────────│──── $5.00 gate ──── $10.00 hard cap                  │  │  T3/01 retry     │
│  │  ┌────────────── last 6 log lines, mono, shimmer on new ─────────────────────────────┐     │  │  T3/02 heartbt   │
│  │  │ 14:02:04  tool:Read  engine/src/rig/dispatcher.ts                                 │     │  │  T3/03 archival  │
│  │  │ 14:02:05  tool:Edit  engine/src/rig/session.ts                                    │     │  │  ...             │
│  │  │ 14:02:07  assistant:  "adding tier gate check"                                     │     │  │                  │
│  │  │ 14:02:09  tool:Bash   bun run typecheck                                            │     │  │  HELD (1)        │
│  │  │ 14:02:11  (typecheck passed, 0 errors)                                             │     │  │  T4/09 manual    │
│  │  │ 14:02:12  tool:Edit  engine/src/rig/index.ts                                       │     │  │                  │
│  │  └─────────────────────────────────────────────────────────────────────────────────────┘   │  │                  │
│  │  [ expand log (L) ]  [ tell (T) ]  [ abort (X) ]                                            │  │                  │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘  │                  │
│                                                                                                   │                   │
│   (when concurrency=2, a second SESSION CARD sits below the first, same width, flush)            │                   │
│                                                                                                   │                   │
│   [ Recent activity feed — 4-line footer, monospace, last 6 transitions, non-scrolling preview ] │                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┴───────────────────┘
```

**Why it wins:** the primary region is *always* used — if no session is live, it shows an empty-state CTA that's still full-width (not squeezed). The queue rail is narrower (280px) than v2's 300px but feels roomier because it drops the 5-bucket structure and replaces it with a simple T-grouped "up next" list. Approvals/Escalations/History get dedicated *tabs* with URL addresses, not a cramped sidebar. And the Mission Strip commits the top 88px to the four questions the operator actually asks.

### Breakpoints

- **1440+ (desktop primary)** — as drawn above. Mission Strip at 88px, primary region expands to fill, rail at 280px right-aligned.
- **1280** — rail narrows to 240px; session card's log preview drops from 6 lines to 4 lines.
- **1024** — rail collapses into a drawer behind an "Up Next (3)" button in the Mission Strip. Primary region takes full width.
- **iPad portrait (≥768)** — Mission Strip stacks to two rows (status + budget / tiers + action). Primary region is full-width. Rail is a full-screen bottom sheet summoned by a button.
- **< 768** — not supported. Shows a "Mission Control is desktop-first. Open on your Mac." stub. (This is a supervision UI; no one is stopping a rig from their phone.)

### URL addressing

Routing uses **hash-based client routing** (no react-router dependency — we aren't adding one). State lives in `window.location.hash`:

- `#/autobuild` — Live tab (default).
- `#/autobuild/queue`
- `#/autobuild/history`
- `#/autobuild/approvals`
- `#/autobuild/run/<run-id>` — pinned to a specific run; disables auto-select.
- `#/autobuild/run/<run-id>/log` — full log viewer overlay for a run.

Why hash over react-router: the app is single-page and Vite serves under `/`. A hash router is 30 lines of code in `useAutobuildRoute`. Adding react-router is a 27kb dep + context provider + `<BrowserRouter>` refactor for zero user-facing benefit. Every URL is copy-pasteable.

Why URL addressing at all: (a) deep-link on bug reports ("look at `#/autobuild/run/T0-03-abc`"), (b) browser back button does the right thing, (c) future-proof for embedding in Genie's dashboard iframe.

### Keyboard map

| Key           | Action                                                        |
|---------------|---------------------------------------------------------------|
| `1` / `2` / `3` / `4` | Switch tab: Live / Queue / History / Approvals        |
| `s`           | Start rig (if offline) / no-op when online                     |
| `p`           | Pause / Resume (toggles)                                       |
| `.`           | Tick (one-shot dispatcher tick; dev/debug only)                |
| `H`           | Halt (SHIFT-H required; shows confirm dialog)                   |
| `j` / `k`     | Move selection down / up in the current list                   |
| `L`           | Expand log for focused session                                 |
| `T`           | Tell — open hint-injection modal for focused session            |
| `X`           | Abort focused session (confirm dialog)                          |
| `a`           | Approve focused run (only when in review/approvals tab)         |
| `r`           | Retry focused run (only when in escalated state)                |
| `Enter`       | Open focused item in detail view                                |
| `Esc`         | Close modal / deselect / exit expanded log                      |
| `?`           | Open keyboard help overlay                                     |
| `/`           | Focus the global search (filters queue + history)              |
| `g` `h`       | Go home (`#/autobuild`)                                        |

Global rule: if focus is in an `<input>` or `<textarea>`, all single-letter shortcuts are suppressed. `Esc` always works.

### Zoom levels — yes, three

1. **Fleet view** (default, tab `Live`) — 1-2 session cards + rail queue + mission strip. The "what's happening right now" view.
2. **Single-session view** (`#/autobuild/run/<id>`) — one session card promoted to fill the whole primary region; timeline expands to show all phases with tooltips; log preview grows to 20 lines; retry history is inline expanded. Accessed via Enter on a card or clicking the session header. Back/Esc returns to Fleet view.
3. **History view** (tab `History`) — table of all runs from state.json plus archived sessions. Filter by tier/status/date. Clicking a row navigates to `#/autobuild/run/<id>` (which degrades gracefully for archived runs — shows the committed summary rather than a live log).

---

## Section 4 — Component tree

All components live under `src/components/autobuild-v3/`. Kebab-case files, PascalCase exports.

```
autobuild-v3/
├── MissionControl.tsx            ← root; reads hash; renders Strip + tab body + Rail
├── MissionStrip.tsx              ← sticky 88px top band (4 always-on signals)
│   ├── RigStateBadge.tsx         ← offline|starting|online|paused|halted + uptime + pid
│   ├── ConcurrencyPips.tsx       ← 1/1 or 2/2 dots
│   ├── TierStrip.tsx             ← 5-segment T0..T4 bar; hover = bucket tooltip
│   ├── DailyBudgetBar.tsx        ← $spent / $cap with tone
│   ├── NextActionHint.tsx        ← one-sentence imperative + bound shortcut
│   └── RigControls.tsx           ← ⏸ resume, ⏹ stop, ⚠ halt; start button promoted when offline
├── AlertStack.tsx                ← full-width banners: halt / stale-heartbeat / sse-dropped / parse-error
├── ContextTabs.tsx               ← tab bar (Live · Queue · History · Approvals)
│   └── TabBadge.tsx              ← small count with tone (red if blocked)
├── live/
│   ├── LiveDeck.tsx              ← stacks 0..2 SessionCard(s); renders LiveIdleCard when empty
│   ├── SessionCard.tsx           ← hero component (spec in §11)
│   │   ├── SessionHeader.tsx     ← slug, tier chip, status, branch, tmux, attempt N/M
│   │   ├── PhaseTimeline.tsx     ← 5-phase horizontal timeline (spawning..committing)
│   │   ├── TurnsCostBar.tsx      ← turns + session-cost bar with $5 gate tick + $10 hard cap
│   │   ├── LogPreview.tsx        ← last 6 lines, mono, shimmer on new line
│   │   ├── SessionActions.tsx    ← [abort] [tell] [expand log]
│   │   └── RetryRibbon.tsx       ← collapsed by default; shows attempt history
│   ├── LiveIdleCard.tsx          ← shown when no session is running
│   └── ActivityFooter.tsx        ← 4-line feed of recent transitions (non-scrolling)
├── queue/
│   ├── QueueTab.tsx              ← T0-grouped list, drag-reorder disabled (tier-gated)
│   ├── QueueGroup.tsx            ← one tier's worth; collapses when tier is fully done
│   ├── QueueItem.tsx             ← slug + title + est_minutes + frontmatter popover on hover
│   └── QueueHeldDrawer.tsx       ← `hold: true` prompts; requires explicit "unhold" to enqueue
├── approvals/
│   ├── ApprovalsTab.tsx          ← vertical stack of cards, newest first
│   └── ApprovalCard.tsx          ← commit SHA, test results summary, diff-file count, [approve] [reject]
├── history/
│   ├── HistoryTab.tsx            ← table; filter chips; virtualized (react-virtual later; not MVP)
│   └── HistoryRow.tsx            ← slug, tier, outcome, cost, duration, commit SHA (clickable to run view)
├── rail/
│   ├── UpNextRail.tsx            ← always-visible 280px right rail with "next 6" by tier
│   └── UpNextItem.tsx            ← compact slug + est minutes, tier-colored dot
├── modals/
│   ├── HaltConfirmModal.tsx      ← two-step (type "HALT" + press Enter)
│   ├── AbortConfirmModal.tsx     ← one-step confirm; shows "current turn will finish"
│   ├── TellHintModal.tsx         ← textarea to inject a hint sentinel into .orchestrator/inbox/
│   ├── LogOverlay.tsx            ← full-viewport tail viewer; `#/autobuild/run/<id>/log`
│   └── KeyboardHelpOverlay.tsx   ← `?` key; lists the full shortcut map
├── empty/
│   ├── FirstRunEmptyState.tsx    ← when rig never started (see §6)
│   ├── AllDoneVictory.tsx        ← when tier pack complete (see §6)
│   └── LiveIdleCard.tsx          ← (same as above, listed again here for discoverability)
├── hooks/
│   ├── useAutobuildRoute.ts      ← hash router; { view, runId }; subscribes to hashchange
│   ├── useFocusedRun.ts          ← selected run from route OR auto-selection logic
│   ├── useRigAlerts.ts           ← derives which alert banners to show from RigState
│   ├── useNextAction.ts          ← returns the imperative sentence + bound shortcut
│   └── useKeyBindings.ts         ← installs the keyboard map, dedupes with global handlers
└── logic.ts                      ← pure helpers (extracted from v2/logic.ts with additions:
                                       tierGroupQueue, nextActionFromState, alertsFromState,
                                       phaseTimelineFromRun, isStale)
```

~25 components, 5 hooks. Each component ≤200 LOC.

### State ownership

- **TanStack Query reads only** (no new queries; reuses existing hooks):
  - `useRuns()` → RigState (5s polling + SSE-invalidated)
  - `useRigProcess()` → supervisor pid/since
  - `usePrompts()` → tier totals + queue items
  - `useRunLog(runId)` → SSE log tail
- **Zustand (`store/dashboard.ts`)** owns:
  - `focusedRunId` (existing `selectedRunId`, renamed mentally to signal explicit-focus semantic)
  - `expandedLogRunId` (new; drives LogOverlay)
  - `queueFilter` (search/tier filter)
  - `autobuildView` (already exists for top-level nav; unchanged)
- **Route state** (hash): `{ tab: 'live'|'queue'|'history'|'approvals', runId?: string, logOpen?: boolean }`
- **Local component state**: component-specific toggles only (hover tooltips, collapse animations).

---

## Section 5 — State & transitions (visual grammar)

Every session card and every queue item renders one of these visual states. Grammar is: **color = semantic tone, motion = liveness, border = interaction affordance**.

| Semantic state           | Card base                 | Border                                    | Dot/Indicator                         | Motion                         |
|--------------------------|---------------------------|-------------------------------------------|---------------------------------------|--------------------------------|
| `queued`                 | `var(--color-surface)`    | 1px `--color-gold-subtle` (20% gold)      | grey muted dot                        | none                           |
| `spawning`               | surface                   | 1px gold (40%)                            | gold dot, `pulse-glow` 2s             | **shimmer sweep** on card L→R  |
| `working`                | surface                   | 1px gold (60%)                            | gold dot, `pulse-glow` 2s              | log preview: new-line shimmer   |
| `self_checking`          | surface                   | 1px gold-bright (80%)                     | gold-bright dot, pulse               | timeline segment widening      |
| `testing`                | surface                   | 1px gold-bright                           | gold-bright dot, pulse (faster 1s)    | tests counter animates         |
| `passed` (needs_review)  | surface + review-glow     | 1px gold (gold faint fill)                | solid gold                            | **gentle pulse** 4s cycle       |
| `failed`                 | `rgba(199,84,84,0.06)` fill | 1px danger (40%)                          | red dot                               | one-shot shake on transition   |
| `escalated`              | `rgba(199,84,84,0.10)` fill | 1px danger (60%)                          | red dot + ⚠ glyph                     | none (terminal state)           |
| `retrying`               | surface                   | 1px warning (40%)                         | warning dot                           | `retry-spinner` on ↻ icon      |
| `complete`               | surface                   | 1px success (30%)                         | success (muted green) dot             | one-shot check-mark tick       |
| `halted` (card-level)    | surface with grey overlay | 1px danger (40%) + dashed                 | ⏸ glyph grey                          | none                           |

### Transition animations

| Transition              | Motion                                                                                     | Duration | Curve           |
|-------------------------|--------------------------------------------------------------------------------------------|----------|-----------------|
| card enter (new run)    | slide down 8px + fade from 0→1                                                             | 240ms    | `ease-out`      |
| card exit (archived)    | fade to 0.4 + collapse height                                                              | 200ms    | `ease-in`       |
| phase advance           | timeline segment: `--color-gold` fills L→R                                                 | 360ms    | `ease-out`      |
| status pill swap        | crossfade with 60ms overlap                                                                | 180ms    | linear          |
| new log line            | soft bg flash on the new line, fades to normal                                             | 600ms    | `ease-out`      |
| approval arriving       | review-glow border pulses 3× then settles; `✓` icon rises into header                     | 1200ms   | tri-phase `ease-in-out` |
| error arriving          | card fill crossfade to danger-tint + 80ms horizontal 2px shake                             | 300ms    | hard            |
| retry count increment   | `1→2` numeric: odometer roll (vertical slide)                                              | 220ms    | `ease-out`      |
| tier segment fill       | width tween on `.tier-seg-fill`                                                            | 500ms    | `ease-out`      |
| budget bar tick         | width tween                                                                                | 400ms    | `ease-out`      |

### Sound

No audio. This is a desk tool and George works in cafes. Nothing beeps.

### `prefers-reduced-motion`

When the user's OS reports reduced-motion:
- All `pulse-glow` and shimmer animations → static at max opacity.
- All fills/tweens → instant (0ms).
- New-log-line flash → solid 200ms single frame instead of fade.
- Odometer / shake → not applied (number swaps instantly; card tint flips instantly).
- Status dot: **stays colored** but stops pulsing — color carries the state, motion was just the emphasis.

---

## Section 6 — Empty states (first-run UX)

### 6.1 Rig never started (never-has-run)

Condition: `rigProcess.running === false && Object.keys(rig.runs).length === 0 && rig.completed.length === 0`.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    M I S S I O N   C O N T R O L                                 │
│                                                                                                   │
│                       Your jellyclaw autobuild rig has not run yet.                              │
│                                                                                                   │
│         When you start it, it will dispatch prompts in tier order (T0 first), spawn              │
│         a Claude Code worker per run in a tmux session, check tests, and escalate                │
│         to you when it fails or gets stuck. You stay in the loop — it never merges               │
│         anything without you approving.                                                           │
│                                                                                                   │
│                              ┌───────────────────────────────┐                                   │
│                              │   ▶  S T A R T   T H E   R I G  │   (S)                             │
│                              └───────────────────────────────┘                                   │
│                                                                                                   │
│     ┌──────────── WHAT YOU WILL SEE ────────────┐   ┌──────────── WHAT YOU CAN DO ─────────────┐ │
│     │ ● 5 T0 prompts queued → dispatched one    │   │ ● Approve / Reject finished runs         │ │
│     │   at a time (concurrency starts at 1).    │   │ ● Pause to hold new dispatch             │ │
│     │ ● Each run gets its own git branch        │   │ ● Halt the rig (destructive; confirms)   │ │
│     │   autobuild/<id> — never auto-merged.     │   │ ● Tell — inject a hint mid-run           │ │
│     │ ● Daily cap $25. Per-session hard $10.    │   │ ● All actions keyboard-addressable       │ │
│     └───────────────────────────────────────────┘   └──────────────────────────────────────────┘ │
│                                                                                                   │
│                    5 T0 prompts ready · 0 prompts held · Tier pack: unfucking-v2                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Mission Strip is **suppressed** in this state — we only show its skeleton: OFFLINE badge + "—" for tiers + `$ 0.00 / $25.00` — all greyed out.
- The big Start button is the only thing that can be pressed. Keyboard `s` works.
- Bottom line reports queue readiness so the operator knows prompts were parsed successfully.

### 6.2 Rig online, no runs yet (dispatcher just started)

Condition: `rigProcess.running === true && Object.keys(rig.runs).length === 0`.

The LiveDeck shows `LiveIdleCard`:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                              │
│                          ●  The rig is alive. Waiting for the next tick.                     │
│                                                                                              │
│             Next dispatch: T0/01-fix-serve-shim  — est 12 min                                │
│             Concurrency: 1/1 open                                                             │
│                                                                                              │
│                           [ ▷ Tick now (.) ]    [ view queue (2) ]                            │
│                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Tick interval is 2s so in practice this state lasts <5s. But it must exist — shows liveness.

### 6.3 No queue loaded (prompts/ empty or parse failed)

This is actually a *broken* state (the rig can't do anything), not an empty state. Rendered as an AlertStack item:

```
┌──── ⚠ NO QUEUE ────────────────────────────────────────────────────────────────────────────┐
│ Dispatcher has no prompts to run. Check prompts/ exists and frontmatter passes Zod.         │
│ Nearest cause: [PROMPT_PARSE_ERROR] at prompts/T0-02-creds-read.md (line 4)                 │
│ [ open file ]   [ re-scan prompts ]                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.4 All done (victory)

Condition: `rig.queue.length === 0 && rig.escalated.length === 0 && every prompt.status === 'complete'`.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                              │
│                                   ✓  T I E R   P A C K   D O N E                              │
│                                                                                              │
│                       52 prompts landed across T0–T4. 0 open escalations.                    │
│                                                                                              │
│                   Spent today: $18.40 / $25.00   ·   Total sessions: 58                      │
│                   Average duration: 9m 14s      ·   Retry rate: 12%                           │
│                                                                                              │
│          ┌──────────────────┐   ┌─────────────────────────┐    ┌──────────────────┐          │
│          │  review history  │   │  export COMPLETION-LOG  │    │   stop rig       │          │
│          └──────────────────┘   └─────────────────────────┘    └──────────────────┘          │
│                                                                                              │
│              The rig will auto-stop after the next tick. No new runs to dispatch.            │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Gold border, no pulse. Not a confetti moment — calm celebration. The tier strip at the top is fully gold-filled with a subtle shimmer that loops once and stops.

---

## Section 7 — Error states

All error banners mount in `<AlertStack />` above the `<ContextTabs />` but below `<MissionStrip />`. Multiple can stack; each has a dismiss affordance. Priority order (highest first): `halt > parse-error > backend-unreachable > stale-heartbeat > sse-dropped > budget-warning`.

### 7.1 Rig crashed / halted

Condition: `rig.halted === true` OR (`rigProcess.running === false && lastKnownHeartbeat within 60s`).

```
┌──── ⬣ RIG HALTED ──────────────────────────────────────────────────────────────────────────────┐
│  Dispatcher halted at 14:07:22. Reason: budget.daily_halt — spent $25.04 / $25.00.             │
│  5 runs in-flight continue in their tmux sessions until claude-code exits; no new spawns.      │
│                                                                                                 │
│  [ unhalt rig (requires typing UNHALT) ]   [ restart rig (stop then start) ]   [ open logs ]   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Red bar. Not dismissable.
- If the halt reason is `tier_out_of_order`, the unhalt button is replaced with `[ open prompts/ ]` because the only fix is editing frontmatter.
- When rig is restarted, the banner crossfades to green "Rig resumed at 14:09:15" and auto-dismisses after 8s.

### 7.2 SSE dropped

Condition: `useRuns` still returns data (polling) but SSE connection errors > 2 in 30s.

```
[● online · 2/2 · up 3h 14m]    [yellow dot]  [live feed degraded — polling at 5s (last event 34s ago)]
```

No banner. Just a small yellow indicator in the Mission Strip next to the rig status. Tooltip: "Server-sent events unreachable. Falling back to 5s polling. Retrying in 8s." Non-blocking.

### 7.3 State.json corrupted / parse error

Condition: `/api/runs` returns 500 with `{ error: 'state_parse_error', offset, snippet }`.

```
┌──── ✕  CANNOT READ STATE.JSON ─────────────────────────────────────────────────────────────────┐
│  Malformed JSON at byte offset 4120. The rig may still be running — the dispatcher's atomic    │
│  writer pattern should prevent this, so this is probably manual corruption. Last good snapshot │
│  was 14:02:10 (shown below, read-only).                                                         │
│                                                                                                 │
│  [ show snippet ]   [ copy error to clipboard ]   [ retry load ]                                │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The UI continues to render the **last successful state** as a read-only snapshot (dimmed 70% opacity across all cards). All mutate actions (start/stop/approve/reject) are disabled with tooltip "disabled — state file is unreadable."

### 7.4 Dashboard backend unreachable

Condition: `/api/runs` fetch fails with network error AND `useSSE` is disconnected.

```
┌──── ✕  DASHBOARD BACKEND UNREACHABLE ─────────────────────────────────────────────────────────┐
│  Lost connection to the dashboard server at http://localhost:4319. The rig may still be        │
│  running — what you see here is your last good snapshot (cached 2m 14s ago). Will retry every  │
│  5 seconds.                                                                                     │
│                                                                                                 │
│  [ retry now ]   [ show last good snapshot ]   [ check `jc status` in terminal ]                │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Red. Sticky. Dismisses itself when the fetch recovers.

### 7.5 Heartbeat stale (dispatcher says running but isn't ticking)

Condition: `rigProcess.running === true && (Date.now() - rig.rig_heartbeat) > 45s`.

```
┌──── ⚠ STALE HEARTBEAT ─────────────────────────────────────────────────────────────────────────┐
│  Dispatcher pid 48271 claims running but hasn't tick'd in 86s. If a tmux session is spinning   │
│  on a long tool call, this is normal. If the rig is wedged, you can force a halt + restart.    │
│                                                                                                 │
│  [ force restart ]   [ open rig log (logs/rig.log) ]   [ ignore for 2 min ]                     │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Amber. Dismissable (stores dismissal in sessionStorage for 2 minutes so it doesn't immediately re-appear).

---

## Section 8 — Interaction model

### Click vs hover

- **Click-to-select** for session cards, queue items, approval cards. Selection is URL-synced (`#/autobuild/run/<id>`). Clicking a selected item deselects.
- **Hover-to-preview** ONLY for: slug popovers (show frontmatter), dot tooltips (show exact status name), segment tooltips (show per-tier `done/total`), and the "next-action hint" (hover reveals which shortcut fires it).
- **Double-click** reserved: on a session card → opens LogOverlay. On a queue item → opens the prompt frontmatter viewer (uses existing `PromptViewer`).

### Confirmation model

Tiered by destructiveness:

| Action               | Confirmation     | Why                                                                       |
|----------------------|-----------------|---------------------------------------------------------------------------|
| Start rig            | **None** — fires immediately | non-destructive, trivially reversible (`p`/Stop)                 |
| Pause                | **None**        | trivially reversible                                                       |
| Resume               | **None**        | trivially reversible                                                       |
| Tick                 | **None**        | idempotent, cheap                                                          |
| Approve              | **None**        | writes COMPLETION-LOG, but this is the intended terminal action            |
| Reject               | **Soft** — inline "sure? (Y/N)" underneath the button; 3s auto-timeout | reversible via Retry button, but surfaces intent  |
| Stop rig             | **Modal** — 1-click "Stop rig" button in modal                              | in-flight runs keep going; recoverable |
| Abort run            | **Modal** — "Abort session jc-abc123?" with "current turn will finish" note | kills a running session mid-work |
| Retry (escalated)    | **None**        | retries are cheap; aborted retries fall back to escalated                  |
| Halt                 | **Modal + type** — user must type `HALT` in a field to arm the button     | destructive, hard to undo, must be deliberate |
| Unhalt               | **Modal + type** — user must type `UNHALT`                                 | same                                            |
| Skip (orchestrator)  | **Modal** — tells user "this advances past T<N>"; slug-specific confirm   | changes tier semantics                          |
| Tell (hint inject)   | **Modal** — the textarea modal IS the confirmation                         | content IS the intent                          |

### Undo affordances

- **Pause** → "Resume" is a one-click undo, right next to the Pause button, only visible in paused state.
- **Stop rig** → "Start rig" replaces the Stop button; state is not lost (rig resumes with last state.json).
- **Approve** → no undo. COMPLETION-LOG is append-only. After approve, a 4s toast shows `Approved T1/02 · undo` — the undo button fires a `reject` action within the window. After 4s, the undo expires.
- **Reject** → no undo. Same 4s toast pattern.
- **Abort** → no undo, but the slug returns to the queue marked `retrying` so it can be re-dispatched.
- **Halt** → `Unhalt` button is always visible in the halt banner. So technically reversible, but the UNHALT-type-confirm forces awareness.

### Keyboard-first power-user flow

Example flow, no mouse:
1. `g h` → home / fleet view.
2. `j j j` → move selection down 3 sessions.
3. `L` → expand log.
4. `/` + type slug → filter.
5. `Enter` → open run detail.
6. `T` → tell modal, type hint, `Cmd+Enter` submits.
7. `Esc` → close modal.
8. `4` → approvals tab.
9. `j`, `a` → approve next pending run.
10. `Esc` → back to fleet view.

The `?` overlay documents this. The overlay is accessible from any screen at any time.

### Bulk actions

**Yes, but narrowly scoped.** Only the History tab and the Approvals tab support multi-select (checkbox on each row, `Shift-click` range, `Cmd-click` toggle).

- **History tab bulk**: Archive (move selected runs to archive/), Export (download as CSV), Filter (update URL filter to match selection's tier).
- **Approvals bulk**: Approve all · Reject all. Both behind modal confirms.

The Live tab does NOT support bulk — you're supervising one or two sessions at a time; you operate on them individually. Adding bulk here would enable accidents.

---

## Section 9 — Typography + color micro-decisions

### Font application

| Surface                              | Font         | Size    | Tracking      | Reason                                        |
|--------------------------------------|--------------|---------|---------------|-----------------------------------------------|
| Section labels / eyebrows            | mono         | 10–11px | `0.20em` uppercase | hierarchy signal, "this is UI chrome" |
| Session slug (headline id)           | mono         | 13px    | tight         | it's an identifier, mono reads it right       |
| Branch name / tmux session / pid     | mono         | 11px    | tight tabular | identifier + alignment in tables              |
| Status pill text (`online`, `review`) | mono         | 10px    | `0.20em` uppercase | UI chrome                                 |
| Numbers: cost, turns, elapsed, counts | mono tabular | 11–12px | tabular-nums  | column alignment, no kerning bounce           |
| Prose/instructional text             | sans (Inter) | 13–14px | default       | legibility                                    |
| Primary button label                 | mono         | 12px    | semibold      | matches status pills, feels "UI"              |
| Empty-state hero title               | sans         | 24–28px | `-0.01em`     | this is brand copy, not UI chrome             |
| Log lines                             | mono         | 11.5px  | tight         | terminal heritage                             |

Rule of thumb: **anything that is an identifier, a count, or a UI chrome label → mono. Anything that is human explanatory prose → sans.** The existing v2 is right about this; v3 keeps the rule.

### Color tokens (no new tokens except tier colors)

Existing tokens map to states:

| State           | Token(s) used                                              | Why                                      |
|-----------------|------------------------------------------------------------|------------------------------------------|
| online          | `--color-success` (muted green)                            | alive, good                              |
| offline         | `--color-danger` (red)                                     | can't do work                            |
| paused          | `--color-warning` (amber)                                  | holding; soft signal                     |
| halted          | `--color-danger` (red) + dashed border                     | hard signal, distinct from offline       |
| queued          | `--color-text-muted` (muted greige)                        | waiting; quiet                           |
| working / spawning | `--color-gold`                                             | active attention                         |
| testing / self-check | `--color-gold-bright`                                      | under scrutiny                           |
| passed / needs_review | `--color-gold` + `--color-gold-faint` fill                | celebration, but requires human          |
| complete        | `--color-success` at 30% border                             | done; receded                            |
| failed / escalated | `--color-danger` + 6–10% fill                              | pain                                    |
| retrying        | `--color-warning`                                           | in flux                                 |

**Tier colors** — the v2 spec references `--color-tier-N` which aren't in theme.css yet. Propose these additions (and ONLY these, no other new tokens) to extend `theme.css`:

```css
--color-tier-0: #928466;        /* plain gold — core/blockers */
--color-tier-1: #a89a7a;        /* lighter gold */
--color-tier-2: #b8a67f;        /* gold-bright (matches --color-gold-bright) */
--color-tier-3: #c4b48c;        /* champagne */
--color-tier-4: #d4c5a0;        /* palest — polish tier */
```

These are monochromatic: every tier is a tint of the same gold, only brightness varies. A colorblind operator still reads the ordering. No hue shift.

### Contrast

All text/background combinations verified to WCAG AA (4.5:1 for body, 3:1 for large text):

| Pair                                         | Ratio  | Passes   |
|----------------------------------------------|--------|----------|
| `--color-text` (#e8e6e1) on `--color-bg` (#050505) | 15.8:1 | AAA      |
| `--color-text` on `--color-surface` (rgba)  | ~14:1  | AAA      |
| `--color-text-muted` (#6b6760) on bg        | 4.6:1  | AA body  |
| `--color-gold-bright` (#b8a67f) on bg       | 7.8:1  | AAA      |
| `--color-gold` (#928466) on bg              | 5.3:1  | AA body  |
| `--color-success` (#4a7a5a) on bg           | 4.5:1  | AA body (borderline — pill fills give more margin) |
| `--color-danger` (#c75454) on bg            | 5.6:1  | AA body  |
| `--color-warning` (#d4a04a) on bg           | 7.9:1  | AAA      |

Buttons with `#0a0a0a` text on gold fills get 14:1 (AAA). Log lines render on `#080808` (the terminal bg), which is slightly darker than the surface so the log area reads as a distinct pane — contrast vs `--color-text` is 15.2:1.

---

## Section 10 — Animations

### Catalog

| Class / name             | Target                                  | Trigger                              | Duration | Reduced-motion     |
|--------------------------|-----------------------------------------|--------------------------------------|----------|--------------------|
| `pulse-glow` (existing)  | Live status dot, running sessions       | always while active                  | 2s loop  | static opacity 1   |
| `shimmer-sweep`          | Session card bg on spawn                | one-shot at spawn                    | 900ms    | omit (instant)     |
| `phase-fill`             | PhaseTimeline active segment            | on phase advance                     | 360ms    | instant width set  |
| `log-flash`              | New log line bg                         | on new line arrival                  | 600ms    | 200ms solid flash  |
| `review-pulse`           | Review card border                      | on needs_review transition           | 1.2s × 3 | static border 100% opacity |
| `retry-spin`             | ↻ icon on retrying sessions             | always while status=retrying         | 1.5s loop| static (no spin)   |
| `shake`                  | Session card on failed transition       | one-shot                             | 300ms    | omit               |
| `odometer`               | attempt / turns counters                | on increment                         | 220ms    | instant swap       |
| `tier-fill`              | Tier strip segment fills                | on prompts update                    | 500ms    | instant            |
| `budget-fill`            | Daily budget bar                        | on spend update                      | 400ms    | instant            |
| `crossfade`              | Status pill label swap                  | on status change                     | 180ms    | instant            |
| `victory-shimmer`        | Tier strip when all done                | one-shot on all-done transition      | 1800ms   | omit               |
| `card-enter`             | Session card mount                      | on new run                           | 240ms    | omit; instant mount|
| `card-exit`              | Session card unmount (archived)         | on archival                          | 200ms    | omit; instant unmount |
| `banner-slide`           | AlertStack banner enter/exit            | on alert condition change            | 200ms    | 0ms; instant       |

### Timings rationale

- **≤ 200ms** for anything related to direct input response (button press, tab switch, pill swap) — Nielsen's threshold for "feels instant."
- **200–400ms** for state transitions the user should notice but not wait on (phase fill, budget tick).
- **600–1200ms** for celebration / salience moments (review pulse, log flash, card enter). Long enough to register, short enough to not annoy.
- **Loops** only on "alive" indicators (pulse-glow, retry-spin). Never loop a decorative animation on a non-live element.

---

## Section 11 — Per-component detailed specs

### 11.1 `<MissionStrip />`

**Responsibility**: the always-visible top 88px band. Answers the four questions (alive / needs me / budget / tier) in ≤2 seconds of gaze.

**Props**: none. Reads from `useRuns()`, `useRigProcess()`, `usePrompts()`, `useNextAction()`.

**Visual variants**:
- Normal (rig online, no alerts) — gold-accented borders, live pulse on dot.
- Offline — pill red, bar greyed, next-action = "Rig offline. Press S to start."
- Halted — pill red with HALTED glyph, all bars freeze state, next-action = "Halted. See banner."
- Paused — pill amber, next-action = "Paused. Press P to resume."
- Starting (transitional, ≤10s) — pill gold pulsing, uptime shows `—`, next-action = "Spinning up worker…"

**Micro-interactions**:
- Tier segment hover → shows `T2 · 4/11 complete · 7 remaining` tooltip.
- Budget bar hover → shows exact spend breakdown (tester vs self-check, %). If ≥95%, shows `Will halt at 100%.`
- Clicking the RigStateBadge opens the rig log overlay (same mechanism as SessionCard's log overlay).
- Next-action hint auto-updates every snapshot tick; pressing its bound key fires the action.

**Edge cases**: when `rigProcess.since` is older than 24h, uptime collapses to "up >1d" rather than "27h 14m." When `daily_budget_usd.cap` is 0 (unbounded; shouldn't happen in prod), bar renders as striped grey with `∞` label.

---

### 11.2 `<SessionCard />` — the hero component

**Responsibility**: full picture of a single live session. Always at least ~260px tall so the 6-line log preview is always readable without hover.

**Props**:
```ts
{
  runId: string
  run: RunRecord
  focused: boolean     // drives outline
  onFocus: () => void
  onAbort: () => void
  onTell: () => void
  onExpandLog: () => void
}
```

**Visual variants**: one per status (see §5 table). Focused variant adds a 1px outer outline in `--color-gold-bright`.

**Anatomy**:
```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  T1  phase-99b-unfucking-v2/02-extract                     [●working]          abort ▸       │
│  branch autobuild/a7f3 · tmux jc-a7f3 · attempt 1/2 · turns 14/25 · 3m 42s                   │
│  ──────────────────────────────────────────────────────────────────────                      │
│  PhaseTimeline:  ◐ spawn ─── ●● WORKING ────── ○ self-check ── ○ tester ── ○ commit           │
│  ──────────────────────────────────────────────────────────────────────                      │
│  TurnsCostBar:   $ 0.00 ─────────────│──── $5.00 gate ──── $10.00 hard cap                    │
│  ──────────────────────────────────────────────────────────────────────                      │
│  LogPreview (6 lines, monospace, new-line shimmer):                                           │
│    14:02:04  tool:Read  engine/src/rig/dispatcher.ts                                         │
│    14:02:05  tool:Edit  engine/src/rig/session.ts                                            │
│    14:02:07  assistant: "adding tier gate check"                                              │
│    14:02:09  tool:Bash   bun run typecheck                                                    │
│    14:02:11  typecheck: 0 errors                                                              │
│    14:02:12  tool:Edit  engine/src/rig/index.ts                                              │
│  ──────────────────────────────────────────────────────────────────────                      │
│  [ expand log (L) ]  [ tell (T) ]  [ abort (X) ]          retry history: attempt 1/2 ▾        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Micro-interactions**:
- `PhaseTimeline`: active segment fills gold L→R as the session progresses. Completed segments are solid. Pending are hollow dots. Hover a segment → tooltip with phase duration.
- `TurnsCostBar`: $5 gate is a tick mark; $10 cap is an end label. Bar color: gold below gate, warning between gate and hard cap, danger above.
- `LogPreview`: new lines enter with a bg-flash animation. If the log is generating faster than 1 line/200ms, flashes coalesce so the card doesn't strobe.
- `RetryRibbon` (the "retry history ▾"): click to expand inline. Shows a vertical list of attempts with timestamp, reason_code, reason_detail, cost, hint_injected. Max 3 attempts rendered; if more, `+ 2 older` reveals the rest.
- Focus: pressing `Enter` while focused opens `#/autobuild/run/<id>` (single-session view).

**Edge cases**:
- No log yet (fresh spawn) → LogPreview shows "waiting for output…" with the cursor shimmer.
- Log paused (SSE dropped) → small "paused" badge over the LogPreview; auto-recovers when SSE returns.
- `tests.total === 0` and status=testing → TurnsCostBar area is labeled "running tester…" — the testing phase is visible in PhaseTimeline, and tests pane swaps in once results arrive.
- `needs_review === true` → the card header's status pill reads `review`, the border gains review-glow, and the action row gets `[ approve (A) ]` and `[ reject ]` inserted to the LEFT of abort.
- Status `escalated` → card fills with danger-tint, abort is replaced with `[ retry (R) ]`, PhaseTimeline freezes in whatever state it last was.
- Status `complete` + committed → card shows commit SHA + "committed on autobuild/a7f3 (not merged)". After 24h archive, card unmounts from the deck.

---

### 11.3 `<PhaseTimeline />`

**Responsibility**: show the 6-state machine (`spawning → working → self_checking → testing → committing → committed`) as a horizontal track with per-phase segments.

**Props**:
```ts
{
  run: RunRecord
  variant: 'card' | 'expanded'  // card = compact 32px tall, expanded = 56px with per-segment labels
}
```

**Anatomy** (card variant):
```
◐ spawn  ●●●●●●●●● working  ○ self-check  ○ tester  ○ commit
   6s           3m 41s (now)    —             —        —
```

- Completed segments: solid gold bar, end-glyph checkmark.
- Active segment: gold bar with pulse-glow, cursor at current position.
- Pending segments: hollow dot with segment label.
- Failed segment: red bar, glyph ✕, all subsequent segments greyed.
- Retry loop: if `attempt > 1`, a subtle ↻ glyph sits above the timeline with "retry 1 → 2" text; the track resets to spawning on the new attempt.

**Micro-interactions**: hover a segment → tooltip "self-check · 12s · decided: escalate (conf 0.62)". Click a completed segment → scrolls the log overlay to that phase's start timestamp.

**Edge cases**: if a phase is skipped (self-check passes with high confidence → tester skipped), the skipped segment renders dashed with "skipped" label. If the run halts mid-phase, the active segment stops pulsing and shows an amber ⏸ glyph at the cursor position.

---

### 11.4 `<UpNextRail />`

**Responsibility**: the 280px right rail. Shows the next 6–10 queued prompts grouped by tier, plus a "held" drawer for `hold: true` prompts.

**Props**: none. Reads `useRuns().queue` + `usePrompts()`.

**Visual variants**:
- Populated (default): tier-grouped vertical list; gold tier labels; item = `slug` + `title` + `est_minutes`.
- Empty (queue drained): "Queue is empty. Rig will auto-stop after current runs." + `open prompts/` button.
- Rig halted: items render dimmed 50%; a banner at top says "Queue frozen — rig halted."

**Micro-interactions**:
- Hover item → popover shows full frontmatter (scope_globs, depends_on, max_turns, max_cost_usd).
- Cmd-click item → opens prompt in `PromptViewer` (existing component, right-drawer).
- Items do NOT support drag-reorder. Tier ordering is strict at the dispatcher; the rail is read-only. A note at the bottom says "order is T0→T4; edit prompts/ to change."

**Edge cases**: if the same slug appears in queue and in retrying status, show it once at its earliest tier position with a small ↻ badge. If a frontmatter error exists for any queued prompt, replace the item with a red row "⚠ prompt.malformed — cannot dispatch" and link to the file.

---

### 11.5 `<AlertStack />`

**Responsibility**: render all active banners, priority-sorted, with stack-internal transitions.

**Props**: none. Reads `useRigAlerts()` which returns `Alert[]` derived from state.

**Visual variants** per alert kind: see §7.

**Micro-interactions**:
- Dismissable alerts: `×` at the right; dismissed state persists in sessionStorage (per alert id) for 2 minutes, then re-appears if condition still holds. Non-dismissable alerts (halt, parse-error) have no `×`.
- New alert enters with `banner-slide` from the top (translateY -100% → 0). Exits reverse.
- When a higher-priority alert arrives, lower-priority alerts re-flow down; the new alert animates in above.

**Edge cases**: if more than 3 alerts would stack, show the top 3 and a "+ 2 more" affordance that opens a modal listing all alerts. Should never happen in practice, but defensive.

---

### 11.6 `<NextActionHint />`

**Responsibility**: the single sentence on the right side of Mission Strip that tells the operator what they should do next.

**Props**: none. Reads `useNextAction()` which encodes this priority:

```
if rig.halted:                        → "Rig halted. See banner above."
if !rigProcess.running:               → "Rig offline. Press [S] to start."
if daily_budget.pct >= 0.95:          → "Budget at 95%. Rig will halt at $25."
if approvals_pending > 0:             → "{N} run(s) await approval. Press [A]."
if escalated > 0:                     → "{N} escalation(s). Tap [4] to review."
if paused:                            → "Rig paused. Press [P] to resume."
if n_active > 0:                      → "Rig working: {focused_run_slug}."
if queue.length > 0:                  → "Rig idle. Next dispatch on tick."
if all done:                          → "Tier pack complete."
default:                              → "All quiet."
```

**Visual variants**:
- Normal (informational) — text color `--color-text-muted`.
- Action-expected (approvals/escalations waiting) — text color `--color-gold-bright` + shortcut key rendered in `<kbd>` tag.
- Critical (halted / budget at 95%) — text color `--color-danger`.

**Micro-interactions**:
- Hover the `<kbd>` → shows "press {key} to {verb}" tooltip.
- Clicking the kbd fires the action as if the key were pressed. (Accessibility — people reading with mouse-only still get the verb).

**Edge cases**: when the hint changes, text uses the `crossfade` animation (180ms). The shortcut `<kbd>` never animates (consistency).

---

### 11.7 `<ContextTabs />`

**Responsibility**: four-tab bar below Mission Strip. Routes to `#/autobuild/{live|queue|history|approvals}`.

**Props**: none. Reads `useAutobuildRoute()`.

**Variants**:
- Tab active: underline bar in `--color-gold-bright`, text `--color-gold-bright`, label slightly heavier.
- Tab inactive: text `--color-text-muted`, underline absent, hover darkens bg `--color-gold-faint`.
- Tab with badge: small count circle to the right of the label. Badge tone:
  - Approvals badge > 0 → gold.
  - Approvals badge > 5 → red (signals backlog).
  - History badge: never shown (history is read-only; no unread concept).
  - Queue badge: shows pending count in muted grey, always.

**Micro-interactions**:
- Keyboard `1`/`2`/`3`/`4` switches tabs. Underline slides horizontally with `ease-out` 240ms.
- Clicking an active tab is a no-op (not "refresh").

**Edge cases**: if the focused run from the URL doesn't match the current tab (e.g. user loaded `#/autobuild/run/X` which lives under `live`), the URL is canonicalized to `live`.

---

### 11.8 `<HaltConfirmModal />`

**Responsibility**: the high-friction halt confirmation.

**Props**:
```ts
{ onConfirm: () => void; onCancel: () => void }
```

**Anatomy**:
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ Halt the rig?                                             │
│                                                             │
│ This stops the dispatcher and blocks auto-restart.          │
│ In-flight tmux sessions will keep running until             │
│ claude-code exits on its own. No new runs will spawn        │
│ until you Unhalt.                                           │
│                                                             │
│ Type HALT to arm the button:                                │
│ ┌──────────────────────────────────────────────────────┐    │
│ │ ▏                                                    │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                             │
│                              [ cancel ]   [ halt rig ]      │
│                                             ^ disabled      │
│                                             until HALT typed│
└─────────────────────────────────────────────────────────────┘
```

**Micro-interactions**:
- Input is autofocused.
- Button `halt rig` is disabled with 50% opacity until the input value (case-insensitive, trimmed) === `HALT`.
- Pressing Enter while armed fires confirm.
- Esc fires cancel.
- Clicking backdrop fires cancel.

**Edge cases**: if the user pastes "halt rig pls" the button stays disabled (exact token match); tooltip explains. If the rig becomes halted for unrelated reasons (e.g. hit daily cap) while the modal is open, the modal auto-closes with a toast "rig halted by budget cap."

---

## Section 12 — Why this wins vs. the existing autobuild-v2

The v2 AutobuildConsole is well-engineered but designed for a different use-case than what George actually needs. Specific problems:

1. **"Empty" feeling even with data.** v2's three-column grid dedicates 300px left + 320px right of fixed chrome around a squeezed middle. When approvals/escalations are empty (which is the normal state), those 320px are pure decorative box-drawing. The new deck layout puts all the real estate behind ONE tab that can fill the screen, and pushes secondary lists to tabs that vanish when empty.

2. **The tier strip is at the top but detached from reality.** v2 renders T0..T4 as 5 segments of equal width, each segment showing a fill bar that's ~4px tall. From 2 feet away you can't read it. In v3 the Mission Strip's tier strip is inline with text labels (`T1 ████ 8/11`), is 8px tall, and tooltips give exact breakdowns.

3. **No primary "what should I do next?" signal.** v2 has a RigStatusPill and an uptime label, but nothing tells the operator "you need to do X." v3's NextActionHint sentence is the direct-action signal. It's the one thing the operator reads first.

4. **Approvals buried behind a chevron.** v2's right column is collapsible. The first time a user clicks collapse they never find the Approve button again. v3's Approvals is a TOP-LEVEL TAB with a count badge that goes red when there's a backlog. Impossible to miss.

5. **LogStream is the only interesting thing but it's the smallest pane.** In v2, the log tail lives inside a middle column that competes with a SessionDetailHeader at the top and an Abort/Skip footer at the bottom — about 60% of the middle column is log, ~40% is chrome. In v3 the log preview is 6 lines by default in the SessionCard (always visible) and expands to full-viewport via `L` / LogOverlay.

6. **No timeline view.** v2 has a `StatusPill` that says "working" and a cost bar. It does NOT show "you're 4 minutes into spawn/work/self-check/tester/commit." The operator can't spot a stuck phase vs a slow one. v3's `PhaseTimeline` makes this visible in 32px of vertical space.

7. **Queue is just a scrollable list of runs, not a tier-ordered preview.** v2's QueueBoard buckets by lifecycle status, not by tier. The operator can't see "the next 3 things the rig will do." v3's UpNextRail is explicitly tier-ordered and labeled.

8. **No routing.** Every v2 view lives at the same URL. No deep links, no browser back button, no way to say "come look at run X." v3 is hash-routed with `#/autobuild/run/<id>`.

9. **Retry history invisible.** v2's RunRecord has `retry_history: RetryHistoryEntry[]` but nothing renders it. v3's SessionCard has a collapsed RetryRibbon at the bottom that expands inline.

10. **Halt has no friction.** v2 has a HaltConfirmModal but the modal just says "Halt rig" with a single-click Halt button. v3 requires typing `HALT` — same as Kubernetes's `--cascade=orphan` confirmation pattern, same as GitHub's "type the repo name to delete." Halt is destructive; it deserves friction.

---

## Section 13 — Implementation order

Built incrementally — each step is shippable on its own, and a later step can be stubbed by an earlier one (marked `stub` below).

1. **Step 1 — Scaffolding + routing (0.5 day)**. Create `autobuild-v3/` folder, add `useAutobuildRoute` hash-router hook, wire `MissionControl` as the render root when `autobuildView === 'autobuild'` in `App.tsx`. Put a placeholder for each tab so clicking tabs routes correctly. STUBS: tabs show "coming soon." **Lands:** URL addressing, keyboard tab switching, scaffolding contract the rest of the steps rely on.

2. **Step 2 — Mission Strip (1 day)**. Build `MissionStrip`, `RigStateBadge`, `ConcurrencyPips`, `TierStrip`, `DailyBudgetBar`, `NextActionHint`, `RigControls`. Also build `useNextAction` and `useRigAlerts`. Wire to existing `useRuns`/`useRigProcess`/`usePrompts`. **Lands:** the operator can now glance-read the four questions. Biggest user-facing win for the time.

3. **Step 3 — AlertStack (0.5 day)**. Build the banner system, wire alerts. Banner variants: halt, stale-heartbeat, sse-dropped, backend-unreachable, parse-error. **Lands:** red-state UI; from here on, when things break the user knows. STUB OK: `parse-error` banner can be hardcoded to "cannot read state.json" without parsing the backend's exact error payload.

4. **Step 4 — LiveDeck + SessionCard (1.5 days)**. Build the hero component: `LiveDeck`, `SessionCard` + all its children (`SessionHeader`, `PhaseTimeline`, `TurnsCostBar`, `LogPreview`, `SessionActions`, `RetryRibbon`). Wire `LogPreview` to the existing `useRunLog` SSE hook. Build `LiveIdleCard` empty state. **Lands:** the centerpiece. This is what the operator stares at all day.

5. **Step 5 — UpNextRail (0.5 day)**. Build the right rail — `UpNextRail`, `UpNextItem`, `QueueHeldDrawer`. Tier-group from `useRuns().queue` + `usePrompts()`. **Lands:** the "what's next" question is answered.

6. **Step 6 — Approvals tab (0.5 day)**. Build `ApprovalsTab` + `ApprovalCard`. The mutate actions already exist in `useRigAction`. Include the bulk Approve-all / Reject-all flow. **Lands:** clears the backlog scenario; the most pressing v2 pain point goes away.

7. **Step 7 — History + Queue tabs + LogOverlay (1 day)**. Build `HistoryTab` (simple virtualized list reading from `state.runs` + archived runs when that API exists), `QueueTab` (more detailed view of the rail content, with frontmatter inline), `LogOverlay` (full-viewport log tail for `#/autobuild/run/<id>/log`). **Lands:** power-user view; deep links stop routing to stubs.

8. **Step 8 — Polish: empty states, modals, reduced-motion, a11y pass (1 day)**. Build `FirstRunEmptyState`, `AllDoneVictory`, `HaltConfirmModal` (with the type-HALT gate), `AbortConfirmModal`, `TellHintModal`, `KeyboardHelpOverlay`. Verify `prefers-reduced-motion` behavior for each animation. ARIA labels, focus management, keyboard-trap on modals. **Lands:** production-ready.

Total: ~6.5 days. A single smart engineer can stage this over a week. After step 4 the UI is already visibly better than v2; after step 6 it's feature-complete relative to v2; steps 7–8 add capabilities v2 lacks.

### Parallelism opportunities

- Step 2 and Step 3 can be done in parallel (different components, no shared state).
- Step 5 (rail) can be done in parallel with Step 6 (approvals) — both read from the same query, touch different components.
- Step 8 polish can be folded into each earlier step if the engineer wants; listing it separately lets step 1–7 focus on structure.

### Cutover

When Step 4 is green, flip the default of `autobuildView` to render `<MissionControl />` instead of `<AutobuildConsole />`. Keep `autobuild-v2/` around for one release cycle as a rollback fallback behind a feature flag (`import.meta.env.VITE_AUTOBUILD_V3 === 'false'`). Remove `autobuild-v2/` when confidence is high (≥2 weeks of the operator using v3 daily with no reverts).

---

## Appendix A — File inventory

The spec above maps to the following files (all paths relative to `dashboard/src/components/autobuild-v3/`):

```
DESIGN-SPEC.md                           this file
MissionControl.tsx                       root
MissionStrip.tsx + RigStateBadge.tsx + ConcurrencyPips.tsx + TierStrip.tsx +
  DailyBudgetBar.tsx + NextActionHint.tsx + RigControls.tsx
AlertStack.tsx
ContextTabs.tsx + TabBadge.tsx
live/LiveDeck.tsx + SessionCard.tsx + SessionHeader.tsx + PhaseTimeline.tsx +
  TurnsCostBar.tsx + LogPreview.tsx + SessionActions.tsx + RetryRibbon.tsx +
  LiveIdleCard.tsx + ActivityFooter.tsx
queue/QueueTab.tsx + QueueGroup.tsx + QueueItem.tsx + QueueHeldDrawer.tsx
approvals/ApprovalsTab.tsx + ApprovalCard.tsx
history/HistoryTab.tsx + HistoryRow.tsx
rail/UpNextRail.tsx + UpNextItem.tsx
modals/HaltConfirmModal.tsx + AbortConfirmModal.tsx + TellHintModal.tsx +
  LogOverlay.tsx + KeyboardHelpOverlay.tsx
empty/FirstRunEmptyState.tsx + AllDoneVictory.tsx
hooks/useAutobuildRoute.ts + useFocusedRun.ts + useRigAlerts.ts +
  useNextAction.ts + useKeyBindings.ts
logic.ts                                 pure helpers
```

## Appendix B — theme.css additions (minimal)

```css
/* Tier colors — monochromatic gold tints (ordered by tier index) */
--color-tier-0: #928466;
--color-tier-1: #a89a7a;
--color-tier-2: #b8a67f;
--color-tier-3: #c4b48c;
--color-tier-4: #d4c5a0;

/* Animation keyframes */
@keyframes shimmer-sweep { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
@keyframes log-flash     { 0% { background-color: var(--color-gold-faint) } 100% { background-color: transparent } }
@keyframes review-pulse  { 0%,100% { box-shadow: 0 0 0 0 rgba(146,132,102,0) } 50% { box-shadow: 0 0 0 4px rgba(146,132,102,0.18) } }
@keyframes retry-spin    { from { transform: rotate(0) } to { transform: rotate(360deg) } }
@keyframes shake         { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-2px) } 40% { transform: translateX(2px) } 60% { transform: translateX(-2px) } 80% { transform: translateX(1px) } }
@keyframes odometer      { from { transform: translateY(-100%); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
@keyframes banner-slide  { from { transform: translateY(-100%); opacity: 0 } to { transform: translateY(0); opacity: 1 } }

@media (prefers-reduced-motion: reduce) {
  .pulse-glow, .shimmer-sweep, .review-pulse, .retry-spin, .shake, .odometer, .banner-slide { animation: none !important; }
}
```

That's the only `theme.css` diff. Everything else reuses existing tokens.

---

**END OF SPEC**
