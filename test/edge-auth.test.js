import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const functions = ["ai-extract", "manage-users", "pos-mirror", "pos-push", "pos-reconcile"];

describe("Edge Function authorization posture", () => {
  for (const name of functions) {
    it(`${name} pins its Supabase client and checks account activity`, () => {
      const source = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
      expect(source).toContain("@supabase/supabase-js@2.110.2");
      expect(source).toMatch(/\.select\([^\n]*active/);
      expect(source).toMatch(/\.active/);
    });
  }

  for (const name of ["ai-extract", "pos-mirror", "pos-push", "pos-reconcile"]) {
    it(`${name} bounds outbound network calls`, () => {
      const source = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
      expect(source).toContain("AbortSignal.timeout");
      expect(source).not.toMatch(/await fetch\(/);
    });
  }

  it("pos-push awaits lock release without calling catch on an RPC builder", () => {
    const source = readFileSync(new URL("../supabase/functions/pos-push/index.ts", import.meta.url), "utf8");
    expect(source).toContain('await db.rpc("release_sync_lock"');
    expect(source).not.toMatch(/db\.rpc\("release_sync_lock"[^;]*\.catch/);
  });
});
