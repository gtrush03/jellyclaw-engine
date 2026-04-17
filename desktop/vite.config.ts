import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  // Tauri expects a fixed port
  server: {
    port: 5173,
    strictPort: true,
  },
  // Build output for Tauri
  build: {
    outDir: "dist",
    target: "esnext",
    minify: false,
  },
  // Clear screen is annoying with Tauri
  clearScreen: false,
});
