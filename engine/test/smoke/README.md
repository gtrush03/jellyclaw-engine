# jellyclaw smoke-suite

Global regression detector. Runs after every per-prompt autobuild test pass; if
any smoke test fails, the prompt's fix is rolled back even if its own unit
tests were green. These are the "did we break something collateral?" tests.

## What's here

| Test                           | What it exercises                                         |
| ------------------------------ | --------------------------------------------------------- |
| `smoke-01-boot.mjs`            | CLI bootability: `--help`, `--version`, `jellyclaw-serve` shim. **Canary.** |
| `smoke-02-simple-prompt.mjs`   | HTTP `POST /v1/runs` + SSE happy path: `agent.message(final)` + `session.completed`, no errors. |
| `smoke-03-parallel-tools.mjs`  | Parallel tool dispatch: ≥2 of `{Glob, Read, Grep}` fire via `tool.called`. |
| `smoke-04-long-chain.mjs`      | Sequential 6-turn Bash chain: ≥5 `tool.called` Bash, peak `input_tokens` < 50k (no context blow-up). |
| `smoke-05-http-roundtrip.mjs`  | HTTP surface: `/v1/health` authed → 200, invalid `/v1/runs` → 400, unauth `/v1/health` → 401. |

Shared code lives in `lib/harness.mjs` (server spawner, SSE consumer,
`assert`, API-key loader). No new deps — node stdlib + `undici`.

## Running

From the repo root:

```bash
# pretty, parallel (default), verbose traces on stderr
node engine/test/smoke/run-smoke.mjs --verbose

# single test
node engine/test/smoke/run-smoke.mjs --test smoke-02

# json output for the autobuild tester
node engine/test/smoke/run-smoke.mjs --output json
```

Results are always written to `engine/test/smoke/results/latest.json`. Exit
code is 0 iff every test passed.

`ANTHROPIC_API_KEY` is resolved from the environment, falling back to
`~/.jellyclaw/credentials.json` (field `anthropicApiKey`), which matches
`engine/src/cli/credentials.ts`.

## Autobuild integration (`kind: smoke-suite`)

The autobuild tester invokes `run-smoke.mjs --output json`, reads
`results/latest.json`, and treats any `failed > 0` as a rollback signal. The
schema is stable: `{ total, passed, failed, duration_ms, tests: [{name,
passed, duration_ms, details?, error?}] }`.

## Canary: smoke-01

`smoke-01-boot` includes a third step that runs `engine/bin/jellyclaw-serve
--help`. On pre-T0-01 main this shim dispatches to `dist/cli/main.js` without
injecting `serve` into argv, so `--help` prints the top-level CLI help instead
of `serve`'s help — exit code may still be 0, but the behavior is wrong. Once
T0-01 lands the shim should translate `jellyclaw-serve <args>` → `main.js
serve <args>`, and this test should go green. Until then, smoke-01 is the
"do not regress further" canary for the serve shim.

## Adding a new smoke test

1. Create `smoke-NN-<name>.mjs` in this directory.
2. `export default async function run({ harness, log }) { ... }` — resolve
   with `{ name, passed: true, duration_ms, details? }` on success; throw on
   failure.
3. Use helpers from `./lib/harness.mjs`: `withServer`, `createRun`,
   `streamRunEvents`, `assert`, `readApiKey`.
4. Keep the test under 90s when possible. Use random free ports via
   `harness.spawnServer` (the default) so tests can run in parallel.
5. Update this README's table.
