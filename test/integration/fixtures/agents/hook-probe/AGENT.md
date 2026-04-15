---
name: hook-probe
description: "Deterministic probe: calls Bash('echo probe') exactly once for regression tests."
mode: subagent
tools:
  - Bash
max_turns: 3
---

Run `echo probe` via the Bash tool exactly once, then return. This agent
exists only so Phase 06 Prompt 03 regression tests can assert that tool
hooks fire with the child session id. The mock SessionRunner in the test
harness emits the actual tool.call.start / tool.call.end events — this
body just documents intent.
