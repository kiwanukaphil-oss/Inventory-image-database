import { requestRailwayCatalog } from "./railwayCatalogApi.js";

// Loads and caches the reference data that drives the UI: the category tree,
// per-category field definitions (with inheritance), and the controlled
// vocabularies. Fetched once per session; call refreshRefData() after edits to
// categories/vocab if needed.

let cache = null;

export async function loadRefData(force = false) {
  if (cache && !force) return cache;
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
  // Stock distribution is returned with each Railway catalog item. Preserve
  // this neutral legacy-shaped value for shared display helpers.
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
