# Scripts cheat sheet

All commands run from `dashboard/` unless noted.

## Recommended additions

### `dashboard/package.json`

```jsonc
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:all": "npm run test:unit && npm run test:integration",
    "test:e2e": "playwright test",
    "test:coverage": "vitest run --coverage"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "@vitest/coverage-v8": "^2.1.0",
    "vitest": "^2.1.0",
    "zod": "^3.23.8"
  }
}
```

Install: `npm install --save-dev @playwright/test @vitest/coverage-v8 vitest zod`
Then: `npx playwright install chromium`

### `dashboard/server/package.json`

```jsonc
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test:unit": "vitest run ../tests/unit",
    "test:integration": "vitest run ../tests/integration",
    "test:all": "npm run test:unit && npm run test:integration"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^2.1.0",
    "vitest": "^2.1.0"
  }
}
```

## Daily commands

| Command | What it does |
| --- | --- |
| `./start.sh` | Start backend + frontend, open browser |
| `./stop.sh` | Kill both, free ports 5173 and 5174 |
| `npm run typecheck` | TypeScript check, no build output |
| `npm run lint` | Biome check across the dashboard |
| `npm run test:unit` | Vitest — pure function tests (parser, etc.) |
| `npm run test:integration` | Vitest — hits live backend on 5174 |
| `npm run test:e2e` | Playwright — needs `./start.sh` running first |
| `npm run test:all` | Unit + integration (skips E2E) |
| `npm run test:coverage` | Vitest with v8 coverage → `coverage/` |
| `npm run build` | Production build of the frontend |

## CI-style sequence

```bash
cd dashboard
npm run typecheck
npm run lint
npm run test:unit
./start.sh &
sleep 5
npm run test:integration
npm run test:e2e
./stop.sh
```

## Troubleshooting specific scripts

- **`test:integration` fails with `ECONNREFUSED`** → backend not running. Start with
  `cd server && PORT=5174 npm run dev`.
- **`test:e2e` fails with "browser not installed"** → run
  `npx playwright install chromium` once per machine.
- **`test:coverage` reports 0% for server files** → vitest runs from `dashboard/` by
  default. Ensure `vitest.config.ts` `coverage.include` lists `server/src/**` (it does).
