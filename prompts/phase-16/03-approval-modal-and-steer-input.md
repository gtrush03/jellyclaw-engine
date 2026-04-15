# Phase 16 — Desktop App Polish — Prompt 03: Approval modal + steer input

**When to run:** After 16.02 is marked done.
**Estimated duration:** 5–6 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with 16. Verify 16.02 is ticked.

---

## Research task

Read:

1. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-16-desktop-polish.md` — step 3 (Approval modal).
2. `/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md` — approval UX, timeline layout, steer pane behavior.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §11 (permissions + approval event shape: `approval_request { requestId, tool, args, matchedRule, proposedArgs? }`), §9 (sessions — crash/resume contract), §10 (HTTP API: `POST /v1/runs/:id/permissions/:reqId/reply`, `POST /v1/runs/:id/steer`, `POST /v1/runs/:id/cancel`, `POST /v1/runs/:id/resume`).
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — what the modal must surface (matched rule text, risk classification, arg scrubbing).
5. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/03-sse-consumer-and-state.md` — the existing XState machine + SSE reducer.
6. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/04-core-ui-shell.md` — timeline component, where to slot the steer pane.

Fetch:

- `https://shiki.matsu.io/` — Shiki syntax highlighting (we already have it from Phase 15 timeline; reuse).
- `https://v2.tauri.app/plugin/notification/` — desktop notifications.
- Context7: `statelyai/xstate` — invoking, event sending, context updates.
- `https://github.com/pacocoursey/cmdk` — reference if building a richer shortcut palette.

## Implementation task

Build three tightly coupled features that together deliver human-in-the-loop control:

1. **Approval modal** — fires on `approval_request` SSE events, supports Allow / Deny / Rewrite, allow-once vs allow-always.
2. **Steer input** — right-side collapsible pane that injects mid-run user messages without interrupting the wish.
3. **Cancel + resume** — always-visible cancel button with a cost-spend guard, and a crash-recovery banner with idempotent resume.

### Files to create/modify

```
desktop/src/components/approval/ApprovalModal.tsx
desktop/src/components/approval/RiskBadge.tsx
desktop/src/components/approval/RewriteEditor.tsx
desktop/src/components/approval/ApprovalSound.ts          # WebAudio ping
desktop/src/components/steer/SteerPane.tsx
desktop/src/components/steer/SteerHistory.tsx
desktop/src/components/run/CancelButton.tsx
desktop/src/components/run/ResumeBanner.tsx
desktop/src/state/runMachine.ts                           # extend Phase 15 XState
desktop/src/lib/notify.ts                                 # Tauri notification bridge
desktop/src/lib/risk.ts                                   # risk-level heuristic
desktop/src-tauri/src/notify.rs                           # wraps plugin-notification
desktop/src-tauri/Cargo.toml                              # tauri-plugin-notification
engine/src/http/routes/runs.ts                            # ensure steer/cancel/resume endpoints exist
engine/src/runs/resume.ts                                 # idempotency-log replay
```

### Prerequisites check

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
grep -r "approval_request" engine/src/ || echo "missing — block on Phase 08"
grep -r "POST /v1/runs/:id/steer" engine/src/ || echo "missing — stub needed"
```

If the approval-request event emitter or the steer endpoint is absent, add minimal stubs before building the UI — otherwise the UI has nothing to talk to.

### Step-by-step

**1. Dependencies.**

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm add @tauri-apps/plugin-notification @radix-ui/react-dialog framer-motion@^11 react-textarea-autosize@^8
cd src-tauri && cargo add tauri-plugin-notification && cd ..
```

Register in `lib.rs`: `.plugin(tauri_plugin_notification::init())`.

**2. XState extension** (`runMachine.ts`).

Add states/events to the Phase 15 machine:

```ts
type RunEvent =
  | { type: "APPROVAL_REQUESTED"; req: ApprovalReq }
  | { type: "APPROVAL_REPLIED"; reqId: string; decision: "allow" | "deny"; scope: "once" | "always"; updatedArgs?: unknown }
  | { type: "STEER"; message: string }
  | { type: "CANCEL_REQUESTED" }
  | { type: "CANCEL_CONFIRMED" }
  | { type: "RESUME" };

interface RunContext {
  pendingApprovals: Record<string, ApprovalReq>;
  steers: Array<{ ts: number; message: string }>;
  lastCostAt: number;             // ms since last cost-contributing event, used by cancel guard
  crashedSessionId?: string;
}

// In the machine:
states: {
  running: {
    on: {
      APPROVAL_REQUESTED: { actions: "enqueueApproval" },
      APPROVAL_REPLIED:   { actions: ["sendReplyToEngine", "dequeueApproval"] },
      STEER:              { actions: ["appendSteer", "postSteerToEngine"] },
      CANCEL_REQUESTED:   { target: "confirmingCancel" },
    },
  },
  confirmingCancel: {
    on: {
      CANCEL_CONFIRMED: { target: "cancelling", actions: "postCancelToEngine" },
      CANCEL_REQUESTED: "running", // toggle off
    },
  },
  cancelling: { /* wait for engine to emit run.cancelled */ },
  crashed: { on: { RESUME: { target: "running", actions: "postResumeToEngine" } } },
}
```

