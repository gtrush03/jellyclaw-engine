# Phase 99 — Unfucking — Prompt 03: Wire RunManager engine + verify /v1/runs/* + CLI uses real engine

**When to run:** After 99-02 (loop tests green).
**Estimated duration:** ~120 minutes
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- Working API key for the smoke test: <REDACTED_API_KEY> -->
<!-- END SESSION STARTUP -->

---

## Pre-flight — confirm starting state (run this FIRST)

Copy-paste exactly this block, confirm outputs match before writing any code:

```bash
set -e
cd /Users/gtrush/Downloads/jellyclaw-engine

# 1. Routes ARE registered — confirm location.
grep -n "registerRunRoutes" engine/src/cli/serve.ts
# Expect: line ~338 `routesMod.registerRunRoutes(app, { runManager, sessionPaths, logger, version });`

# 2. RunManager factory currently yields events from legacy-run.ts (stub).
grep -n "legacy-run\|engineRun" engine/src/server/run-manager.ts | head
# Expect a reference into `../internal.js` which re-exports the legacy stub.

# 3. Boot the server under node (bun has an SSE-chunked bug, see "Known gotchas").
export ANTHROPIC_API_KEY='<REDACTED_API_KEY>'
node engine/dist/cli/main.js serve --port 8766 --auth-token testtoken123 > /tmp/jelly.log 2>&1 &
SERVER_PID=$!
sleep 2
curl -s http://127.0.0.1:8766/v1/health            # {"ok":true,...}
curl -s -X POST http://127.0.0.1:8766/v1/runs \
  -H 'Authorization: Bearer testtoken123' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"say pong"}'                        # {"runId":"...","sessionId":"..."}
RUNID=$(curl -s -X POST http://127.0.0.1:8766/v1/runs \
  -H 'Authorization: Bearer testtoken123' -H 'Content-Type: application/json' \
  -d '{"prompt":"say pong"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
curl -s -N --max-time 4 -H 'Authorization: Bearer testtoken123' \
  "http://127.0.0.1:8766/v1/runs/$RUNID/events"   # SSE frames ending with "event: done"
kill $SERVER_PID
```

If the SSE stream above ends with `event: done` and the `data:` payloads contain `"type":"session.started"`, `"type":"agent.message"` (with `"[phase-0 stub]"` content), `"type":"session.completed"` — **the wire layer works**. What's missing is that the run factory yields a stub instead of real Anthropic output. That is the only thing this prompt fixes.

## Why this exists — corrected diagnosis

Earlier audit said "/v1/runs/* stubbed but not mounted". That was wrong. Actual state:

1. **HTTP routes ARE mounted.** `engine/src/cli/serve.ts` (productionDeps, ~line 338) imports `registerRunRoutes` and attaches it to the app built by `createApp()`. The comment in `engine/src/server/app.ts` line 54-58 ("Routes reserved for Agent B — not mounted here") is TRUE about `app.ts` but MISLEADING because `serve.ts` is where mounting happens. Keep as-is or rewrite the comment; don't move the mounting.
2. **Mounted routes (verified by live curl):**
   - `GET /v1/health` (pre-auth, registered in app.ts)
   - `POST /v1/runs` → 201 `{runId, sessionId}`
   - `GET /v1/runs/:id/events` → text/event-stream, `event: event` frames with `id:` + JSON `data:`, terminal `event: done` frame with `id: done`
   - `POST /v1/runs/:id/steer` → 202 or 409
   - `POST /v1/runs/:id/cancel` → 202
   - `POST /v1/runs/:id/resume` → 201
   - Plus `/v1/config`, `/v1/sessions/*`, `/v1/messages/*`, `/v1/permissions/*`, `/v1/events/*` (registered inside `createApp`).
3. **The actual problem:** `RunManager`'s default run factory delegates to `engineRun` from `../internal.js`, which currently re-exports `legacy-run.ts`'s Phase-0 stub. The stub emits `session.started`, one `agent.message` with `"[phase-0 stub] received wish: ..."`, `usage.updated` (all zeros), `session.completed`. It never hits Anthropic.
4. **Same for CLI:** `engine/src/cli/run.ts` imports `realRun` from `../internal.js` — same stub.

After this prompt: `jellyclaw run "hello"` makes a real Anthropic call. `curl /v1/runs` → real runIds backed by a real agent loop. SSE frames carry real agent messages.

## Known gotchas (read before building)

