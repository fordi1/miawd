import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API server runs on port 3000; in production the same server also serves this built app.
// `changeOrigin: false` keeps the browser's Host header, so the server's same-origin check (Origin must match Host) passes.
const API = { target: "http://localhost:3000", changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/panel": API, "/v1": API, "/docs": API, "/health": API } },
  build: { outDir: "dist", sourcemap: false },
});
