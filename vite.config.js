import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Served from the root of the custom domain (klinemen-catalog.com, set via the
// public/CNAME file), so the base is "/" everywhere — dev, preview, and deployed.
export default defineConfig(() => ({
  base: "/",
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@supabase/")) return "supabase";
        },
      },
    },
  },
  server: { port: 5173, host: true }, // host:true exposes on LAN for phone testing
  plugins: [
    VitePWA({
      // Updates are offered explicitly so an active review/pricing task is never
      // replaced by a service-worker reload halfway through the work.
      registerType: "prompt",
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
        // Long-press the installed icon to jump straight to the two hot paths.
        shortcuts: [
          { name: "Add stock", short_name: "Add", url: "/?view=add",
            icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }] },
          { name: "Review queue", short_name: "Review", url: "/?view=review",
            icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }] },
        ],
        // Accept photos shared from the camera roll / other apps straight into Add.
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: { files: [{ name: "photos", accept: ["image/*"] }] },
        },
      },
      workbox: {
        // A tiny extra SW script receives the share POST (see public/sw-share.js).
        importScripts: ["/sw-share.js"],
        // Precache the app shell only. Supabase REST/Auth/Storage calls are XHR
        // (not navigations) and are never matched here, so live data is always
        // fetched fresh — exactly what we want.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Inter ships Latin/Cyrillic/Greek/Vietnamese subsets; this app is Latin
        // only, so keep just latin (+latin-ext) in the offline precache. The
        // browser still only requests the subset a glyph needs at runtime.
        globIgnores: ["**/inter-cyrillic*", "**/inter-greek*", "**/inter-vietnamese*"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api/, /supabase\.co/, /^\/share-target/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
}));