- **Bun blocks SSE under the current shim.** `engine/bin/jellyclaw` hard-codes `#!/usr/bin/env bun`. Live curl against a bun-booted server returned `"Malformed encoding found in chunked-encoding"` — Hono's `streamSSE` on `@hono/node-server` under Bun emits a broken chunked response that curl aborts after ~14 bytes. Under `node engine/dist/cli/main.js serve` the same endpoint streams a full 979-byte session correctly. **This prompt's smoke tests MUST launch the server via `node engine/dist/cli/main.js serve …` or fix the shim, not via `bun run engine/bin/jellyclaw serve`.** Also add a `@jellyclaw/server` bin alternative that runs under node, or patch `engine/bin/jellyclaw` to use `node` when the command is `serve`. Track upstream: Hono + @hono/node-server + Bun SSE compatibility.
- **better-sqlite3 is broken under Bun** (`jellyclaw doctor` prints `'better-sqlite3' is not yet supported in Bun`, tracked at oven-sh/bun#4290). Session persistence writes will throw when the CLI runs under bun. This does NOT block the wire layer (in-memory ring buffer + JSONL still work), but it WILL block the `resume`/`continue` path. Options: (a) switch to `bun:sqlite` when runtime is bun, (b) pin the whole CLI to node, (c) make `SessionWriter` tolerant of missing db and fall back to JSONL-only. Recommend (b) — already needed for SSE fix.
- **CLI flag is `--auth-token` not `--token`.** Earlier draft of this prompt used `--token`. The actual flag parsed by `jellyclaw serve` is `--auth-token <token>` (also accepts env `OPENCODE_SERVER_PASSWORD` or `JELLYCLAW_TOKEN`). All smoke scripts below use the correct flag.
- **Default port is 8765**, default host `127.0.0.1`, CORS defaults to `http://localhost:*,http://127.0.0.1:*`.

## Files to read first

1. `engine/src/server/run-manager.ts` — current run factory, `RunManagerOptions`.
2. `engine/src/server/routes/runs.ts` — already-built routes; the target shape.
3. `engine/src/server/routes/runs.test.ts` — existing tests (currently stubbed streamer via `__setStreamRunEventsForTests`); will keep passing.
4. `engine/src/cli/serve.ts` — `productionDeps()` builds app, mounts runs routes. DO NOT break this.
5. `engine/src/server/app.ts` — top-level factory; middleware order; note lines 54-58 comment is out of date.
6. `engine/src/server/sse.ts` — SSE pump. Ring-buffer-then-subscribe semantics.
7. `engine/src/create-engine.ts` — entry that builds RunManager; needs provider+toolRegistry+hookRunner threaded in.
8. `engine/src/cli/run.ts` — `realRun` swap point.
9. `engine/src/internal.ts` — keep `legacy-run` exported under a `legacy-run` alias for one more prompt (not deleted yet).
10. `engine/src/agents/loop.ts` (built in 99-02).
11. `engine/bin/jellyclaw` — runtime shim (currently bun — see gotchas).

## Build

### Step A — RunManager swap

Modify `engine/src/server/run-manager.ts`:

- Extend `RunManagerOptions` to include `provider: Provider, toolRegistry: ToolRegistry, hookRunner: HookRunner, permissionGate?: PermissionGate, config: EngineConfig`.
- Replace the default run factory's body with a closure that imports `runAgentLoop` from `agents/loop.ts` and yields its events. Honor any `runFactory` override for tests.
- Keep all existing ring-buffer / JSONL / SessionWriter / AbortController behavior — do NOT touch.

Modify `engine/src/create-engine.ts`:

- Pass `provider`, `toolRegistry`, `hookRunner`, `permissionGate`, `config` into `createRunManager()`.

### Step B — Runtime shim fix (node for serve)

Modify `engine/bin/jellyclaw`:

- Either switch shebang to `#!/usr/bin/env node` if the TUI's dynamic TSX imports are no longer mandatory at top-level, OR write a companion `engine/bin/jellyclaw-serve` under node (simplest). The current `jellyclaw` stays bun for TUI.
- Update `jellyclaw doctor` to surface a warning when invoked under bun.
- Update `README.md` usage snippets to `node engine/dist/cli/main.js serve ...` or the new shim.

The simplest implementation:

```bash
#!/usr/bin/env node
// engine/bin/jellyclaw-serve — node-only shim for the HTTP server (SSE bug workaround)
import("../dist/cli/main.js").catch((e) => {
  process.stderr.write(`${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
```

Link from `package.json` `bin` map.

### Step C — HTTP routes wiring (verification only)

Routes are already mounted in `engine/src/cli/serve.ts`. Work here is limited to:

- Delete or rewrite the stale comment in `engine/src/server/app.ts` lines 54-58 to read: "Routes under `/v1/runs/*` are attached by `engine/src/cli/serve.ts#productionDeps` after `createApp()` returns. They are NOT wired here so tests can build a bare app without RunManager DI."
- If `engine/src/server/routes/runs.ts` references methods that don't yet exist on RunManager (e.g. `subscribe(runId, lastEventId)`), ADD them as thin wrappers. Most already exist per Phase 10.02.

### Step D — CLI swap

Modify `engine/src/cli/run.ts`:

```ts
// OLD:
import { realRun } from "../internal.js";
const runFn = realRun;

// NEW:
import { createEngine } from "../create-engine.js";
const runFn = async function* (opts) {
  const engine = await createEngine({ /* config from opts */ });
  try {
    const handle = engine.run({
      prompt: opts.prompt,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      systemPrompt: opts.systemPrompt,
    });
    for await (const event of handle) {
      yield event;
    }
  } finally {
    await engine.dispose?.();
  }
};
```

Keep the wish-ledger short-circuit untouched. Keep all output-format handling (`stream-json`, `text`, `json`) untouched — **the `createOutputWriter` layer in `engine/src/cli/output.ts` already works for all three formats; prompt 04 only EXTENDS it with `claude-stream-json`, does not modify text/json.** Verified stub outputs:

- `--output-format stream-json`: one JSON object per line (alongside pino logs on stderr-mixed-stdout; see note below).
- `--output-format text`: just assistant deltas on stdout (logs mixed; clean stdout requires pino silencing).
- `--output-format json`: final JSON blob `{session_id, transcript: AgentEvent[], usage, summary}` after logs.

**Stdout/stderr hygiene issue:** pino currently prints to stdout (or is being captured in the same stream the output-format writer uses). Either route logger to stderr via `pino.destination({dest: 2})` OR make the run CLI use `--verbose` to opt IN to logs. Fix this as a TRIVIAL part of Step D — `--output-format stream-json` must emit NDJSON only (zero non-JSON lines), otherwise the dispatcher in prompt 04 can't parse it.

### Step E — Smoke test (live, with real API key)

Add `engine/test/smoke/run-cli.smoke.test.ts` (gated by `RUN_LIVE=1` env var):

```ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const live = process.env.RUN_LIVE === "1";
describe.skipIf(!live)("jellyclaw run — live smoke", () => {
  it("returns text from Claude Haiku", () => {
    const r = spawnSync("node", ["engine/dist/cli/main.js", "run", "say the single word: pong", "--output-format", "json"], {
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.summary?.toLowerCase()).toContain("pong");
    expect(parsed.usage?.outputTokens).toBeGreaterThan(0);
  });
});
```

Run it:

```bash
ANTHROPIC_API_KEY=<REDACTED_API_KEY> \
  RUN_LIVE=1 bun test engine/test/smoke/run-cli.smoke.test.ts
```

## Tests / gates

- `bun test engine/src/server/run-manager.test.ts` — existing tests pass with stub provider injection.
- `bun test engine/src/server/routes/runs.test.ts` — existing test file passes.
- HTTP smoke (boot server under **node**, curl):
  ```bash
  PORT=$((40000 + RANDOM % 1000))
  TOKEN=$(openssl rand -hex 16)
  ANTHROPIC_API_KEY=sk-ant-api03-... node engine/dist/cli/main.js serve --port $PORT --auth-token $TOKEN &
  sleep 2
  curl -s -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:$PORT/v1/runs \
    -H 'Content-Type: application/json' -d '{"prompt":"say pong"}' | jq -r .runId > /tmp/rid
  RID=$(cat /tmp/rid)
  curl -s -N --max-time 10 -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:$PORT/v1/runs/$RID/events" | tee /tmp/sse.out
  # Must contain: event: event, data: {"type":"agent.message"..., event: done
  grep "event: done" /tmp/sse.out
  ```
- Live CLI smoke: `RUN_LIVE=1 bun test engine/test/smoke/run-cli.smoke.test.ts` — green.

## Out of scope

- Don't delete `legacy-run.ts` yet — leave it for review diff. Mark as `@deprecated` in JSDoc.
- Don't touch the TUI (it still spawns vendored OpenCode; that's prompt 05).
- Don't add `--output-format claude-stream-json` (that's prompt 04).
- Don't fix better-sqlite3 beyond documenting the bun incompatibility and routing `serve` through node. Full session-persistence fix is its own prompt.

## Done when

- All test gates above green
- HTTP smoke prints a `event: done` frame from a real Anthropic-backed run
- `--output-format stream-json` emits pure NDJSON to stdout (no interleaved pino lines)
- COMPLETION-LOG.md updated with smoke-test transcript (paste the actual `pong` response with token usage)
- `git status` clean (every change committed)

<!-- BEGIN SESSION CLOSEOUT -->
<!-- After this prompt jellyclaw run actually calls Anthropic. Tag this commit `phase-99-engine-real`. -->
<!-- END SESSION CLOSEOUT -->
