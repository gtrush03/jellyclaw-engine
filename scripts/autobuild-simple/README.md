# autobuild-simple

The simpler autobuild: **one tmux session, interactive `claude`, prompts fed
sequentially, shell orchestrator.**

## Why

The old rig (`scripts/autobuild/`) spawns a fresh `claude -p` subprocess per
prompt, manages branches, state machines, retries, budgets, etc. For a linear
fix-list like T0..T4 that's overkill — and none of that ceremony actually
produces working code.

This does one thing: it sends each prompt into a persistent claude tmux
session in order. Claude keeps its own context, writes code, runs tests,
prints `DONE: <id>`, then the next prompt lands. When a phase finishes you
attach to the same tmux and watch the next one start.

## Run

```bash
./scripts/autobuild-simple/run.sh                  # T0..T4 (all 42 prompts)
./scripts/autobuild-simple/run.sh T0               # just T0 (5 prompts)
./scripts/autobuild-simple/run.sh T0-01 T0-02      # specific prompts
```

Watch live:

```bash
tmux attach -t jc-autobuild        # detach with Ctrl+B then d
tail -f .autobuild-simple/tmux.log # follow without attaching
tail -f .autobuild-simple/state.log # one line per prompt transition
```

Abort:

```bash
tmux kill-session -t jc-autobuild
```

## Completion detection

Claude is instructed to print `DONE: <id>` on its own line when all tests
pass. The orchestrator polls the tmux pane every 5s for that literal string.
Two failure modes:

- **timeout** (30 min default) → exits with code 1
- **idle stuck** (2 min no new output in pane) → exits with code 2; attach
  and unstick manually

## Notes

- Uses `claude --dangerously-skip-permissions` so no approval prompts block.
  Edit the script if you want per-action confirms.
- State lives in `.autobuild-simple/`.
- Requires `tmux` and `claude` (Claude Code CLI) on `PATH`.
