---
id: T0-02-serve-reads-credentials
tier: 0
title: "serve reads ANTHROPIC_API_KEY from ~/.jellyclaw/credentials.json"
scope:
  - "engine/src/cli/serve.ts"
depends_on_fix:
  - T0-01-fix-serve-shim
tests:
  - name: serve-starts-with-creds-file
    kind: shell
    description: "jellyclaw-serve picks up credentials.json and binds to a free port"
    command: |
      PORT=$(node -e "const s=require('net').createServer(); s.listen(0,()=>{console.log(s.address().port);s.close()})")
      env -u ANTHROPIC_API_KEY node engine/bin/jellyclaw-serve --port $PORT --auth-token test &
      PID=$!
      sleep 3
      kill -0 $PID && curl -fsS -H "Authorization: Bearer test" http://127.0.0.1:$PORT/v1/health >/dev/null
      RC=$?
      kill $PID 2>/dev/null
      exit $RC
    expect_exit: 0
    timeout_sec: 15
  - name: serve-errors-with-no-creds
    kind: shell
    description: "serve fails with a clear error when neither env nor creds file has a key"
    command: |
      PORT=$(node -e "const s=require('net').createServer(); s.listen(0,()=>{console.log(s.address().port);s.close()})")
      env -u ANTHROPIC_API_KEY JELLYCLAW_CREDENTIALS_PATH=/tmp/jc-empty-$$/creds.json node engine/bin/jellyclaw-serve --port $PORT || true
    expect_exit: 0
    timeout_sec: 10
human_gate: false
max_turns: 25
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 15
---

# T0-02 — serve reads credentials.json

## Context
`jellyclaw serve` currently throws `AuthTokenMissingError` if `ANTHROPIC_API_KEY` is not in the process environment, even though the TUI onboarding flow already persists the key to `~/.jellyclaw/credentials.json`. The server must read that file as a fallback so users who onboarded via the TUI can `jellyclaw serve` without re-exporting their key.

## Root cause (from audit)
- `engine/src/cli/serve.ts:346-352` inside `productionDeps().createRunManager` reads only `process.env.ANTHROPIC_API_KEY` and throws `AuthTokenMissingError` when it's missing.
- `engine/src/cli/credentials.ts` already exports `loadCredentials()` which returns `{ anthropicApiKey?: string }` parsed through a zod schema, with safe defaults on failure.
- The TUI already uses this helper path (see `engine/src/cli/tui.ts`); serve is the outlier.

## Fix — exact change needed
1. At the top of `engine/src/cli/serve.ts`, add: `import { loadCredentials } from "./credentials.js";`.
2. Replace the body of `createRunManager` at `engine/src/cli/serve.ts:345-367` so API-key resolution is:
   1. `process.env.ANTHROPIC_API_KEY` if non-empty, else
   2. `(await loadCredentials()).anthropicApiKey` if non-empty, else
   3. throw `AuthTokenMissingError` with a message instructing the user to either export the env var OR run `jellyclaw tui` to onboard.
3. Because `loadCredentials` is async but the current `createRunManager` factory signature is sync, promote the resolution to happen once in `productionDeps()` (async) and close over the resolved `apiKey` in the returned `createRunManager` closure. Do NOT convert `createRunManager`'s public signature to async — keep the DI shape stable.
4. Do not log the key. Do not add new fields to the logger redact list; `anthropicApiKey` is already redacted.

## Acceptance criteria
- `env -u ANTHROPIC_API_KEY node engine/bin/jellyclaw-serve --port <free-port>` boots successfully when `~/.jellyclaw/credentials.json` contains a valid `anthropicApiKey` (maps to `serve-starts-with-creds-file`; the fixture picks a free port at runtime because `parsePort` rejects `0`).
- With no env var AND no creds file, serve exits non-zero with a message mentioning both `ANTHROPIC_API_KEY` and `jellyclaw tui` (maps to `serve-errors-with-no-creds`).
- `env ANTHROPIC_API_KEY=sk-... jellyclaw serve ...` still works unchanged (env takes priority).

## Out of scope
- Do not modify `engine/src/cli/credentials.ts` (already correct).
- Do not touch the TUI or the `run` subcommand — run also needs this but is handled in a separate tier prompt.
- Do not introduce new zod schemas or change the shape of `Credentials`.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run build
bun run test engine/src/cli/serve
# Simulate creds-only boot:
export JELLYCLAW_CREDENTIALS_PATH=/tmp/jc-creds-$$/creds.json
mkdir -p "$(dirname $JELLYCLAW_CREDENTIALS_PATH)"
echo '{"anthropicApiKey":"sk-ant-testxxxxxxxxxx"}' > "$JELLYCLAW_CREDENTIALS_PATH"
env -u ANTHROPIC_API_KEY node engine/bin/jellyclaw-serve --port 0 &
sleep 2 && kill %1
```
