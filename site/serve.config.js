// site/serve.config.js
// Tiny same-origin file server for the landing page during local development.
// Run with:  bun run serve:site         → http://127.0.0.1:4311
//
// Bun built-in `serve` is enough — no framework, no bundler. The landing page
// is fully static, so this just maps URL paths into ./site/ and lets Bun.file
// stream the bytes (with correct content-type via Bun's built-in sniffing).

import { serve } from "bun";

const ROOT = new URL("./", import.meta.url).pathname.replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 4311);

const SAFE = /^[/A-Za-z0-9._-]+$/;

const mime = (path) => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css"))  return "text/css; charset=utf-8";
  if (path.endsWith(".js"))   return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg"))  return "image/svg+xml";
  if (path.endsWith(".cast")) return "application/x-asciicast";
  if (path.endsWith(".json")) return "application/json";
  return undefined;
};

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!SAFE.test(path) || path.includes("..")) {
      return new Response("forbidden", { status: 403 });
    }
    const file = Bun.file(`${ROOT}${path}`);
    if (!(await file.exists())) {
      return new Response("not found", { status: 404 });
    }
    const headers = new Headers();
    const ct = mime(path);
    if (ct) headers.set("content-type", ct);
    headers.set("cache-control", "no-store");
    return new Response(file, { headers });
  },
});

console.log(`landing: http://127.0.0.1:${PORT}`);
console.log(`serving: ${ROOT}`);
