// Pure faceting + filtering for the browse/review grid (Q1 gallery decomposition).
// NO DOM, NO closure state: the stateful bits (POS mirror lookup, readiness/issue
// resolvers, the review-queue predicate, the current filter criteria) are passed
// IN as resolvers/criteria, so this is trivially unit-testable (test/facets.test.js)
// and gallery.js keeps thin wrappers that bind its live state.

// One mutually-exclusive shop state per item, from the sync columns + a mirror
// lookup (mirrorOf: item -> mirror row | undefined). Used verbatim as the "shop"
// facet value, so the card chip and the filter can never disagree.
export function shopState(it, mirrorOf) {
  const s = it.pos_sync_status;
  if (s === "synced") {
    if (it.pos_dirty) return "Update pending";
    const m = mirrorOf(it);
    if (m && m.is_active === false) return "Retired";
    if (m && m.stock_quantity <= 0) return "Sold out";
    if (m && m.reorder_level != null && m.stock_quantity <= m.reorder_level) return "Low stock";
    return "In shop";
  }
  if (s === "error") return "Sync error";
  if (s === "awaiting_approval" || s === "pending") return "Sending";
  if (it.status === "approved") return "Queued";
  return "Not pushed";
}

// The value of a facet key for an item. resolvers = {
//   statusLabel(status), issueLabel(it), shopStateOf(it), categoryPathOf(catId)
// } — gallery binds these to its imports/closures.
export function facetValue(it, key, r) {
  if (key === "brand") return it.brand || "";
  if (key === "status") return r.statusLabel(it.status);
  if (key === "issue") return r.issueLabel(it);
  if (key === "shop") return r.shopStateOf(it);
  if (key === "top") return (r.categoryPathOf(it.category_id) || "").split(" › ")[0] || "";
  if (key === "category") return (r.categoryPathOf(it.category_id) || "").split(" › ").pop() || "";
  const v = it.attributes?.[key];
  return v === null || v === undefined ? "" : String(v);
}

const BASE_FACETS = [
  { key: "top", label: "Top category" },
  { key: "category", label: "Category" },
  { key: "brand", label: "Brand" },
  { key: "status", label: "Status" },
  { key: "issue", label: "Issue" },
  { key: "shop", label: "Shop" },
];

// Build the facet list from items: base facets + every attribute key present,
// keeping only facets that have ≥2 distinct values. attrKeys + fieldLabel(key)
// come from the caller; resolvers feed facetValue.
export function buildFacets(items, { attrKeys = [], fieldLabel, resolvers }) {
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const defs = [...BASE_FACETS, ...attrKeys.map((k) => ({ key: k, label: fieldLabel(k) }))];
  const facets = [];
  for (const f of defs) {
    const values = [...new Set(items.map((it) => facetValue(it, f.key, resolvers)).filter(Boolean))].sort(cmp);
    if (values.length >= 2) facets.push({ ...f, values });
  }
  return facets;
}

// Lowercased free-text haystack: brand/name/sku/category + issue label/short +
// every attribute value. resolvers.issueLabel/issueShort feed it.
export function searchText(it, r) {
  return [
    it.brand, it.name, it.sku, it.categories?.name,
    r.issueLabel(it), r.issueShort(it),
    ...Object.values(it.attributes || {}),
  ].join(" ").toLowerCase();
}

// Does an item pass the current filters? `excludeKey` lets a facet's own counts
// ignore its own selection (standard faceted counting).
//   criteria = { q, itemIds(Set|null), noPrice, priceMin, priceMax, cutoff(Date|null),
//                active({ key: Set(values) }) }
//   ctx      = { textOf(it), valueOf(it,key), passesQueue(it) }
export function matchesItem(it, criteria, ctx, excludeKey) {
  const { q, itemIds, noPrice, priceMin, priceMax, cutoff, active } = criteria;
  if (q && !ctx.textOf(it).includes(q)) return false;
  if (itemIds && itemIds.size && !itemIds.has(it.id)) return false;
  if (!ctx.passesQueue(it)) return false;
  if (noPrice && it.price != null) return false;
  if ((priceMin ?? "") !== "" && (it.price == null || it.price < Number(priceMin))) return false;
  if ((priceMax ?? "") !== "" && (it.price == null || it.price > Number(priceMax))) return false;
  if (cutoff && (!it.created_at || new Date(it.created_at) < cutoff)) return false;
  for (const k in active) {
    if (k === excludeKey) continue;
    const set = active[k];
    if (set && set.size && !set.has(ctx.valueOf(it, k))) return false;
  }
  return true;
}
