/**
 * Consumer smoke: imports the built `@jellyclaw/engine` from `dist/`, runs a
 * single echo-loop wish, and prints `"consumer OK"` on success.
 *
 * This script is spawned by `test/library/consumer.test.ts` under the
 * `JELLYCLAW_LIB_CONSUMER_TEST=1` gate. It deliberately avoids any dev-time
 * tooling (no vitest, no aliases) so it exercises the real published
 * package surface: bundled JS, bundled .d.ts, proper `exports` map.
 *
 * The env contract (documented here because the test harness reads it too):
 *
 *   JELLYCLAW_HTTP_E2E=0                    — never boot the HTTP server
 *   JELLYCLAW_CONSUMER_MOCK_PROVIDER=1      — skip real API calls; the
 *                                             engine's `providerOverride`
 *                                             receives a no-op object
 *   JELLYCLAW_LOG_LEVEL=silent              — quiet the logger
 */

import { createEngine } from "@jellyclaw/engine";

const engine = await createEngine({});
let ticks = 0;
for await (const ev of engine.run({ prompt: "say 'ok'" })) {
  ticks++;
  if (ticks > 200) throw new Error("runaway");
  if (ev.type === "session.completed") break;
}
await engine.dispose();
process.stdout.write("consumer OK\n");
