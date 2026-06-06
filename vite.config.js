import { defineConfig } from "vite";

// GitHub Pages serves this project under /Inventory-image-database/, so every
// asset URL must be prefixed with that path. Locally (dev/preview) we serve from
// root, so the base is only applied for production builds.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/Inventory-image-database/" : "/",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: true, // expose on LAN so you can test on a real phone during dev
  },
}));
