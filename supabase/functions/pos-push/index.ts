// @ts-nocheck — Runs on Deno (Supabase Edge runtime), not Node. URL imports and
// the global `Deno` object are valid there; VS Code's Node TS server flags them.
// =============================================================================
// pos-push — Supabase Edge Function (Deno)
//
// Phase 2b of the Catalog↔POS integration: the push loop, ported from the
// connector CLI (inventory-pos-connector/src/pipeline/pushApproved.js), which
// remains as a manual/recovery tool. Runs on a schedule, so approving an item
// in the PWA is all it takes for it to become a sellable POS product.
//
// Per run:
//   1. QUEUE — approved items never pushed (pos_sync_status null) or errored:
//      same resolution order as the CLI — exact SKU → reuse variant (+stock);
//      group (brand+category+colour+style) → add size variant; else create
//      product (+image). Then book this item's receipt and write the link back.
//   2. DIRTY — synced items edited after push (pos_dirty): re-derive the POS
//      product fields + variant attributes + image and propagate (Phase 3).
//
// Hardening (Phase 4) baked in:
//   - Receipt idempotency: a receipt is only booked if no POS movement already
//     carries reference_id = this item's id (closes the double-count window
//     when a receipt landed but the write-back failed).
//   - Per-run caps keep each invocation well inside edge-function limits and
//     the POS image rate limit (20 uploads / 5 min): queue 20, dirty 8.
//
// Invocation: Supabase Cron every 5 min, or an admin "Sync now" (Sync Center).
// Body (optional): { limit?: number, dirtyLimit?: number }
// Secrets: POS_BASE_URL, CATALOG_SYNC_USERNAME, CATALOG_SYNC_PASSWORD,
//          MIRROR_INVOKE_KEY (shared invoke key for both functions), and the
//          platform-injected SUPABASE_URL / SERVICE_ROLE / ANON keys.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Self-contained for direct Supabase-dashboard deploy (no CLI bundling of _shared).
// Origin-allowlisted CORS (S5) + constant-time, fail-closed POS-caller auth (S4).
// These two helpers are duplicated across the 3 pos-* functions — keep them in sync.
const DEFAULT_ALLOWED = "https://klinemen-catalog.com";
function isLocalDevOrigin(origin) {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
    if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
    const m = hostname.match(/^172\.(\d+)\./);
    return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
  } catch {
    return false;
  }
}
function corsHeaders(req) {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || DEFAULT_ALLOWED).split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowed.includes("*")) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && (allowed.includes(origin) || isLocalDevOrigin(origin))) headers["Access-Control-Allow-Origin"] = origin;
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

const QUEUE_LIMIT_DEFAULT = 20;
const DIRTY_LIMIT_DEFAULT = 8;
const QUEUE_LIMIT_MAX = 50; // hard cap on caller-supplied limits (audit S10)

// ---------------------------------------------------------------------------
// POS REST client (subset of the connector's posClient, fetch-native).
// ---------------------------------------------------------------------------
class Pos {
  base: string;
  token: string | null = null;
  constructor(base: string) { this.base = base.replace(/\/$/, ""); }

