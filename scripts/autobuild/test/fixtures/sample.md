---
id: T9-99-sample-fixture
tier: 9
title: "Sample fixture for unit tests"
scope:
  - "engine/src/**/*.ts"
  - "test/**/*"
depends_on_fix: []
tests:
  - name: sample-echo
    kind: shell
    description: "echo ok"
    command: "echo ok"
    expect_exit: 0
    expect_stdout: "ok"
human_gate: false
max_turns: 5
max_cost_usd: 1
max_retries: 1
estimated_duration_min: 1
---

# T9-99 — Sample fixture

This prompt exists so the unit test can parse real YAML frontmatter with a
realistic shape. Do not queue this — it's never meant to run.
