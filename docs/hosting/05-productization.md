# jellyclaw — Productization Package

**Status:** Draft v1 (2026-04-17)
**Owner:** Agent 5 (Wrapper / Ops / Launch)
**Scope:** Everything that turns jellyclaw from "thing that works" into "business that earns" — pricing, billing, observability, docs, launch, metrics, risks.
**Horizon:** 60 days. Solo-founder pace. LemonSqueezy-first.
**Companion docs:** `01-fly-deploy.md` (Agent 1), `02-http-api.md` (Agent 2), `03-tui-distribution.md` (Agent 3), `04-browser-cloud.md` (Agent 4).

---

## § TL;DR — 60-day plan in 10 bullets

1. **Pricing shape:** Free (10 msgs/day) → Hobby $9 → Pro $29 → Team $99/seat. BYOK everywhere from Hobby up. No Opus on Free. All prices tested against Anthropic wholesale cost + Claude Code $20 Pro + Cursor $20 Pro.
2. **Billing:** LemonSqueezy from day 1. 5% + $0.50 fee but it's Merchant of Record (handles VAT, sales tax, EU invoicing) — that saves 40+ hours of founder time vs Stripe. Revisit at $50k MRR.
3. **Usage model:** Hybrid. Flat monthly sub gets an **included message allowance**, then pay-per-1k-tokens overage (auto-billed). Overage triggers webhook → LemonSqueezy `updateSubscriptionItem` for metered lines.
4. **Metering:** Use the `usage.updated` AgentEvent already in the stream. Pipe to Tigris/S3 NDJSON → nightly Worker reconciles against Anthropic's usage report → LemonSqueezy invoice adjustment.
5. **Observability:** Fly built-in Grafana + Sentry free → Axiom free (500GB/mo) + BetterStack uptime free tier. **Total $0/mo at launch.** Upgrade triggers at 10k daily users or when Sentry free cap breaks.
6. **Docs:** Astro Starlight at `jellyclaw.dev/docs`. Free, Cloudflare Pages hosting. Search via Pagefind.
7. **Support:** Email + GitHub Discussions. Crisp free tier widget on landing. Discord only after 500 users.
8. **60-day calendar:** W1-2 private alpha (hand-pick 20 from George's X followers) → W3-4 public beta + 1 launch video → W5-6 paid launch + PH/HN day → W7-8 iterate pricing from real data.
9. **Assets:** Re-cut the G-Class, Bentley, and S-Class configurator demos into 3×90-sec videos. One talking-head 3-min pitch. Landing page with Twelve-Tone hero + inline demo player.
10. **Risks:** Anthropic org key rate-limiting is the #1 kill-risk — Tier 4 is the baseline, custom scale tier is the upgrade. Abuse via browser MCP is #2 — Agent 4 owns containment; wrapper side adds 60/min rate bucket per user.

---

## § Pricing Tier Matrix

| | **Free** | **Hobby** | **Pro** | **Team** |
|---|---|---|---|---|
| **Price (monthly)** | $0 | $9 | $29 | $99/seat, min 3 seats |
| **Price (annual)** | — | $7 | $24 | $82/seat |
| **Included messages/day** | 10 | 100 | 500 | 1,500 |
| **Included tokens/month** | ~500k | ~8M | ~40M | ~150M/seat |
| **Models** | Haiku 4.5 only | Haiku + Sonnet 4.6 | All (Haiku / Sonnet / Opus) | All + early access |
| **Opus cap** | — | 20 msgs/day | 100 msgs/day | 300/seat/day |
| **MCP servers** | 2 (Playwright + webfetch) | 5 | 20 | Unlimited |
| **Chrome browser minutes** | 10 min/day | 2 hr/day | 10 hr/day | 40 hr/seat/day |
| **BYOK (own Anthropic key)** | — | Yes | Yes | Yes |
| **Session history retention** | 24 hours | 7 days | 30 days | 90 days |
| **Overage after cap** | Hard block | Auto pay-per-use $0.02/msg | Auto pay-per-use $0.015/msg | Auto, $0.010/msg |
| **Support** | Community (GH Discussions) | Email, 72h SLA | Email, 24h SLA | Email + Slack-shared, 4h SLA |
| **Team admin console** | — | — | — | Yes |
| **SSO / SAML** | — | — | — | +$200/mo enterprise add-on |
| **Audit log export** | — | — | Last 30d CSV | Full, SIEM-compatible |
| **Priority routing** | — | — | Yes | Yes |
| **Early features** | — | — | Flag-gated | All on by default |

Design notes:

- **Free is a demo, not a product.** Enough to try, not enough to run a real workflow. Haiku-only because Haiku wholesale is ~$1/M input — a 10 msgs/day free user at ~5k tokens/msg costs us about $0.05/day ($1.50/mo) max. Sustainable at 5k free users.
- **Hobby at $9** is the impulse-purchase tier — matches Gumroad/GitHub Sponsors psychological price. Sonnet included makes it real. 100 msgs/day with a 500/mo overage safety.
- **Pro at $29** is the "I use this daily" tier. Priced $9 over Cursor Pro ($20) and Claude Code Pro ($20) because jellyclaw offers (a) BYOK, (b) Opus access, (c) cloud browser. Each is a real differentiator — we're not undercutting, we're stacking value.
- **Team at $99/seat with 3-seat minimum** ($297/mo floor) is where solo founders become teams. Matches Cursor Business ($40) but bundles cloud browser-minutes, MCP unlimited, and shared team audit log — items Cursor doesn't compete on.
- **BYOK from Hobby up** is the killer pricing feature. It caps our token cost exposure: BYOK users pay $9 for the wrapper + their own Anthropic bill. Wrapper margin is ~100% on BYOK seats because there is no inference cost.

Competitor comps ([Claude Code pricing](https://www.verdent.ai/guides/claude-code-pricing-2026), [Cursor pricing](https://www.chargebee.com/pricing-repository/cursor)):

| Competitor | Tier | $/mo | What they give | What we add |
|---|---|---|---|---|
| Anthropic Claude Code | Pro | $20 | Claude Code CLI, ~44k tokens / 5h | BYOK, cloud browser, MCP ecosystem |
| Anthropic Claude Code | Max 5x | $100 | 5× Pro budget | We're cheaper + multi-user Team tier |
| Anthropic Claude Code | Max 20x | $200 | 20× Pro budget | — (we concede at this tier for heavy solo) |
| Cursor | Pro | $20 | IDE + $20 in credits | Headless daemon + MCP + Chrome |
| Cursor | Business | $40/seat | Team features | Our Team tier is similar $ with cloud browser |
| OpenRouter | Pay-as-go | +5.5% on credits | Model marketplace | We bundle tools/skills/agent loop |

---

## § Pricing Math — Wholesale → Retail

**Anthropic wholesale (source: [claude.com/pricing](https://claude.com/pricing)):**

| Model | Input $/M | Output $/M | 5m Cache Write $/M | 5m Cache Read $/M |
|---|---|---|---|---|
| Opus 4.7 | $5 | $25 | $6.25 | $0.50 |
| Sonnet 4.6 | $3 | $15 | $3.75 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |

### Math for 1,000 Opus messages (wholesale)

Assume a realistic agent turn:
- Input: 8k tokens (system + CLAUDE.md + skills + user prompt + tool defs)
  - With 85% cache hit rate per SPEC §7 targets: 1.2k fresh input + 6.8k cache reads
- Output: 1.5k tokens (tool calls + reasoning + final response)

**Per-message wholesale cost (Opus, cached):**
- Fresh input: 1.2k × $5/M = $0.0060
- Cache reads: 6.8k × $0.50/M = $0.0034
- Output: 1.5k × $25/M = $0.0375
- Cache writes (amortized over 50-msg session): (8k × $6.25/M) / 50 = $0.0010
- **Total: ~$0.048/message**

**1,000 Opus messages = ~$48 wholesale.**

Without caching (OpenRouter path or cache miss): ~$0.085/msg = **$85/1,000 Opus msgs**. This is why the SPEC mandates anthropic-direct as default.

### Math for Sonnet (the default model for most agent work)

Same assumptions, Sonnet pricing:
- Fresh input: 1.2k × $3/M = $0.0036
- Cache reads: 6.8k × $0.30/M = $0.0020
- Output: 1.5k × $15/M = $0.0225
- Cache writes amortized: $0.0006
- **Total: ~$0.029/message**

**1,000 Sonnet messages = ~$29 wholesale.**

### Break-even check on Pro tier ($29/mo)

Pro gives 500 msgs/day = up to 15,000 msgs/month. If average user does 200 msgs/day (empirical guess, validate in beta):
- 6,000 msgs/mo × 70% Sonnet + 25% Opus + 5% Haiku
- Sonnet: 4,200 × $0.029 = $121.80
- Opus: 1,500 × $0.048 = $72.00
- Haiku: 300 × $0.010 = $3.00
- **Cost to serve Pro power user: ~$197/mo. Revenue: $29. Margin: -580%.**

**That's a problem.** Options:

**A. Tighten the Opus cap.** 100 Opus msgs/day = 3,000/mo max. Cost: 3,000 × $0.048 = $144. Still underwater.

**B. Price Pro at $49, give 300 Opus msgs/mo.** Cost: $14.40 Opus + $82 Sonnet mean = ~$96. Margin -96%. Better but still red.

**C. Re-architect — most users are NOT power users.** Real-world P50 usage on Cursor is ~15% of cap. Applying 15% to our model:
- P50 Pro user: 900 msgs/mo × same mix = **$30/mo cost.** Margin 0%. Break-even.
- P90 Pro user: 4,500 msgs/mo × same mix = **$148/mo cost.** Margin -410%.

**D. The real answer: cap Opus hard + rely on BYOK for power users.**

Revised Pro pricing:
- $29/mo includes **500 msgs/day total, but 100 Opus msgs/DAY max** (not month) — and the Opus cap resets daily.
- A 100/day Opus power user over 30 days = 3,000 Opus msgs. That's $144 wholesale.
- Plus 12,000 Sonnet/Haiku msgs at ~$0.025 avg = $300 wholesale.
- Total: $444/mo cost. Revenue $29. **Still underwater at heavy use.**

**E. The actual answer: overage auto-bill + push heavy users to BYOK.**

Pro tier revised:
- $29/mo includes **$25 in inference credit** (wholesale cost). That's the hard cap.
- After credit depletes → auto pay-per-use at $0.015/msg average (charged at retail, ~25% margin over wholesale).
- Users who burn $25 of credit in days (power users) get a dashboard nag: "You're on track to spend $200/mo overage — switch to BYOK and save 80%."
- BYOK Pro at $29/mo is pure margin — user pays their own Anthropic bill.

**This is what Cursor did in June 2025** ([their repricing lesson](https://www.wearefounders.uk/how-cursor-ai-hit-100m-arr-in-12-months-the-freemium-fueled-rocket-ship-taking-on-github-copilot/)) — moved from fixed-request to credit-pool. The rollout was rocky, but the model is correct. Learn from their communication mistakes: **announce credit model at launch, never retrofit it.**

### Final pricing decision (what goes in the matrix)

Already reflected above. Key rules:

1. **Every tier has an included inference budget measured in wholesale $, not messages.** Messages are marketing; budget is reality.
   - Free: $1.50/mo wholesale budget
   - Hobby: $6/mo wholesale budget (margin: $3)
   - Pro: $22/mo wholesale budget (margin: $7)
   - Team: $75/seat/mo wholesale budget (margin: $24/seat)
2. **Overage auto-bills at 1.25× wholesale.** Users accept because it's transparent and still cheaper than running `claude` locally for occasional bursts.
3. **BYOK is pure-margin.** Encourage it. Target 40% of paid users on BYOK by month 6.

---

## § Billing Mechanics — LemonSqueezy

### Decision: LemonSqueezy, not Stripe

**LemonSqueezy wins on three axes for a solo founder at launch ([UserJot comparison](https://userjot.com/blog/stripe-polar-lemon-squeezy-gumroad-transaction-fees)):**

1. **Merchant of Record.** LS handles EU VAT, US sales tax, Canadian GST, UK VAT, invoicing, chargebacks. Stripe Tax is $0.50/tx + 0.5% and **you're still the merchant of record** — you still file in every jurisdiction you sell to. For a solo founder, that's 40+ hours/year and real legal exposure.
2. **Fee structure comparable on net.** LS charges 5% + $0.50. Stripe charges 2.9% + $0.30 + ~0.5-0.7% for Billing. On a $29 Pro sub, LS takes ~$1.95, Stripe-with-Billing takes ~$1.33 + tax handling cost. The $0.62 delta doesn't buy you back the tax-filing time.
3. **2026 Stripe Managed Payments.** Stripe launched their own MoR in 2026 Q1 at **+3.5% on top of standard fees = ~6.4% total** ([Dodo Payments review](https://dodopayments.com/blogs/lemonsqueezy-review)). LS is now strictly cheaper than Stripe MoR.

**Reconsider Stripe at $50k MRR.** At that scale:
- Hiring a fractional bookkeeper handles tax
- 2.9% vs 5% = $1,050/mo savings on $50k MRR
- Custom pricing flexibility > LS's product-first model

### LemonSqueezy integration pattern

**Products in LS dashboard:**
- `jellyclaw-hobby-monthly` ($9), `jellyclaw-hobby-annual` ($84)
- `jellyclaw-pro-monthly` ($29), `jellyclaw-pro-annual` ($288)
- `jellyclaw-team-seat-monthly` ($99, quantity = seat count)
- `jellyclaw-overage` — usage-billed variant, $0.015/msg

**Key webhook events to handle ([LS event types](https://docs.lemonsqueezy.com/help/webhooks/event-types)):**

| Event | Handler action |
|---|---|
| `subscription_created` | Provision user, set tier, start inference budget cycle |
| `subscription_payment_success` | Reset monthly inference budget to tier allowance |
| `subscription_payment_failed` | 3-day grace, then degrade to Free tier, email user |
| `subscription_updated` | Reconcile plan changes (upgrade/downgrade) |
| `subscription_cancelled` | Mark pending-cancellation; retain until period end |
| `subscription_expired` | Full revoke; archive session data (retain 30d then purge) |
| `order_refunded` | Revoke immediately, audit-log reason |
| `subscription_paused` | Freeze budget, allow read-only dashboard access |

**Usage metering via LS:**
- LS supports per-unit usage via the "usage records" API on subscriptions.
- Report overage daily, not per-event — batch reduces API calls and matches how LS charges.
- Endpoint: `POST /v1/subscription-items/{id}/usage-records` with `quantity=<messages_over_cap>`.

**Minimal code surface for the billing service:**

```
/billing
  ├── webhook-handler.ts          # verify HMAC, dispatch event
  ├── checkout-link.ts            # generate signed checkout URLs
  ├── usage-reporter.ts           # nightly aggregator → LS usage records
  ├── portal-link.ts              # LS customer portal redirect
  └── entitlements.ts             # single source of truth: user→tier→caps
```

### Overage behavior

| Scenario | Action |
|---|---|
| User at 80% of included budget | Email + dashboard banner |
| User at 100% of included budget | Auto-enable pay-per-use overage (opt-out in settings) |
| Overage spending > $50 in 24h | Circuit-breaker: pause, email, require explicit continue |
| Overage spending > $500 in month | Hard pause, require support ticket to resume |

**The circuit-breaker is non-negotiable.** It protects the user (runaway agent) and us (chargeback risk). Learn from Cursor's July 2025 apology.

### Refund policy

- **14-day no-questions refund** on any tier upgrade.
- **Overage never refunded** but circuit-breaker makes runaway charges near-impossible.
- **Prorated cancellation credits** applied to future purchases, not cash refund (keeps customers in orbit).
- Auto-handled by LS portal.

---

## § Usage Metering Architecture

### Data flow

```
[jellyclaw engine]
     │  AgentEvent: usage.updated {sessionId, userId, model, input, output, cache_reads, cache_writes}
     ▼
[Fly app → emit to NATS or direct write]
     ▼
[Tigris S3 bucket: events/YYYY/MM/DD/HH.ndjson]
     │
     ├──▶ [realtime: Durable Object counts toward user budget]  ← gates overage
     └──▶ [nightly: Worker reduces events → per-user daily totals]
                    │
                    ├──▶ [Supabase/Turso: user_usage_daily table]
                    ├──▶ [LemonSqueezy usage-records API (if overage)]
                    └──▶ [Anthropic-bill reconciliation (monthly)]
```

### Latency vs accuracy tradeoff

**Decision: real-time soft-cap, nightly hard-cap reconciliation.**

- **Real-time path (Durable Object / Redis counter):** When user hits 100% of budget, block next request. P99 latency < 50ms. Acceptable drift: +/- 2% because DO counts might lag by milliseconds and cache metadata isn't perfectly attributed in real-time.
- **Nightly reconciliation:** A Worker reads that day's event NDJSON from S3, sums per user, writes authoritative totals to Supabase. If a user was within 2% of their budget and real-time over-counted them, this nightly batch issues a credit. If we under-counted, we bill them tomorrow (rare, capped).
- **Monthly true-up against Anthropic:** Anthropic's Console provides per-org usage reports. Nightly + monthly pulls compare our accumulated count vs Anthropic's. Discrepancy > 3% → Slack alert to George, investigate (usually cache_control attribution bugs).

### Why not OpenMeter?

OpenMeter ([openmeter.io](https://openmeter.io/)) is excellent and open-source Apache-2.0. **Reconsider at month 6.** Reasons to defer:

- One-engineer launch: adding OpenMeter = +1 service to deploy + learn + monitor.
- Tigris/S3 + Workers gets us to 10k users with nothing to manage.
- OpenMeter's sweet spot is when billing logic is complex (tiered rates, credit bundles, commitments). Our pricing is simple enough that a 200-line SQL aggregator handles it.
- LemonSqueezy has native usage records — we're already routing through LS, adding a middle layer is wasteful.

Migrate to OpenMeter when:
- 3+ pricing dimensions (today: 1 — tokens per user)
- Need credit bundles, carryover, or commit-and-consume semantics
- 5-figure MRR where metering correctness is revenue-critical

### Schema (minimal)

```sql
CREATE TABLE user_usage_daily (
  user_id UUID NOT NULL,
  day DATE NOT NULL,
  model TEXT NOT NULL,                  -- 'opus-4-7' | 'sonnet-4-6' | 'haiku-4-5'
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_read_tokens BIGINT NOT NULL,
  cache_write_tokens BIGINT NOT NULL,
  wholesale_cost_usd NUMERIC(10,4) NOT NULL,
  message_count INT NOT NULL,
  browser_seconds INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, model)
);

CREATE TABLE user_budget_cycle (
  user_id UUID NOT NULL,
  cycle_start DATE NOT NULL,
  cycle_end DATE NOT NULL,
  tier TEXT NOT NULL,                   -- 'free' | 'hobby' | 'pro' | 'team'
  budget_wholesale_usd NUMERIC(10,4) NOT NULL,
  consumed_wholesale_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  overage_messages INT NOT NULL DEFAULT 0,
  overage_usd_billed NUMERIC(10,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, cycle_start)
);
```

### Reconciliation job (nightly)

```
1. Read S3 prefix events/YYYY/MM/{yesterday}/*.ndjson
2. Deduplicate by event_id
3. Reduce per (user_id, model) → daily row
4. Compute wholesale_cost_usd using hardcoded Anthropic rates
5. Upsert user_usage_daily
6. For each active user_budget_cycle:
     consumed += sum(wholesale_cost_usd for yesterday)
     if consumed > budget AND tier != 'free':
       overage_messages = sum(message_count where day >= cap_day)
       POST to LS /subscription-items/{id}/usage-records with overage_messages
       overage_usd_billed += overage_messages * retail_rate
7. Emit summary to Axiom for George's daily dashboard
```

### Anthropic-bill true-up

Run on the 1st of each month:
```
1. Pull Anthropic Console "Usage" page via authenticated scrape (or API when available)
2. Sum our internal wholesale_cost across all users for previous month
3. If |anthropic_bill - internal_sum| / anthropic_bill > 3%: PagerDuty alert
4. Common causes to investigate first:
   - cache_control breakpoint drift causing unexpected cache misses
   - A user bypassing the wrapper (bug in session auth)
   - Anthropic rate-limit retries double-counted
```

---

## § Observability Stack — $/month line-items

**Launch stack (target: $0/mo until 1k users):**

| Layer | Service | Free tier limit | Paid starts at | Launch decision |
|---|---|---|---|---|
| **Structured logs** | [Axiom](https://axiom.co/pricing) | 500 GB/mo, 30d retention, 25 GB storage | $25/mo | Axiom free — we won't hit 500GB before 5k DAU |
| **Metrics** | Fly built-in Grafana ([fly.io/docs/monitoring](https://fly.io/docs/monitoring/metrics/)) | All Fly apps free | — | Fly Grafana, no extra cost |
| **Errors** | [Sentry](https://sentry.io/pricing/) Developer | 5k errors/mo, 5M spans/mo, 50 replays/mo | $26/mo (Team) | Sentry free — upgrade when we cross 5k errors |
| **Uptime** | [BetterStack](https://betterstack.com/pricing) Uptime | 10 monitors, 30s checks | $25/mo | BetterStack free — 10 monitors covers every endpoint we have |
| **Status page** | [Instatus](https://instatus.com/pricing) Starter | 15 monitors, 2-min checks, 200 subs | $20/mo | Instatus free — subscribers cap is fine early |
| **Analytics** | Plausible / Umami self-hosted | — | Plausible $9/mo | Plausible $9/mo (privacy-friendly, EU-legal out of box) |

**Total launch cost: $9/mo** (Plausible is the only paid item).

**Upgrade triggers:**
- **Axiom → Team $25/mo** when log volume crosses 400 GB/mo
- **Sentry → Team $26/mo** when approaching 4k errors/mo (keep headroom)
- **BetterStack → Paid $25/mo** when we need >10 monitors (e.g. regional probes after multi-region)
- **Instatus → Pro $20/mo** when subscriber count crosses 150 (paid early to avoid trust damage if a free tier limit hits during an incident)
- **Plausible** scales with pageviews — the $9/mo tier covers 10k/mo

**Intentionally not buying:**
- **Datadog.** Infrastructure Pro is [$18/host + $48/host APM](https://www.datadoghq.com/pricing/) = $66/mo for one Fly machine. Fly Grafana does 80% of this free. Revisit at $50k MRR.
- **PagerDuty.** BetterStack's incident management is bundled in their uptime paid tier — wait until we need real on-call rotation.
- **Intercom/Helpscout.** Email + GitHub Discussions for launch. Consider Plain or Pylon at 500+ users.

### Instrumentation checklist (ship week 1)

1. `pino` logger (already in SPEC) → pino-axiom transport for production, stdout-pretty for dev.
2. Sentry SDK in the Fly HTTP app (Agent 2 surface) + in the engine for uncaught errors. Capture `release` via env.
3. Fly.toml: expose `/metrics` Prometheus endpoint with process + LLM-specific metrics:
   - `jellyclaw_request_total{status,tier,model}`
   - `jellyclaw_tokens_total{kind=input|output|cache_read|cache_write, model}`
   - `jellyclaw_wholesale_cost_usd_total{tier}`
   - `jellyclaw_cache_hit_ratio{model}`
   - `jellyclaw_session_duration_seconds{quantile}`
   - `jellyclaw_active_sessions{tier}`
   - `jellyclaw_browser_seconds_total{tier}`
4. BetterStack monitors: `GET /health`, `POST /v1/prompt` (synthetic), `GET jellyclaw.dev`, `GET /docs`.
5. Instatus components mapped 1:1 to BetterStack monitors.

---

## § Docs + Support

### Docs: **Astro Starlight** on Cloudflare Pages

Pick: [Starlight](https://starlight.astro.build/) over Nextra / Docusaurus / Mintlify.

| | Starlight | Nextra | Docusaurus | Mintlify |
|---|---|---|---|---|
| Cost | Free, OSS | Free, OSS | Free, OSS | Free tier, paid $150+/mo |
| Setup time | 15 min | 30 min | 60 min | 10 min |
| Search | Built-in (Pagefind) | Plugin | Algolia (paid) | Built-in |
| MDX | Yes | Yes | Yes | Proprietary |
| Versioning | Manual | Built-in | Built-in | Built-in |
| Control over theme | Full | Full | Full | Limited |
| Performance | Static, fastest | Next.js | React SPA | Hosted only |

Starlight wins because (a) zero runtime cost on Cloudflare Pages, (b) Pagefind search is free and client-side, (c) we already have writers — George drafts in markdown, this pipeline is zero-friction.

**Site structure (`jellyclaw.dev/docs`):**
```
/
├── getting-started          # 5-min quickstart → first successful prompt
├── concepts
│   ├── sessions
│   ├── models-and-providers
│   ├── prompt-caching
│   ├── permissions
│   └── mcp
├── guides
│   ├── bring-your-own-key
│   ├── chrome-automation        # reference the CHROME-MCP doc
│   ├── skills
│   ├── daemon-mode
│   └── genie-integration
├── api-reference               # Agent 2's HTTP API surface
├── cli-reference               # auto-generated from --help
├── billing
│   ├── plans
│   ├── usage-and-overage
│   └── byok-faq
├── changelog                   # reuse top-level CHANGELOG.md
└── troubleshooting
```

### Support: tiered by plan

| Tier | Channel | SLA |
|---|---|---|
| Free | GitHub Discussions only | Community / best-effort |
| Hobby | Email (support@jellyclaw.dev) | 72 hours business |
| Pro | Email, priority queue | 24 hours business |
| Team | Shared Slack channel + email | 4 hours business |

**Tool stack:** Crisp widget on landing (free tier: 2 seats, unlimited conversations). Email routes to a Helpscout-style Gmail with labels until 500+ users, then move to Plain ($20/mo, dev-focused).

**Discord: delay until 500 paying users.** Premature Discord = empty channels = social proof damage. GitHub Discussions is the launch community.

---

## § 60-Day Launch Calendar

**Assumes kickoff = 2026-04-20. Adjust if different.**

### Week 1 (Apr 20 - Apr 26): Private alpha scaffolding
- [ ] Land Fly deployment (Agent 1) to `jellyclaw.dev` and `api.jellyclaw.dev`
- [ ] Ship Astro Starlight docs skeleton — getting started + 3 guides only
- [ ] Ship landing page (hero + waitlist signup → Supabase table `waitlist`)
- [ ] Set up LemonSqueezy account, products, test-mode checkout
- [ ] Instrument Axiom + Sentry + BetterStack free tiers
- [ ] Alpha invites: hand-pick 20 from George's X followers (devs + AI hackers)

**W1 exit criteria:**
- `POST https://api.jellyclaw.dev/v1/prompt` works for a logged-in alpha user
- Landing page up at jellyclaw.dev
- 10 alpha users have run 1+ session

### Week 2 (Apr 27 - May 3): Alpha iteration
- [ ] Daily bug-triage from alpha reports (Discord DM George directly)
- [ ] Ship BYOK flow (critical feature per §Pricing)
- [ ] Ship billing skeleton: test-mode subscriptions, webhook handler, entitlements table
- [ ] Produce demo video #1: G-Class configurator (90 sec, re-cut from existing footage)
- [ ] Write blog post #1: "What jellyclaw is and why I built it" — George voice, personal, 800-1200 words

**W2 exit criteria:**
- 20 alpha users, 5+ daily active
- 3 paying Hobby users in test mode
- Demo video ready
- Blog post drafted

### Week 3 (May 4 - May 10): Public beta open
- [ ] Beta landing page copy with pricing matrix visible
- [ ] Switch LemonSqueezy to live mode
- [ ] Open public signup (no approval gate) → Hobby and Pro available, Free tier gated behind waitlist for rate control
- [ ] Blog post #1 published + X thread
- [ ] Demo video #1 published on YouTube + X
- [ ] Email waitlist (expect 50-200 names from W1-2): "You're in, here's a 30-day Pro coupon"

**W3 exit criteria:**
- 100 signups total
- 10 paying customers
- First non-George-network user converts

### Week 4 (May 11 - May 17): Iteration on real usage
- [ ] Demo video #2: Bentley configurator (showing Chrome MCP browser work)
- [ ] Blog post #2: "How we cut Opus cost by 85% with prompt caching" (technical, proves credibility)
- [ ] Fix top 3 pain points from W3 feedback (expected: cold-start latency, checkout confusion, docs gaps)
- [ ] Add Plausible + basic metrics dashboard George reads daily
- [ ] Begin PH launch prep: upload assets to Product Hunt's Ship, line up 20+ hunters from followers
- [ ] First "Show HN" draft + peer review

**W4 exit criteria:**
- 200 signups, 25 paying
- D7 retention baseline measured
- PH assets staged, HN post peer-reviewed

### Week 5 (May 18 - May 24): Big launch week
- [ ] **Tuesday May 19, 12:01 AM PST: Product Hunt launch** ([per PH 2026 playbook](https://hackmamba.io/developer-marketing/how-to-launch-on-product-hunt/))
  - George is maker + self-hunts
  - 20+ hunters queued in first hour
  - Engagement-focused (reply to every comment within 15 min)
  - X thread at 9 AM PT tied to PH post
- [ ] Demo video #3: S-Class config + talking-head 3-min pitch
- [ ] Blog post #3: "From claude -p to jellyclaw — the architecture" (technical launch post)
- [ ] Publish "Show HN: jellyclaw — an open-source, embeddable Claude Code" Tuesday morning 8-9 AM ET
- [ ] Post in /r/LocalLLaMA, /r/ClaudeAI, /r/SideProject
- [ ] Monitor BetterStack constantly; all hands on support

**W5 exit criteria:**
- PH: Top 10 of the day (Top 5 is the stretch — most solo dev tools top-5 if prep is right)
- HN: 50+ points keeps front page 6+ hours
- 1000+ signups during launch week
- 100+ paying customers
- George doesn't sleep

### Week 6 (May 25 - May 31): Cashback from launch
- [ ] Follow-up blog post: "Week after launch — what broke, what worked" (authenticity = shareable)
- [ ] Second wave PR: X thread retrospective with numbers
- [ ] Reach out to 5 dev podcasts (Dev Tools Podcast, Podlink/SyntaxFM/ShopTalk indie list)
- [ ] First paid ad experiment: $200 in X ads targeting `@anthropic`, `@cursor` follows, AI-engineer bios
- [ ] Start pricing analysis: who's at overage, who's BYOK, who's churning

**W6 exit criteria:**
- 200 paying customers
- 5 Team tier subscribers
- Pricing hypotheses validated or falsified

### Week 7 (Jun 1 - Jun 7): Iterate
- [ ] Ship pricing changes if data demands (likely: adjust Opus caps, tune BYOK discount)
- [ ] Roll out Team tier self-serve flow (week 1-6 is assisted by George via email)
- [ ] Referral program live: give/get $10 credit, max $50/user
- [ ] Launch affiliate program on LemonSqueezy (30% rev share, 3 months, capped)
- [ ] First customer interview series (5 calls, recorded, 2 used as testimonials)

**W7 exit criteria:**
- Referral program referring 10%+ of new signups
- First real testimonials collected

### Week 8 (Jun 8 - Jun 14): Harden
- [ ] Stability audit: review every Sentry error from launch period, fix top-10
- [ ] Enterprise conversation pipeline: warm 3 accounts (usually emerge from Team tier usage)
- [ ] Content asset: write the "jellyclaw cookbook" — 10 copy-paste recipes for common tasks
- [ ] Begin second launch: this time targeting a specific vertical (e.g. AI-first solo-founders using Genie)
- [ ] George: take a day off. Seriously.

**W8 exit criteria:**
- $5k+ MRR
- <5% weekly churn
- George still alive

---

## § Marketing Assets

### Landing page structure (`jellyclaw.dev`)

Sections, top to bottom:

1. **Hero.** One-line: *"Headless Claude Code you can embed, deploy, and bill for."*
   - Subline: "The engine behind Genie 2.0 and jelly-claw. Bring your own key or use ours."
   - CTA: `Start free` + `See it in action` (scrolls to demo)
   - Background: subtle animated waveform, matches G.TRU brand
2. **Live demo.** Embedded video #1 (G-Class config, 90 sec) with autoplay-on-scroll, muted, looped.
3. **Three-up feature strip.**
   - *Real browser.* Screenshot of the Chrome MCP working
   - *Your skills, your MCP.* Screenshot of skills loaded
   - *Pay what you use.* Screenshot of the usage dashboard
4. **How it works.** 4-step diagram: Prompt → Agent → Tools/MCP/Browser → Result
5. **Pricing.** The matrix (copied verbatim from §Pricing)
6. **Demos grid.** 3 videos in a 3-column grid: G-Class / Bentley / S-Class with one-line captions
7. **Social proof.** (At launch: "First 100 users got in free" badge. Replace with testimonials as acquired.)
8. **FAQ.** 8-12 questions, cover: BYOK, privacy, open source licensing, refund, SOC2 (honest answer: planned Q4), data retention, Anthropic relationship.
9. **Footer.** Links to docs, GitHub, changelog, privacy, terms, status page.

**Tech:** Next.js or plain Astro. Hosted on Cloudflare Pages. Form submissions → Supabase `waitlist` table. Zero JS tracking beyond Plausible.

### Demo videos — production plan

**George already filmed the real sessions.** The work is editorial, not production.

| Video | Length | Source | Key moments to show | Tool |
|---|---|---|---|---|
| G-Class configurator | 90 sec | Existing screen capture | (a) prompt (b) agent opens Chrome (c) clicks through configurator (d) final config summary | Descript or Davinci Resolve, free |
| Bentley configurator | 90 sec | Existing capture | Same rhythm, Bentley is visually richer | Same |
| S-Class configurator | 90 sec | Existing capture | Show multi-turn — "now add the AMG package" | Same |
| Talking-head pitch | 3 min | New shoot | George at desk, 1080p, Krisp for mic clean-up. Hook-problem-solution-demo-CTA | iPhone + simple lighting |
| Technical deep-dive | 5-8 min | New screencast | George narrates the architecture while pointing at SPEC.md diagrams | OBS |

Total editorial time: 20-30 hours over 2 weeks.

### Screenshot gallery (for docs, PH, and X threads)

- Dashboard: usage chart + budget bar + tier
- Terminal: `jellyclaw run "..."` streaming output
- Chrome automation: Playwright MCP driving example.com
- Settings: BYOK configuration
- Billing: LS customer portal embed

### Testimonial acquisition plan

1. **Week 2-4:** Identify the 5 most-engaged alpha users. DM personal ask, offer a free year of Pro in exchange for a 1-2 sentence testimonial + optional logo.
2. **Week 5-6:** Public beta → add "leave feedback" in-product, incentivize with 1 month credit.
3. **Week 7:** Record 5 customer-interview calls (30 min each). Use pull-quotes on landing, full audio as podcast-style drops.
4. **Ongoing:** X mentions → DM for permission to quote on site.

**Specific Week-1 testimonial asks:** anyone who's already told George jellyclaw is good (check X DMs + Genie user group). Warm asks convert ~60%; cold asks ~10%.

---

## § Legal Essentials

**Disclaimer: I'm not a lawyer. These are defaults appropriate for a solo-founder US LLC at launch. Review with a lawyer before Team tier sales.**

### Privacy Policy (`/privacy`)

Must cover:
1. **What we collect:** account (email, name), usage (token counts, session metadata, NO prompt bodies by default), billing (via LS), analytics (Plausible is cookieless).
2. **What we DON'T collect:** prompt content, tool outputs, browser screenshots — unless user opts into "improve jellyclaw" setting.
3. **Retention:**
   - Session metadata: tier-specific (24h Free → 90d Team, per matrix)
   - Billing records: 7 years (US tax law requirement)
   - Usage aggregates: indefinite, but user-deletable on account deletion
4. **Third parties:** Anthropic (inference), LemonSqueezy (billing), Fly (hosting), Tigris (log store), Sentry (errors — scrub PII), Axiom (logs — scrub prompts). Full list published and versioned.
5. **Rights:** export, delete, correct. 30-day response window. Pages: dashboard → Settings → Data.
6. **GDPR nod:** LS is the data controller for billing data (convenient). Jellyclaw is controller for usage data. Explicit opt-in for any product-improvement data use. DPO contact: george@jellyclaw.dev.
7. **Contact:** `privacy@jellyclaw.dev`.

### Terms of Service (`/terms`)

Key provisions:

1. **Acceptable use:**
   - No illegal content generation (CSAM, CFAA violations, weapons-of-mass-destruction info, etc.)
   - No scraping services that explicitly prohibit AI agents in their ToS
   - No spamming / bulk email generation
   - 60 msg/min rate limit per user account
   - Abuse = immediate suspension, no refund, account termination
2. **AI content disclaimer:** "Claude and jellyclaw can be wrong. Verify outputs before relying on them. No warranty of accuracy, fitness, or suitability."
3. **IP:**
   - User owns their prompts and outputs
   - jellyclaw keeps rights to aggregated, non-identifying usage telemetry
   - User grants us a license to process their prompts for the purpose of delivering the service
4. **Pass-through of Anthropic Usage Policies.** Users must comply with [Anthropic's Usage Policy](https://www.anthropic.com/legal/usage-policy). Violations of Anthropic policy → we terminate.
5. **BYOK users** are responsible for their own Anthropic bill and TOS compliance with Anthropic directly.
6. **Limitation of liability:** capped at 12 months of fees paid.
7. **Arbitration:** AAA, Delaware venue (defaults for US LLC).
8. **Changes:** 30-day notice before material changes via email.

### DPA for enterprise (deferred to Week 10+)

- Build off LS's base DPA (they publish one for their role)
- Add our processor clauses, sub-processor list, SCCs for EU
- Not needed for self-serve Team tier launches — kick in when a customer asks

### Anthropic pass-through specifics

- **We are a reseller under Anthropic's Partner terms.** Need to sign Anthropic's Partner Agreement (as of 2026 the self-serve flow is open on console.anthropic.com for qualified partners). Email `partners@anthropic.com` if self-serve doesn't work.
- **Rate-limit protection:** our Anthropic org key must be on Tier 4 minimum (baseline — see §Risks). Request custom scale tier before public beta.
- **Usage reporting:** we are obligated to prevent misuse (CSAM etc.) — our abuse filter runs pre-dispatch. Document this in the Partner onboarding.

---

## § Metrics Dashboard Design

### The three numbers George checks daily

Deliver as a **plain text email at 9 AM PT** (low friction, readable on phone, no login):

```
jellyclaw daily — 2026-05-20

MRR:          $4,240   (+$380 vs yesterday, +8.96%)
Paying:       142      (+12)    churn this week: 3 (2.1%)
Trials→Paid:  17%      (7-day rolling)

Today signups:        38    (PH launch day +500%)
Yesterday cost:       $71   (Anthropic) / $189 collected = 37% gross margin
This month cost:      $1,842 / $4,240 collected = 57% gross margin

Alerts:
  - 2 users in overage circuit-breaker (emailed)
  - Cache hit rate Sonnet: 72% (below 85% target — investigate)
  - 1 BYOK user on Anthropic key error (they were emailed)

Top 3 errors (Sentry):
  1. TOKEN_LIMIT on Hobby tier, 12 occurrences
  2. MCP playwright timeout, 8 occurrences
  3. Checkout redirect mismatch, 3 occurrences

Reply to this email with "details" for a full report.
```

Implementation: a Fly cron job runs the aggregator → formats → sends via Resend/Postmark.

### Full dashboard (Grafana on Fly, read-only link for George)

**Revenue panel:**
- MRR line chart (30d, 90d, 365d)
- ARR projection (MRR × 12)
- Churn (logo and dollar)
- Trial → paid funnel
- Payment failure recovery rate

**Usage panel:**
- DAU / WAU / MAU by tier
- Messages per day by model
- Cache hit rate by model (target: ≥85% Sonnet, ≥60% CLAUDE.md)
- p50 / p95 / p99 latency by endpoint
- Browser minutes per day

**Cost / unit-economics panel:**
- Anthropic spend per day (reconciled)
- Gross margin % overall and per tier
- Cost-per-active-user (CAC ÷ active users)
- Overage revenue per day
- BYOK adoption % (target: 40% of paid by month 6)

**Health panel:**
- Errors per hour (Sentry)
- Uptime by endpoint (BetterStack) last 30 days
- Rate-limit rejections per hour
- Abuse filter triggers per day

### Activation + retention definitions

- **Activated user** = within 7 days of signup, has run ≥1 session with ≥3 agent turns and ≥1 tool call completed successfully.
- **D1 retention** = signed in again within 24h. Target: 40% (matches dev-tool benchmarks).
- **D7 retention** = ran ≥1 session on day 7. Target: 25%.
- **D30 retention** = still a paying customer or on Free tier within 7d of D30. Target: 60% of paying, 15% of free.
- **MRR growth target**: $10k MRR by end of day 60 (aggressive but realistic given George's network + Genie install base).

---

## § Risks + Mitigations

### 1. Anthropic rate-limit kills the org

**Risk:** Launch spike pushes our shared org key past rate limits → every user hits 429 → churn spiral → reputation damage.

**Mitigation:**
- **Pre-launch:** Deposit $400+ to reach Tier 4 on day 1 (4,000 RPM, 2M ITPM Sonnet per [Anthropic tiers guide](https://www.aifreeapi.com/en/posts/claude-api-quota-tiers-limits)). $400 isn't real money.
- **Pre-launch:** Email `partners@anthropic.com` with launch plans — request custom scale tier, reference Genie usage.
- **Runtime:** Queue requests at the wrapper when approaching limit (backoff before Anthropic rejects us). Internal headroom flag: "pause non-priority Free-tier requests above 80% limit."
- **Fallback:** OpenRouter path for Sonnet/Haiku (Opus caching broken per SPEC §6.2) kicks in if Anthropic direct is down — auto-circuit-breaker.
- **BYOK amplification:** Every BYOK user removes load from our key. Push BYOK aggressively in onboarding for heavy users.

### 2. Browser MCP abuse

**Risk:** User scripts jellyclaw to scrape at scale, spam forms, evade paywalls → we get IP-banned from major sites → abuse report escalates to Fly or Anthropic terms violation.

**Mitigation:**
- Agent 4 (browser-in-cloud) owns the sandbox. Wrapper-side enforces:
  - 60 browser operations per minute per user (per CHROME-MCP §5)
  - 10 hours/day browser time on Pro, 40 on Team
  - Shared IP pool rotation with abuse tagging
- ToS forbids scraping / bypassing (§Legal)
- Abuse signals: >1000 browser ops/day from single user → auto-review queue → human decision in 24h
- Report/contact page for abuse complaints → SLA 48h

### 3. Fly.io outage

**Risk:** Primary region goes down. Users can't use jellyclaw. MRR at risk.

**Mitigation:**
- **Phase 1 (launch):** Single region (iad). Accept the risk — Fly iad has 99.9%+ historical uptime. Every Tigris write is durable.
- **Phase 2 (month 3):** Add sjc region for US-West. Fly anycast handles routing. Cost: ~$200/mo additional.
- **Phase 3 (month 6):** fra for EU. Cost: ~$300/mo.
- **Status page** always transparent. **Incident template** pre-written: "We're investigating. Last known good time: X. Next update: 15 min."

### 4. Competitor ships similar product

**Risk:** sst/opencode itself ships a hosted version. Anthropic launches Claude Code Cloud. Cursor adds Chrome MCP.

**Mitigation / differentiation:**
- **Speed.** George's shipping cadence is the moat. Weekly meaningful updates beats any enterprise roadmap.
- **MCP ecosystem.** Jellyclaw commits to being the friendliest host for MCP servers. "Run any MCP on jellyclaw in 30 seconds."
- **First-class Chrome.** Agent 4's browser-in-cloud is a deeper bet than any competitor has shipped. Double down when validated.
- **Open core.** The engine is open source per SPEC. That's a moat against closed competitors — enterprises can audit. Claude Code is closed, Cursor is closed.
- **Plan B:** If a category-killer ships, pivot to specialty verticals (e.g. "jellyclaw for sales teams running research agents").

### 5. Pricing wrong

**Risk:** Nobody buys at these prices, or power users bleed us dry.

**Mitigation:**
- **Budget-based pricing (§Pricing Math) protects the downside.** We only overspend on users we chose to subsidize (Free tier + tight cap).
- **Weekly pricing review** for first 8 weeks. Rules:
  - If trial→paid < 10%, lower Hobby to $7 (experiment)
  - If Opus usage on Pro exceeds budget 2+ weeks running, tighten daily cap from 100 → 50 and grandfather existing
  - Never raise prices on existing subscribers without 60-day notice + explicit email explanation
- **Cursor's June 2025 repricing** is the cautionary tale — they shipped without enough communication. We ship credit model at launch, no retrofit ever.

### 6. Stripe/LS payment processor failure

**Risk:** LemonSqueezy has an outage or changes terms adversely.

**Mitigation:**
- Keep Stripe integration 80% built but dormant. Switch in <48h if needed.
- Monthly backup of subscription list from LS API → encrypted S3 export.
- Never couple product logic to LS-specific features (keep entitlements service abstracted per §Billing).

### 7. Solo-founder burnout

**Risk:** George launches, everything works, 1000 support tickets arrive, George breaks.

**Mitigation:**
- **Week 5 is max-intensity, week 8 is decompression.** Calendar a full rest day in week 8.
- **Support auto-responder** for free-tier explicitly says "community-supported; Hobby+ for priority."
- **George's "do not touch after 9 PM" rule.** Slack silenced, BetterStack pager only for SEV-1.
- **Week 4:** Plan the first contractor hire — a customer-success generalist at ~$30/hr for 10 hrs/wk starting week 6 if MRR > $3k. Cover tickets so George codes.

---

## § Open questions for George

1. **Anthropic Partner status.** Are we already on their Partner agreement? If not, email this week — 2-3 week turnaround.
2. **Domain.** Is `jellyclaw.dev` registered? If not, grab + `jellyclaw.com` defensively. Namecheap / Porkbun.
3. **LLC structure.** US LLC assumed. If something different, the legal boilerplate needs a pass.
4. **Genie integration timing.** Does Genie start routing to jellyclaw at week 5 (launch) or wait until week 8 (stability)? Recommend: wait for W8 — Genie shouldn't be a launch-week dependency.
5. **jelly-claw desktop app.** Per SPEC §21 — is this still the 2026 H2 plan? If so, mention it in launch narrative as "Phase 3: desktop app" to create roadmap excitement without committing dates.
6. **Pricing experiment tolerance.** Are we willing to A/B test Pro ($29 vs $24 vs $39) in W5-6? I'd say yes — it's the fastest way to learn.
7. **Opus-on-Free.** I said no Opus on Free. If marketing signals say we need Opus in the free demo, we can add 3 Opus/day and adjust Free-tier cost model. My strong preference: no, because it trains users to expect free Opus elsewhere.

---

## § Appendix — Source receipts

- [Claude API pricing (claude.com/pricing, accessed 2026-04-17)](https://claude.com/pricing)
- [Anthropic usage tiers / rate limits](https://www.aifreeapi.com/en/posts/claude-api-quota-tiers-limits)
- [LemonSqueezy pricing / fees](https://userjot.com/blog/stripe-polar-lemon-squeezy-gumroad-transaction-fees)
- [Stripe pricing](https://stripe.com/pricing)
- [2026 Stripe MoR update via LemonSqueezy blog](https://www.lemonsqueezy.com/blog/2026-update)
- [OpenRouter pricing](https://openrouter.ai/pricing)
- [OpenMeter (openmeter.io)](https://openmeter.io/)
- [Replicate pricing](https://replicate.com/pricing)
- [Axiom pricing](https://axiom.co/pricing)
- [BetterStack pricing](https://betterstack.com/pricing)
- [Sentry pricing](https://sentry.io/pricing/)
- [Datadog pricing](https://www.datadoghq.com/pricing/)
- [Instatus pricing](https://instatus.com/pricing)
- [Fly metrics / Grafana](https://fly.io/docs/monitoring/metrics/)
- [Cursor pricing repositories](https://www.chargebee.com/pricing-repository/cursor)
- [Claude Code pricing 2026](https://www.verdent.ai/guides/claude-code-pricing-2026)
- [Product Hunt 2026 playbook](https://hackmamba.io/developer-marketing/how-to-launch-on-product-hunt/)
- [Astro Starlight](https://starlight.astro.build/)
- [Nextra](https://nextra.site/)
- [LemonSqueezy webhook events](https://docs.lemonsqueezy.com/help/webhooks/event-types)

*End of productization package v1. George reads, approves, and we execute from week 1.*
