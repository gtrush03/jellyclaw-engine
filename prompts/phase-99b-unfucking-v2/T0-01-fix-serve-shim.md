---
id: T0-01-fix-serve-shim
tier: 0
title: "Fix jellyclaw-serve shim entry-path check"
scope:
  - "engine/src/cli/main.ts"
depends_on_fix: []
tests:
  - name: shim-launches-server
    kind: jellyclaw-run
    description: "jellyclaw-serve shim successfully starts the server on a random free port"
    command: "node engine/bin/jellyclaw-serve --port 0"
    wait_for_stderr: "listening on http"
    timeout_sec: 10
    teardown: "kill the background process"
  - name: shim-help-exits-zero
    kind: shell
    description: "jellyclaw-serve --help routes through to the serve subcommand help"
    command: "node engine/bin/jellyclaw-serve --help"
    expect_exit: 0
human_gate: false
max_turns: 25
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 10
---

# T0-01 — Fix jellyclaw-serve shim entry-path check

## Context
The `jellyclaw-serve` bin shim exists at `engine/bin/jellyclaw-serve` but silently no-ops on launch. The self-invocation guard in `engine/src/cli/main.ts` only recognises two entry paths; when the shim is invoked, `main()` is never called and the process exits 0 with no server bound.

## Root cause (from audit)
- `engine/src/cli/main.ts:391-402` computes `invokedDirectly` by matching only `entry === here`, `entry.endsWith("/dist/cli/main.js")`, and `entry.endsWith("/bin/jellyclaw")`.
- `/bin/jellyclaw-serve` is not matched, so `invokedDirectly === false` and the `if (invokedDirectly)` block at `:404-407` never runs.
- Additionally, even if invoked, `main(process.argv.slice(2))` would not know the user asked for `serve`, because `jellyclaw-serve --port 8765` drops the `serve` subcommand token.

## Fix — exact change needed
1. At `engine/src/cli/main.ts:391-402`, extend the `invokedDirectly` check with a third suffix match:
   ```ts
   entry === here ||
   entry.endsWith("/dist/cli/main.js") ||
   entry.endsWith("/bin/jellyclaw") ||
   entry.endsWith("/bin/jellyclaw-serve")
   ```
2. In the `main()` export at `engine/src/cli/main.ts:372`, before calling `program.parseAsync(argv, { from: "user" })`, detect the basename of `process.argv[1]` (use `node:path` `basename`). If it equals `"jellyclaw-serve"`, prepend `"serve"` to the argv list passed to Commander so `jellyclaw-serve --port 8765` behaves identically to `jellyclaw serve --port 8765`.
3. Add a single-line pino log (`logger.debug`) is NOT required here — no new dependencies. Keep the change local; do not touch other subcommands.

## Acceptance criteria
- Running `node engine/bin/jellyclaw-serve --port 0` causes the HTTP server to bind and emit `"listening on http"` on stderr within 10 seconds (maps to `shim-launches-server`).
- Running `node engine/bin/jellyclaw-serve --help` exits 0 and prints the serve subcommand help (maps to `shim-help-exits-zero`).
- `jellyclaw serve ...` continues to work unchanged (no regression).

## Out of scope
- Do not modify `engine/src/cli/serve.ts` (credentials wiring is T0-02).
- Do not touch `engine/bin/jellyclaw-serve` itself — the shim is correct; only the TS entry check is broken.
- Do not add new commander subcommands or rename existing flags.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run build
node engine/bin/jellyclaw-serve --help
ANTHROPIC_API_KEY=sk-test node engine/bin/jellyclaw-serve --port 0 &
sleep 2 && kill %1
```
