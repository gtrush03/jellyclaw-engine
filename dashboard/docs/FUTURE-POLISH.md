# Future Polish — Deferred Ideas

The following polish ideas are deliberately **out of scope for the MVP** but
worth revisiting once the core dashboard is stable and users are actively
using it.

Each entry is sized roughly, ordered by expected impact-per-hour.

---

## High impact, low effort

### 1. Command palette (⌘K deep)

Today `⌘K` focuses the search bar. A proper command palette (fuzzy-match over
commands *and* prompts) would collapse most keyboard shortcuts into one
surface. Use [`cmdk`](https://cmdk.paco.me/) or build on top of `PromptSearch`.

Scope: ~4 hours. Include actions like "copy phase link", "jump to phase N",
"mark prompt complete".

### 2. Prompt notes (inline annotations)

Let the user leave private notes next to any prompt (what worked, what to
change next time). Persist to `.dashboard-notes/<phase>-<prompt>.md` so they
survive across runs and can be hand-edited.

Scope: ~6 hours. Needs a tiny markdown editor + filesystem write endpoint on
the backend.

### 3. Session time tracker

Start a timer when a prompt is opened, stop when the next one is opened. Emit
an "actual vs estimated" comparison at the end of each phase. Persist in
`~/.jellyclaw/sessions.jsonl`.

Scope: ~3 hours. Purely additive; no UI rework.

---

## Medium impact, medium effort

### 4. Timeline view (gantt-style)

A second tab that renders all 21 phases as horizontal bars on a timeline.
Shows overlap, sequencing, and real durations once we have tracker data.

Scope: ~8 hours. SVG rendering is fine; skip d3.

### 5. Analytics dashboard tab

Aggregate metrics across sessions: average time per phase, most-revisited
prompts, completion ratio, longest gaps. Not user-facing in MVP because we
have no data to aggregate yet.

Scope: ~6 hours, pending tracker.

### 6. Git commit graph per phase

If we're running inside a git repo, render commits scoped to each phase
(filtered by commit time between phase start and end). Gives a visual record
of what was built during that phase.

Scope: ~5 hours. Backend endpoint around `git log --since --until`.

### 7. Export progress report as PDF

Print-to-PDF works already via the print stylesheet, but a proper "Export"
button that produces a cleanly paginated PDF with every phase's status +
notes would be nice for sharing.

Scope: ~4 hours. Browser print job is enough; skip puppeteer unless we go
headless.

---

## Low impact / cosmetic

### 8. Ambient audio (very quiet)

Optional low-volume ambient pad playing while the dashboard is open. Off by
default. Mutes on blur.

Scope: ~2 hours. Web Audio is already wired in `src/lib/sounds.ts`.

### 9. Weather-tinted gold

Shift the gold warmth by ±5% depending on local weather via a cached API.
Pure cosmetic. Fun, easy to kill later.

Scope: ~3 hours. Gate behind a feature flag.

### 10. Konami code easter egg

A sparkle animation over the progress bar on the konami sequence. Cost:
nothing, value: nothing, fun: yes.

Scope: ~30 minutes.

---

## Rejected (do not build)

### ~~Light mode toggle~~

See `dashboard/docs/THEMING.md`. Obsidian & Gold is the theme. Closing this
issue on sight.

### ~~Inline AI chat assistant~~

Too easy to scope-creep into "dashboard that uses AI to explain AI prompts".
The dashboard is a *reader*. If someone wants to chat, they already have
Claude open in another tab.

### ~~Multi-user real-time collaboration~~

Jellyclaw is a single-operator tool running on `localhost`. Collaboration is
a product shift, not a polish ticket.

---

## Triage rule

Before adding anything new to this list, ask:

1. Does it make an **existing** reading session better, or add a new mode?
   (We want the former.)
2. Can it ship behind a feature flag so it's killable in one commit?
3. Will it still be valuable in 6 months, or is it a fad?

If the answers are yes / yes / yes, open a PR. Otherwise the idea stays in
this file and ages like a wine we might never drink.
