// Canonical, unit-tested POS product/variant mapping (Phase 5 · POS-SKU). This is
// the SPEC for how a catalog item becomes a POS product + variant: the grouping
// key, the synthesized product name, gender/size normalisation, and which
// attributes live on the variant vs the product.
//
// NOTE: the Deno `pos-push` edge function and `inventory-pos-connector` keep their
// OWN inline copies (pos-push must be self-contained for dashboard deploy), so
// they MUST stay in sync with this module — these tests (test/sku.test.js) are the
// contract that defines correct behaviour for all three.

export const SIZE_ATTRIBUTE_KEYS = ["size", "size_eu", "waist", "volume_ml"];

// First size-like attribute present, as a string (or null).
export const getSizeValue = (attrs = {}) => {
  const key = SIZE_ATTRIBUTE_KEYS.find((k) => attrs[k]);
  return key ? String(attrs[key]) : null;
};

// Uppercase, strip non-alphanumerics ("3388-21" -> "338821"); "" -> null. This
// folds typo'd/format-variant style codes so they group together.
export const normalizeStyleCode = (v) => {
  const cleaned = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned || null;
};

// Group key brand|category|colour|style — only when BOTH a style code and a size
// exist (so size variants of one style collapse to one product). null = the item
// stays a standalone single-variant product.
export const getGroupKey = (item) => {
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

// Product name: an explicit catalog name wins (grouped products append the colour
// when the name lacks it, so per-colour products don't collide); otherwise
// synthesize "<brand> <category> — <colour> / <size>".
export const resolveProductName = (item, { dropSize = false } = {}) => {
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

export const POS_GENDERS = new Set(["men", "women", "unisex", "kids"]);
const GENDER_SYNONYMS = { man: "men", male: "men", mens: "men", woman: "women", female: "women", womens: "women", kid: "kids", children: "kids" };

// Normalise free-text gender to the POS check set, or null if it doesn't map.
export const normalizeGender = (value) => {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  const mapped = GENDER_SYNONYMS[v] || v;
  return POS_GENDERS.has(mapped) ? mapped : null;
};

// gender + material live on the PRODUCT, not the variant; everything else
// (size, colour, …) is a variant attribute. Empties are dropped.
export const PRODUCT_LEVEL_ATTRS = new Set(["gender", "material"]);
export const buildVariantAttributes = (attributes = {}) => {
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
