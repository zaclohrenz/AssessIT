import { defineConfig } from "vite";

// Tauri expects a fixed port in dev and plain static output in build.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // The PDF engine (~2 MB with fonts) is its own chunk, loaded only when exporting.
  build: { target: "safari15", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
