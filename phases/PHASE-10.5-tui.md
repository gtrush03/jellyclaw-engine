---
phase: 10.5
name: interactive-terminal-tui
duration_estimate: 4-5 hours
depends_on: [10]
blocks: [11]
status: complete
completed: 2026-04-15
---

# Phase 10.5 — Interactive terminal TUI ✅

## Dream outcome

`jellyclaw tui` launches a Claude-Code-shaped interactive terminal UI — streaming tokens, tool-call cards, inline diff viewer, slash-command palette, permission prompts, session picker — backed entirely by `@jellyclaw/engine`. It feels like Claude Code, wears jellyclaw's purple + jellyfish branding, and shares one engine with the CLI, HTTP server, and library paths.

## Why this phase exists

Phase 10.01 shipped a headless, pipe-friendly CLI (`--output-format stream-json`). That serves Genie Phase 12 dispatchers and CI well, but humans (and the Phase 12 Genie handoff) need a real interactive terminal. Building one in Ink from scratch burns weeks. OpenCode already detached its TUI into a stand-alone TypeScript/Solid package (MIT-licensed, `opencode/packages/opencode/src/cli/cmd/tui/`). Forking + rebranding + repointing its SDK at jellyclaw's engine server is dramatically faster and inherits every interaction pattern OpenCode spent a year polishing.

## Non-goals

- NOT building a TUI from scratch (Ink, Blessed, Textual, etc.).
- NOT replacing the Phase 15/16 desktop dashboard web UI.
- NOT supporting Windows native PowerShell in this phase — macOS, Linux, and WSL2 only.
- NOT shipping new engine features — the TUI consumes existing `@jellyclaw/engine` events only.
- NOT forking OpenCode's engine, providers, or server — TUI layer only.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ user terminal                                               │
│   $ jellyclaw tui                                           │
└────────────┬────────────────────────────────────────────────┘
             │ spawn + attach
             ▼
┌─────────────────────────────────────────────────────────────┐
│ jellyclaw tui (engine/src/cli/tui.ts)                       │
│   1. boots engine server on 127.0.0.1:<random-port>         │
│   2. mints per-session Bearer token                         │
│   3. execs the forked TUI with JELLYCLAW_URL + token env    │
│   4. forwards SIGINT/SIGTERM → teardown                     │
└────────────┬────────────────────────────────────────────────┘
             │
    ┌────────┴────────┐
    ▼                 ▼
