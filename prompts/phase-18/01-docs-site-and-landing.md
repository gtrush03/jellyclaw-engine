# Phase 18 — Open-source release — Prompt 01: Docs site and landing page

**When to run:** After Phase 17 (jelly-claw integration) is marked ✅ in `COMPLETION-LOG.md`, and the engine has been validated in Genie production for ≥14 days (per the v1.0 bar in `ROADMAP.md` Q2 2026). This is the first of three Phase 18 prompts; it must run before 02 (distribution) because the docs URL is referenced in npm/Homebrew metadata.
**Estimated duration:** 6–8 hours
**New session?** Yes — start a fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `18` and `<name>` with `open-source-release`.

---

## Research task

Before writing a single line of config, deeply understand the landscape:

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-18-open-source-release.md` end to end. Note Step 6 calls out "Vite + Vocs (or Docusaurus/Astro Starlight)" — **we pick Astro Starlight** for reasons below; document the decision in `docs-site/DECISIONS.md`.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` §3 (dream outcome) and §5 (principles). The landing page copy must echo those principles without sounding like marketing vaporware.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/ROADMAP.md` Q2 2026 — the 1.0 shipping criteria are the *truth* the landing page must reflect. Do not over-claim.
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — the Security page in the docs must link to this verbatim; do not paraphrase the threat model.
5. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — the CLI Reference and API Reference must stay in sync with §10 (CLI + HTTP) and §21 (integration).
6. Skim `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/01-tauri-2-scaffolding.md` for prompt-style conventions (Research → Implementation → Verification → Pitfalls → Why-this-matters).
7. WebFetch authoritative docs:
   - `https://docs.astro.build/en/getting-started/` — Astro 5 install, content collections, integrations
   - `https://starlight.astro.build/` — Starlight theme, sidebar config, Pagefind bundled-by-default
   - `https://starlight.astro.build/guides/pages/#custom-pages` — how to co-locate a non-docs landing page
   - `https://vercel.com/docs/deployments/configure-a-build` — build command + output dir for Astro on Vercel
   - `https://vercel.com/docs/projects/domains/add-a-domain` — custom domain + CNAME
   - `https://pagefind.app/docs/` — Pagefind indexes at build time, <200KB wasm, filter UI
   - `https://docs.astro.build/en/guides/rss/` — RSS feed
   - `https://vercel.com/docs/functions/og-image-generation` — `@vercel/og` dynamic OG images
   - `https://plausible.io/docs/script-extensions` — privacy-respecting analytics
8. Resolve library IDs via `mcp__plugin_compound-engineering_context7__resolve-library-id` for `withastro/astro` and `withastro/starlight`, then `query-docs` for "content collections mdx", "starlight sidebar", and "pagefind integration".

## Implementation task

Build an Astro 5 + Starlight docs site at `docs-site/` (subdirectory of the main repo — **not** a separate repo; this keeps docs and code in lockstep so PRs updating CLI flags update docs in the same diff). Deploy to Vercel with `jellyclaw.dev` (apex) and `docs.jellyclaw.dev` (subdomain) pointing at the same project via path-based routing. The root serves a marketing landing page; `/docs/*` serves Starlight; `/blog/*` serves Markdown blog posts; `/press` serves the press kit.

### Why the same-repo decision

A separate `jellyclaw-docs` repo means a second PR for every CLI flag change. We've seen this fail in projects that prioritize "clean separation" — docs drift, contributors don't update them, users get stale info. Same-repo forces the docs diff to live next to the code diff; code review catches drift.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/package.json` — name `@jellyclaw/docs-site`, private, scripts: `dev`, `build`, `preview`, `astro`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/astro.config.mjs` — Starlight integration, sidebar, Pagefind, MDX, sitemap
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/tsconfig.json` — extends `astro/tsconfigs/strict`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/content/config.ts` — Starlight + blog collection schemas
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/content/docs/` — docs tree (see Content structure)
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/pages/index.astro` — landing page (overrides Starlight root)
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/pages/blog/[...slug].astro` — blog renderer
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/pages/press.astro` — press kit
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/pages/rss.xml.ts` — RSS feed
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/pages/og/[slug].png.ts` — dynamic OG images via `@vercel/og`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/styles/theme.css` — Obsidian & Gold tokens
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/components/Hero.astro`, `FeatureGrid.astro`, `SocialProof.astro`, `Footer.astro`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/scripts/generate-cli-reference.ts` — runs `jellyclaw --help` recursively, emits MDX
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/vercel.json` — build/output config, redirects, security headers
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/public/robots.txt`, `favicon.svg`, `demo.mp4`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/DECISIONS.md` — why Astro Starlight, why same-repo, why Plausible

