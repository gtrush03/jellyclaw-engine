import { defineConfig } from "tsup";

// Native + runtime-resolved deps that must NEVER be bundled into dist/.
// `better-sqlite3` ships a native `.node` binary; bundling its JS shim would
// still pull in require()s to that binary and break in downstream envs.
// Everything else is either a peer, heavyweight, or resolved dynamically.
const EXTERNAL: readonly string[] = [
  "opencode-ai",
  "@opencode-ai/sdk",
  "@opencode-ai/plugin",
  "@anthropic-ai/sdk",
  "@openrouter/ai-sdk-provider",
  "@modelcontextprotocol/sdk",
  "better-sqlite3",
  "better-sse",
  "@vscode/ripgrep",
  "pdfjs-dist",
  "chokidar",
  "patch-package",
  "zod",
  "zod-to-json-schema",
  "pino",
  "pino-pretty",
  "picomatch",
  "tinyglobby",
  "turndown",
  "undici",
  "ipaddr.js",
  "diff",
  "gray-matter",
  "hono",
  "@hono/node-server",
  "commander",
  "eventsource-parser",
  "execa",
  "p-limit",
  "ink",
  "ink-text-input",
  "ink-spinner",
  "react",
  "react/jsx-runtime",
  "react-devtools-core",
];

export default defineConfig({
  entry: {
    index: "engine/src/index.ts",
    internal: "engine/src/internal.ts",
    events: "engine/src/events.ts",
    config: "engine/src/config.ts",
    cli: "engine/src/cli.ts",
    "cli/main": "engine/src/cli/main.ts",
  },
  outDir: "engine/dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  shims: false,
  treeshake: true,
  external: [...EXTERNAL],
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
