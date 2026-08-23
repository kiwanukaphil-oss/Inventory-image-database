import { supabase } from "./db.js";
import { requestRailwayCatalog } from "./railwayCatalogApi.js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";
import {
  branchVariantKey,
  defaultPosBranchId,
  mergeBranchMirror,
  storedPosBranchId,
} from "./posbranches.js";

// Loads and caches the reference data that drives the UI: the category tree,
// per-category field definitions (with inheritance), and the controlled
// vocabularies. Fetched once per session; call refreshRefData() after edits to
// categories/vocab if needed.

let cache = null;

export async function loadRefData(force = false) {
  if (cache && !force) return cache;
  if (isRailwayCatalogMode) {
    const payload = await requestRailwayCatalog("/catalog/reference-data");
    const categories = payload.data?.categories || [];
    const fields = payload.data?.fields || [];
    const vocabByField = {};
    for (const vocabulary of payload.data?.vocabularies || []) {
      if (vocabulary.active === false) continue;
      (vocabByField[vocabulary.field] ||= []).push(vocabulary);
    }
    cache = {
      categories,
      byId: Object.fromEntries(categories.map((category) => [category.id, category])),
      fields,
      vocabByField,
      settings: payload.data?.settings || {},
    };
    return cache;
  }
  // Explicit cap so ref-data never silently truncates at PostgREST's 1,000-row
  // default — a shop with >1,000 categories/fields/vocab would otherwise load
  // incomplete data with no warning.
  const REF_DATA_LIMIT = 10000;
  const [cats, fields, vocab, settings] = await Promise.all([
    supabase.from("categories").select("id, slug, name, parent_id, sort, sku_token").limit(REF_DATA_LIMIT),
    supabase
      .from("category_fields")
      .select("category_id, key, label, type, options, vocab, required, inherit, sort")
      .limit(REF_DATA_LIMIT),
    supabase.from("vocabularies").select("field, canonical, aliases, active").limit(REF_DATA_LIMIT),
    supabase.from("app_settings").select("key, value").limit(REF_DATA_LIMIT),
  ]);

  // Ref data is load-bearing (cards/editor render blank without it). Keep the
  // graceful `|| []` fallback below, but surface a failure instead of a silent
  // degraded UI (Q3). app_settings can legitimately be missing on older DBs.
  if (cats.error) console.warn("ref data: categories failed —", cats.error.message);
  if (fields.error) console.warn("ref data: category_fields failed —", fields.error.message);
  if (vocab.error) console.warn("ref data: vocabularies failed —", vocab.error.message);
  if (settings.error) console.warn("ref data: app_settings failed —", settings.error.message);

  const categories = cats.data || [];
  const byId = Object.fromEntries(categories.map((c) => [c.id, c]));

  // Group vocab by field name.
  const vocabByField = {};
  for (const v of vocab.data || []) {
    if (v.active === false) continue;
    (vocabByField[v.field] ||= []).push(v);
  }

  // Shop-wide settings (empty if the table isn't there yet).
  const settingsMap = Object.fromEntries((settings.data || []).map((s) => [s.key, s.value]));

  cache = { categories, byId, fields: fields.data || [], vocabByField, settings: settingsMap };
  return cache;
}

/** A shop-wide setting value (e.g. "currency"), or the default if unset. */
export function getSetting(key, def = "") {
  return cache?.settings?.[key] || def;
}

/**
 * The POS live-stock mirror (read-only; written by the pos-mirror edge
 * function) plus the most recent mirror run for the freshness line. Items join
 * to it via items.pos_variant_id — several duplicate-SKU items share one
 * variant, so stock is per-variant by design. Returns empty structures when
 * migration 0018 isn't applied yet, so every caller degrades gracefully.
 */
export async function loadPosMirror() {
  if (isRailwayCatalogMode) {
    // POS data is already live in the shared Railway database. The dedicated
    // direct-stock read model belongs to the publication slice; return a neutral
    // structure here so the Phase B gallery never consults Supabase mirrors.
    return {
      branches: [],
      branchRows: [],
      globalRows: [],
      globalByVariant: new Map(),
      byBranchVariant: new Map(),
      byVariant: new Map(),
      defaultBranchId: null,
      selectedBranchId: null,
      forBranch: () => new Map(),
      lastMirror: null,
    };
  }
  const [mirror, branchStock, branchesResult, run] = await Promise.all([
    // select(*) so the call survives column additions that the deployed app
    // predates (e.g. the 0019 window columns) — callers default missing keys.
    supabase
      .from("pos_stock_mirror")
      .select("*"),
    supabase
      .from("pos_branch_stock")
      .select("*"),
    supabase
      .from("pos_branches")
      .select("pos_branch_id, code, name, status, is_default, is_enabled, timezone, mirrored_at")
      .order("is_default", { ascending: false })
      .order("code", { ascending: true }),
    supabase
      .from("pos_sync_runs")
      .select("finished_at, ok, error")
      .eq("kind", "mirror")
      .order("started_at", { ascending: false })
      .limit(1),
  ]);
  const globalRows = mirror.data || [];
  const branchRows = branchStock.data || [];
  const branches = branchesResult.data || [];
  const globalByVariant = new Map(globalRows.map((r) => [r.pos_variant_id, r]));
  const byBranchVariant = new Map(
    branchRows.map((r) => [branchVariantKey(r.pos_branch_id, r.pos_variant_id), r])
  );
  const defaultBranchId = defaultPosBranchId(branches);
  const selectedBranchId = storedPosBranchId(branches) || defaultBranchId;
  const byVariant = mergeBranchMirror(globalRows, branchRows, selectedBranchId);
  return {
    branches,
    branchRows,
    globalRows,
    globalByVariant,
    byBranchVariant,
    byVariant,
    defaultBranchId,
    selectedBranchId,
    forBranch: (branchId) => mergeBranchMirror(globalRows, branchRows, branchId || defaultBranchId),
    lastMirror: (run.data || [])[0] || null,
  };
}

