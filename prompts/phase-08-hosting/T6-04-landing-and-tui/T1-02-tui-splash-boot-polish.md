---
id: T1-02-tui-splash-boot-polish
tier: 1
title: "Polish splash + boot animation + jellyfish spinner"
scope:
  - engine/src/tui/components/splash.tsx
  - engine/src/tui/components/boot-animation.tsx
  - engine/src/tui/components/jellyfish.tsx
  - engine/src/tui/components/tool-spinner.tsx
  - engine/src/tui/jellyfish-spinner.ts
  - engine/src/tui/jellyfish-spinner.test.ts
depends_on_fix:
  - T1-01-tui-theme-typography
tests:
  - name: splash-snapshot
    kind: shell
    description: "splash component renders target mockup from design brief"
    command: "bun run test engine/src/tui/components/splash"
    expect_exit: 0
    timeout_sec: 60
  - name: spinner-cadence
    kind: shell
    description: "jellyfish spinner frame cadence within tolerance; honors NO_COLOR"
    command: "bun run test engine/src/tui/jellyfish-spinner"
    expect_exit: 0
    timeout_sec: 30
  - name: no-anim-guard
    kind: shell
    description: "JELLYCLAW_NO_ANIM=1 disables boot animation"
    command: "bun run test engine/src/tui/components/boot-animation"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 40
max_cost_usd: 12
max_retries: 3
estimated_duration_min: 30
---

# T1-02 — Splash + boot + spinner polish

## Context
Design brief § 2 includes target ASCII mockups for splash and boot. Goal is
an alive, deliberate boot sequence (≤800ms total) that ends on a calm splash
with the wordmark + BYOK line + "press enter to start".

Keep the boot short. No cute 3-second intros. If `JELLYCLAW_NO_ANIM=1` or
`NO_COLOR` set, skip straight to splash with no animation.

## Work

### 1. `boot-animation.tsx`
- Staggered reveal: logo → wordmark → tagline → prompt, 150ms between steps.
- Wordmark uses `brand.ts` row-accent gradient across letters (pick per-char
  color via lerp between jellyCyan → medusaViolet).
- Heartbeat indicator (1 beat / 2 frames) uses `amberEye`.
- Respects `JELLYCLAW_NO_ANIM=1` → renders final frame immediately.
- Honors `NO_COLOR` env (Ink respects it if colors are undefined — set them
  to undefined rather than hex when guarded).

### 2. `splash.tsx`
- Final frame from boot-animation stays on screen.
- Lines: wordmark, 1-line pitch (from design brief), `ENTER to start` hint,
  version string bottom-right (from `engine/package.json` `version`).
- Press Enter → onStart callback (existing contract). Escape → quit.

### 3. `jellyfish-spinner.ts` + `jellyfish.tsx`
- Spinner is 8 frames (existing). Tweak to match design brief B's cadence
  guidance — if brief suggests a different frame count or timing, use that.
- Add a `variant: 'tentacle' | 'bell' | 'minimal'` prop (default 'tentacle').
- `minimal` is 3 frames `.` `..` `...` for dumb terms.

### 4. `tool-spinner.tsx`
- Narrow spinner shown inline in tool-call banner. Just use `jellyfish-spinner`
  with `variant='minimal'` + the tool accent color.

### 5. Tests
- Update snapshots to match new mockups.
- `jellyfish-spinner.test.ts` asserts frame cadence ≈ 120ms ±10%.
- `boot-animation.test.tsx` covers: normal render, `JELLYCLAW_NO_ANIM=1`
  skip, `NO_COLOR` strip, escape-to-quit.

## Acceptance criteria
- `bun run test engine/src/tui/components/{splash,boot-animation}` passes.
- `bun run test engine/src/tui/jellyfish-spinner` passes.
- `bun run typecheck` + `bun run lint` clean.
- Manual check: `node engine/bin/jellyclaw tui` shows the new boot → splash
  → input flow within 1s total (add a timer note to SUMMARY).

## Out of scope
- Transcript / tool-call polish — T1-03.
- Status bar / input box — T1-04.

## Verification the worker should self-run before finishing
```bash
bun run test engine/src/tui/components/splash engine/src/tui/components/boot-animation engine/src/tui/jellyfish-spinner
bun run typecheck
# Manual spawn (non-blocking — use node-pty-free smoke from T0-01)
node engine/src/tui/scripts/smoke-spawn-exit.mjs && echo "tui spawn ok"
echo "DONE: T1-02-tui-splash-boot-polish"
```
