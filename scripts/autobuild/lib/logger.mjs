// logger.mjs — thin pino wrapper. Pretty stdout + file tee under .autobuild/logs/.
// Uses the pino + pino-pretty already in the root package.json.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { logsDir } from "./paths.mjs";

function ensureLogsDir() {
  const dir = logsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeLogger(name = "autobuild") {
  ensureLogsDir();
  const logFile = join(logsDir(), `${name}.log`);
  // Use multistream so we tee to both stdout (pretty) and a file (json).
  const streams = [
    { stream: pino.destination({ dest: logFile, sync: false }) },
    {
      stream: pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
      }),
    },
  ];
  return pino(
    { name, level: process.env.AUTOBUILD_LOG_LEVEL || "info" },
    pino.multistream(streams),
  );
}

// Singleton default for most call sites.
let _default = null;
export function logger() {
  if (!_default) _default = makeLogger("autobuild");
  return _default;
}
