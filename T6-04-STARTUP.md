# T6-04 — autobuild startup

Paste this into a fresh Claude Code session to launch the T6-04 autobuild. The
orchestrator runs in tmux; you can attach/detach freely. No babysitting.

---

## One-time pre-flight

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Sanity
claude --version                                     # must print
tmux -V                                              # must print
jq 'keys' ~/.jellyclaw/credentials.json              # must have 'anthropic' key
ls prompts/phase-08-hosting/T6-04-landing-and-tui/T*.md | wc -l   # 14 expected
ls scripts/autobuild-simple/run.sh                   # must exist
```

If the creds file is missing:
```bash
./engine/bin/jellyclaw key   # paste the new Anthropic key
```

## Dry-run one tier (recommended first)

Run just T0 to validate the pipeline + baseline:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
mkdir -p .autobuild-simple
nohup ./scripts/autobuild-simple/run.sh T0 \
  > .autobuild-simple/T0.log 2>&1 &
echo "autobuild pid: $!"
```

Watch:
```bash
tmux attach -t jc-autobuild      # Ctrl+B d to detach
# or
tail -f .autobuild-simple/state.log
```

When state.log shows `COMPLETE T0-02` you're ready for the chain.

## Full chain (T0 → T4, fresh tmux per tier)

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
nohup ./scripts/autobuild-simple/run-phases.sh T0 T1 T2 T3 T4 \
  > .autobuild-simple/chain.log 2>&1 &
echo "chain pid: $!"
```

Expect ~5–8 hours wall clock. Safe to leave overnight. Each prompt times out
at 30 min; if it FAILs, the orchestrator stops at that prompt and you pick it
up manually.

## Monitor from a second Claude Code session

Open a second session, paste:

> Read `/Users/gtrush/Downloads/jellyclaw-engine/T6-04-PLAN.md`. Arm a Monitor
> on `.autobuild-simple/state.log`; whenever a new line appears, summarise it
> and `git diff --stat HEAD` so I see the running scoreboard. If a line starts
> with `FAIL`, stop monitoring and surface the prompt id + reason.

## Abort

```bash
tmux kill-session -t jc-autobuild
# kill the chain wrapper (from the pid you captured above, or):
pkill -f run-phases.sh
```

All changes stay uncommitted; `git status` + `git checkout -- .` reverses
cleanly.

## When done

After T4-02 reports `DONE`:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck && bun run lint && bun run test && bun run build
git status
```

If everything's green, the cutover is yours to commit. Suggested message:

```
feat(hosting): T6-04 landing page + beautiful TUI + web-TUI deploy stack

- TUI: polished splash/boot/transcript/toolcall/statusbar/input
- site/: production landing (hero + features + demo cast + /tui CTA)
- web-tui/: ttyd + Caddy container stage; entrypoint supervisor
- Playwright smoke + golden-prompt regression fixtures

Phase 08 T6-04 ✅. Closes skeleton scope; production-ready.
```
