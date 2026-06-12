// @ts-nocheck — Runs on Deno (Supabase Edge runtime), not Node. URL imports and
// the global `Deno` object are valid there; VS Code's Node TS server flags them.
// =============================================================================
// pos-mirror — Supabase Edge Function (Deno)
//
// Phase 2a of the Catalog↔POS integration (see
// inventory-pos-connector/EXPERIENCE-PLAN.md). Pulls live stock / sold counts /
// current prices from the POS REST API into the read-only pos_stock_mirror
// table, and logs a heartbeat row in pos_sync_runs. The PWA renders both as
// the "In shop · N left" chips and the "Shop data as of HH:MM" freshness line.
//
// Strictly read-only toward the POS (GET + login only) and the single writer
// of pos_stock_mirror — the POS owns every mirrored value.
//
// Invocation:
//   - Supabase Cron every 10 min (POST with the service-role key as Bearer)
//   - Manually by a signed-in admin / user-manager (future "Sync now" button)
//
// Secrets (supabase secrets set ...):
//   POS_BASE_URL              e.g. https://inventorypos-production.up.railway.app/api
//   CATALOG_SYNC_USERNAME     the POS catalog_sync service account
//   CATALOG_SYNC_PASSWORD
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected by
// the platform automatically.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

// Decode a (platform-verified) JWT payload without re-verifying — we only need
// the role claim to distinguish the cron/service caller from a real user.
const jwtPayload = (token: string) => {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch {
    return {};
  }
};

/** Log in to the POS as catalog_sync and return a Bearer token. */
async function posLogin(baseUrl: string) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: Deno.env.get("CATALOG_SYNC_USERNAME"),
      password: Deno.env.get("CATALOG_SYNC_PASSWORD"),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new Error(`POS login failed (${res.status}): ${body.message || "no token"}`);
  }
  return body.token;
}

async function posGet(baseUrl: string, token: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POS GET ${path} failed (${res.status}): ${body.message || ""}`);
  return body;
}

/**
 * Sum a movement type's quantity_change per variant by paging the full POS
 * ledger. A full scan every run is deliberate at this scale (self-healing, no
 * cursor state to corrupt); the Phase 3 delta endpoint replaces it when the
 * ledger grows.
 */
async function sumMovements(baseUrl: string, token: string, movementType: string) {
  const PAGE = 500;
  const MAX_PAGES = 400; // hard stop ≈ 200k movements, far beyond current scale
  const totals = new Map(); // variant_id -> summed |quantity_change|
  let offset = 0;
  let scanned = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await posGet(
      baseUrl,
      token,
      `/inventory/movements?movement_type=${movementType}&limit=${PAGE}&offset=${offset}`
    );
    const rows = body.data || [];
    for (const m of rows) {
      const qty = Math.abs(Number(m.quantity_change) || 0);
      totals.set(m.variant_id, (totals.get(m.variant_id) || 0) + qty);
    }
    scanned += rows.length;
    const total = body.pagination?.total ?? scanned;
    offset += PAGE;
    if (rows.length < PAGE || offset >= total) break;
  }
  return { totals, scanned };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const POS_BASE_URL = (Deno.env.get("POS_BASE_URL") || "").replace(/\/$/, "");

  // --- authorize: the cron/service caller, or an admin/user-manager user ---
  // Deployed with --no-verify-jwt (the project uses new-style sb_secret_ keys,
  // which the gateway's JWT check doesn't understand), so THIS block is the
  // only gate. Accepted callers:
  //   1. the service-role key itself (legacy JWT claim OR exact new-key match)
  //   2. the dedicated MIRROR_INVOKE_KEY secret (what the cron job sends)
  //   3. a signed-in admin / user-manager (the future "Sync now" button)
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const INVOKE_KEY = Deno.env.get("MIRROR_INVOKE_KEY") || "";
  const isService =
    jwtPayload(bearer).role === "service_role" ||
    (bearer && bearer === SERVICE_KEY) ||
    (INVOKE_KEY && bearer === INVOKE_KEY);
  if (!isService) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: "unauthorized" }, 401);
    const adminCheck = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: me } = await adminCheck
      .from("profiles").select("role, can_manage_users").eq("id", userData.user.id).single();
    if (!me || !(me.can_manage_users || me.role === "admin")) return json({ error: "forbidden" }, 403);
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const startedAt = new Date().toISOString();

  // The run row is written in BOTH outcomes (finally-style) — a silent gap in
  // pos_sync_runs is how the UI detects a dead mirror, so failures must log too.
  try {
    if (!POS_BASE_URL) throw new Error("POS_BASE_URL secret is not set");
    const token = await posLogin(POS_BASE_URL);

    // 1. Every active variant (one call — the endpoint is unpaginated).
    const variantsBody = await posGet(POS_BASE_URL, token, "/products/variants");
    const variants = variantsBody.data || [];

    // 2. Lifetime sold/returned per variant from the movements ledger.
    const sales = await sumMovements(POS_BASE_URL, token, "sale");
    const returns = await sumMovements(POS_BASE_URL, token, "return");

    // 3. Upsert the mirror.
    const nowIso = new Date().toISOString();
    const rows = variants.map((v) => ({
      pos_variant_id: v.id,
      pos_sku: (v.sku || "").toUpperCase(),
      product_name: v.product_name || null,
      brand_name: v.brand_name || null,
      price: v.price ?? null,
      stock_quantity: Number(v.quantity_in_stock) || 0,
      reorder_level: v.reorder_level ?? null,
      units_sold: sales.totals.get(v.id) || 0,
      units_returned: returns.totals.get(v.id) || 0,
      is_active: v.is_active !== false,
      mirrored_at: nowIso,
    }));
    if (rows.length) {
      const { error } = await db.from("pos_stock_mirror").upsert(rows, { onConflict: "pos_variant_id" });
      if (error) throw new Error(`mirror upsert failed: ${error.message}`);
    }

    // 4. Variants that vanished from the active list were archived in the POS —
    //    keep their rows but flag them, so the catalog can say "retired".
    const activeIds = new Set(rows.map((r) => r.pos_variant_id));
    const { data: existing, error: exErr } = await db.from("pos_stock_mirror").select("pos_variant_id").eq("is_active", true);
    if (exErr) throw new Error(`mirror read failed: ${exErr.message}`);
    const retired = (existing || []).map((r) => r.pos_variant_id).filter((id) => !activeIds.has(id));
    if (retired.length) {
      const { error } = await db.from("pos_stock_mirror")
        .update({ is_active: false, mirrored_at: nowIso })
        .in("pos_variant_id", retired);
      if (error) throw new Error(`mirror retire failed: ${error.message}`);
    }

    const summary = {
      variants: rows.length,
      retired: retired.length,
      sale_movements_scanned: sales.scanned,
      return_movements_scanned: returns.scanned,
    };
    await db.from("pos_sync_runs").insert({
      kind: "mirror", started_at: startedAt, finished_at: new Date().toISOString(),
      ok: true, ok_count: rows.length, error_count: 0, summary,
    });
    return json({ ok: true, ...summary });
  } catch (err) {
    await db.from("pos_sync_runs").insert({
      kind: "mirror", started_at: startedAt, finished_at: new Date().toISOString(),
      ok: false, ok_count: 0, error_count: 1, error: String(err?.message || err),
    });
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
});
