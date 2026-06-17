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
// Self-contained for direct Supabase-dashboard deploy (no CLI bundling of _shared).
// Origin-allowlisted CORS (S5) + constant-time, fail-closed POS-caller auth (S4).
// These two helpers are duplicated across the 3 pos-* functions — keep them in sync.
const DEFAULT_ALLOWED = "https://klinemen-catalog.com";
function corsHeaders(req) {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || DEFAULT_ALLOWED).split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowed.includes("*")) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
const makeJson = (cors) => (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha), vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
async function authorizePosCaller(req, env) {
  const { SUPABASE_URL, SERVICE_KEY, ANON_KEY } = env;
  if (!SERVICE_KEY || SERVICE_KEY.length < 20) return { ok: false, status: 500, error: "server auth not configured" };
  const invokeKey = Deno.env.get("MIRROR_INVOKE_KEY") || "";
  if (invokeKey && invokeKey.length < 32) console.warn("MIRROR_INVOKE_KEY shorter than 32 chars — rotate to a stronger value.");
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer) {
    if (await timingSafeEqual(bearer, SERVICE_KEY)) return { ok: true };
    if (invokeKey && (await timingSafeEqual(bearer, invokeKey))) return { ok: true };
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return { ok: false, status: 401, error: "unauthorized" };
  const adminCheck = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: me } = await adminCheck.from("profiles").select("role, can_manage_users").eq("id", userData.user.id).maybeSingle();
  if (!me || !(me.can_manage_users || me.role === "admin")) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true };
}

const MAX_FINDINGS = 50;

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

/** One movement type's ledger (paged) → per-variant totals + per-reference map. */
async function fetchLedger(baseUrl: string, token: string, movementType: string) {
  const PAGE = 500;
  const MAX_PAGES = 400;
  // variant_id -> { total, negative, refs: Map(reference_id -> qty) }
  const byVariant = new Map();
  let offset = 0, scanned = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${baseUrl}/inventory/movements?movement_type=${movementType}&limit=${PAGE}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`movements read failed (${res.status})`);
    const rows = body.data || [];
    for (const m of rows) {
      const slot = byVariant.get(m.variant_id) || { total: 0, negative: 0, refs: new Map() };
      const change = Number(m.quantity_change) || 0;
      slot.total += Math.abs(change);
      if (change < 0) slot.negative += -change;
      if (m.reference_id) slot.refs.set(m.reference_id, (slot.refs.get(m.reference_id) || 0) + Math.abs(change));
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
  const cors = corsHeaders(req);
  const json = makeJson(cors);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const POS_BASE_URL = (Deno.env.get("POS_BASE_URL") || "").replace(/\/$/, "");

  // Authorize: constant-time service secret / MIRROR_INVOKE_KEY, or a signed-in
  // admin/user-manager. Deployed --no-verify-jwt — see authorizePosCaller above (S4).
  const authz = await authorizePosCaller(req, { SUPABASE_URL, SERVICE_KEY, ANON_KEY });
  if (!authz.ok) return json({ error: authz.error }, authz.status);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const startedAt = new Date().toISOString();
  const findings = [];
  const add = (kind, sku, note) => {
    if (findings.length < MAX_FINDINGS) findings.push({ kind, sku, note });
  };

  try {
    if (!POS_BASE_URL) throw new Error("POS_BASE_URL secret is not set");
    const token = await posLogin(POS_BASE_URL);

    const [{ data: synced, error: sErr }, { data: mirrorRows, error: mErr }, ledger, adjustments] = await Promise.all([
      db.from("items")
        .select("id, sku, stock_quantity, pos_variant_id")
        .eq("pos_sync_status", "synced")
        .not("pos_variant_id", "is", null),
      db.from("pos_stock_mirror").select("pos_variant_id, pos_sku, stock_quantity, is_active"),
      fetchLedger(POS_BASE_URL, token, "purchase"),
      fetchLedger(POS_BASE_URL, token, "adjustment"),
    ]);
    if (sErr) throw new Error(`items read failed: ${sErr.message}`);
    if (mErr) throw new Error(`mirror read failed: ${mErr.message}`);
    const mirror = new Map((mirrorRows || []).map((r) => [r.pos_variant_id, r]));

    // Group synced items per variant: expected receipt units = each item's qty.
    // Blank legacy quantities are one photographed unit; explicit zero expects
    // no receipt.
    const expect = new Map(); // variant_id -> { sku, units, itemIds }
    for (const it of synced || []) {
      const slot = expect.get(it.pos_variant_id) || { sku: it.sku, units: 0, itemIds: [] };
      // Match pos-push: legacy blank quantity means one photographed unit;
      // explicit 0 still means catalog-only/no receipt expected.
      slot.units += it.stock_quantity ?? 1;
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
        // Receipts are append-only history: a known over-receipt is corrected
        // by booking a NEGATIVE adjustment, never by rewriting the receipt
        // (the 2026-06-12 duplicate-SKU correction did exactly this). So an
        // over-receipt only counts as drift when no downward adjustment of at
        // least the excess exists on the variant — i.e. nobody has corrected it.
        const excess = receivedFromCatalog - exp.units;
        const correctedDown = adjustments.byVariant.get(variantId)?.negative || 0;
        if (correctedDown < excess) {
          add("double-receipt", exp.sku,
            `POS ledger holds ${receivedFromCatalog} catalog-receipt unit(s) but the catalog accounts for ${exp.units}, and only ${correctedDown} were adjusted away`);
        }
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
    // Detail stays in the manager-readable run row + logs; caller gets generic (S11).
    console.error("pos-reconcile error", String(err?.stack || err));
    await db.from("pos_sync_runs").insert({
      kind: "reconcile", started_at: startedAt, finished_at: new Date().toISOString(),
      ok: false, ok_count: 0, error_count: 1, error: String(err?.message || err),
      summary: { findings },
    });
    return json({ ok: false, error: "internal error" }, 500);
  }
});
