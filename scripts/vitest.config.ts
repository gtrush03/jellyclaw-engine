import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules"],
    deps: {
      // Allow yaml package for release workflow tests
      interopDefault: true,
    },
  },
});
