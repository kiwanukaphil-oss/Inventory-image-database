import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Served from the root of the custom domain (klinemen-catalog.com, set via the
// public/CNAME file), so the base is "/" everywhere — dev, preview, and deployed.
export default defineConfig(() => ({
  base: "/",
  build: { outDir: "dist", sourcemap: false },
  server: { port: 5173, host: true }, // host:true exposes on LAN for phone testing
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      // Keep dev clean (no service worker in `npm run dev`); the PWA is active in
      // the built/deployed site, which is what gets installed on a phone.
      devOptions: { enabled: false },
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "K-LINE MEN Catalog",
        short_name: "K-LINE MEN",
        description: "Inventory image catalogue for K-Line menswear.",
        theme_color: "#0f1115",
        background_color: "#0f1115",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the app shell only. Supabase REST/Auth/Storage calls are XHR
        // (not navigations) and are never matched here, so live data is always
        // fetched fresh — exactly what we want.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Inter ships Latin/Cyrillic/Greek/Vietnamese subsets; this app is Latin
        // only, so keep just latin (+latin-ext) in the offline precache. The
        // browser still only requests the subset a glyph needs at runtime.
        globIgnores: ["**/inter-cyrillic*", "**/inter-greek*", "**/inter-vietnamese*"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api/, /supabase\.co/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
}));
