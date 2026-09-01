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

/** Derive the photo, variant, unit, and priced-line counts shown in catalog review. */
export function catalogVariantLotMetrics(item) {
  const normalizedLines = Array.isArray(item?.variant_lines) && item.variant_lines.length
    ? item.variant_lines
    : catalogStockDistributionEntries(item);
  const variantCount = Number.isInteger(Number(item?.variant_count))
    ? Number(item.variant_count)
    : normalizedLines.filter((line) => Number(line?.quantity) > 0).length;
  const reportedUnitCount = item?.total_units ?? item?.unit_count;
  const unitCount = Number.isInteger(Number(reportedUnitCount))
    ? Number(reportedUnitCount)
    : catalogStockDistributionTotal(normalizedLines);
  const pricedVariantCount = Number.isInteger(Number(item?.priced_variant_count))
    ? Number(item.priced_variant_count)
    : normalizedLines.filter((line) => (
      Number(line?.quantity) > 0
      && (line?.effective_price != null || line?.price_override != null || item?.price != null)
    )).length;
  return { photoCount: 1, variantCount, unitCount, pricedVariantCount };
}

/** Build a concise review label that makes a multi-unit photo explicit. */
export function catalogVariantLotSummary(item, { includePricing = false } = {}) {
  const metrics = catalogVariantLotMetrics(item);
  const parts = [
    "1 photo",
    `${metrics.variantCount} variant${metrics.variantCount === 1 ? "" : "s"}`,
    `${metrics.unitCount} unit${metrics.unitCount === 1 ? "" : "s"}`,
  ];
  if (includePricing && metrics.variantCount > 0) {
    parts.push(`${metrics.pricedVariantCount}/${metrics.variantCount} priced`);
  }
  return parts.join(" · ");
}

/** Build a compact mobile label such as "S ×1 · M ×1 · XL ×10". */
export function catalogStockDistributionSummary(entries) {
  return (entries || []).map((entry) => {
    const size = String(entry?.variant_attributes?.size || "All").trim() || "All";
    return `${size} ×${Number(entry?.quantity) || 0}`;
  }).join(" · ");
}
