import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` here + `npm run dev -w @fa/server` for live reload during development.
    proxy: { "/api": "http://localhost:8080", "/healthz": "http://localhost:8080" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