### Prerequisites check

```bash
node --version                 # >=20.6
pnpm --version                 # 9.x
which vercel || pnpm add -g vercel@latest
vercel --version               # >=34.x
cd /Users/gtrush/Downloads/jellyclaw-engine && pwd
git status                     # clean on main
ls engine/openapi.yaml         # must exist (Phase 10 artifact)
./dist/cli.js --help | head    # smoke test the CLI we're about to document
```

### Step-by-step implementation

1. **Scaffold Astro Starlight.**
   ```bash
   cd /Users/gtrush/Downloads/jellyclaw-engine
   pnpm create astro@latest docs-site -- \
     --template starlight --install --no-git --typescript strict --yes
   cd docs-site
   pnpm add @astrojs/mdx @astrojs/sitemap @astrojs/starlight-openapi \
            @astrojs/rss @vercel/og
   pnpm add -D @types/node
   ```
   Starlight ships Pagefind out of the box — no separate install. Dark theme is default; we customize via `src/styles/theme.css`.

2. **Write `astro.config.mjs`** with the full sidebar:
   ```js
   import { defineConfig } from 'astro/config';
   import starlight from '@astrojs/starlight';
   import mdx from '@astrojs/mdx';
   import sitemap from '@astrojs/sitemap';
   import starlightOpenAPI, { openAPISidebarGroups } from '@astrojs/starlight-openapi';

   export default defineConfig({
     site: 'https://jellyclaw.dev',
     integrations: [
       starlight({
         title: 'Jellyclaw',
         logo: { src: './src/assets/logo.svg', replacesTitle: true },
         social: {
           github: 'https://github.com/gtrush03/jellyclaw-engine',
           discord: 'https://discord.gg/jellyclaw',
         },
         customCss: ['./src/styles/theme.css'],
         editLink: {
           baseUrl:
             'https://github.com/gtrush03/jellyclaw-engine/edit/main/docs-site/',
         },
         head: [
           {
             tag: 'script',
             attrs: {
               defer: true,
               'data-domain': 'jellyclaw.dev',
               src: 'https://plausible.io/js/script.js',
             },
           },
         ],
         plugins: [
           starlightOpenAPI([
             { base: 'api', label: 'HTTP API', schema: '../engine/openapi.yaml' },
           ]),
         ],
         sidebar: [
           { label: 'Getting Started', autogenerate: { directory: 'getting-started' } },
           { label: 'Architecture', autogenerate: { directory: 'architecture' } },
           { label: 'CLI Reference', autogenerate: { directory: 'cli' } },
           ...openAPISidebarGroups,
           { label: 'Skills', autogenerate: { directory: 'skills' } },
           { label: 'MCP Servers', autogenerate: { directory: 'mcp' } },
           { label: 'Plugins', autogenerate: { directory: 'plugins' } },
           { label: 'Security', autogenerate: { directory: 'security' } },
           { label: 'FAQ', link: '/docs/faq/' },
           { label: 'Contributing', link: '/docs/contributing/' },
         ],
       }),
       mdx(),
       sitemap(),
     ],
   });
   ```