┌─────────┐   ┌───────────────────────────────────┐
│ Engine  │   │ Forked TUI (engine/src/tui/)      │
│ server  │   │   OpenTUI + Solid renderer        │
│ (Hono,  │◄──┤   SDK adapter → engine HTTP+SSE   │
│ Ph.10)  │   │   purple theme + jellyfish spin.  │
└─────────┘   └───────────────────────────────────┘
```

The TUI is a sibling of the CLI and HTTP server — all three are thin clients of `Engine`. The TUI never imports engine internals; it talks to the engine exclusively over the HTTP+SSE surface that Phase 10.02 already ships.

## Deliverables

- `engine/src/tui/` — vendored + rebranded OpenCode TUI (Solid + OpenTUI)
- `engine/src/tui/sdk/jellyclaw-client.ts` — thin SDK adapter wrapping Phase 10.02's HTTP+SSE API in the shape OpenCode's TUI expects
- `engine/src/tui/theme/jellyclaw.json` — purple-primary color palette
- `engine/src/tui/assets/jellyfish-spinner.json` — animated spinner frames (honors reduced-motion)
- `engine/src/cli/tui.ts` — `jellyclaw tui` subcommand (spawn engine + attach TUI + teardown)
- `engine/bin/jellyclaw-tui` — optional direct entry (for power users who already have an engine running)
- `docs/tui.md` — user guide: keybindings, slash commands, config
- `test/tui/*.test.ts` — vitest suite (boot/teardown + dialog snapshots)
- Dashboard + phase-index updates so Phase 10.5 appears in STATUS, COMPLETION-LOG, README

## Prompts in this phase (run in order)

| # | File | What it does | Time | Status |
|---|------|--------------|------|--------|
| 01 | `prompts/phase-10.5/01-vendor-tui.md` | Fork OpenCode TUI into `engine/src/tui/`, write the SDK adapter, rebrand copy strings | 1.5 h | ✅ |
| 02 | `prompts/phase-10.5/02-jellyfish-theme.md` | Spinner frames + `jellyclaw.json` theme + purple primary + reduced-motion support | 1 h | ✅ |
| 03 | `prompts/phase-10.5/03-tui-command.md` | `jellyclaw tui` subcommand — spawn engine, mint token, attach, tear down on exit | 1 h | ✅ |
| 04 | `prompts/phase-10.5/04-docs-dashboard.md` | Insert Phase 10.5 in phase index, widen dashboard regex, update tests + docs | 0.5-1 h | ✅ |

### Prompt checklist

- [x] ✅ Prompt 01 — Vendor TUI + SDK adapter + CLI rewire + rebrand + docs (see [`COMPLETION-LOG.md`](../COMPLETION-LOG.md) → Phase 10.5)
- [x] ✅ Prompt 02 — Jellyfish spinner + `jellyclaw.json` purple theme + reduced-motion (see [`COMPLETION-LOG.md`](../COMPLETION-LOG.md) → Phase 10.5)
- [x] ✅ Prompt 03 — `jellyclaw tui` subcommand (engine spawn, token mint, live render loop, signal forwarding, teardown)
- [x] ✅ Prompt 04 — Docs + dashboard (phase regex widen, denominator bump to 21, `docs/tui.md` polish, Phase 10.5 close-out)

Always open a fresh Claude Code session per prompt. Mark each ✅ in `COMPLETION-LOG.md` before starting the next.

## Key sources to read

- **OpenCode TUI upstream (fork target):** `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/` — this is what we vendor. License: MIT.
- **Jellyfish spinner spec:** `/Users/gtrush/Downloads/jellyclaw-engine/jellyfish-spinner-spec.txt` — frame glyphs, cadence, reduced-motion behavior.
- **Phase 10.02 HTTP API:** `engine/src/server/http.ts` — the surface the TUI SDK adapter wraps.
- **`docs/ARCHITECTURE.md`** — confirms the one-Engine-three-entry-points pillar the TUI slots into.

## Step-by-step overview

### Step 1 — Vendor and rebrand (prompt 01)

Copy the OpenCode TUI tree into `engine/src/tui/`. Strip OpenCode branding (logos, ASCII splash, product name in copy, help text, about dialog). Replace every `@opencode-ai/sdk` import with `@jellyclaw/engine/tui/sdk` — the local adapter. Preserve upstream file structure so future OpenCode TUI diffs are easy to cherry-pick. Keep the MIT notice in `engine/src/tui/LICENSE-OPENCODE`.

### Step 2 — SDK adapter (prompt 01 cont.)

Write `engine/src/tui/sdk/jellyclaw-client.ts` that exposes the exact method shape OpenCode's TUI calls (`client.session.create`, `client.session.chat`, `client.session.events`, etc.) but routes to Phase 10.02's `/run`, `/events/:id`, `/cancel/:id` endpoints with Bearer auth. Thin wire-compat layer, no business logic.

### Step 3 — Theme + spinner (prompt 02)

Ship `theme/jellyclaw.json` with `primary: #8B5CF6` (or whatever the brand purple lands on), neutrals tuned for dark terminals, accent + danger from the existing dashboard palette. Replace OpenCode's spinner with the jellyfish-spinner frames from the spec file. Honor `NO_COLOR`, `FORCE_COLOR`, and `--reduced-motion` — the spinner collapses to a single static glyph when reduced motion is requested.

### Step 4 — `jellyclaw tui` subcommand (prompt 03)

`engine/src/cli/tui.ts` registers the `tui` subcommand with Commander. Flow:
1. Resolve config via `loadConfig()` (Phase 10.03).
2. Pick a random free port on `127.0.0.1`.
3. Mint a Bearer token (crypto.randomUUID).
4. Boot the engine HTTP server in-process (reuse Phase 10.02's `serve()` rather than spawning a child — faster, simpler, one-process teardown).
5. Spawn the forked TUI with env: `JELLYCLAW_URL=http://127.0.0.1:<port>`, `JELLYCLAW_TOKEN=<token>`, `JELLYCLAW_THEME=jellyclaw`.
6. On TUI exit (any signal, clean or dirty) → shut down the HTTP server, flush SQLite WAL, exit with the TUI's code.
7. On `SIGINT`/`SIGTERM` at the parent → forward to TUI, wait up to 3 s, then hard-kill.

Flags:
```
jellyclaw tui
  --cwd <path>             # project root (default: cwd)
  --session <id>           # resume a session
  --continue               # resume latest session for cwd
  --model <id>             # provider model override
  --permission-mode <mode> # default|acceptEdits|bypassPermissions|plan
  --theme <name>           # jellyclaw | opencode (escape hatch)
  --no-spinner             # reduced-motion
```

### Step 5 — Docs + dashboard (prompt 04)

- Add Phase 10.5 row to `phases/README.md` phase table (between 10 and 11).
- Update the dependency ASCII to show `10 → 10.5 → 11`.
- Update `STATUS.md` + `COMPLETION-LOG.md` schemas to accept a dotted phase id (`10.5`); widen any phase-parsing regex (search for `/^\d+$/` or `/PHASE-\d+/` in repo scripts).
- Write `docs/tui.md`: install, launch, keybindings, slash commands, theming, troubleshooting.
- Update `README.md` top-level: add `jellyclaw tui` to the three entry points list (it's technically a fourth surface, but users think of it as "the interactive one").

### Step 6 — Tests (spread across prompts)

- `test/tui/boot.test.ts` — spawn `jellyclaw tui` with `--session-smoke` headless flag that exits after first render; assert engine server started + stopped cleanly.
- `test/tui/teardown.test.ts` — kill parent with SIGINT mid-render; assert no zombie engine server, no leftover `.wal` beyond threshold.
- `test/tui/sdk.test.ts` — SDK adapter talks to a mock `/run`+`/events` server; assert all OpenCode-expected methods resolve.
- `test/tui/snapshots/*.test.ts` — snapshot-render the key dialogs (welcome, tool-card, permission prompt, diff viewer, slash palette) using OpenTUI's headless renderer; snapshots live in `test/tui/__snapshots__/`.
- `test/tui/reduced-motion.test.ts` — assert spinner renders single static glyph when `--no-spinner` or `PREFERS_REDUCED_MOTION=1`.

## Acceptance criteria / Gate

- [ ] `jellyclaw tui` opens a Claude-Code-shaped TUI without errors on macOS + Linux.
- [ ] Jellyfish spinner animates on first stream token; collapses to static glyph under `--no-spinner`.
- [ ] Purple theme renders (no OpenCode orange remnants anywhere).
- [ ] Streaming, tool-call cards, permission prompts, slash palette, diff viewer, session picker all work end-to-end against the engine.
- [ ] `Ctrl-C` at the TUI exits cleanly with no orphaned engine process (`pgrep -f jellyclaw` returns nothing).
- [ ] `Ctrl-C` at the parent shell forwards to the TUI, which unwinds within 3 s.
- [ ] Reduced-motion honored via flag + env var.
- [ ] `bun run test test/tui` green.
- [ ] Phase 10.5 row visible in phase table + dashboard.
- [ ] No regression in Phase 10 tests.

## Risks + mitigations

- **SDK wire-compat drift** between OpenCode's TUI and our engine — OpenCode may change `client.session.*` method signatures.
  *Mitigation:* the adapter is ~200 lines of thin translation; pin OpenCode TUI commit in `engine/src/tui/UPSTREAM.md`; snapshot the SDK surface in `test/tui/sdk.test.ts` so drift fails tests loudly.
- **OpenTUI maintenance risk** — upstream library could stall.
  *Mitigation:* pin exact version in `package.json`; OpenTUI is small enough to vendor if it's ever abandoned.
- **Bun raw-mode TTY quirks on macOS** — known issue with stdin `setRawMode` under Bun < 1.1.x.
  *Mitigation:* require Bun `>=1.1.x` in `engine/package.json` engines; fall back to Node spawn for the TUI child if Bun raw-mode misbehaves (detected in `doctor`).
- **Vendored tree rot** — OpenCode TUI will drift upstream; we'll want future fixes.
  *Mitigation:* preserve upstream file structure; maintain `engine/src/tui/UPSTREAM.md` with commit SHA + last-synced date + cherry-pick notes.
- **License** — OpenCode is MIT.
  *Mitigation:* ship `engine/src/tui/LICENSE-OPENCODE` verbatim; add attribution to `docs/tui.md` and top-level `NOTICE`.

## Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run lint
bun run test test/tui
bun run build
./engine/bin/jellyclaw tui --cwd /tmp/test-project
# manual: send "hello"; observe spinner, streaming, tool card; Ctrl-C; confirm clean exit
pgrep -af jellyclaw    # expect: no matches
```

## Dependencies to add

```
@opentui/core@<pin>
@opentui/solid@<pin>
solid-js@<pin>
```

Exact pins captured in prompt 01 after reading upstream OpenCode's `package.json`.

## Files touched

- `engine/src/tui/**/*` (new vendored tree)
- `engine/src/cli/tui.ts` (new)
- `engine/src/cli/main.ts` (register subcommand)
- `engine/bin/jellyclaw-tui` (optional)
- `engine/package.json` (deps + bin entry)
- `test/tui/**/*` (new)
- `docs/tui.md` (new)
- `phases/README.md` (row insert)
- `README.md` (entry-points list)
- `STATUS.md`, `COMPLETION-LOG.md` (phase id handling)
