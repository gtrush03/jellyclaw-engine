---
id: T1-01-cap-tool-output-bytes
tier: 1
title: "Cap tool result stringification at 200KB to prevent context explosion"
scope:
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/loop.test.ts"
depends_on_fix: []
tests:
  - name: huge-bash-output-truncated
    kind: shell
    description: "a tool returning 10MB of output is truncated to <=200K chars with an elision marker"
    command: "bun run test engine/src/agents/loop -t cap-tool-output"
    expect_exit: 0
    timeout_sec: 60
  - name: small-tool-output-unchanged
    kind: shell
    description: "small results pass through verbatim with no elision marker"
    command: "bun run test engine/src/agents/loop -t small-tool-output"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 30
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 25
---

# T1-01 — Cap tool result stringification at 200KB

## Context
A single runaway tool call (e.g. `bash: cat large.log`, `grep` without `head_limit`, `read` on a giant file) can drop >10MB of text into `messages` as the `tool_result` content. On the next turn the request body blows past Anthropic's context window and the provider returns HTTP 429 / 413. The engine silently dies after one or two turns. Cap every tool result at 200KB at the stringification boundary.

## Root cause (from audit)
- `engine/src/agents/loop.ts:559-566` — `stringifyResult(value)` returns the full string / JSON with no length limit.
- `engine/src/agents/loop.ts:521` — the returned string is dropped directly into `content` of a `tool_result` block with no truncation.
- Impact: users see "it just stops after one big file read" and a confusing 429 in the logs.

## Fix — exact change needed
1. In `engine/src/agents/loop.ts`, add a module-level constant:
   ```ts
   const MAX_TOOL_RESULT_BYTES = 200_000;
   ```
2. Rewrite `stringifyResult(value: unknown): string` at `loop.ts:559-566` so that AFTER the existing branch produces the raw string, if `Buffer.byteLength(raw, "utf8") > MAX_TOOL_RESULT_BYTES` it returns `raw.slice(0, headChars) + "\n\n[... " + elidedBytes + " more bytes elided ...]"` where `headChars` is the largest prefix whose UTF-8 byte length stays under the cap (walk down from `MAX_TOOL_RESULT_BYTES` until a valid UTF-8 boundary is found — use `Buffer.from(raw).subarray(0, cap).toString("utf8")` and let Node handle the partial-codepoint trim).
3. At the tool_result construction site (`loop.ts:516-523`), when truncation occurred, annotate the preceding `tool.result` event with `truncated: true` and `output_bytes: <original byte length>`. This requires widening the `tool.result` variant in `engine/src/events.ts` (add `truncated?: boolean; output_bytes?: number` — optional, backward compatible). Emit these fields only when truncation happens; otherwise omit (respect `exactOptionalPropertyTypes`).
4. Add two vitest cases to `engine/src/agents/loop.test.ts`:
   - `cap-tool-output`: stub a tool that returns a 10MB string; assert the resulting `tool_result` block's `content` length is <= 200_050 bytes, contains the marker `"more bytes elided"`, and the preceding `tool.result` event has `truncated: true`.
   - `small-tool-output`: stub a tool that returns 1KB; assert passthrough and no `truncated` field.

## Acceptance criteria
- Every `tool_result` content string is <= ~200KB UTF-8 bytes (maps to `huge-bash-output-truncated`).
- Normal small results unchanged, no `truncated` field set (maps to `small-tool-output-unchanged`).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT change Read/Grep/Bash internal defaults — those are a separate prompt if needed.
- Do NOT touch `engine/src/providers/adapter.ts` usage accounting (that's T1-07).
- Do NOT alter the `tool_result` is_error path.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/loop
grep -n "MAX_TOOL_RESULT_BYTES" engine/src/agents/loop.ts
```
