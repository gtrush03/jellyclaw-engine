# Phase 03 — Event stream adapter — Prompt 01: Research and types

**When to run:** After Phase 02 is marked ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3-5 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `03`
- `<phase-name>` → `Event stream adapter`
- `<sub-prompt>` → `01-research-and-types`
<!-- END SESSION STARTUP -->

## Task

Finalize the 15-event discriminated union that `jellyclaw` emits on stdout. Build the Zod schemas, the inferred TypeScript types, the type guards, and the mapping table from OpenCode's upstream events → our superset. Produce a concrete compatibility matrix for the three output formats (`jellyclaw-full`, `claude-code-compat`, `claurst-min`). No adapter wiring yet — that is Prompt 02.

### Context

`phases/PHASE-03-event-stream.md` enumerates the 15 events. `engine/SPEC.md` §3 specifies NDJSON on stdout, human text on stderr. The adapter must never emit `tool.call.end` before the matching `tool.call.start` even if OpenCode reorders them. `@jellyclaw/shared` is the workspace package that holds types used by both engine and desktop — co-locate events there.

### Steps

1. Read `phases/PHASE-03-event-stream.md` end to end. Keep a list of the 15 events open.
2. Inspect OpenCode's event stream shape. Two sources: (a) `engine/opencode-research-notes.md` §4 from Phase 01; (b) if available, a live OpenCode server via `engine/src/bootstrap/opencode-server.ts` — boot it, `curl -N -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/event`, record 5-10 real events per type into `test/golden/opencode-raw-samples.jsonl`.
3. Author `shared/src/events.ts`:
   - Define `Usage` zod object with: `input_tokens`, `output_tokens`, `cache_creation_input_tokens` (default 0), `cache_read_input_tokens` (default 0), `cost_usd` (default 0).
   - Define all 15 event variants as `z.object` with `type: z.literal("...")`, matching names from the phase doc:
     1. `system.init` — `{ session_id, cwd, model, tools: string[], ts }`
     2. `system.config` — `{ config: RedactedConfig, ts }`
     3. `user` — `{ session_id, content: string | Block[], ts }`
     4. `assistant.delta` — `{ session_id, text: string, ts }`
     5. `assistant.message` — `{ session_id, message: Message, usage: Usage, ts }`
     6. `tool.call.start` — `{ session_id, tool_use_id, name, input: unknown, subagent_path: string[], ts }`
     7. `tool.call.delta` — `{ session_id, tool_use_id, partial_json: string, ts }`
     8. `tool.call.end` — `{ session_id, tool_use_id, result?: unknown, error?: string, duration_ms: number, ts }`
     9. `subagent.start` — `{ session_id, agent_name, parent_id, allowed_tools: string[], ts }`
     10. `subagent.end` — `{ session_id, summary: string, usage: Usage, ts }`
     11. `hook.fire` — `{ session_id, event, decision, stdout, stderr, ts }`
     12. `permission.request` — `{ session_id, tool, rule_matched: string, action: "allow"|"ask"|"deny", ts }`
     13. `session.update` — `{ session_id, patch: unknown, ts }`
     14. `cost.tick` — `{ session_id, usage: Usage, ts }`
     15. `result` — `{ session_id, status: "success"|"error"|"cancelled"|"max_turns", stats: { turns: number; tools_called: number; duration_ms: number }, ts }`
   - Combine via `z.discriminatedUnion("type", [...])`. Export `Event` type via `z.infer`.
   - Add type guards: `isToolStart(e)`, `isToolEnd(e)`, `isAssistantDelta(e)`, etc. Generate via a small factory to avoid copy-paste.
4. Map upstream OpenCode events to our 15. Produce a table in `docs/event-stream.md` with columns: `opencode_event`, `opencode_shape_key`, `jellyclaw_event`, `transformation_notes`. Include at minimum the rows from `phases/PHASE-03-event-stream.md` Step 3 plus anything extra you observed in §2's samples.
5. Design the three output-format downgrades:
   - `jellyclaw-full` — emit all 15 events verbatim.
   - `claude-code-compat` — emit only `system.init`, `user`, `assistant.message` (text-only), `result`. `assistant.delta` is coalesced into `assistant.message`. Tool events are omitted (Claude Code's stream-json does not include per-tool events in this mode).
   - `claurst-min` — emit only `assistant.delta` and `result`. Text-only.
   Write the mapping explicitly in `docs/event-stream.md`.
6. Author `shared/src/events.test.ts`:
   - Round-trip: each variant parses → stringifies → re-parses identically.
   - Rejects unknown `type`.
   - Rejects missing required fields.
   - `Usage` defaults fill when omitted.
7. Set up `shared/package.json` to export `./events` and `./index.js`. Update `engine/tsconfig.json` so `@jellyclaw/shared` resolves via workspace. Smoke-import from engine: `import type { Event } from "@jellyclaw/shared";`.
8. Author `docs/event-stream.md`: (§1 Rationale) (§2 The 15 events — one subsection each with shape + when emitted) (§3 Upstream mapping table) (§4 Output-format downgrades) (§5 Ordering invariants — `tool.call.start` before `tool.call.end`, `subagent.start` before any nested tool event) (§6 Redaction rules — which fields are redacted in `system.config`).
9. Run `bun run --filter @jellyclaw/shared test && bun run typecheck`. All green.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/shared/src/events.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/shared/src/events.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/shared/src/index.ts` — re-export.
- `/Users/gtrush/Downloads/jellyclaw-engine/shared/package.json` — exports map, vitest script.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/event-stream.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/golden/opencode-raw-samples.jsonl` (if a live server was captured)

### Verification

- All 15 event variants compile and parse a hand-written golden sample each.
- `z.infer<typeof Event>` yields a correctly-discriminated union in `tsc` output (test this by writing a `switch(ev.type)` with exhaustiveness check `const _: never = ev`).
- `shared` package typechecks and tests pass.
- `docs/event-stream.md` maps every OpenCode event we observed to exactly one jellyclaw event (or marks it intentionally dropped with reason).
- Output-format matrix explicitly states which events survive each downgrade.

### Common pitfalls

- **Using `z.union` instead of `z.discriminatedUnion`.** Non-discriminated unions fail on the exhaustiveness check and give worse error messages. Use discriminated.
- **Forgetting `ts`.** Every event carries a `ts: number` for deterministic replay and backpressure measurement. Don't use `new Date()` — the adapter injects a clock.
- **Coupling `shared/` to Node-only APIs.** `shared/` must be consumable by the Tauri frontend eventually. Import only from `zod` and pure TS.
- **Redacting too little in `system.config`.** The `system.config` event carries the config snapshot — strip `apiKey`, `anthropic.apiKey`, `openrouter.apiKey`, `OPENCODE_SERVER_PASSWORD`. Add a `redactConfig()` helper here and test it.
- **Out-of-order tool events.** This is the adapter's job (Prompt 02), but the schema must permit the buffering design: `tool.call.end.tool_use_id` must match a prior `tool.call.start.tool_use_id`, not an arbitrary id.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `03`
- `<phase-name>` → `Event stream adapter`
- `<sub-prompt>` → `01-research-and-types`
- Do NOT mark Phase 03 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
