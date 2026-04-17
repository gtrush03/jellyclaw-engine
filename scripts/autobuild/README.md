# autobuild — self-running Claude Code harness for jellyclaw-engine

MVP (M4 slice). Single-threaded. One prompt at a time. No evolver. No retries.
Fail → escalate.

## Layout

```
scripts/autobuild/
├── dispatcher.mjs            main daemon loop
├── tester.mjs                per-prompt test runner
├── state.mjs                 atomic state.json helpers
├── git-warden.mjs            branch cut + scope enforcement
├── evolver.mjs               STUB — returns the prompt body as startup context
├── lib/
│   ├── tmux.mjs              tmux session spawn / pipe / kill
│   ├── prompt-parser.mjs     gray-matter wrapper
│   ├── jellyclaw-driver.mjs  shell + long-running command runners
│   ├── budget.mjs            cost tracking + $5 self-check gate
│   ├── paths.mjs             canonical paths
│   └── logger.mjs            pino wrapper
├── bin/
│   ├── autobuild             CLI
│   └── autobuild-tester      direct tester for debugging
└── test/                     node:test suites
```

## Usage

```bash
# Bootstrap on first run:
node scripts/autobuild/bin/autobuild init

# Queue a prompt from prompts/phase-99b-unfucking-v2/:
node scripts/autobuild/bin/autobuild queue add T0-01-fix-serve-shim

# Run a single tick (for cron / manual testing):
node scripts/autobuild/bin/autobuild tick

# Run the daemon forever:
node scripts/autobuild/bin/autobuild run

# See what's going on:
node scripts/autobuild/bin/autobuild status

# Abort an in-flight run via the inbox:
node scripts/autobuild/bin/autobuild abort T0-01-fix-serve-shim
```

## State and sessions

- `.autobuild/state.json` — single source of truth. Atomic tmp+rename writes,
  lock file guarding concurrent writers.
- `.autobuild/queue.json` — ordered queue (`{order: [...]}`).
- `.autobuild/sessions/<uuid>/` — per-run artifacts: `prompt.md`,
  `startup-context.md`, `events.ndjson`, `tmux.log`, `stderr.log`,
  `transitions.ndjson`, `test-results.json`.
- `.autobuild/logs/autobuild.log` — pino JSON log.
- `.orchestrator/inbox/*.json` — inbox commands. Each tick the dispatcher
  drains and deletes.

## Inbox commands

Drop a JSON file into `.orchestrator/inbox/` with shape
`{cmd, target?, payload?, ts}`. Supported commands:

- `pause` — dispatcher stops spawning new workers
- `resume` — unpause
- `halt` — hard stop (no new spawns)
- `abort <id>` — mark the run aborted
- `approve <id>` — clear `needs_review`
- `skip <id>` — remove from queue without running
- `rerun <id>` — re-queue

Unknown commands are logged and deleted.

## Testing

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
node --test scripts/autobuild/test/
```

The smoke test sets `AUTOBUILD_DRY_RUN=1` so no tmux, git, or claude binary is
invoked. It writes a fake prompt into a tmp dir, queues it, runs one tick, and
asserts the run lands in `complete` with a passing test record.
