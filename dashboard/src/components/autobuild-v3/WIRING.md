# autobuild-v3 WIRING

> How the integration layer (Agent A) and the component layers (Agents B + C)
> plug into each other. Read this before refactoring the module boundary.

## File ownership

| Path                                          | Owner  | Purpose                                        |
| --------------------------------------------- | ------ | ---------------------------------------------- |
| `pages/AutobuildPage.tsx`                     | A      | Route component — renders `<MissionControl />` |
| `autobuild-v3/MissionControl.tsx`             | A      | Root — owns hotkeys, tab routing, empty states |
| `autobuild-v3/AutobuildLayout.tsx`            | A      | 3-column variant (legacy, kept for fallback)   |
| `autobuild-v3/ContextTabs.tsx`                | A      | Live/Queue/History/Approvals tab bar           |
| `autobuild-v3/AlertStack.tsx`                 | A      | Red-state banner stack                         |
| `autobuild-v3/ConfirmModal.tsx`               | A      | Destructive confirm modal (Stop / HALT)        |
| `autobuild-v3/KeyboardHelp.tsx`               | A      | `?` overlay listing bindings                   |
| `autobuild-v3/stubs.tsx`                      | A      | Named placeholder components keyed to contract |
| `autobuild-v3/contracts.ts`                   | A      | Shared prop interfaces + context shape         |
| `autobuild-v3/index.ts`                       | A      | Barrel                                         |
| `autobuild-v3/logic.ts`                       | A      | Pure helpers (queue bucketing, activity diff)  |
| `autobuild-v3/useAutobuildRoute.ts`           | A      | Hash-route state for the autobuild subtree     |
| `autobuild-v3/useRigAlerts.ts`                | A      | Alert-stack source of truth                    |
| `autobuild-v3/useNextAction.ts`               | A      | "What should I do next" hint                   |
| `hooks/useHashRoute.ts`                       | A      | Top-level hash-route detection                 |
| `hooks/useAutobuildHotkeys.ts`                | A      | Page-scoped keyboard dispatcher                |
| `hooks/useActivityFeed.ts`                    | A      | Rolling synthetic event buffer                 |
| `autobuild-v3/MissionStrip.tsx`               | B      | Top strip (status + controls + tier + budget) |
| `autobuild-v3/RigControls.tsx`                | B      | Cluster of rig-lifecycle buttons               |
| `autobuild-v3/UpNextRail.tsx`                 | B      | Queue rail on the right                        |
| `autobuild-v3/TierProgressTrack.tsx`          | B      | 5-cell tier progress strip                     |
| `autobuild-v3/BudgetPanel.tsx`                | B      | Daily + per-session budget meter               |
| `autobuild-v3/NextActionHint.tsx`             | B      | Imperative "do this next" sentence             |
| `autobuild-v3/SessionHeaderV3.tsx`            | C      | Session identity chrome                        |
| `autobuild-v3/LogTerminal.tsx`                | C      | Live log tail                                  |
| `autobuild-v3/PhaseTimeline.tsx`              | C      | Lifecycle dots with timing                     |
| `autobuild-v3/ActivityFeed.tsx`               | C      | Rolling event stream                           |
| `autobuild-v3/ApprovalCard.tsx`               | C      | Approve/reject widget for a review-pending run |
| `autobuild-v3/EscalationCard.tsx`             | C      | Retry/skip widget for an escalated run         |
| `autobuild-v3/EmptyRigStateV3.tsx`            | C      | First-run CTA                                  |
| `autobuild-v3/LiveSessionPane.tsx`            | C      | Middle deck — composes the above              |

## How stubs fit in

`stubs.tsx` exports `<Name>Stub` placeholders for every sibling-owned
component, each keyed to the same prop interface as the real component. They
render a hairline debug box with the component name + a short prop snapshot.

When to reach for a stub:

1. **Isolated tests.** Importing `ApprovalCardStub` from `./stubs` (or the
   barrel) lets a vitest case mount the surface without needing a
   TanStack-Query provider.
2. **Storybook / dev scaffolding.** A dev page can show every stub side-by-
   side to eyeball the contract.
3. **Fallback during parallel development.** If a sibling pulls their real
   component and the build breaks, swap the import from the real file to the
   stub (`from './stubs'`) as a temporary bridge while we coordinate.

Stubs do **not** replace real components in production. The barrel re-exports
the real components by default — stubs are only available by their `*Stub`
name.

## Contracts rule of thumb

Every sibling-owned component MUST import its props type from
`./contracts` (re-exported by the barrel). If a new field is needed, update
`contracts.ts` first and land that in a shared PR before the consumer lands.
The integration layer (Agent A) treats the contracts file as a source of
truth — any divergence in the real component's prop signature is a bug.

## Keyboard priorities

Global dispatch lives in `useAutobuildHotkeys`. `MissionControl` layers a
small `1..4` tab-switching listener on top. If a child needs to capture a
key (e.g. a modal), it should either set the parent's `hotkeysEnabled` flag
to `false` via a future prop, or call `e.stopPropagation()` inside a local
`onKeyDown`. Do NOT add a third top-level listener.

## Route rule of thumb

`useHashRoute()` decides "are we on the autobuild page at all?" and lives at
the app level. `useAutobuildRoute()` refines the subtree state once we know
we are. Mixing them in the same component is a smell — if you find yourself
needing both, compute once at the parent and pass down.
