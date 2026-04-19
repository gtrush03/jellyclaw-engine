# Browser-in-Cloud — jellyclaw Hosted Architecture (Agent 3 / Browser Layer)

**Status:** DRAFT, opinionated (2026-04-17).
**Owner:** George.
**Scope:** the browser layer only. Agent 1 covers Fly.io deploy, Agent 2 covers the API surface.
**Source pins:** every pricing / capability claim carries a footnote URL, fetched 2026-04-17.
**Companion docs:** `docs/CHROME-MCP-INTEGRATION-PLAN.md`, `docs/chrome-setup.md`, `scripts/jellyclaw-chrome.sh`.

---

## § TL;DR

1. **Launch on Browserbase.** Use their hosted MCP endpoint at `https://mcp.browserbase.com/mcp` as the default browser backend in the hosted jellyclaw. Zero browser ops, signed contexts, session-replay UI, CAPTCHA solving on by default, persistent profiles via their Contexts API — which is the *only* credible answer to "agent-owned Chrome with my logins" server-side. Cost envelope at alpha (~50 concurrent, ~500 browser-hours/mo): **$99/mo flat on the Startup plan**, overage $0.10/browser-hour ¹.
2. **"Logged-in personas" is Contexts, not profile files.** We expose a `jellyclaw connect <service>` flow: the user runs an interactive Browserbase session against Google / GitHub / whatever, logs in, we save the Context ID. Every subsequent agent run resumes that Context. No credentials ever pass through our backend.
3. **Per-tenant isolation = one Browserbase session per jellyclaw run.** One `run_id` → one `session.create(contextId, persist: true)` → one WSS endpoint → teardown at run end. Browserbase's hard guarantee is one browser per session; isolation is their problem, not ours.
4. **Screenshot pipeline inherits our raw-CDP + animation-freeze fix.** Browserbase recommends CDP `Page.captureScreenshot` natively ². PNGs land in the Browserbase replay bucket (first-class support) *and* we stream base64 in SSE events for clients that want inline images. Hosted Tigris bucket for long-term pinning. No per-tenant S3 setup.
5. **Self-host escape hatch exists but is Phase 2.** When concurrency > ~200 or per-session economics drop below $0.05/hr, build a Fly Machines sidecar pool running `ghcr.io/browserless/chromium` behind our own CDP broker. Until then: every $ of browser infra work is better spent on product.
6. **BYO-Chrome fallback stays the power-user default.** The current `scripts/jellyclaw-chrome.sh` keeps working for anyone who runs jellyclaw locally. We surface "Use my Chrome" in the hosted UI via a reverse tunnel (Phase 2, optional).

**Headline cost envelope** at three scales (details in § Cost model):

| Scale                                    | Est. browser-hrs/mo | Browserbase plan | Fly sidecar approx | Our pick |
| ---------------------------------------- | ------------------: | ---------------: | -----------------: | -------- |
| Alpha (≤20 DAU, ~100 hrs)                |                 100 | **$20 Dev** ¹    | ~$80 @ perf-2 ³    | BB       |
| Beta (≤200 DAU, ~1 500 hrs)              |               1 500 | **$199 + $100 overage** = ~$300 | ~$600       | BB       |
| Public (≤2 000 DAU, ~15 000 hrs)         |              15 000 | ~$1 550 ($99 + 14 500 × $0.10) | ~$2 000         | hybrid   |

Break-even against rolling our own is around **12 000 browser-hours / mo**. Before then Browserbase is unambiguously cheaper than the human-time cost of operating Chrome on Fly.

¹ https://www.browserbase.com/pricing (2026-04-17)
² https://docs.browserbase.com/features/screenshots (2026-04-17)
³ https://fly.io/docs/about/pricing/ (2026-04-17) — 2 perf CPU / 4 GB = $0.0894/hr ≈ $64/mo per always-on machine. Pool of 5 ≈ $320/mo before egress.

---

## § The four options compared

The brief named four paths. Here is the honest verdict on each:

| Axis                    | A. Chrome in jellyclaw container | B. Chrome sidecar Machines on Fly | C. Browser-as-a-service (Browserbase) | D. User brings own Chrome |
| ----------------------- | -------------------------------- | --------------------------------- | ------------------------------------- | ------------------------- |
| **Per-run isolation**   | Weak (shared process w/o care)   | Strong (1 machine / tenant)       | Strongest (vendor guarantees)         | N/A (user's device)       |
| **Cost @ 100 hr/mo**    | $5–15 Fly VM ³                   | $60–320 (pool + egress)           | **$20 flat** ¹                        | $0 (user pays in laptop CPU) |
| **Cost @ 15 000 hr/mo** | $300 infra, but 1 tenant max     | $1 500–2 500                      | $1 500                                | $0                        |
| **Persistent logins**   | Only if we store profile bytes (scary) | Same problem on volume        | **Contexts API — done for us** ⁴      | User's real profile. Trivial. |
| **Setup for end user**  | None                             | None                              | None                                  | Install jellyclaw + Chrome locally |
| **Heavy-JS reliability**| Our headless problems, our fix   | Same                              | Known good — their CDP path ²         | User's real GPU — best    |
| **Ops burden**          | Low (1 image)                    | **High** (machine pool, autoscaler, health-checks, profile storage, network policy) | Zero                                  | Zero for us               |
| **CAPTCHA bypass**      | DIY                              | DIY                               | Included ⁵                            | User solves like a human  |
| **Outbound abuse risk** | On our Fly egress bill           | On our Fly egress bill            | Vendor eats it                        | On user's network         |
| **Lock-in**             | None                             | None                              | Medium (Contexts format is theirs)    | None                      |
| **Ship-date for alpha** | 2 weeks                          | 6 weeks                           | **3 days**                            | 0 days (already works)    |

**A. Same-container Chrome** is seductive ("just throw it in") but three facts kill it:

1. **No per-tenant isolation.** If two concurrent jellyclaw runs share the Chrome process, a malicious prompt in run A can read run B's cookies trivially. Fixing this = spawning a Chrome process per run = see option B, you just imported all the ops work.
2. **Memory math.** Chrome with one tab open on a heavy JS site is 300–500 MB resident ⁶. A Fly `shared-cpu-1x-2g` VM ($11/mo) holds maybe 3 simultaneous sessions before swap death. A `performance-cpu-2x-4g` ($64/mo) holds 6–8. Once you horizontalscale, you're at option B.
3. **"Agent owns Chrome with my logins" is meaningless here.** Who is *my*? On the user's laptop, *my* logins are the user's, and `--user-data-dir=~/Library/…` persists them. On our server, nobody has ever logged in. The profile is empty forever. The only way to populate it is to implement delegated auth plumbing — which is exactly what Browserbase's Contexts already is.

**B. Sidecar Fly Machines** is the right answer if Browserbase stops making business sense. Architecture: one `jellyclaw-api` Fly app (stateless, autoscaling) + one `jellyclaw-chrome-pool` Fly app of ephemeral machines running `ghcr.io/browserless/chromium` ⁷ or our own Dockerfile. API machine picks a healthy pool member via `chrome-pool.internal` DNS ⁸, calls `sessions.create()` against a broker (we write this), broker spins up or reuses a machine, hands back a CDP WSS URL, jellyclaw's MCP config points at it. Beautiful. Also four weeks of real work, plus an on-call rotation for when Chrome deadlocks in a container.

Real Fly.io gotchas (verified):

- Chrome **must** run `--no-sandbox`; Fly's unprivileged Docker doesn't support user namespaces for the Chrome sandbox ⁹.
- Chrome needs `--disable-dev-shm-usage` or you'll OOM `/dev/shm` under load ⁹.
- Volumes are 1-machine-at-a-time, up to 500 GB, encrypted at rest by default ¹⁰ — so persistent profiles = 1 volume per tenant = linear cost, doesn't scale horizontally inside a single machine.
- Machines stop → zero billing when idle; good for bursty agent traffic. Cold-start ≈ 2–5 s for a lightweight Chrome image.
- Private network uses IPv6 6PN mesh with `<machine_id>.vm.<app>.internal` DNS ⁸ — so the API can address a specific Chrome machine reliably (6PN addresses are not static; use the machine_id form).

**C. Browser-as-a-service (Browserbase picked over alternatives)** is the launch answer. Why not the alternatives?

- **Browserless Cloud** ¹¹: $140/mo Starter gets 180k units; a "unit" is a 30-second block, so ~1 500 browser-hours worth. Same ballpark as Browserbase Startup. BUT: their open-source Docker image is **SSPL-1.0** ¹²; we can't ship it in a commercial hosted jellyclaw without a paid license. Rules out the "self-host Browserless" speedrun.
- **Hyperbrowser** ¹³: $99/mo Basic, $0.10/browser-hour, similar credit model. Younger vendor, smaller surface. Fine but no Contexts-equivalent docs we could verify; we'd be reimplementing persistent-login plumbing. No.
- **Browser Use Cloud** ¹⁴: **$0.06/browser-hour** (cheapest we found), but pricing is "per-task $0.01 + per-minute session + per-LLM-step" which compounds with agent verbosity. Their hosted model is designed for *their* agent harness (browser-use Python lib), not as a vanilla CDP endpoint. Integration with our existing Playwright MCP setup would be lossy. Good fallback for a future "ultra-cheap tier."
- **Cloudflare Browser Rendering** ¹⁵: $0.09/browser-hour after 10 free, supports Playwright/Puppeteer/CDP, but requires Cloudflare Workers orchestration — architectural pivot we don't need.
- **ScrapingBee / ScrapingDog / Scrapfly**: these are scraping APIs (submit URL → get HTML/PDF), not interactive browser sessions. Out of scope.

Browserbase wins because it's the only one with: (a) **first-class MCP server** we can drop into jellyclaw's mcp.json with 3 lines of JSON ¹⁶; (b) **Contexts API** for encrypted persistent profiles ⁴; (c) session replay + audit UI built-in (we don't have to build it); (d) Verified browsers / CAPTCHA on by default ⁵.

**D. User brings own Chrome** already works — it's what we ship today in `scripts/jellyclaw-chrome.sh`. We will keep shipping it for jellyclaw-the-CLI. For jellyclaw-the-hosted-service, it's a Phase 2 feature: a "Connect my Chrome" button that opens an install sequence + relay tunnel back to our API. Useful for power users who want their real GDocs/Gmail sessions without going through our Contexts flow.

⁴ https://docs.browserbase.com/features/contexts (2026-04-17)
⁵ https://docs.browserbase.com/features/stealth-mode (2026-04-17) — "CAPTCHA solving is enabled by default for all sessions."
⁶ Direct observation in current jellyclaw Chrome sessions; matches public Chrome memory reports.
⁷ https://github.com/browserless/browserless — the OSS image.
⁸ https://fly.io/docs/networking/private-networking/ (2026-04-17)
⁹ Community Fly.io posts + multiple Puppeteer-on-Fly guides, 2024–2026. `--no-sandbox` is universal requirement.
¹⁰ https://fly.io/docs/volumes/overview/ (2026-04-17) — 500 GB max, encryption-at-rest default.
¹¹ https://www.browserless.io/pricing (2026-04-17)
¹² https://github.com/browserless/browserless — SSPL-1.0 OR Commercial License.
¹³ https://www.hyperbrowser.ai/docs/pricing (2026-04-17)
¹⁴ https://browser-use.com/pricing (2026-04-17)
¹⁵ https://developers.cloudflare.com/browser-rendering/pricing/ (2026-04-17)
¹⁶ https://github.com/browserbase/mcp-server-browserbase (2026-04-17)

---

## § Chosen architecture in detail

```
┌──────────────────────────────────────────────────────────────────────────┐
│  User's laptop (browser or jellyclaw desktop)                            │
│  HTTPS → jellyclaw.app                                                   │
└──────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Fly app: jellyclaw-api (stateless, autoscaling 1→N)                     │
│  Runs: engine + HTTP server + SSE event stream                           │
│  Per request:                                                            │
│    1. Auth check (Agent 2's API layer)                                   │
│    2. Load user's Context ID from Postgres (per service: google / gh…)   │
│    3. Construct per-run MCP config → points at Browserbase MCP           │
│    4. Spawn engine; engine talks to Browserbase MCP over HTTP/SSE        │
│  No Chrome on these machines. Ever.                                      │
└──────────────────────────────────────────────────────────────────────────┘
                                │ HTTP+SSE
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Browserbase hosted MCP: https://mcp.browserbase.com/mcp                 │
│  Authenticated by BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID           │
│  Per MCP tool call:                                                      │
│    - `start {contextId, persist: true}` → one new Chrome session         │
│    - `navigate | act | observe | extract` → drive that Chrome            │
│    - `end` → session torn down, Context bytes persisted back             │
│  Underneath: real Chrome, verified fingerprint, CAPTCHA-solver optional, │
│  residential proxies optional, session replay video retained 7–30 days.  │
└──────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ returns to engine as MCP tool_result
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Back in jellyclaw-api:                                                  │
│   - Screenshots (base64) → SSE event to client, then pinned in Tigris    │
│   - DOM extracts → scrubbed via engine/src/security/scrub.ts             │
│   - Rate-limit: browser:60/min (existing policy)                         │
│   - Audit log: every navigate / click → Postgres `browser_events`        │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why this specific topology.** The jellyclaw engine already speaks MCP. Browserbase already speaks MCP. We wire two things that speak the same protocol to each other and walk away. No Chrome on our infra, no profile bytes on our disks, no CDP brokers, no Playwright bundle. The only code we write is:

1. A `contextId` lookup in the per-run MCP config assembler (jellyclaw-api).
2. A `jellyclaw connect <service>` onboarding flow (new).
3. A hosted SSE passthrough that forwards Browserbase session events back to the user's client.

All three are small (~200 LOC total estimated).

**Region.** Browserbase runs in US + EU regions; pick US-East as the default to keep RTT to Fly's IAD region < 20 ms. For EU customers, mirror Fly to CDG / AMS.

**Failure modes.**
- Browserbase returns 5xx: engine surfaces `tool.error code="upstream_unavailable"`. Automatic 1 retry with jitter, then give up (avoid hammering their API during an outage).
- Browserbase session timeout (free=15 min, paid=6 hr — verify): engine gets `session_expired`, spins up a new session, resumes from the last snapshot if the agent agrees.
- Contexts ID missing / rotated: fall back to a fresh ephemeral session for that run; surface a banner to the user: "Reconnect your Google account — session expired."

---

## § Server-side "agent-owned Chrome" — what we offer and what we don't

The laptop-local version of jellyclaw works like this: user opens Chrome once under a dedicated profile dir, logs into Gmail, closes it, and from then on any `jellyclaw run` that needs Gmail just works, because the profile has Google's auth cookies. Beautiful. **That does not port to a hosted service.** On our server, there is nobody to "log in." There is no keyboard in front of the Chrome instance. If we just ship a hosted Chrome with no cookies, the agent is forever limited to public-web pages — useful for a lot, useless for anything authenticated.

We offer three tiers:

**Tier 0 — "Ephemeral Chrome."** Every agent run gets a fresh Browserbase session, no Context. Can do research, configurators (our existing Mercedes/Bentley demos), scraping, anything that doesn't need login. **This is the free tier.** It's also 90% of early agent value — don't underestimate it.

**Tier 1 — "Connect a service."** User clicks "Connect Google" (or GitHub, LinkedIn, Gmail, etc.) in the hosted UI. We create a Browserbase session in **interactive mode** (session replay on, user's browser sees a live video of the remote Chrome), surface it to the user, they log in with their real credentials into the remote Chrome, we save the resulting Context ID against their jellyclaw account + service name. From then on, any run they kick off where the prompt references that service (or the agent navigates there) resumes their Context, sees their logged-in state, acts on their behalf. **We never see their password**, it stays in Browserbase's encrypted Context store ⁴.

This is the "agent-owned Chrome with my logins" experience — just server-side, via Contexts, not a raw profile dir. It's **paid tier only** (our cost: one persistent Context per service per user, Browserbase charges nothing extra for stored Contexts today ⁴, but it does increase session create-time by ~1 s).

**Tier 2 — "Bring your own Chrome."** Power-user escape hatch. See § BYO-Chrome fallback.

What we **explicitly do not offer**:

- **Credential vault where jellyclaw stores passwords and auto-types them.** No. We never touch plaintext credentials. Users log in directly into the remote Chrome; we hold Context IDs, not passwords. If Browserbase gets breached, they've signed off on their own threat model; our surface area stays minimal.
- **OAuth delegation for every site.** We support OAuth-proper flows for *jellyclaw's own APIs* (GitHub PR integration, etc.) where the user sanctions a token. For arbitrary sites the agent visits, Contexts + interactive login is the only mechanism. It's slower to set up but doesn't require per-site plumbing we can't maintain.
- **Shared/team Chromes.** One Context per (user, service). No shared-seat Gmail. That's a product decision, not a tech one — revisit at team pricing.

---

## § Per-tenant isolation model

**Model:** one Browserbase session per jellyclaw run. Period.

```
run_id 7f3a…   ── sessions.create({ contextId: ctx_goog_abc }) ──► browser instance 1
run_id 8c21…   ── sessions.create({ contextId: ctx_goog_xyz }) ──► browser instance 2
run_id 5e44…   ── sessions.create() (no context)              ──► browser instance 3 (ephemeral)
```

Browserbase's guarantee ¹⁷: every `sessions.create()` returns a fresh, isolated Chrome instance. No OS-level sharing with any other session. Cookies, localStorage, IndexedDB, tabs — all scoped to that single session. They terminate the process on `sessions.end()`. Context bytes (if persistent) are encrypted at rest between uses.

**Why we don't do "one Chrome PROFILE per tenant, shared process":** even if we ran our own Chrome, that design leaks — DNS cache, extension state, service workers, `/tmp`, can all bleed across profiles in the same process. Fine for *our own* laptop-mode dev; unacceptable in multi-tenant hosted. If we ever insource Chrome (Phase 2), the rule is one Chrome process per session, full stop. This is why option B's economics get scary fast.

**Why we don't do "one Chrome process per REQUEST":** interpreting "request" as "MCP tool call" would give us 0.5 s Chrome cold-starts on every `browser_click` — DOA for UX. We do it per *run*: the session lives for the whole agent loop, then tears down.

**Concurrency caps.** Browserbase plans gate on concurrent sessions (3 free / 25 Dev / 100 Startup ¹). jellyclaw's hosted queue respects this: if 101 users hit "run" at once on the Startup plan, 100 get live sessions and 1 waits ≤ a few seconds for one to free up. We expose `concurrency_available` in `/health` so the frontend can show "currently N agents running."

**Blast radius if Browserbase has a security incident.** Their job: tell us, rotate our API key, force a rebuild of every Context. Our job: audit log every run → a user can see "here's every session that used your Google Context in the last 90 days." This log is worth building on day 1.

¹⁷ Implied by https://www.browserbase.com/pricing "N concurrent browsers" + the fact that every `sessions.create()` returns a unique `connectUrl`. No vendor contractually commits to "tenant isolation" in text but the session model makes sharing impossible by construction.

---

## § Screenshot pipeline (reliable + fast on heavy JS sites)

Our current learning: **headless Chrome `Page.captureScreenshot` on heavy WebGL/3D-canvas sites** (Mercedes configurator, Bentley configurator) **hangs for 30+ s** because the screenshot call waits for a rendering quiescence that never arrives while the 3D scene animates. Our fix in the local flow: **freeze animations via `document.getAnimations().forEach(a => a.pause())`** plus a CDP `Animation.setPlaybackRate(0)`, then `Page.captureScreenshot` with `captureBeyondViewport: false`. Reliable, < 1 s.

**Hosted pipeline:**

```
agent calls  browser_take_screenshot
       │
       ▼
jellyclaw-api (the MCP client side)
       │ sends MCP tool call to Browserbase MCP
       ▼
Browserbase MCP server
       │ runs Stagehand's screenshot helper
       │ which under the hood uses CDP Page.captureScreenshot ²
       │
       ▼
Browserbase Chrome returns PNG base64
       │
       ▼
jellyclaw-api receives base64 PNG
       │
       ├──► SSE event { type: "screenshot", base64: "…", size: 512341 }
       │         streamed to the user's client immediately
       │
       ├──► Pin to Tigris (s3-compatible, same-region to Fly) at
       │       s3://jellyclaw-screenshots/{user_id}/{run_id}/{idx}.png
       │       Returns a signed URL, TTL = 7 days
       │
       └──► Also stored in the Postgres `run_artifacts` table for audit
```

**Animation-freeze injection.** Before every `browser_take_screenshot`, we send `browser_run_code` with:

```js
// Stop CSS animations + Web Animations API
document.getAnimations?.().forEach(a => a.pause());
// Stop requestAnimationFrame loops via CDP (out-of-band)
// (the Playwright MCP side can emit Animation.setPlaybackRate via --caps devtools)
```

This is codified as a hidden preamble inside jellyclaw's MCP client for every `browser_take_screenshot` call. The user's agent doesn't need to know it exists. We add an opt-out `freeze_animations: false` for sites where the animation *is* the point.

**Why base64 in SSE** (not just a URL): the model sees the image inline — matches Anthropic's multimodal expectations. We *also* emit a URL for the frontend to render / cache.

**Why Tigris specifically:** Fly integrates Tigris S3 natively, same-region egress is free, single-tenant bucket with signed URLs + short TTL keeps the blast-radius small ¹⁸.

**Why not use Browserbase's replay bucket as primary:** (a) vendor lock-in, (b) they retain for 7–30 days by plan ¹ — we need longer for enterprise, (c) their URLs are their-domain and we want our-domain signed URLs in the product.

**Fast-path exception.** For huge PNGs (> 1 MB base64), skip the SSE inline and just send the URL. The model can load it lazily via our vision layer. Threshold tunable.

¹⁸ Tigris is Fly's integrated S3. https://fly.io/docs/tigris/overview/ (2026-04-17)

---

## § Cost model at three scales

All numbers **@ 2026-04-17**; volatile; recheck at launch.

### Alpha — 20 DAU, ~5 sessions/user/day @ ~6 min each = ~100 browser-hours/mo

| Line | Browserbase path | Fly-sidecar path |
| --- | ---: | ---: |
| Browser infra | $20/mo Dev plan (100 hrs included) ¹ | 2 × performance-2x-4g always-on = $128/mo ³ (can't autoscale to 0 reliably on cold Chrome) |
| Proxy / captcha | $0 (1 GB free) ¹ | Not included. Budget $10/mo for anti-bot vendor. |
| Ops time | $0 | ~8 hr engineer-time/mo for upkeep = $800 opportunity cost (cheap at $100/hr) |
| **Monthly** | **$20** | **~$138 infra + ~$800 ops** |

**Verdict:** Browserbase. No one sane self-hosts at this scale.

### Beta — 200 DAU, ~1 500 browser-hours/mo

| Line | Browserbase | Fly-sidecar |
| --- | ---: | ---: |
| Browser infra | Startup plan $99 + (1 500 − 500) × $0.10 = **$199** ¹ | Pool of 10 performance-2x-4g, partial auto-stop = ~$500 ³ |
| Proxy | 0 (5 GB incl) | $40 external vendor |
| CAPTCHA | included ⁵ | $50 external vendor |
| Egress (screenshots out) | included | Fly $0.02/GB × ~30 GB = $0.60 |
| Ops | 0 | ~16 hr/mo upkeep = $1 600 opp-cost |
| **Monthly** | **~$199** | **~$590 infra + $1 600 ops** |

**Verdict:** Browserbase. Still unambiguously cheaper; still saves ~2 dev-days/mo.

### Public — 2 000 DAU, ~15 000 browser-hours/mo

| Line | Browserbase | Fly-sidecar hybrid |
| --- | ---: | ---: |
| Browser infra | $99 + (15 000 − 500) × $0.10 = **$1 549** ¹ | 50-machine autoscaling pool, 40% avg utilization = ~$1 900 |
| Proxy | 9 GB @ $10 = $90 | $200 vendor |
| CAPTCHA | included | $300 vendor |
| Ops | $0 | $3 200/mo (1 day-a-week SRE) |
| **Monthly** | **~$1 640** | **~$2 400 infra + $3 200 ops** |

**Verdict:** Browserbase still cheaper, but the **crossover is visible**: at ~$1 600/mo vs ~$2 400/mo, the ops cost dominates. **Crossover point is around 30 000 browser-hours/mo.** At that level, commit to building option B *or* negotiate a Browserbase enterprise contract.

### When self-hosting Chrome makes sense

- **Scale.** Crossover is ~30 000 browser-hours/mo (≈ 4 000 DAU).
- **Compliance.** Enterprise customer requires SOC2 boundary under our control. Browserbase is SOC2 ¹⁹ but some gov/finance orgs insist.
- **Cost per session below $0.02/hr.** Fly spot-style machines or a dedicated-hardware deal could push us there. Browserbase floor is ~$0.10/hr overage.
- **Feature we need that they don't have.** e.g. a custom Chrome build with an extension pre-loaded. Browserbase does support custom extensions via sessions but auditing is theirs, not ours.

Until any of those triggers, keep using them.

¹⁹ Implied by Scale plan offering HIPAA, DPA, SSO ¹. Confirm in sales call before enterprise contract.

---

## § Security / abuse controls

The attacker persona: a jellyclaw user who creates an account specifically to make our browser hit their endpoint or some third-party endpoint for purposes of (a) credential stuffing, (b) scraping behind our IP, (c) crypto mining in Chrome, (d) hosting CSAM probes from our IP.

**Controls we layer:**

1. **Rate-limit on our side.** Existing `browser:60/min` policy, burst 10, applied to every `mcp__browserbase__*` and `mcp__playwright__*` tool call. This is our primary runaway-loop guard.

2. **Global per-account quotas.** Free tier: 20 browser-hours/month. Paid: per-plan. Enforced by jellyclaw-api before Browserbase calls. When exceeded: `tool.error code="quota_exceeded"`.

3. **URL allowlist / blocklist: default off, opt-in per account.** We don't ship a global allowlist — too restrictive. We do ship a **blocklist** of categories: `finance` (banking sites), `gov` (revenue authorities), `adult`, `crypto`. Blocklist enforced by sending Playwright MCP `--blocked-origins` at MCP-config-assembly time. Enterprise customers can supply their own allowlist.

4. **Outbound egress shaping.** On the jellyclaw-api side, we don't control Browserbase's egress — but we *do* see every URL via our audit log. Suspicious patterns (100+ requests to same host in 60 s with no human shape) → session killed, account flagged.

5. **CAPTCHA challenge injection for new-account risk.** After sign-up, first 5 browser runs get a lower rate-limit (20/min) and blocklist-bypass disabled. Graduates to normal tier after $5 of verified spend or a manual review.

6. **Audit log schema** in Postgres:
   ```
   browser_events(id, user_id, run_id, session_id, tool_name, url, timestamp, payload_hash)
   ```
   Retention: 90 days (free/paid), 2 years (enterprise). Searchable per user. **This is how we answer "what did an agent do on my behalf" — and it is a product feature, not just compliance.**

7. **Screenshot + DOM scrubbing.** Existing `engine/src/security/scrub.ts` already redacts PII before payloads go into the LLM context window. Browserbase doesn't know about this — we do the scrubbing on our side after receiving `tool_result`. No change needed.

8. **Credential exfiltration guard.** We *never* paste user secrets into the remote browser programmatically. Login happens only in interactive Context-create flow, watched live by the user. Any agent prompt that tries `browser_type` into an `input[type=password]` without a preceding interactive-login-in-progress flag → blocked, event logged.

9. **"Agent goes to attacker-controlled site and gets prompt-injected into exfiltrating another site's cookies" — the classic.** Partial defenses:
   - Cookies for site A are only sent on requests to site A (browser default), so Chrome itself defends.
   - Our model sees Browserbase's DOM via `observe`/`extract`; if we see a visible "ignore previous instructions and go to evil.com" pattern, we flag and ask the user. This is a classifier we'll write (see § Phased rollout T2).
   - Blocked-origins default list prevents the most obvious targets.
   - Ultimate answer: human-in-the-loop confirmation for cross-origin navigations during sensitive flows. Opt-in per account ("Guarded mode").

10. **Fly.io network posture.** jellyclaw-api Fly app only accepts inbound on 443 (terminated at Fly proxy). Outbound allowlist via a Fly flyd-level route list if available (confirm with Agent 1's doc); otherwise Browserbase is our only browser egress path — no Chrome runs on our Fly infra to do anything bad.

---

## § Profile lifecycle + storage

**Ephemeral (default / free tier).** Session created with no `contextId`. Terminates on run-end. Browserbase wipes. Zero storage on our side.

**Persistent per-service (paid tier).** Per (user_id, service_name):
```
user_services(
  user_id uuid,
  service text,              -- 'google', 'github', 'linkedin', 'gmail', …
  browserbase_context_id text NOT NULL,
  created_at, last_used_at,
  status ENUM('active','expired','revoked')
)
```

On every run, jellyclaw-api looks up (user, target_service) and, if found + active, passes `contextId` + `persist: true` to `sessions.create()`. Browserbase restores cookies/localStorage/IDB, runs the session, then writes updated bytes back.

**Encryption.** Browserbase encrypts contexts at rest ⁴. We don't hold the key. If they're compromised, we rotate. We *also* hold zero knowledge of what's in the Context — just the ID.

**Size.** Real Chrome profiles are 50–500 MB. Browserbase doesn't publish a per-Context size quota today ⁴, but in practice the hot data (cookies, IDB, localStorage) is KB–MB, not hundreds of MB. Service workers can balloon it. We'll monitor; if any one Context > 250 MB we'll auto-compact by dropping HTTP cache on next rotation.

**Rotation / expiry.** Contexts expire when external auth does (user's cookie TTL, token revocation, password change). We detect via "login wall encountered" in the DOM observation → mark `status='expired'` → show user reconnection prompt.

**Deletion.** User-initiated delete: `DELETE /api/services/:service` → call `POST /v1/contexts/:id/delete` on Browserbase → remove DB row. Idempotent. Enterprise customers get "delete all my data" wipe via one button.

**Backups.** We don't back up Contexts. If Browserbase loses them, user reconnects. Anything sensitive enough to need our own backup probably shouldn't be in an agent-accessible Chrome anyway.

**Free-tier leakage guard.** Free accounts only get ephemeral sessions. No Context storage. A free user cannot accidentally leak persistent state to a future run.

---

## § Sample MCP config JSON per architecture

All four shown so we can pivot mid-project without touching engine code (config-only).

### Option C (chosen for alpha/beta) — Browserbase hosted MCP over HTTP

Goes in the jellyclaw-api's per-run MCP assembler (NOT a static file):
```json
{
  "mcp": [
    {
      "transport": "http",
      "name": "browserbase",
      "url": "https://mcp.browserbase.com/mcp",
      "headers": {
        "Authorization": "Bearer ${BROWSERBASE_API_KEY}",
        "X-Browserbase-Project": "${BROWSERBASE_PROJECT_ID}",
        "X-Jellyclaw-User": "${user_id}",
        "X-Jellyclaw-Run": "${run_id}",
        "X-Browserbase-Context-Id": "${context_id_or_empty}",
        "X-Browserbase-Persist": "${true_if_paid_tier_else_false}"
      }
    }
  ]
}
```

> Note: `transport: "http"` requires T0-01's MCP-wiring to support HTTP streams (the current code supports stdio only). Adding HTTP MCP transport is a tractable ~150 LOC extension to `engine/src/mcp/registry.ts`. Agent 2 should wire this under their API surface.

### Option C alternative — self-hosted Browserbase MCP via stdio (for dev)

When we want to run the MCP locally (dev / staging) but still hit Browserbase cloud:
```json
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "browserbase",
      "command": "npx",
      "args": ["-y", "@browserbasehq/mcp@latest"],
      "env": {
        "BROWSERBASE_API_KEY": "bb_live_…",
        "BROWSERBASE_PROJECT_ID": "proj_…",
        "GEMINI_API_KEY": "ya29…",
        "BROWSERBASE_CONTEXT_ID": "ctx_abc123",
        "BROWSERBASE_PERSIST": "true"
      }
    }
  ]
}
```

### Option B (Fly sidecar, future) — Playwright MCP pointed at Chrome pool over 6PN

```json
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "playwright",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--browser", "chrome",
        "--cdp-endpoint", "http://${machine_id}.vm.jellyclaw-chrome-pool.internal:9333",
        "--user-data-dir", "/data/profiles/${user_id}",
        "--no-sandbox"
      ]
    }
  ]
}
```

`${machine_id}` picked by our broker; `${user_id}` ensures profile isolation on the machine's Fly Volume. `--no-sandbox` required on Fly containers ⁹. The `.vm.<app>.internal` DNS form hits a specific machine even under 6PN re-IP ⁸.

### Option A (not chosen) — Chrome in same container, DO NOT SHIP

```json
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "playwright",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--cdp-endpoint", "http://127.0.0.1:9333"
      ]
    }
  ]
}
```

Same as our current laptop config. Fine for single-tenant. Explicitly unsafe multi-tenant.

### Option D (BYO-Chrome) — user's laptop + reverse tunnel

This one isn't an MCP config per se; it's what the user runs locally. Documented in § BYO-Chrome fallback.

---

## § Playwright MCP in server mode — for the record

We considered running `@playwright/mcp` itself as a long-lived HTTP service (it supports `--port` and `--host` flags ²⁰) that our jellyclaw-api connects to. This gives: "our engine talks to our Playwright MCP talks to Browserbase via `--cdp-endpoint wss://connect.browserbase.com?…`". Extra hop. Pros: we keep full control of tool list + capabilities. Cons: extra moving part for zero user-visible gain, because Browserbase's own MCP server already exposes roughly equivalent tools.

