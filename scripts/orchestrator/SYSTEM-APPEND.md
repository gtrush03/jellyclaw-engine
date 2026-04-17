# SYSTEM-APPEND — reserved for brain pane (M13)

This file is a placeholder. It will be consumed by the **brain pane** milestone
(M13) — an LLM-driven advisor that watches the rig and proposes actions
(`jc approve`, `jc rerun`, `jc tell …`). When implemented, the brain pane will
load this file as the system-prompt tail, appended after the core instructions.

## Status

Not wired yet. The `brain` tmux window is currently a `sleep infinity`
placeholder, and `jc hint <id> accept|reject` prints "M13 not yet".

## When M13 lands

- The brain pane will stream suggestions as proposals with IDs.
- George will accept/reject via `jc hint <proposal-id> accept|reject`.
- Accepted proposals will dispatch as inbox commands (`abort`, `rerun`, `tell`, etc.).
- Rejected proposals will be logged for later analysis.

## What goes here later

Short, stable, rig-specific guidance the brain needs to reason well:

- Which tiers block on which (T0 before T1, etc.).
- Which tests are flaky vs. load-bearing.
- The rig's budget gates and what "escalated" means.
- George's preferences (branching discipline, no autonomous PRs).

Keep it focused. The generic "be a helpful assistant" stuff does not belong
here — the brain agent already has that.

## Why a file (not a string in code)

So George can edit it without redeploying the daemon. Reload on change (chokidar
watch) will be the M13 implementation detail.
