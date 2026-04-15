# Phase 10.5 — Prompts index

**Phase runbook:** [`phases/PHASE-10.5-tui.md`](../../phases/PHASE-10.5-tui.md)
**Depends on:** Phase 10 (all three prompts ✅)
**Blocks:** Phase 11
**Total estimated time:** 4–5 hours

Run these prompts in order. Always open a fresh Claude Code session per prompt. Mark each one ✅ in `COMPLETION-LOG.md` before starting the next.

## Prompt order

| # | File | What it does | Est. time |
|---|------|--------------|-----------|
| 01 | [`01-vendor-tui.md`](./01-vendor-tui.md) | Fork OpenCode's detached TUI into `engine/src/tui/`, write the `@jellyclaw/engine` SDK adapter, strip OpenCode branding, preserve upstream structure for future cherry-picks. | 1.5 h |
| 02 | [`02-jellyfish-theme.md`](./02-jellyfish-theme.md) | Ship `theme/jellyclaw.json` with purple primary + jellyfish-spinner frames from the spec. Honor `NO_COLOR`, `FORCE_COLOR`, `--reduced-motion`. | 1 h |
| 03 | [`03-tui-command.md`](./03-tui-command.md) | `jellyclaw tui` subcommand: boot in-process HTTP server, mint Bearer token, spawn TUI child with env, orchestrate clean teardown on any signal. | 1 h |
| 04 | [`04-docs-dashboard.md`](./04-docs-dashboard.md) | Insert Phase 10.5 into phase index + dashboard, widen any `/PHASE-\d+/` regexes to accept dotted ids, update `docs/tui.md` + top-level README, mark Phase 10.5 ✅. | 0.5–1 h |

## When to run each

- **01 — first.** Nothing else can land without the vendored tree + SDK adapter.
- **02 — after 01 ✅.** The theme hooks into the vendored OpenTUI renderer; it needs the tree in place.
- **03 — after 02 ✅.** The subcommand launches the themed binary; smoke test depends on real visuals.
- **04 — last.** Flips the phase complete, widens schema/regex, updates docs. This is the gate.

## Exit criteria

Phase 10.5 is complete when:

- `jellyclaw tui` opens a Claude-Code-shaped interactive TUI with jellyfish spinner + purple theme
- Streaming, tool cards, permission prompts, slash palette, diff viewer, session picker all work
- `Ctrl-C` tears down the in-process engine cleanly (no zombies, WAL flushed)
- Reduced-motion honored
- `bun run test test/tui` green
- Phase 10.5 row visible in `phases/README.md`, `STATUS.md`, and the dashboard

See the [phase runbook](../../phases/PHASE-10.5-tui.md) for the full acceptance checklist.