Keep side-effects in `services`/actors so the machine is pure.

**3. `ApprovalModal.tsx`.**

Opens when `pendingApprovals` is non-empty. Renders the **oldest** request first (FIFO). Layout:

```
┌──────────────────────────────────────────────────────┐
│ Approval required  [Risk: HIGH]                 ×   │
│                                                      │
│ Tool:  Bash                                          │
│ Rule:  ask Bash(rm*)                                 │
│                                                      │
│ ┌─ Args ────────────────────────────────────────┐   │
│ │ {                                              │   │
│ │   "command": "rm -rf /tmp/old-cache"          │   │
│ │ }                                              │   │
│ └────────────────────────────────────────────────┘   │
│                                                      │
│ [ ] Remember this decision (allow-always)            │
│                                                      │
│   [Deny  (⌘Esc)]   [Rewrite…]   [Allow  (⌘↵)]       │
└──────────────────────────────────────────────────────┘
```

Args render via Shiki (`json` grammar, Obsidian & Gold theme). Keyboard shortcuts:

- `⌘-Enter` → Allow
- `⌘-Esc` or `Esc` → Deny
- `R` → Rewrite mode (args become editable in a CM6 JSON editor, validate against a JSON-schema hint from the engine when available)
- `⌘-.` → same as Deny (mac convention)

Allow-once vs allow-always toggle: when checked, the reply also writes a new rule. Send this as part of the reply so the engine persists atomically:

```json
POST /v1/runs/:id/permissions/:reqId/reply
{ "decision": "allow", "scope": "always", "updatedArgs": null,
  "rule": { "action": "allow", "pattern": "Bash(rm -rf /tmp/*)" } }
```

The engine validates the rule pattern matches the current args; on success it appends the rule to the user scope (or project scope if a project is active — toggle in the footer of the modal).

**4. `RiskBadge.tsx` + `lib/risk.ts`.**

Pure classifier:

```ts
export function classifyRisk(tool: string, args: any): "low" | "medium" | "high" {
  if (tool === "Bash") {
    const cmd = String(args?.command ?? "");
    if (/\b(rm\s+-rf|sudo|curl\s+.*\|\s*sh|dd\s+if=)/i.test(cmd)) return "high";
    if (/\b(git\s+push|npm\s+publish|cargo\s+publish|brew\s+install)/i.test(cmd)) return "medium";
    return "low";
  }
  if (tool === "Edit" || tool === "Write") {
    const path = String(args?.path ?? args?.file ?? "");
    if (/\.ssh|\.env|credentials|secrets/i.test(path)) return "high";
    if (/node_modules|dist|build|target/i.test(path)) return "low";
    return "medium";
  }
  if (tool === "WebFetch") return "medium";
  if (tool.startsWith("mcp__")) return "medium";
  return "low";
}
```

Badge colors: low=green, medium=amber, high=red with a subtle red pulse (Framer Motion 2s loop).

**5. Sound + notification.**

- WebAudio: a 440Hz→660Hz sine chirp, 180ms, at -24dBFS. Off by default — toggled in Settings → Telemetry (`sounds: { approvalPing: boolean }`).
- Notification: fire ONLY when `document.visibilityState !== "visible"`. Tauri `@tauri-apps/plugin-notification` with action buttons where supported (macOS 14+, Windows 11; Linux fallback = click-to-focus).

```ts
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export async function notifyApproval(req: ApprovalReq) {
  if (document.visibilityState === "visible") return;
  if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
  await sendNotification({
    title: `Approval needed: ${req.tool}`,
    body: typeof req.args?.command === "string" ? req.args.command.slice(0, 120) : "click to review",
    icon: "icons/icon.png",
  });
}
```

**6. `SteerPane.tsx`.**

Right sidebar, collapsible (width 320px open / 44px closed), toggle persisted to localStorage. Contents:

- Textarea (autoresize via `react-textarea-autosize`)
- "Send" button + `⌘-Enter` shortcut
- History list below: last 5 steers with relative timestamp + chevron to expand
- `⌘-Shift-S` (registered at App level) focuses the textarea

On send:

```ts
POST /v1/runs/:id/steer { "message": "actually use pytest, not unittest" }
```

Engine injects the message as a user turn into the in-flight conversation without cancelling tool calls. Append to `context.steers`; render an inline `"↳ steered"` marker in the timeline at the point it landed (engine emits `steer.injected { ts }`).

**7. `CancelButton.tsx`.**

Always visible in the run header when state is `running | approving | steering`. Ghost style normally; red-bordered on hover. Click:

- If `Date.now() - context.lastCostAt < 10_000` → confirm dialog: "A tool call is in flight and may have consumed tokens in the last 10s. Cancel anyway?"
- Else → cancel immediately.

