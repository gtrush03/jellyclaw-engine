import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "engine/src/index.ts",
    cli: "engine/src/cli.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  shims: false,
  treeshake: true,
  banner: ({ format }) => {
    if (format === "esm") {
      return { js: "#!/usr/bin/env node" };
    }
    return {};
  },
  // Only the CLI needs the shebang; tsup will put it on every esm entry. That
  // is harmless (Node ignores the shebang in library imports), but we keep the
  // produced dist/cli.js executable in scripts/setup.sh via chmod.
});