  async login() {
    const res = await fetch(`${this.base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: Deno.env.get("CATALOG_SYNC_USERNAME"),
        password: Deno.env.get("CATALOG_SYNC_PASSWORD"),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(`POS login failed (${res.status}): ${body.message || "no token"}`);
    this.token = body.token;
  }

  async req(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const out = await res.json().catch(() => ({}));
    return { status: res.status, body: out };
  }

  async getBrands() {
    const { status, body } = await this.req("/brands");
    if (status !== 200) throw new Error(`list brands failed (${status})`);
    return body.data || [];
  }
  async createBrand(name: string) {
    const { status, body } = await this.req("/brands", { method: "POST", body: { name, description: null } });
    if (status !== 201 && status !== 200) throw new Error(`create brand "${name}" failed (${status}): ${body.message || ""}`);
    return body.data;
  }
  async findVariantBySku(sku: string) {
    const { status, body } = await this.req(`/products/variants/sku/${encodeURIComponent(sku)}`);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`SKU lookup failed for "${sku}" (${status})`);
    return body.data;
  }
  async createProduct(payload: unknown) {
    const { status, body } = await this.req("/products", { method: "POST", body: payload });
    if (status !== 201) throw new Error(`create product failed (${status}): ${body.message || ""}`);
    return body.data;
  }
  async createVariantsForProduct(productId: string, payload: unknown) {
    const { status, body } = await this.req(`/products/${productId}/variants`, { method: "POST", body: payload });
    if (status !== 201) throw new Error(`add variant failed (${status}): ${body.message || ""}`);
    return body.data || [];
  }
  async updateProduct(productId: string, fields: unknown) {
    const { status, body } = await this.req(`/products/${productId}`, { method: "PUT", body: fields });
    if (status !== 200) throw new Error(`update product failed (${status}): ${body.message || ""}`);
    return body.data;
  }
  async updateVariant(variantId: string, fields: unknown) {
    const { status, body } = await this.req(`/products/variants/${variantId}`, { method: "PUT", body: fields });
    if (status !== 200) throw new Error(`update variant failed (${status}): ${body.message || ""}`);
    return body.data;
  }
  /** Does this variant's ledger already hold a movement for this catalog item? */
  async hasMovementWithReference(variantId: string, referenceId: string) {
    const qs = new URLSearchParams({
      variant_id: variantId,
      reference_id: referenceId,
      movement_type: RECEIVE_MOVEMENT_TYPE,
      limit: "1",
      offset: "0",
    });
    const { status, body } = await this.req(`/inventory/movements?${qs.toString()}`);
    if (status !== 200) throw new Error(`movement check failed (${status})`);
    return (body.data || []).some((m) => m.reference_id === referenceId && m.variant_id === variantId);
  }
  async adjustStock(payload: unknown) {
    const { status, body } = await this.req("/inventory/adjust", { method: "POST", body: payload });
    if (status === 202) return { pendingApproval: true };
    if (status !== 200) throw new Error(`stock adjust failed (${status}): ${body.message || ""}`);
    return { pendingApproval: false };
  }
  async getProductImages(productId: string) {
    const { status, body } = await this.req(`/products/${productId}/images`);
    if (status !== 200) throw new Error(`list images failed (${status})`);
    return body.data || [];
  }
  async deleteProductImage(productId: string, imageId: string) {
    const { status, body } = await this.req(`/products/${productId}/images/${imageId}`, { method: "DELETE" });
    if (status !== 200) throw new Error(`delete image failed (${status}): ${body.message || ""}`);
  }
  async uploadProductImage(productId: string, bytes: ArrayBuffer, filename: string) {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/webp" }), filename);
    const res = await fetch(`${this.base}/products/${productId}/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`image upload failed (${res.status}): ${out.message || ""}`);
  }
}

// ---------------------------------------------------------------------------
// Mapping — the CANONICAL, UNIT-TESTED spec lives in src/lib/sku.js
// (test/sku.test.js is the contract). This copy is kept inline because the
// function must be self-contained for dashboard deploy; the connector's
// mapping.js is a third copy. KEEP ALL THREE IN SYNC with src/lib/sku.js.
// ---------------------------------------------------------------------------
const normalize = (v: unknown) => String(v || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const planBrand = (item, posBrands) => {
  const name = item.brand?.trim();
  if (!name) return { action: "none" };
  const match = posBrands.find((b) => normalize(b.name) === normalize(name));
  if (match) return { action: "match", brandId: match.id, name: match.name };
  return { action: "create", name };
};

const extractCostPrice = (item) => {
  const costs = item.item_costs;
  if (!costs) return null;
  if (Array.isArray(costs)) return costs[0]?.cost_price ?? null;
  return costs.cost_price ?? null;
};

const SIZE_ATTRIBUTE_KEYS = ["size", "size_eu", "waist", "volume_ml"];
const getSizeValue = (attrs = {}) => {
  const key = SIZE_ATTRIBUTE_KEYS.find((k) => attrs[k]);
  return key ? String(attrs[key]) : null;
};

const normalizeStyleCode = (v) => {
  const cleaned = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned || null;
};

const getGroupKey = (item) => {
  const attrs = item.attributes || {};
  const style = normalizeStyleCode(attrs.style);
  const size = getSizeValue(attrs);
  if (!style || !size) return null;
  return [
    String(item.brand || "").trim().toLowerCase(),
    item.category_id || "",
    String(attrs.color || "").trim().toLowerCase(),
    style,
  ].join("|");
};

const resolveProductName = (item, { dropSize = false } = {}) => {
  const attrs = item.attributes || {};
  const explicit = item.name?.trim();
  if (explicit) {
    const color = String(attrs.color || "").trim();
    if (dropSize && color && !explicit.toLowerCase().includes(color.toLowerCase())) {
      return `${explicit} — ${color}`;
    }
    return explicit;
  }
  const head = [item.brand?.trim(), item.categories?.name?.trim()].filter(Boolean).join(" ");
  const detail = [];
  if (attrs.color) detail.push(attrs.color);
  if (!dropSize) {
    const size = getSizeValue(attrs);
    if (size) detail.push(size);
  }
  const name = detail.length ? (head ? `${head} — ${detail.join(" / ")}` : detail.join(" / ")) : head;
  return name || "Unnamed item";
};

const POS_GENDERS = new Set(["men", "women", "unisex", "kids"]);
const GENDER_SYNONYMS = { man: "men", male: "men", mens: "men", woman: "women", female: "women", womens: "women", kid: "kids", children: "kids" };
const normalizeGender = (value) => {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  const mapped = GENDER_SYNONYMS[v] || v;
  return POS_GENDERS.has(mapped) ? mapped : null;
};

const PRODUCT_LEVEL_ATTRS = new Set(["gender", "material"]);
const buildVariantAttributes = (attributes = {}) => {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(attributes || {})) {
    const key = String(rawKey).trim();
    if (!key || PRODUCT_LEVEL_ATTRS.has(key.toLowerCase())) continue;
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue).trim();
    if (!value) continue;
    out[key] = value;
  }
  return out;
};

