import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5174",
        changeOrigin: true,
        ws: true,
        // SSE needs an infinite proxy timeout and disabled response buffering.
        // Default http-proxy settings close long-lived streams after ~30s —
        // which manifests as "UI goes stale, have to refresh". Zero means
        // no timeout; `selfHandleResponse: false` + per-res tweaks keep the
        // chunked stream flowing.
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            const ct = proxyRes.headers["content-type"] ?? "";
            if (typeof ct === "string" && ct.includes("text/event-stream")) {
              proxyRes.headers["x-accel-buffering"] = "no";
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["connection"] = "keep-alive";
            }
          });
        },
      },
    },
  },
});
