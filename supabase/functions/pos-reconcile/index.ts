// @ts-nocheck — Runs on Deno (Supabase Edge runtime), not Node. URL imports and
// the global `Deno` object are valid there; VS Code's Node TS server flags them.
// =============================================================================
// pos-reconcile — Supabase Edge Function (Deno)
//
// Phase 4: the nightly drift detector. Every sync mechanism is built to be
// idempotent, but this is the safety net that PROVES it — comparing what the
// Catalog believes against what the POS ledger actually recorded, and writing
// findings where the Sync Center surfaces them. Usually the report is empty;
// when it isn't, something specific and named needs a human.
//
// Checks:
//   1. Receipt completeness — per synced variant: catalog units (each item's
//      receipt qty) vs the sum of POS purchase movements carrying those items'
//      reference_ids. Catches missing AND duplicated receipts.
//   2. Link integrity — synced items whose POS variant has vanished from the
//      mirror (deleted/retired in the POS without the catalog knowing).
//   3. Oversold stock — mirror rows below zero (the POS allows confirmed
//      oversells; the floor should know).
//   4. Mirror freshness — the mirror loop hasn't completed recently.
//
// Read-only toward the POS. Writes only pos_sync_runs (kind 'reconcile').
// Scheduled nightly; also invocable from the Sync Center.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_FINDINGS = 50;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const jwtPayload = (token: string) => {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch {
    return {};
  }
};

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
  if (!res.ok || !body.token) throw new Error(`POS login failed (${res.status}): ${body.message || "no token"}`);
  return body.token;
}

/** All purchase movements (paged) → per-variant { total, byReference } maps. */
async function fetchPurchaseLedger(baseUrl: string, token: string) {
  const PAGE = 500;
  const MAX_PAGES = 400;
  const byVariant = new Map(); // variant_id -> { total, refs: Map(reference_id -> qty) }
  let offset = 0, scanned = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${baseUrl}/inventory/movements?movement_type=purchase&limit=${PAGE}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`movements read failed (${res.status})`);
    const rows = body.data || [];
    for (const m of rows) {
      const slot = byVariant.get(m.variant_id) || { total: 0, refs: new Map() };
      const qty = Math.abs(Number(m.quantity_change) || 0);
      slot.total += qty;
      if (m.reference_id) slot.refs.set(m.reference_id, (slot.refs.get(m.reference_id) || 0) + qty);
      byVariant.set(m.variant_id, slot);
    }
    scanned += rows.length;
    const total = body.pagination?.total ?? scanned;
    offset += PAGE;
    if (rows.length < PAGE || offset >= total) break;
  }
  return { byVariant, scanned };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const POS_BASE_URL = (Deno.env.get("POS_BASE_URL") || "").replace(/\/$/, "");

  // Same gate as the other loops: service caller, invoke key, or admin user.
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
  const findings = [];
  const add = (kind, sku, note) => {
    if (findings.length < MAX_FINDINGS) findings.push({ kind, sku, note });
  };

  try {
    if (!POS_BASE_URL) throw new Error("POS_BASE_URL secret is not set");
    const token = await posLogin(POS_BASE_URL);

    const [{ data: synced, error: sErr }, { data: mirrorRows, error: mErr }, ledger] = await Promise.all([
      db.from("items")
        .select("id, sku, stock_quantity, pos_variant_id")
        .eq("pos_sync_status", "synced")
        .not("pos_variant_id", "is", null),
      db.from("pos_stock_mirror").select("pos_variant_id, pos_sku, stock_quantity, is_active"),
      fetchPurchaseLedger(POS_BASE_URL, token),
    ]);
    if (sErr) throw new Error(`items read failed: ${sErr.message}`);
    if (mErr) throw new Error(`mirror read failed: ${mErr.message}`);
    const mirror = new Map((mirrorRows || []).map((r) => [r.pos_variant_id, r]));

    // Group synced items per variant: expected receipt units = each item's qty
    // (zero-qty items expect no receipt, by the zero/blank-stock rule).
    const expect = new Map(); // variant_id -> { sku, units, itemIds }
    for (const it of synced || []) {
      const slot = expect.get(it.pos_variant_id) || { sku: it.sku, units: 0, itemIds: [] };
      slot.units += it.stock_quantity ?? 0;
      slot.itemIds.push(it.id);
      expect.set(it.pos_variant_id, slot);
    }

    // 1 + 2: per variant — receipts vs expectation, and link integrity.
    for (const [variantId, exp] of expect) {
      const mir = mirror.get(variantId);
      if (!mir) {
        add("missing-variant", exp.sku, "linked POS variant is not in the mirror — deleted in the POS?");
        continue;
      }
      if (mir.is_active === false) {
        add("retired-variant", exp.sku, "variant was retired in the POS but the catalog still lists it as in-shop");
      }
      const slot = ledger.byVariant.get(variantId);
      const receivedFromCatalog = exp.itemIds.reduce(
        (sum, id) => sum + (slot?.refs.get(id) || 0), 0);
      if (receivedFromCatalog < exp.units) {
        add("missing-receipt", exp.sku,
          `catalog expects ${exp.units} unit(s) received, POS ledger has ${receivedFromCatalog} from catalog receipts`);
      } else if (receivedFromCatalog > exp.units) {
        add("double-receipt", exp.sku,
          `POS ledger holds ${receivedFromCatalog} catalog-receipt unit(s) but the catalog only accounts for ${exp.units}`);
      }
      // 3: oversell visibility.
      if (mir.stock_quantity < 0) {
        add("oversold", exp.sku, `stock is ${mir.stock_quantity} (confirmed oversell) — needs a recount`);
      }
    }

    // 4: mirror freshness — silence means broken, and reconcile runs at night
    //    when nobody is watching the UI's freshness line.
    const { data: lastMirror } = await db
      .from("pos_sync_runs").select("finished_at, ok").eq("kind", "mirror")
      .order("started_at", { ascending: false }).limit(1);
    const lm = (lastMirror || [])[0];
    const ageMin = lm?.finished_at ? (Date.now() - new Date(lm.finished_at).getTime()) / 60000 : Infinity;
    if (!lm || ageMin > 60) add("stale-mirror", null, lm ? `last mirror ran ${Math.round(ageMin)} min ago` : "mirror has never run");
    else if (lm.ok === false) add("mirror-failing", null, "the most recent mirror run failed");

    const summary = {
      variants_checked: expect.size,
      purchase_movements_scanned: ledger.scanned,
      findings,
    };
    await db.from("pos_sync_runs").insert({
      kind: "reconcile", started_at: startedAt, finished_at: new Date().toISOString(),
      ok: true, ok_count: expect.size, error_count: findings.length, summary,
    });
    return json({ ok: true, drift: findings.length, ...summary });
  } catch (err) {
    await db.from("pos_sync_runs").insert({
      kind: "reconcile", started_at: startedAt, finished_at: new Date().toISOString(),
      ok: false, ok_count: 0, error_count: 1, error: String(err?.message || err),
      summary: { findings },
    });
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
});
