import { supabase } from "./db.js";

// Loads and caches the reference data that drives the UI: the category tree,
// per-category field definitions (with inheritance), and the controlled
// vocabularies. Fetched once per session; call refreshRefData() after edits to
// categories/vocab if needed.

let cache = null;

export async function loadRefData(force = false) {
  if (cache && !force) return cache;
  const [cats, fields, vocab] = await Promise.all([
    supabase.from("categories").select("id, slug, name, parent_id, sort, sku_token"),
    supabase
      .from("category_fields")
      .select("category_id, key, label, type, options, vocab, required, inherit, sort"),
    supabase.from("vocabularies").select("field, canonical, aliases, active"),
  ]);

  const categories = cats.data || [];
  const byId = Object.fromEntries(categories.map((c) => [c.id, c]));

  // Group vocab by field name.
  const vocabByField = {};
  for (const v of vocab.data || []) {
    if (v.active === false) continue;
    (vocabByField[v.field] ||= []).push(v);
  }

  cache = { categories, byId, fields: fields.data || [], vocabByField };
  return cache;
}

export function refreshRefData() {
  cache = null;
}

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