3. **Port the Obsidian & Gold tokens** from `desktop/src/styles.css` into `docs-site/src/styles/theme.css`. Starlight exposes `--sl-color-accent`, `--sl-color-bg`, `--sl-color-text`. Key values:
   ```css
   :root, :root[data-theme='dark'] {
     --sl-color-bg: #050505;
     --sl-color-bg-nav: #0a0a0a;
     --sl-color-accent: #928466;
     --sl-color-accent-high: #b8a885;
     --sl-color-text: #e8e6e0;
     --sl-font: 'Inter', system-ui, sans-serif;
     --sl-font-system-mono: 'JetBrains Mono', ui-monospace, monospace;
   }
   ```
   Note: `#928466` on `#050505` is under AA for small body text (≈4.3:1). Use `#b8a885` for body links on dark; keep the pure gold as accent only.

4. **Generate CLI reference at build time.** `scripts/generate-cli-reference.ts` spawns `../dist/cli.js --help` and each subcommand's `--help`, parses the output, emits `src/content/docs/cli/*.mdx` with frontmatter. Wire as `prebuild` in `package.json` so stale docs fail the build.

5. **Generate API reference.** `@astrojs/starlight-openapi` consumes `engine/openapi.yaml` (Phase 10 artifact) directly at build time — no extra script. Verify Phase 10 produced a valid OpenAPI 3.1 doc; if not, STOP and report.

6. **Write the landing page** at `src/pages/index.astro`. Structure:
   - **Hero**: tagline `"Open-source Claude Code. Yours to own."`, sub `"A thin, patched wrapper on OpenCode that matches Claude Code's UX — and that you, not Anthropic, own."`, 30s autoplay-muted demo video (`/public/demo.mp4`), three CTAs: `Install`, `Star on GitHub`, `Join Discord`.
   - **Install block**: tabs for `brew`, `npm`, `download`. Copy-to-clipboard.
   - **Feature grid (6 cards)**: Multi-provider, MCP native, Skills, Subagents, Browser-aware, Open source (MIT).
   - **Architecture diagram**: simplified Mermaid rendered at build time via `rehype-mermaid`.
   - **Social proof**: GitHub stars (Shields.io badge), npm weekly downloads (Shields.io), Discord member count (via `https://discord.com/api/guilds/<id>/widget.json` fetched at build time).
   - **Footer**: Docs, GitHub, Discord, X, RSS, Press, Security (`security@gtru.xyz`).

7. **Blog** at `src/content/blog/` with a collection schema in `src/content/config.ts`:
   ```ts
   import { defineCollection, z } from 'astro:content';
   export const collections = {
     blog: defineCollection({
       type: 'content',
       schema: z.object({
         title: z.string(),
         description: z.string(),
         pubDate: z.date(),
         author: z.string().default('George Trushevskiy'),
         heroImage: z.string().optional(),
         tags: z.array(z.string()).default([]),
       }),
     }),
   };
   ```
   First post (`introducing-jellyclaw.mdx`) is drafted in prompt 03 — not here.

8. **RSS** at `src/pages/rss.xml.ts` via `@astrojs/rss`. Include blog posts only.

9. **Dynamic OG images** at `src/pages/og/[slug].png.ts` via `@vercel/og`. Each doc and blog post gets an OG image with the page title on an Obsidian & Gold background.

10. **Content scaffolds** (stubs, not full content — content fills during v1.0 hardening):
    - `getting-started/install.mdx`, `quickstart.mdx`, `first-wish.mdx`
    - `architecture/overview.mdx` — port from `docs/ARCHITECTURE.md`
    - `skills/authoring.mdx` — SKILL.md frontmatter schema, progressive disclosure, `$ARGUMENTS`
    - `skills/registry.mdx` — community registry stub
    - `mcp/configuring.mdx` — `mcp.json` structure
    - `mcp/known-good.mdx` — tested servers (Playwright MCP pinned `0.0.41` per SECURITY §3.4)
    - `plugins/sdk.mdx` — plugin hook API + subagent-hook-fire patch note
    - `security/disclosure.mdx` — **copy verbatim from `engine/SECURITY.md` §4 + §6**; do not paraphrase. Contact `security@gtru.xyz`, PGP fingerprint, 90-day window.
    - `security/threat-model.mdx` — link to full SECURITY.md on GitHub
    - `faq.mdx`, `contributing.mdx`

