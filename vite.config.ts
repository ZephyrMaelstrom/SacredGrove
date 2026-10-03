import { defineConfig } from "vite";

// GitHub Pages serves the site from /SacredGrove/.
export default defineConfig({
  base: "/SacredGrove/",
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  server: { host: true },
});
