import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built to web/dist, served by the Express backend in production.
// In dev, proxy /api to the backend so the SPA and API share an origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
