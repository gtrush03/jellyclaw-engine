---
phase: 13
name: "Make jellyclaw default in Genie"
duration: "2 days + 72h burn-in"
depends_on: [12]
blocks: [14, 17]
---

# Phase 13 — Flip jellyclaw to default

## Dream outcome

After 72 hours of observed parity or better, `GENIE_ENGINE` defaults to `jellyclaw` in production Genie. Claurst stays one env var away as a rollback lever. Cost + latency + error-rate telemetry is reviewed and published in `BURN-IN-REPORT.md`.

## Deliverables

- Genie PR that flips default: `process.env.GENIE_ENGINE ?? "jellyclaw"`
- `BURN-IN-REPORT.md` after 72 h
- Monitoring dashboard (Grafana/console) with 3 panels: cost, latency p50/p95, error rate
- Rollback runbook `docs/rollback.md`

## Step-by-step

### Step 1 — Pre-flight
- Phase 12 acceptance fully met
- Scenario tier green 3 runs in a row
- At least 1 week of dogfooding by owner (George) on daily wishes

### Step 2 — Metrics plumbing
Add structured log lines to Genie on wish start + end:
```
{ts, engine, wish_id, duration_ms, input_tokens, output_tokens, cost_usd, status}
```
Aggregate to a JSONL file or a lightweight DB.

### Step 3 — Flip default
One-line change in `engine-factory.mjs`:
```js
const name = process.env.GENIE_ENGINE ?? "jellyclaw";
```
Ship to prod.

### Step 4 — 72 h burn-in
Monitor:
- Error rate vs baseline (should be <= baseline + 10%)
- p50/p95 latency (<= +20%)
- Cost/wish (<= +15% — accept a bit for richer features)
- Any new stack traces
- User-reported issues

Daily check-in at 24 h / 48 h / 72 h; log findings into `BURN-IN-REPORT.md`.

### Step 5 — Rollback trigger
If any of:
- Error rate >1.5× baseline
- Cost >1.5× baseline
- Crash on a common wish

→ set `GENIE_ENGINE=claurst` in the Genie service env, restart, file issues.

### Step 6 — Final report
At 72 h:
- Pass → keep default, close phase
- Fail → rollback, document failure classes, create per-class issue, schedule fixes, re-attempt

## Acceptance criteria

- [ ] Default flipped in code
- [ ] 72 h burn-in complete with no rollback event
- [ ] BURN-IN-REPORT.md published
- [ ] Rollback runbook tested (simulated on staging)
- [ ] Cost delta within budget
- [ ] No P0 issues open

## Risks + mitigations

- **Silent cost regression** → cost panel; alert at 1.3×.
- **Feature gap only discovered in production** → structured log of unhandled code paths; triage daily.
- **Dogfooding blind spot** — George's wishes don't exercise all flows — → include Genie's scheduled jobs in burn-in scope.

## Dependencies to install

None new.

## Files touched

- `genie-2.0/src/core/engine-factory.mjs` (one line)
- `genie-2.0/BURN-IN-REPORT.md`
- `genie-2.0/docs/rollback.md`
- `genie-2.0/src/core/metrics.mjs` (new, structured logs)
