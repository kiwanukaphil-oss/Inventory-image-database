/**
 * Catalog Pricing Plan
 *
 * Responsible for: Pure selection and impact calculations for Railway bulk
 *                  catalog pricing.
 * NOT responsible for: DOM rendering, authentication, or price persistence.
 */

export const catalogItemNeedsRetailPrice = (item = {}) => item.pricing_ready !== true;

export const catalogItemNeedsPricing = (item = {}, { includeCosts = false } = {}) =>
  catalogItemNeedsRetailPrice(item) || (includeCosts && item.cost_ready !== true);

export const catalogItemCanBePriced = (item = {}) =>
  !item.is_published && item.pos_sync_status !== "synced";

/** Keep a caller-supplied selection, or default to every incomplete item. */
export function selectCatalogPricingItems(items = [], { itemIds, includeCosts = false } = {}) {
  const requestedIds = Array.isArray(itemIds) && itemIds.length ? new Set(itemIds) : null;
  return items.filter((item) => (
    catalogItemCanBePriced(item)
    && (requestedIds ? requestedIds.has(item.id) : catalogItemNeedsPricing(item, { includeCosts }))
  ));
}

/** Summarize the exact evidence, variants, and physical units in one plan. */
export function summarizeCatalogPricingItems(items = []) {
  return items.reduce((summary, item) => ({
    itemCount: summary.itemCount + 1,
    variantCount: summary.variantCount + Number(item.variant_count || 0),
    unitCount: summary.unitCount + Number(item.total_units || item.stock_quantity || 0),
  }), { itemCount: 0, variantCount: 0, unitCount: 0 });
}

/** Return distinct values for one normalized variant attribute and their impact. */
export function summarizeCatalogVariantValues(items = [], attribute = "size") {
  const summariesByValue = new Map();
  for (const item of items) {
    for (const line of item.variant_lines || []) {
      const value = line?.variant_attributes?.[attribute];
      if (value === null || value === undefined || value === "" || Number(line.quantity) <= 0) continue;
      const normalizedValue = String(value);
      const summary = summariesByValue.get(normalizedValue) || {
        value: normalizedValue,
        itemIds: new Set(),
        variantCount: 0,
        unitCount: 0,
      };
      summary.itemIds.add(item.id);
      summary.variantCount += 1;
      summary.unitCount += Number(line.quantity);
      summariesByValue.set(normalizedValue, summary);
    }
  }
  return [...summariesByValue.values()].map((summary) => ({
    value: summary.value,
    itemCount: summary.itemIds.size,
    variantCount: summary.variantCount,
    unitCount: summary.unitCount,
  }));
}
