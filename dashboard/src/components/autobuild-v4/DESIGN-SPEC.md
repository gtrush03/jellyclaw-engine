# Autobuild v4 — Design Spec

## Layout (verbatim)

```
┌─────────────────────────────────────────────────────────────┐
│  AUTOBUILD                                                  │
│  ● ONLINE · pid 84395 · 12m up · $5.07/$25 today      [◼]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  T0 ████▌  T1 ░░░░░  T2 ░░░░░  T3 ░░░░░  T4 ░░░░░    4/42  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  NOW                                                        │
│  ▶ T1-01 cap-tool-output-bytes               · 2m 14s       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ spawn ✓  work ●  self ○  test ○  commit ○           │    │
│  │                                                     │    │
│  │ [live log tail — 8 most recent lines, auto-scroll]  │    │
│  │                                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│  [abort]  [skip]  [tell…]                                   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  UP NEXT  (37)                                              │
│   T1-02 handle-max-tokens-stop-reason       est 45 min      │
│   T1-03 raise-max-output-tokens-default     est 15 min      │
│   T1-04 fix-todowrite-session               est 30 min      │
│   + 34 more ▾                                               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  DONE  (4)                                                  │
│   ✓ T0-05 gitignore-autobuild-dirs   abc1234  1m 25s  $0.25 │
│   ✓ T0-04 thread-cli-flags           def5678  4m 12s  $1.55 │
│   ✓ T0-03 fix-hardcoded-model-id     789abcd  7m      $2.01 │
│   ✓ T0-02 serve-reads-credentials    ef12345  10m 23s $1.25 │
│                                                             │
│   Click any row to see what changed — diff, test output,   │
│   commit SHA, tmux log.                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Component tree

```
AutobuildV4Page
└── AutobuildV4
    ├── StatusHeader
    ├── TierTrack
    ├── NowCard            (or EmptyState when offline+0 runs)
    ├── UpNextList
    │   └── EscalationRow  (top, if any)
    └── DoneFeed
        ├── ApprovalRow    (top, if any)
        └── DoneRow[]      (each expands to DoneDetail inline)
```

## Props

```ts
type Fn = () => void; type IdFn = (id: string) => void;
// Hash-route wrapper
interface AutobuildV4PageProps {}
// Root: owns hooks + bucketizes
interface AutobuildV4Props {}
// Rig pill, pid, uptime, budget, controls
interface StatusHeaderProps { rigProcess: RigProcess; budgetSpent: number; budgetCap: number; hasHistory: boolean; onStart: Fn; onStop: Fn; onReset: Fn; }
// Tier strip; done = rig.completed ∩ prompts
interface TierTrackProps { tiers: { tier: string; done: number; total: number }[]; totalDone: number; totalAll: number; }
// Hero in-flight run; null = idle
interface NowCardProps { run: Run | null; onAbort: IdFn; onSkip: IdFn; onTell: (id: string, msg: string) => void; }
// Queued preview; collapse-after-3
interface UpNextListProps { queued: QueuedPrompt[]; escalated: Run[]; onRetry: IdFn; onSkipEsc: IdFn; onApproveAnyway: IdFn; }
// Completed feed + approvals
interface DoneFeedProps { completed: Run[]; awaitingApproval: Run[]; allComplete: boolean; onApprove: IdFn; onReject: IdFn; }
// Row toggles inline DoneDetail
interface DoneRowProps { run: Run; expanded: boolean; onToggle: Fn; }
// Slide-down: diff, tests, journal, log
interface DoneDetailProps { runId: string; commitSha: string; diffStat: string; tests: TestResult[]; }
// Red row atop UpNextList
interface EscalationRowProps { run: Run; onRetry: Fn; onSkip: Fn; onApproveAnyway: Fn; }
// Gold row atop DoneFeed
interface ApprovalRowProps { run: Run; onApprove: Fn; onReject: Fn; }
// Centered Press Start
interface EmptyStateProps { onStart: Fn; }
```

## State flow

- `useRuns()` → AutobuildV4 (bucketizes running/queued/review/escalated/completed).
- `useRigProcess()` → StatusHeader.
- `usePrompts()` → TierTrack + UpNextList (joined `rig.completed`).
- `useRigControl()` → StatusHeader.
- `useRigAction(runId)` → NowCard, ApprovalRow, EscalationRow.
- `useRunLog(runId)` → NowCard + DoneDetail.

## Render states

- Offline + 0 runs → EmptyState only.
- Online + 0 in-flight → NowCard muted Idle.
- Running → NowCard active (dots + tail).
- History → DoneFeed; ApprovalRow on top.
- Escalated → EscalationRow atop UpNextList.
- All 42 done → gold `✓ complete` pill; Start dims.

## Brand

Obsidian `#050505`, gold `#928466`, hairlines `rgba(146,132,102,0.18)`, backdrop-blur glass. Mono (`ui-monospace`) for IDs/SHAs/costs/times; sans (`ui-sans-serif`) for labels. Honor `prefers-reduced-motion`.

## Reject

NO tabs, columns, side panels, modals. DoneDetail is inline slide-down. Won't fit one scroll → reject.
