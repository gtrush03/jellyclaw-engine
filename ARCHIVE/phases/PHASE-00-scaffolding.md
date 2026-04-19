---
phase: 00
name: "Repo scaffolding"
duration: "0.5 day"
depends_on: []
blocks: [01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
---

# Phase 00 — Repo scaffolding

## Dream outcome

A fresh clone of `jellyclaw-engine` runs `pnpm install && pnpm typecheck && pnpm test` green on a machine with Node 20+ and pnpm 9+. Every future contributor starts from a known-good state with lint, typecheck, test, format, and commit hygiene wired in.

## Deliverables

- `package.json` (pnpm workspace, Node `>=20.18`)
- `pnpm-workspace.yaml` listing `engine`, `desktop`, `integration`, `shared`
- `tsconfig.base.json` + per-package `tsconfig.json`
- `biome.json` (lint + format)
- `vitest.config.ts` (root) + per-package overrides
- `.gitignore`, `.npmrc` (`auto-install-peers=true`, `strict-peer-dependencies=false`)
- `.env.example` (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENCODE_SERVER_PASSWORD, JELLYCLAW_LOG_LEVEL)
- `.nvmrc` → `20.18.0`
- `LICENSE` (MIT, copyright "G. Trushevskiy")
- `README.md` (1-pager: what/why/status)
- `CLAUDE.md` for the repo itself (what jellyclaw is, directory map, "don't touch patches/ without reading Phase 01")
- `.github/workflows/ci.yml` (matrix node 20, 22; runs install, typecheck, lint, test)
- Initial git commit, tag `v0.0.0-scaffold`

## Step-by-step

### Step 1 — Init git + .gitignore
(a) Initialize repo. (b) `cd /Users/gtrush/Downloads/jellyclaw-engine && git init -b main`. (c) `Initialized empty Git repository`. (d) `git status` returns clean worktree. (e) If dir already a repo, skip.

Create `.gitignore`:
```
node_modules/
dist/
.DS_Store
.env
.env.local
coverage/
*.log
.turbo/
.vitest-cache/
~/.jellyclaw/
**/target/
**/src-tauri/target/
```

### Step 2 — Root package.json
Create `package.json`:
```json
{
  "name": "jellyclaw",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20.18" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "biome check .",
    "format": "biome format --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "pnpm -r build",
    "postinstall": "patch-package"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/node": "^20.16.0",
    "patch-package": "^8.0.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

### Step 3 — pnpm workspace
`pnpm-workspace.yaml`:
```yaml
packages:
  - engine
  - desktop
  - integration
  - shared
```
Create `shared/package.json` stub with `name: "@jellyclaw/shared"`.

### Step 4 — tsconfig.base.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

### Step 5 — Biome config
`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "files": { "ignore": ["dist", "node_modules", "patches", "**/target"] }
}
```

### Step 6 — Vitest root
`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: { provider: "v8", reporter: ["text", "html"] }
  }
});
```

### Step 7 — .env.example
```
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
OPENCODE_SERVER_PASSWORD=change-me
JELLYCLAW_LOG_LEVEL=info
JELLYCLAW_HOME=~/.jellyclaw
```

### Step 8 — LICENSE (MIT)
Standard MIT text, `Copyright (c) 2026 George Trushevskiy`.

### Step 9 — README.md
One page: title, 3-line pitch, status badge placeholder, `pnpm install && pnpm test`, link to `phases/README.md`.

### Step 10 — CLAUDE.md (for agents working on this repo)
Describe directory map (`engine/`, `desktop/`, `integration/`, `patches/`, `skills/`, `agents/`, `phases/`), the "thin wrapper" rule, the "don't modify `node_modules/opencode-ai` — use `patches/`" rule, and point at `phases/README.md`.

### Step 11 — CI workflow
`.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { node: [20, 22] } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

### Step 12 — Install + first commit
Commands:
```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
pnpm install
pnpm typecheck   # will pass with empty packages
pnpm lint        # should pass
git add -A
git commit -m "chore: initial scaffold"
git tag v0.0.0-scaffold
```
Expected: clean install, no errors.

## Acceptance criteria

- [ ] `pnpm install` exits 0 on a clean clone
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 (no tests yet → "no tests found" is acceptable with `--passWithNoTests`)
- [ ] CI matrix green on GitHub Actions
- [ ] `LICENSE`, `README.md`, `CLAUDE.md`, `.env.example` present
- [ ] Git tag `v0.0.0-scaffold` exists

## Risks + mitigations

- **pnpm version drift** → pin via `packageManager` field + `.nvmrc`.
- **Biome rule churn** → pin exact version, not `^`.
- **`patch-package` postinstall errors on first run** (no patches yet) → accept exit 0 with no patches message.

## Dependencies to install

```
@biomejs/biome@1.9.4
@types/node@^20.16
patch-package@^8
typescript@^5.6
vitest@^2.1
```

## Files touched

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`
- `.gitignore`, `.nvmrc`, `.npmrc`, `.env.example`
- `LICENSE`, `README.md`, `CLAUDE.md`
- `.github/workflows/ci.yml`
- `shared/package.json` (stub)
