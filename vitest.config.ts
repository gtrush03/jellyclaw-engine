import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "engine/src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["engine/src/**/*.ts"],
      exclude: ["engine/src/**/*.test.ts", "engine/src/**/types.ts", "engine/src/cli.ts"],
      // Phase 0: informational only. Phase 3 lifts these to 70/70/70/70.
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
  resolve: {
    alias: {
      "@jellyclaw/engine": new URL("./engine/src/index.ts", import.meta.url).pathname,
    },
  },
});