export function refreshRefData() {
  cache = null;
}

// Fields the AI structurally cannot read from a single product photo (e.g. the
// cut/fit of a garment), so its confidence on them is always Low and carries no
// information. Shared so the gallery triage predicate and the calibration tool
// exclude them identically.
export const AI_BLIND_FIELDS = new Set(["fit"]);

/**
 * Resolve the effective field set for a category: its own fields plus any
 * inheritable fields from ancestor categories. Own fields override inherited
 * ones with the same key. Returned sorted by `sort`.
 */
export function resolveFields(categoryId) {
  if (!cache) return [];
  const chain = [];
  let cur = cache.byId[categoryId];
  let depth = 0;
  while (cur && depth++ < 20) {
    chain.push(cur.id); // index 0 = the category itself, then ancestors
    cur = cur.parent_id ? cache.byId[cur.parent_id] : null;
  }

  const result = new Map(); // key -> field def
  // Walk ancestors first (farthest -> nearest) so nearer definitions win.
  for (let i = chain.length - 1; i >= 0; i--) {
    const catId = chain[i];
    const isSelf = i === 0;
    for (const f of cache.fields) {
      if (f.category_id !== catId) continue;
      if (!isSelf && !f.inherit) continue; // ancestor field only if inheritable
      result.set(f.key, f);
    }
  }
  return [...result.values()].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
}

/** Full "Clothing › Pants › Cargo" style path for a category id. */
export function categoryPath(categoryId) {
  if (!cache) return "";
  const names = [];
  let cur = cache.byId[categoryId];
  let depth = 0;
  while (cur && depth++ < 20) {
    names.unshift(cur.name);
    cur = cur.parent_id ? cache.byId[cur.parent_id] : null;
  }
  return names.join(" › ");
}

/** Human label for an attribute key (from any category_field that defines it). */
export function fieldLabel(key) {
  const f = cache?.fields.find((x) => x.key === key);
  if (f?.label) return f.label;
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Canonical suggestions for a vocab-backed field (for autocomplete). */
export function vocabSuggestions(field) {
  return (cache?.vocabByField[field] || []).map((v) => v.canonical).sort();
}

/**
 * Normalise a typed value to its canonical form (e.g. "Grey" -> "Gray").
 * Matches canonical or any alias, case-insensitively. Unknown values are
 * returned unchanged so new values are still allowed.
 */
export function normalizeValue(field, value) {
  const v = (value ?? "").trim();
  if (!v) return v;
  const list = cache?.vocabByField[field] || [];
  const low = v.toLowerCase();
  for (const entry of list) {
    if (entry.canonical.toLowerCase() === low) return entry.canonical;
    if ((entry.aliases || []).some((a) => a.toLowerCase() === low)) return entry.canonical;
  }
  return v;
}

function isCategoryOrDescendant(categoryId, slug) {
  if (!cache) return false;
  let cur = cache.byId[categoryId];
  let depth = 0;
  while (cur && depth++ < 20) {
    if (cur.slug === slug) return true;
    cur = cur.parent_id ? cache.byId[cur.parent_id] : null;
  }
  return false;
}

function normalizePantsWaist(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  const v = raw.replace(/\s+/g, " ").toUpperCase();
  const patterns = [
    /^(?:W|WAIST)\s*([0-9]{2,3})\s*(?:"|IN|INCH|INCHES)?$/,
    /^([0-9]{2,3})\s*(?:W|WAIST)$/,
    /^([0-9]{2,3})\s*(?:"|IN|INCH|INCHES)$/,
    /^(?:W\s*)?([0-9]{2,3})\s*(?:X|\/|-|L|LEG|INSEAM)\s*[0-9]{2,3}\s*(?:"|IN|INCH|INCHES)?$/,
  ];
  for (const p of patterns) {
    const m = v.match(p);
    if (m) return m[1];
  }
  return raw;
}

/**
 * Canonicalise free-text category attributes where a controlled vocabulary is
 * too rigid. Pants waist size is stored as the numeric waist only, so AI/manual
 * variants like W32, W 32, 32W, or W32 L34 all group/SKU as 32.
 */
export function normalizeAttributeValue(categoryId, key, value) {
  if (value === null || value === undefined) return value;
  if (key === "size" && isCategoryOrDescendant(categoryId, "pants")) {
    return normalizePantsWaist(value);
  }
  return typeof value === "string" ? value.trim() : value;
}
