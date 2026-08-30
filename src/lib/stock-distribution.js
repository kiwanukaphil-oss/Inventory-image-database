/** Return safe stock rows, including a compatibility row for older API data. */
export function catalogStockDistributionEntries(item) {
  const entries = Array.isArray(item?.stock_distribution)
    ? item.stock_distribution
        .map((entry) => ({
          variant_attributes:
            entry?.variant_attributes && typeof entry.variant_attributes === "object"
              ? { ...entry.variant_attributes }
              : {},
          quantity: Number(entry?.quantity),
        }))
        .filter((entry) => Number.isInteger(entry.quantity) && entry.quantity >= 0)
    : [];
  if (entries.length) return entries;
  const size = String(item?.attributes?.size || "").trim();
  return [{
    variant_attributes: size ? { size } : {},
    quantity: item?.stock_quantity == null
      ? 1
      : Math.max(0, Number(item.stock_quantity) || 0),
  }];
}

/** Derive the display total from entries rather than trusting a separate total. */
export function catalogStockDistributionTotal(entries) {
  return (entries || []).reduce(
    (total, entry) => total + (Number.isInteger(Number(entry?.quantity)) ? Number(entry.quantity) : 0),
    0
  );
}

/** Build a compact mobile label such as "S ×1 · M ×1 · XL ×10". */
export function catalogStockDistributionSummary(entries) {
  return (entries || []).map((entry) => {
    const size = String(entry?.variant_attributes?.size || "All").trim() || "All";
    return `${size} ×${Number(entry?.quantity) || 0}`;
  }).join(" · ");
}
