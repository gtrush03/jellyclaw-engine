import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Shared vitest config for both the React frontend (`src/`) and the Hono backend
 * (`server/src/`).
 *
 * Test buckets:
 *   - tests/unit/**          : pure-function unit tests (parsers, formatters)
 *   - tests/integration/**   : hit the live backend at 127.0.0.1:5174
 *   - tests/e2e/**           : Playwright — NOT run by vitest
 *
 * Run a single bucket:
 *   npm run test:unit
 *   npm run test:integration
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: [
      "tests/unit/**/*.{test,spec}.ts",
      "tests/integration/**/*.{test,spec}.ts",
      "tests/*.{test,spec}.{ts,tsx}",
      "src/**/*.{test,spec}.{ts,tsx}",
      "server/src/**/*.{test,spec}.ts",
      "server/tests/**/*.{test,spec}.ts",
    ],
    exclude: [
      "node_modules/**",
      "server/node_modules/**",
      "dist/**",
      "server/dist/**",
      "tests/e2e/**", // Playwright owns these
    ],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**", "server/src/**"],
      exclude: [
        "src/main.tsx",
        "src/**/*.d.ts",
        "server/src/index.ts",
        "**/*.config.*",
        "tests/**",
      ],
    },
  },
});
