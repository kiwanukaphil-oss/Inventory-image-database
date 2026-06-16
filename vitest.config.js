import { defineConfig } from "vitest/config";

// Separate from vite.config.js so the PWA plugin doesn't run during tests.
// The suite covers pure logic (src/lib/*, imagehash), so the node environment
// is enough — no DOM or Supabase needed.
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
  },
});