const DEFAULT_REORDER_LEVEL = Number(Deno.env.get("DEFAULT_REORDER_LEVEL") || 5);
const PRODUCT_STATUS = Deno.env.get("POS_PRODUCT_STATUS") || "published";
const RECEIVE_MOVEMENT_TYPE = Deno.env.get("RECEIVE_MOVEMENT_TYPE") || "purchase";

const buildVariantRow = (item, costPrice) => ({
  sku: item.sku,
  price: item.price,
  cost_price: costPrice,
  stock_quantity: 0,
  reorder_level: item.reorder_level ?? DEFAULT_REORDER_LEVEL,
  is_active: true,
  attributes: buildVariantAttributes(item.attributes || {}),
});

const buildProductPayload = ({ item, brandId, posCategoryId, costPrice, grouped = false }) => {
  const attrs = item.attributes || {};
  const variant = buildVariantRow(item, costPrice);
  const hasVariantAttributes = Object.keys(variant.attributes).length > 0;
  return {
    name: resolveProductName(item, { dropSize: grouped }),
    category_id: posCategoryId,
    brand_id: brandId,
    description: null,
    has_variants: hasVariantAttributes,
    status: PRODUCT_STATUS,
    gender: normalizeGender(attrs.gender),
    material: attrs.material ? String(attrs.material).slice(0, 20) : null,
    master_sku: grouped ? null : item.sku || null,
    variants: [variant],
  };
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
const ITEM_SELECT =
  "id, name, brand, price, stock_quantity, reorder_level, sku, image_path, attributes, category_id, " +
  "pos_product_id, pos_variant_id, item_costs ( cost_price ), categories ( slug, name )";

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

  // Clamp caller-supplied limits so one request can't blow past the edge-function
  // timeout or the POS image rate limit (audit S10).
  const opts = await req.json().catch(() => ({}));
  const queueLimit = Math.min(Number(opts?.limit) > 0 ? Number(opts.limit) : QUEUE_LIMIT_DEFAULT, QUEUE_LIMIT_MAX);
  const dirtyLimit = Math.min(Number(opts?.dirtyLimit) >= 0 ? Number(opts.dirtyLimit) : DIRTY_LIMIT_DEFAULT, QUEUE_LIMIT_MAX);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Single-flight lock: two overlapping push runs (cron + manual "Sync now")
  // could each book a stock receipt for the same item. Acquire an atomic,
  // stale-tolerant lock; bail if another run holds it (audit DI1, migration 0028).
  const LOCK_NAME = "pos-push";
  const { data: gotLock, error: lockErr } = await db.rpc("try_acquire_sync_lock", {
    p_name: LOCK_NAME, p_stale_seconds: 600, p_by: new Date().toISOString(),
  });
  if (lockErr) return json({ ok: false, error: `lock error: ${lockErr.message}` }, 500);
  if (!gotLock) return json({ ok: true, skipped: true, reason: "another push run is in progress" });

  const startedAt = new Date().toISOString();
  const summary = {
    queue_seen: 0, created: 0, add_variant: 0, add_stock: 0, blocked: 0, errored: 0,
    receipts_skipped_existing: 0, pending_approval: 0,
    dirty_seen: 0, dirty_updated: 0, dirty_errored: 0,
  };

  const writeBack = async (itemId, patch) => {
    const { error } = await db.from("items").update(patch).eq("id", itemId);
    if (error) throw new Error(`write-back failed: ${error.message}`);
  };

  const signedImageUrl = async (path) => {
    if (!path) return null;
    const { data, error } = await db.storage.from("product-images").createSignedUrl(path, 600);
    if (error) throw new Error(`sign image failed: ${error.message}`);
    return data?.signedUrl || null;
  };

  const transferImage = async (pos, item, productId) => {
    const url = await signedImageUrl(item.image_path);
    if (!url) return false;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image download ${res.status}`);
    await pos.uploadProductImage(productId, await res.arrayBuffer(), `${item.sku || "product"}.webp`);
    return true;
  };

  try {
    if (!POS_BASE_URL) throw new Error("POS_BASE_URL secret is not set");
    const pos = new Pos(POS_BASE_URL);
    await pos.login();

    // Shared lookups. The group registry seeds from already-linked items so a
    // new size joins the product an earlier run created.
    const [{ data: mapRows, error: mapErr }, posBrands] = await Promise.all([
      db.from("pos_category_map").select("image_category_id, pos_category_id"),
      pos.getBrands(),
    ]);
    if (mapErr) throw new Error(`category map read failed: ${mapErr.message}`);
    const categoryMap = new Map((mapRows || []).map((r) => [r.image_category_id, r.pos_category_id]));

    const { data: regRows, error: regErr } = await db
      .from("items").select("id, sku, brand, category_id, attributes, pos_product_id")
      .not("pos_product_id", "is", null);
    if (regErr) throw new Error(`group registry read failed: ${regErr.message}`);
    const groupRegistry = new Map();
    for (const row of regRows || []) {
      const key = getGroupKey(row);
      if (key && !groupRegistry.has(key)) groupRegistry.set(key, row.pos_product_id);
    }

    const resolveBrandId = async (item) => {
      const plan = planBrand(item, posBrands);
      if (plan.action === "none") return null;
      if (plan.action === "match") return plan.brandId;
      const created = await pos.createBrand(plan.name);
      posBrands.push({ id: created.id, name: created.name });
      return created.id;
    };

    // ---- 1. The queue: approved, never-pushed or errored, oldest first ----
    const { data: queue, error: qErr } = await db
      .from("items").select(ITEM_SELECT)
      .eq("status", "approved")
      .or("pos_sync_status.is.null,pos_sync_status.eq.error")
      .order("created_at", { ascending: true })
      .limit(queueLimit);
    if (qErr) throw new Error(`queue read failed: ${qErr.message}`);

    for (const item of queue || []) {
      summary.queue_seen++;
      const posCategoryId = categoryMap.get(item.category_id);
      if (item.price == null || !item.sku || !posCategoryId) {
        const reasons = [];
        if (item.price == null) reasons.push("missing price");
        if (!item.sku) reasons.push("missing SKU");
        if (!posCategoryId) reasons.push("category not mapped to POS");
        summary.blocked++;
        await db.from("items").update({
          pos_sync_status: "error",
          pos_sync_error: `Blocked before POS push: ${reasons.join("; ")}`,
        }).eq("id", item.id);
        continue;
      }
      const costPrice = extractCostPrice(item);
      const groupKey = getGroupKey(item);
      let posProductId = item.pos_product_id;
      let posVariantId = item.pos_variant_id;
      try {
        const existing = await pos.findVariantBySku(item.sku);
        let action;
        if (existing) {
          posVariantId = existing.id;
          posProductId = existing.product_id || posProductId;
          action = "add_stock";
        } else if (groupKey && groupRegistry.has(groupKey)) {
          posProductId = groupRegistry.get(groupKey);
          const variants = await pos.createVariantsForProduct(posProductId, {
            variants: [buildVariantRow(item, costPrice)],
          });
          posVariantId = variants[0]?.id || null;
          action = "add_variant";
        } else {
          const brandId = await resolveBrandId(item);
          const product = await pos.createProduct(
            buildProductPayload({ item, brandId, posCategoryId, costPrice, grouped: Boolean(groupKey) })
          );
          posProductId = product.id;
          posVariantId = product.variants?.[0]?.id || (await pos.findVariantBySku(item.sku))?.id || null;
          action = "created";
        }
        if (groupKey && posProductId) groupRegistry.set(groupKey, posProductId);

        // Image only on create; best-effort (a bad image never sinks the push).
        let imageNote = null;
        if (action === "created") {
          try {
            const ok = await transferImage(pos, item, posProductId);
            if (!ok && item.image_path) imageNote = "image skipped";
          } catch (e) {
            imageNote = `image failed: ${e.message}`;
          }
        }

        // Receipt — idempotent by reference_id (Phase 4): if this item's
        // receipt already landed in a previous half-failed run, don't re-book.
        // One photo = one unit: a BLANK quantity means 1 (legacy rows predate
        // the upload default; blank once meant "no receipt" and items landed
        // in the POS with 0 stock). An explicit 0 still means catalog-only.
        const qty = item.stock_quantity ?? 1;
        let pendingApproval = false;
        if (qty > 0 && posVariantId) {
          if (await pos.hasMovementWithReference(posVariantId, item.id)) {
            summary.receipts_skipped_existing++;
          } else {
            const r = await pos.adjustStock({
              variant_id: posVariantId,
              quantity_change: qty,
              movement_type: RECEIVE_MOVEMENT_TYPE,
              cost_price: costPrice,
              reference_id: item.id,
              reason: `Stock receipt from catalog (item ${item.id})`,
            });
            pendingApproval = r.pendingApproval;
          }
        }

        await writeBack(item.id, {
          pos_product_id: posProductId,
          pos_variant_id: posVariantId,
          pos_sku: item.sku,
          pos_sync_status: pendingApproval ? "awaiting_approval" : "synced",
          pos_sync_error: pendingApproval ? "stock receipt awaiting POS approval" : imageNote,
          pos_dirty: false,
          ...(pendingApproval ? {} : { pos_synced_at: new Date().toISOString() }),
        });
        if (pendingApproval) summary.pending_approval++;
        summary[action]++;
      } catch (err) {
        summary.errored++;
        await db.from("items").update({
          pos_sync_status: "error",
          pos_sync_error: String(err?.message || err),
          ...(posProductId ? { pos_product_id: posProductId } : {}),
          ...(posVariantId ? { pos_variant_id: posVariantId } : {}),
        }).eq("id", item.id);
      }
    }

    // ---- 2. Edit propagation: synced items whose identity changed (Phase 3) ----
    if (dirtyLimit > 0) {
      const { data: dirty, error: dErr } = await db
        .from("items").select(ITEM_SELECT)
        .eq("pos_sync_status", "synced")
        .eq("pos_dirty", true)
        .not("pos_product_id", "is", null)
        .limit(dirtyLimit);
      if (dErr) throw new Error(`dirty read failed: ${dErr.message}`);

      for (const item of dirty || []) {
        summary.dirty_seen++;
        try {
          const posCategoryId = categoryMap.get(item.category_id);
          const brandId = await resolveBrandId(item);
          const grouped = Boolean(getGroupKey(item));
          const attrs = item.attributes || {};
          await pos.updateProduct(item.pos_product_id, {
            name: resolveProductName(item, { dropSize: grouped }),
            ...(posCategoryId ? { category_id: posCategoryId } : {}),
            brand_id: brandId,
            gender: normalizeGender(attrs.gender),
            material: attrs.material ? String(attrs.material).slice(0, 20) : null,
          });
          if (item.pos_variant_id) {
            await pos.updateVariant(item.pos_variant_id, {
              variant_attributes: buildVariantAttributes(attrs),
            });
          }
          // Refresh the product photo from the (possibly re-shot) catalog
          // image: clear what's there, upload fresh. Best-effort.
          if (item.image_path) {
            try {
              const imgs = await pos.getProductImages(item.pos_product_id);
              for (const img of imgs) await pos.deleteProductImage(item.pos_product_id, img.id);
              await transferImage(pos, item, item.pos_product_id);
            } catch { /* image refresh is best-effort; next dirty pass retries */ }
          }
          await writeBack(item.id, { pos_dirty: false, pos_synced_at: new Date().toISOString() });
          summary.dirty_updated++;
        } catch (err) {
          // Leave pos_dirty set — retried next run; surface the reason.
          summary.dirty_errored++;
          await db.from("items").update({ pos_sync_error: `update failed: ${String(err?.message || err)}` })
            .eq("id", item.id);
        }
      }
    }

    await db.from("pos_sync_runs").insert({
      kind: "push", started_at: startedAt, finished_at: new Date().toISOString(),
      ok: true,
      ok_count: summary.created + summary.add_variant + summary.add_stock + summary.dirty_updated,
      error_count: summary.errored + summary.dirty_errored,
      summary,
    });
    return json({ ok: true, ...summary });
  } catch (err) {
    // Detail stays in the manager-readable run row + logs; caller gets generic (S11).
    console.error("pos-push error", String(err?.stack || err));
    await db.from("pos_sync_runs").insert({
      kind: "push", started_at: startedAt, finished_at: new Date().toISOString(),
      ok: false, ok_count: 0, error_count: 1, error: String(err?.message || err), summary,
    });
    return json({ ok: false, error: "internal error", ...summary }, 500);
  } finally {
    // Always release the single-flight lock, even on error.
    await db.rpc("release_sync_lock", { p_name: LOCK_NAME }).catch(() => {});
  }
});