11. **Vercel config** at `vercel.json`:
    ```json
    {
      "buildCommand": "pnpm build",
      "outputDirectory": "dist",
      "framework": "astro",
      "installCommand": "pnpm install --frozen-lockfile",
      "headers": [
        {
          "source": "/(.*)",
          "headers": [
            { "key": "X-Frame-Options", "value": "DENY" },
            { "key": "X-Content-Type-Options", "value": "nosniff" },
            { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
            { "key": "Permissions-Policy", "value": "interest-cohort=()" }
          ]
        },
        {
          "source": "/og/(.*)",
          "headers": [
            { "key": "Cache-Control", "value": "public, s-maxage=86400, stale-while-revalidate=604800" }
          ]
        }
      ],
      "redirects": [
        { "source": "/security", "destination": "/docs/security/disclosure", "permanent": true }
      ]
    }
    ```

12. **Deploy.**
    ```bash
    cd docs-site
    vercel login
    vercel link --project jellyclaw-docs
    vercel --prod
    ```
    In the Vercel dashboard: Production Branch → `main`; Root Directory → `docs-site`; Domains → `jellyclaw.dev` (apex `A 76.76.21.21`) and `docs.jellyclaw.dev` (CNAME `cname.vercel-dns.com`); Env → `PUBLIC_PLAUSIBLE_DOMAIN=jellyclaw.dev`.

13. **Sitemap + robots.** `@astrojs/sitemap` auto-emits `sitemap-index.xml`. `public/robots.txt`:
    ```
    User-agent: *
    Allow: /
    Sitemap: https://jellyclaw.dev/sitemap-index.xml
    ```

### Verification

- `pnpm dev` — loads at `http://localhost:4321`, landing page renders, dark theme active, hero video plays
- `pnpm build` — completes with zero errors, `dist/` <5 MB
- `curl -sI https://docs.jellyclaw.dev/getting-started/install` → `HTTP/2 200`
- Pagefind search: type "skill" → returns skills authoring page in <300ms
- Lighthouse desktop ≥95 on Performance, Accessibility, SEO
- `curl https://jellyclaw.dev/rss.xml` returns valid RSS 2.0
- `curl https://jellyclaw.dev/og/introducing-jellyclaw.png` returns a PNG ≥10 KB

### Common pitfalls

- **Starlight owns `/` by default.** To use a custom landing, put `src/pages/index.astro` outside `src/content/docs/` and serve docs under the `/docs` prefix via the collection's path structure.
- **OpenAPI plugin wants an absolute schema path.** Use `path.resolve()` in `astro.config.mjs` or symlink `engine/openapi.yaml` into `docs-site/`.
- **Pagefind doesn't index MDX code blocks or custom components.** Verify search returns results for the CLI reference before declaring victory; if not, add `data-pagefind-body` to the MDX layout.
- **Vercel edge caches OG images too long.** The `Cache-Control` header above is set deliberately to SWR so updates propagate within a day.
- **`new Date()` in OG generator** makes builds non-deterministic — inject the build-time date via `import.meta.env.VERCEL_GIT_COMMIT_SHA` instead.

### Why this matters

The docs site is the first touchpoint for anyone who reads the HN thread or X launch in prompt 03. If docs are broken, slow, or wrong on launch day, the narrative becomes "another half-finished OSS project." A 95+ Lighthouse, working Pagefind, and a Security page that mirrors the engine's actual threat model are the difference between "serious infrastructure" and "weekend hack." Same-repo means Phase 19's weekly rebase automatically keeps docs honest.

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `18` and `<sub-prompt>` with `01-docs-site-and-landing`.

First of three Phase 18 sub-prompts — do **not** mark Phase 18 ✅ yet. In the Phase 18 detail block, add a checkmark for sub-prompt 01 and leave status `🔄 In progress`. The final prompt (03) marks Phase 18 ✅.
