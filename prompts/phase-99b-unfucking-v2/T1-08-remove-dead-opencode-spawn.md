---
id: T1-08-remove-dead-opencode-spawn
tier: 1
title: "Remove dead OpenCode child-process spawn from createEngine"
scope:
  - "engine/src/create-engine.ts"
  - "engine/src/engine.ts"
  - "engine/src/create-engine.test.ts"
depends_on_fix: []
tests:
  - name: create-engine-spawns-no-child
    kind: shell
    description: "createEngine() does not spawn any child process (no opencode binary on disk either)"
    command: "bun run test engine/src/create-engine -t no-child-process"
    expect_exit: 0
    timeout_sec: 60
  - name: existing-engine-tests-still-pass
    kind: shell
    description: "every existing create-engine / engine test still green after removal"
    command: "bun run test engine/src/create-engine engine/src/engine"
    expect_exit: 0
    timeout_sec: 120
human_gate: false
max_turns: 30
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 25
---

# T1-08 — Remove dead OpenCode spawn from `createEngine`

## Context
`createEngine()` at `engine/src/create-engine.ts:133` calls `startOpenCode({})`, holds the live handle + a minted 256-bit password on `EngineInternals`, and tears it down in `engine.dispose()`. But NOTHING in the engine currently talks to that loopback HTTP port — the agent loop dispatches directly through `AnthropicProvider`, tools run in-process, and no OpenCode route is wired. The child process is dead weight: it consumes a port, burns RAM, extends engine startup, and exposes an unused authenticated HTTP surface. Remove it.

## Root cause (from audit)
- `engine/src/create-engine.ts:133-134` — `opencode = await startOpenCode({}); opencodePassword = opencode.password;` — unused after assignment.
- `engine/src/create-engine.ts:214-215` — `opencode,` + `opencodePassword,` written into `EngineInternals`.
- `engine/src/engine.ts:84,86` — `EngineInternals.opencode` and `EngineInternals.opencodePassword` fields exist.
- `engine/src/engine.ts:304-309` — dispose path calls `internals.opencode.kill()`.
- `engine/src/create-engine.ts:243-248` — rollback path calls `opencode.kill()` on construction failure.
- Search confirms no other reference: `grep -R "internals.opencode" engine/src/` returns only these sites.
- Impact: slower engine boot (~100ms+ process spawn), unnecessary surface area, confusion for future readers.

## Fix — exact change needed
1. In `engine/src/create-engine.ts`:
   - Remove imports: `import type { OpenCodeHandle } from "./bootstrap/opencode-server.js";` and `import { startOpenCode } from "./bootstrap/opencode-server.js";` (lines ~21-22).
   - Remove the local declarations `let opencode: OpenCodeHandle | null = null;` and `let opencodePassword: string | null = null;` (~:123-124).
   - Remove the spawn call `opencode = await startOpenCode({}); opencodePassword = opencode.password;` (~:133-134).
   - In the `internals: EngineInternals = { ... }` literal, delete the `opencode,` and `opencodePassword,` properties (~:214-215).
   - In the rollback-on-error `catch` block (~:243-248), delete the `if (opencode) { ... opencode.kill() ... }` stanza.
2. In `engine/src/engine.ts`:
   - Remove the `import type { OpenCodeHandle } from "./bootstrap/opencode-server.js";` line (~:15).
   - Remove `opencode: OpenCodeHandle | null;` and `opencodePassword: string | null;` fields from `EngineInternals` (~:84, :86).
   - In `dispose()` remove the `if (internals.opencode) { ... internals.opencode.kill() ... }` block (~:304-309).
3. Do NOT delete `engine/src/bootstrap/opencode-server.ts` itself. A future phase may wire it back; leaving the module in-tree with no callers is fine. The prompt's scope is removing the CALL, not the file.
4. Update any test that constructed `EngineInternals` by hand with `opencode: null, opencodePassword: null` — remove those properties. Search: `grep -R "opencodePassword\|internals.opencode" engine/src/`.
5. Add one new vitest case to `engine/src/create-engine.test.ts`:
   - `no-child-process`: spy on `node:child_process` `spawn` / `fork` (whichever `startOpenCode` uses — likely `spawn`) via `vi.spyOn` or a pre-import mock; call `createEngine({ config: { provider: "anthropic" } })`; assert the spy was called zero times. Teardown the engine via `engine.dispose()`.

## Acceptance criteria
- `createEngine()` does not invoke `startOpenCode` (maps to `create-engine-spawns-no-child`).
- `EngineInternals` no longer carries `opencode` / `opencodePassword` fields.
- Existing engine tests still pass unchanged (maps to `existing-engine-tests-still-pass`).
- `grep -R "startOpenCode\|internals.opencode\|opencodePassword" engine/src/` returns nothing under `engine/src/` (except the `bootstrap/opencode-server.ts` module itself).

## Out of scope
- Do NOT delete `engine/src/bootstrap/opencode-server.ts`. Leave the module intact.
- Do NOT wire OpenCode into a different code path. The whole point is removing the dead link.
- Do NOT change `EngineOptions` (public API). Internal-only removal.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/create-engine
bun run test engine/src/engine
grep -RnE "startOpenCode\(|opencodePassword|internals\.opencode" engine/src/ | grep -v "bootstrap/opencode-server.ts" && echo "STILL REFERENCED" || echo "clean"
```
