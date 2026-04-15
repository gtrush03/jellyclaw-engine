> **STATUS: superseded by `engine/src/bootstrap/opencode-server.ts`.** This file was authored
> when we believed opencode-ai would be patchable at the source level. The npm
> distribution is a compiled binary, so the patch is not applicable. This document
> is retained as the design-intent record; the live implementation is at
> `engine/src/bootstrap/opencode-server.ts` (hostname-locked spawn plus a
> `getsockname`-equivalent assertion after listen).

# [upstream-unlikely][security] Force 127.0.0.1 bind; mandatory auth token
#
# Context: CVE-2026-22812. OpenCode <1.0.216 bound to all interfaces with
# no auth. Even after the upstream auth fix, the CLI still accepts
# `--bind 0.0.0.0` without a warning, and OPENCODE_SERVER_PASSWORD is
# optional (silent fallthrough to "no password" in some paths).
#
# This patch:
#   1. Refuses any bind address that is not loopback, unless the user
#      passes `--unsafe-bind-all` explicitly.
#   2. Auto-generates a 32-byte hex OPENCODE_SERVER_PASSWORD if unset,
#      writes it to stderr exactly once, and never logs it again.
#   3. Prints a single-line startup banner confirming the safe defaults.
#
# Upstream probably will not take this — they lean toward "ship minimal
# defaults, trust the operator." We ship strict defaults because jellyclaw
# runs under a desktop app where any webpage is an adversary.
#
# Jellyclaw ticket: SEC-003
# Line numbers approximate against @sst/opencode@1.1.10.
# --------------------------------------------------------------------

diff --git a/packages/opencode/src/cli/cmd/serve.ts b/packages/opencode/src/cli/cmd/serve.ts
index 5555555..6666666 100644
--- a/packages/opencode/src/cli/cmd/serve.ts
+++ b/packages/opencode/src/cli/cmd/serve.ts
@@ -1,4 +1,5 @@
 import { Command } from "commander";
+import { randomBytes } from "node:crypto";
 import { createServer } from "../../server";
 import { log } from "../../log";

@@ -12,11 +13,47 @@ export const serveCmd = new Command("serve")
   .description("Start the OpenCode HTTP server")
   .option("--bind <address>", "Address to bind", "127.0.0.1")
   .option("--port <port>", "Port to listen on", "4096")
+  .option("--unsafe-bind-all", "Allow binding to non-loopback (DANGEROUS)", false)
   .action(async (opts) => {
-    const server = await createServer({ bind: opts.bind, port: Number(opts.port) });
+    const bind = opts.bind ?? "127.0.0.1";
+
+    // --- SEC-003: refuse non-loopback bind unless explicitly overridden ---
+    const isLoopback =
+      bind === "127.0.0.1" ||
+      bind === "::1" ||
+      bind === "localhost" ||
+      bind.startsWith("127.");
+
+    if (!isLoopback && !opts.unsafeBindAll) {
+      log.error(
+        `Refusing to bind to non-loopback address "${bind}".\n` +
+          `Jellyclaw binds to 127.0.0.1 by default because exposing this\n` +
+          `server to a network interface is a high-risk configuration\n` +
+          `(see CVE-2026-22812).\n\n` +
+          `If you really mean this, pass --unsafe-bind-all. You must also\n` +
+          `put the server behind a TLS-terminating reverse proxy with its\n` +
+          `own authentication layer. The built-in bearer token is not a\n` +
+          `substitute for that.`,
+      );
+      process.exit(2);
+    }
+
+    if (opts.unsafeBindAll) {
+      log.warn(
+        `[SECURITY] --unsafe-bind-all in effect. Binding to ${bind}. ` +
+          `Any host that can route to this machine can reach the server.`,
+      );
+    }
+
+    // --- SEC-003: ensure OPENCODE_SERVER_PASSWORD is always set ---
+    if (!process.env.OPENCODE_SERVER_PASSWORD) {
+      const token = randomBytes(32).toString("hex");
+      process.env.OPENCODE_SERVER_PASSWORD = token;
+      // Write to stderr exactly once. The parent dispatcher captures this
+      // line (matched by the prefix) and rotates its cached token. After
+      // this point the token is never logged again.
+      process.stderr.write(
+        `JELLYCLAW_SERVER_TOKEN=${token}\n`,
+      );
+    }
+
+    log.info(
+      `jellyclaw serve bind=${bind} port=${opts.port} auth=bearer cors=empty`,
+    );
+
+    const server = await createServer({
+      bind,
+      port: Number(opts.port),
+      // Server reads OPENCODE_SERVER_PASSWORD from env; we just ensured it.
+    });
     server.listen();
   });
