# Phase 99 — UNFUCKING

**Mission:** Make the engine actually power Genie. Replace `claude -p` with a working `jellyclaw` brain inside 2 weeks.

This phase exists because Phase 10.5 was marked complete but didn't ship the real thing. See `phases/PHASE-99-unfucking.md` for the full audit.

## Order of operations

```
01 ─→ 02 ─→ 03 ─→ ┬─→ 04 ─→ 07 ─→ 08
                  └─→ 05 ─→ 06
```

| # | Title | Depends on | Parallel-safe with |
|---|---|---|---|
| 01 | Provider→AgentEvent adapter | — | — |
| 02 | Real agent loop | 01 | — |
| 03 | Wire RunManager + mount /v1/runs/* + CLI uses real engine | 02 | — |
| 04 | Claude-Code-compat stream-json writer | 03 | 05, 06 |
| 05 | Demolish vendored OpenCode + slim TUI client | 03 | 04 |
| 06 | Ink TUI rebuild with paste-in API key | 05 | 04, 07 |
| 07 | Genie selectEngine() flag + dispatcher swap | 04 | 06 |
| 08 | Shadow mode + smoke harness + cutover prep | 07 | — |

## Working API key

Live tests in this phase use:
```
<REDACTED_API_KEY>
```
Verified responsive — Claude Haiku 4.5 returned `pong` (15 input / 5 output tokens, HTTP 200) on 2026-04-15.

## Definition of done for the whole phase

- [ ] `jellyclaw run "hello"` makes a real Anthropic call, streams real text
- [ ] `curl /v1/runs` works end-to-end with SSE
- [ ] `jellyclaw tui` boots, paste-in API key works, real chat with tool use
- [ ] `--output-format claude-stream-json` matches `claude -p` shape (fixture-verified)
- [ ] Genie dispatcher cuts over to jellyclaw with operator-flippable env var
- [ ] Shadow mode runs 7 days clean
- [ ] Telegram receipts under jellyclaw indistinguishable from claude