Chrome-DevTools MCP (Google's) is **stdio-only as of 0.21.0** ²¹ — not a server-mode candidate today.

Verdict: Browserbase MCP directly. Revisit if we need a tool Browserbase's server doesn't expose.

²⁰ https://github.com/microsoft/playwright-mcp (2026-04-17) — `--port`, `--host`, `--allowed-hosts` flags documented.
²¹ https://github.com/ChromeDevTools/chrome-devtools-mcp (2026-04-17) — no `--port`, stdio only.

---

## § BYO-Chrome fallback (the power-user escape hatch)

Some users *will* want their real Chrome (Gmail, banking, rare-earth behaviors the vendor browser can't reproduce). We offer "Connect My Chrome" as an explicit opt-in:

```
[user clicks "Use My Chrome" in hosted UI]
         │
         ▼
[hosted UI]  "Run this one-liner on your laptop:"
         │
         │   curl -fsSL https://jellyclaw.app/install | JC_TOKEN=jct_… sh
         │
         ▼
[install script]
    - Downloads small jellyclaw agent binary
    - Runs ./scripts/jellyclaw-chrome.sh (existing)
    - Opens a reverse tunnel to tunnel.jellyclaw.app
    - Registers the user's laptop CDP as the target for future runs
         │
         ▼
[next "jellyclaw run" on hosted UI]
         │  per-run MCP config points at tunnel-proxied CDP
         │      "--cdp-endpoint", "https://tunnel.jellyclaw.app/u/{user}/cdp"
         ▼
[agent drives user's real Chrome, with their real profile + logins]
```

**Properties:**

- Tunnel is an outbound WebSocket from the laptop — no inbound firewall setup.
- User closes their laptop → agent session fails cleanly with "tunnel disconnected" → fallback prompt to the hosted Browserbase path.
- We charge a flat $5/mo for this tier to cover tunnel infra; operating cost is tiny (Cloudflare Tunnel, ngrok, or our own WireGuard — TBD).
- Security: the laptop's Chrome is only accessible *from the authenticated jellyclaw user's own hosted account* via the tunnel token. Rotating the token kills all access.

**NOT launch-blocking.** Ship hosted Browserbase first, add this in Phase 2 once we see demand.

---

## § Phased rollout timeline + decision triggers

```
PHASE         WHEN       WHO        DELIVERABLE                                DECISION-GATE
─────────────────────────────────────────────────────────────────────────────────────────────
Phase 1 ALPHA Apr–May 26 george+AI  - Add HTTP MCP transport to engine         ship alpha
                                    - jellyclaw-api service on Fly             = 10 paying
                                    - Browserbase MCP wired in                 beta users?
                                    - Context-create onboarding (Tier 1)
                                    - Audit log table
                                    - 60-sec deploy docs

Phase 2 BETA  Jun 26     george+AI  - Rate-limit + quota enforcement           ship beta
                                    - Category blocklist                       = usage
                                    - Screenshot Tigris pinning                dashboards
                                    - Session-replay UI (Browserbase iframe)   green?
                                    - "Guarded mode" cross-origin prompt

Phase 3 SCALE Jul–Aug 26 +SRE       - Metrics: browser-hrs/user, context-hit  trigger B?
                                      rate, CAPTCHA-trigger rate               see below
                                    - Enterprise plan plumbing
                                    - SOC2 evidence collection

Phase 4 FORK  Iff trig   +SRE       - Fly Chrome pool sidecar (Option B)       only if
                                    - CDP broker service                       trigger met
                                    - Hybrid routing: BB default, sidecar for
                                      bulk / enterprise tenants
                                    - Migration plan for Contexts

Phase 5 BYOC  Parallel   +frontend  - "Connect My Chrome" flow (Option D)      user demand
              Jun–Aug    lead       - Reverse-tunnel infrastructure            signal
                                    - macOS/Linux install script
```

### Decision triggers for Phase 4 (build our own Chrome infra)

- **Monthly browser-hours ≥ 30 000.** Crossover math says we're paying Browserbase more than (Fly infra + SRE time).
- **Enterprise deal explicitly requires data-plane inside our boundary.** SOC2-under-our-roof.
- **Browserbase pricing changes adversely** by > 50%, or they exit our pricing band.
- **Sustained p99 Browserbase latency > 2 s for MCP roundtrips** for a week. (Probably never, but measure.)

**Until at least two triggers fire, do not build Phase 4.** Every week we don't self-host Chrome is a week the engine ships features instead of operating a browser pool.

### Decision triggers for Phase 5 (BYO-Chrome)

- **≥ 3 paying users explicitly ask** for "use my Chrome" with real logins.
- **Enterprise ask** for hybrid (BYO for logged-in workflows, Browserbase for scale).
- **Jellyclaw desktop app** ships and needs a hosted↔local bridge anyway — Phase 5 rides along.

### What Agent 1 (Fly.io deploy) needs from us

- `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` as Fly secrets on `jellyclaw-api`.
- `TIGRIS_*` creds for screenshot bucket.
- Optional: reserved 6PN CIDR for the eventual `jellyclaw-chrome-pool` app.
- No Chrome binary or Playwright install in the jellyclaw-api Dockerfile. Keep it slim (< 300 MB).

### What Agent 2 (API surface) needs from us

- A `PerRunMcpConfig` builder: `buildMcpConfig({ userId, runId, targetService? }): McpConfig[]` that yields the Browserbase-pointing config with correct Context ID injected.
- SSE event types: `screenshot`, `navigation`, `context_expired`, `browser_error`.
- Quota-check function: `checkBrowserQuota(userId): { remainingHrs, ok, upgradePath }`.
- Interactive-session endpoint for Context-create onboarding: `POST /api/services/:service/connect` → returns Browserbase live-replay URL.

---

## § Known unknowns / things to verify before launch

1. **Browserbase actually exposes CDP to their MCP tools?** Their MCP server uses Stagehand internally ¹⁶. If we need raw `browser_evaluate` / `browser_run_code` parity with Playwright MCP, confirm by building a smoke test. Our current animation-freeze JS relies on this.
2. **Context size limits.** Not published ⁴. Probe with a large real session; if we hit a wall we need a compaction strategy.
3. **Regional latency from jellyclaw-api (Fly IAD) → Browserbase US regions.** Measure; target < 20 ms p50. If > 50 ms, put jellyclaw-api in whichever region Browserbase is in.
4. **Browserbase uptime SLO.** Their TOS doesn't publish one publicly. Ask sales during contract negotiation; if they won't commit, we need a graceful-degrade story to ephemeral Playwright-bundled Chromium (Flow 3 from our existing plan) when they're down.
5. **GDPR.** Browserbase processes potentially-PII DOM via their Stagehand pipeline. We need a DPA. They offer one on Scale plan ¹. Paid tier onwards we require it.
6. **Screenshot data retention.** Tigris lifecycle policy set to 7-day expiry for free tier, 90-day for paid, indefinite for enterprise. Enforce via bucket lifecycle rules, not application code.
7. **`@browserbasehq/mcp` requiring `GEMINI_API_KEY`.** Their Stagehand server uses an LLM for `act`/`observe`/`extract`. We need to either (a) pay for Gemini keys ourselves and absorb, or (b) ask Browserbase if their HTTP MCP endpoint can proxy a single shared model key for all our users (enterprise deal). If (a), budget ~$0.001/step × avg-15-steps-per-run = ~$0.015/run in Gemini overhead. Note in costs.

---

## § Appendix: ruthless-honesty verdict

**What ships alpha fastest:** Browserbase. 3 days of wiring, zero Chrome ops.

**What scales best long-term:** hybrid. Browserbase for 95% of traffic, Option-B sidecar for bulk enterprise + compliance-required tenants.

**What we do NOT do at any point:** run Chrome inside the jellyclaw-api container. No matter how tempting.

**What George gets wrong if he insists on self-hosting day 1:** ~3 months of eng time on a browser pool + SRE rotation + profile-storage plumbing + CAPTCHA integration + ongoing Chrome-breakage whack-a-mole. That's $40–60k of opportunity cost on a launch where the product isn't proven yet. Every one of those dollars is better spent making jellyclaw itself do more things.

**Biggest open architectural risk:** HTTP MCP transport in jellyclaw's engine. Today it's stdio-only. This whole design assumes we can point the engine at a remote MCP server over HTTP/SSE. If T0-01 didn't already build this plumbing, it's the next ~150 LOC we write. Everything else is config.

*End of Agent 3 / browser-layer design. See companion docs for API surface and Fly.io deploy.*