`context.lastCostAt` is updated by the SSE reducer on every `tool.result` and `assistant.delta`.

```ts
POST /v1/runs/:id/cancel
// engine responds 202, then emits run.cancelled once teardown completes
```

**8. `ResumeBanner.tsx`.**

On app start: `GET /v1/runs?status=killed,crashed&since=-24h`. If any match, show a top banner:

> Last session `<short-id>` ended unexpectedly at `<time>`. [Resume] [Archive]

Resume → `POST /v1/runs/:id/resume`. Engine replays the idempotency log — every tool call that was committed pre-crash is skipped, every pending one is retried. This is the contract from SPEC §9; trust it, don't re-implement it in the UI.

**9. Engine-side reply handler.**

```ts
// engine/src/http/routes/runs.ts
router.post("/v1/runs/:id/permissions/:reqId/reply", async (req, res) => {
  const body = ReplySchema.parse(req.body);
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();
  await run.replyApproval(req.params.reqId, body);

  if (body.scope === "always" && body.rule) {
    if (!ruleMatchesArgs(body.rule, body.updatedArgs ?? run.approvalArgs(req.params.reqId))) {
      return res.status(400).json({ error: "rule does not match args" });
    }
    await permissions.appendRule(body.rule, "user");
  }
  res.json({ ok: true });
});
```

Reply schema:

```ts
const ReplySchema = z.object({
  decision: z.enum(["allow", "deny"]),
  scope: z.enum(["once", "always"]).default("once"),
  updatedArgs: z.unknown().optional(),
  rule: z.object({ action: z.enum(["allow", "deny", "ask"]), pattern: z.string() }).optional(),
});
```

### Tests to add

- Vitest: `classifyRisk` — 20-case fixture.
- Vitest: XState — approval enqueued → replied → dequeued; cancel during approving → posts cancel.
- Engine integration: reply with invalid rule returns 400; reply with scope=always persists to user rules file.
- Playwright E2E: dispatch a wish that fires `Bash(rm *)` → modal opens → press `R`, edit args, `⌘-Enter` → engine executes updated args.
- Playwright E2E: dispatch wish → click Cancel within 10s → confirm dialog appears; outside 10s → immediate cancel.

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm typecheck && pnpm test
pnpm tauri dev
# Trigger approval: prompt "delete all .tmp files in /tmp"
# Modal appears: risk=HIGH, rule=ask Bash(rm*), args highlighted JSON
# Press R → args editable → change to "rm /tmp/specific.tmp" → ⌘-Enter
# Engine log shows updated args executed
# Steer pane: ⌘-Shift-S focuses it → send "also delete .log files" → timeline shows ↳ steered
# Kill engine mid-run → reopen app → Resume banner → click Resume → run continues
```

### Common pitfalls

- **Event ordering.** Multiple `approval_request` events can arrive back-to-back. Keep a queue; never clobber. If user dismisses without replying, fall back to `deny` after 5 minutes — engine treats missing replies as deny at 10 min anyway.
- **Args with secrets.** SSE stream is already scrubbed, but user-edited args in Rewrite may contain pasted keys. Scrub again on display + before sending to Sentry breadcrumbs.
- **`⌘-Enter` vs form submit.** The Rewrite CM6 editor intercepts `Enter`. Bind `⌘-Enter` at the modal root via a capture-phase listener.
- **Cancel race.** User clicks Cancel while an `approval_request` is pending. Engine handles "cancel before reply" → resolve approval as `deny`, tear down. UI sends cancel only; do NOT also send deny-reply (409).
- **Resume idempotency** relies on the engine's idempotency log. If `~/.jellyclaw/sessions/<id>/` was manually deleted, resume returns 410. Show "Session data missing" and offer Archive.
- **Notification permission** prompt fires on first approval. Pre-flight it during onboarding.
- **Linux notifications** need a session D-Bus + notification daemon (dunst/mako). On minimal WMs, silently fail with a debug log; don't alert the user.
- **Steer during tool call.** Engine may be mid-tool-call. Steers queue until the tool returns, then inject as user message BEFORE the next assistant turn. Document this in the pane tooltip.
- **XState v5 `send`.** Use the `useActor()` hook's memoized `send`; don't pull it from `useRef`.

### Why this matters

Approval is the hinge between "autonomous agent that scares people" and "collaborative tool people trust with `sudo`". Slow, unclear, or missing approval UX pushes users to YOLO (defeating the point) or rage-deny (making the agent useless). Steer + resume turn multi-minute runs from "hope it works" into "drive it like a car." This prompt is the single biggest trust lever in the desktop app.

---

## Session closeout

Paste `COMPLETION-UPDATE-TEMPLATE.md` with `<NN>=16`. Mark 16.03 complete. Phase 16 status 🔄. Commit `docs: phase 16.03 approval + steer + resume`. Next: `prompts/phase-16/04-auto-update-and-crash-reporting.md`.
