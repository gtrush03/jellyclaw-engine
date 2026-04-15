---
phase: 12
name: "Genie integration behind a flag"
duration: "3 days"
depends_on: [10, 11]
blocks: [13]
---

# Phase 12 — Genie integration behind a flag

## Dream outcome

Set `GENIE_ENGINE=jellyclaw` and Genie runs its dispatcher on jellyclaw with zero other changes. Set `GENIE_ENGINE=claurst` (default for now) and Genie runs on Claurst as before. A 12-wish canonical corpus runs on both engines in parallel; the diff report shows functional equivalence (same tool sequences, same final file state).

## Deliverables

- PR against `/Users/gtrush/Downloads/genie-2.0/` that adds engine-pluggable dispatcher
- `genie-2.0/src/core/engines/claurst.mjs` + `genie-2.0/src/core/engines/jellyclaw.mjs`
- `genie-2.0/src/core/engine-factory.mjs` — picks engine per env
- Symlink: `~/.claurst/skills/` → `~/.jellyclaw/skills/` (or reverse, document direction)
- `genie-2.0/test/canonical-wishes/` — 12 wishes
- `genie-2.0/test/compare.mjs` — runs both engines, diffs
- `docs/genie-integration.md`

## Step-by-step

### Step 1 — Audit current dispatcher
Read `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs`. Note every place it:
- Spawns `claude -p` / `claurst`
- Parses stream-json events
- Handles session ids
- Resolves skill paths
- Reads config

Document each call site in `docs/genie-integration.md` with line numbers.

### Step 2 — Extract engine interface
Define in Genie:
```js
// engines/types.js (jsdoc)
// Engine = { run(prompt, opts) -> AsyncIterable<Event>, resume(id), cancel(id) }
```

### Step 3 — Claurst adapter
`engines/claurst.mjs` wraps existing `spawn('claurst', ...)` + stream parser. Extract unchanged behavior into this module.

### Step 4 — Jellyclaw adapter
`engines/jellyclaw.mjs` uses `@jellyclaw/engine` library API:
```js
import { createEngine } from "@jellyclaw/engine";
export function create(config) {
  const engine = await createEngine(config);
  return { run: engine.run.bind(engine), resume: engine.resume.bind(engine), cancel: engine.cancel.bind(engine) };
}
```

### Step 5 — Event parser upgrade
Genie's existing parser expects Claurst minimal events. Jellyclaw emits a superset. Add a translator so Genie's downstream consumers receive the Claurst-shape events when on jellyclaw, while logging the richer fields separately.

### Step 6 — Engine factory
`engine-factory.mjs`:
```js
export function pickEngine(config) {
  const name = process.env.GENIE_ENGINE ?? "claurst";
  if (name === "jellyclaw") return require("./engines/jellyclaw.mjs").create(config);
  if (name === "claurst") return require("./engines/claurst.mjs").create(config);
  throw new Error(`Unknown GENIE_ENGINE: ${name}`);
}
```

### Step 7 — Skills/agents unification
Symlink:
```bash
mkdir -p ~/.jellyclaw
if [ -d ~/.claurst/skills ] && [ ! -e ~/.jellyclaw/skills ]; then
  ln -s ~/.claurst/skills ~/.jellyclaw/skills
fi
```
Document in `docs/genie-integration.md`.

### Step 8 — MCP config port
Genie already runs `playwright-mcp@0.0.41` against CDP:9222. Port its config into `jellyclaw.json` (or whatever config Genie's factory writes for jellyclaw).

### Step 9 — Canonical 12 wishes
Seed `genie-2.0/test/canonical-wishes/` with:
1. "add a /health route to the Express app"
2. "fix the failing test in src/foo.test.ts"
3. "refactor X module to remove Y"
4. "write a README for Z"
5. "bump lodash to latest"
6. "open a PR for current branch"
7. "summarize git log since yesterday"
8. "navigate to example.com and screenshot" (MCP)
9. "run the playwright suite and summarize failures"
10. "generate a changelog"
11. "add a skill that does X"
12. "resume the last session and continue"

### Step 10 — Compare harness
`test/compare.mjs` runs each wish on both engines in isolated temp worktrees, captures: final file diff, tool sequence, duration, tokens, cost. Writes a report.

### Step 11 — Run, analyze, iterate
Run compare. Expect some drift. Triage each delta: fix jellyclaw or accept (document).

## Acceptance criteria

- [ ] `GENIE_ENGINE=claurst` reproduces prior Genie behavior exactly
- [ ] `GENIE_ENGINE=jellyclaw` runs without errors
- [ ] 12 canonical wishes complete on both engines
- [ ] Diff report produced; deltas all either fixed or justified
- [ ] Skills/agents discovered from unified path
- [ ] Playwright MCP works via CDP:9222 on jellyclaw

## Risks + mitigations

- **Genie downstream code depends on specific Claurst event shape** → translator layer maintains back-compat.
- **Subtle cost regressions on jellyclaw** → comparison harness tracks $/wish; alert on >20% regression.
- **Path/symlink confusion** → make symlink direction explicit in docs; tooling picks correct direction based on pre-existing directory.

## Dependencies to install

(In `genie-2.0/`)
```
@jellyclaw/engine@link:../jellyclaw-engine/engine
```

## Files touched

- `genie-2.0/src/core/dispatcher.mjs`
- `genie-2.0/src/core/engine-factory.mjs`
- `genie-2.0/src/core/engines/{claurst,jellyclaw}.mjs`
- `genie-2.0/test/canonical-wishes/*.md`
- `genie-2.0/test/compare.mjs`
- `jellyclaw-engine/docs/genie-integration.md`
