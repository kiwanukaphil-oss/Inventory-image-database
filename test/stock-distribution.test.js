import { describe, expect, it } from "vitest";
import {
  catalogStockDistributionEntries,
  catalogStockDistributionSummary,
  catalogStockDistributionTotal,
  catalogVariantLotMetrics,
  catalogVariantLotSummary,
} from "../src/lib/stock-distribution.js";

describe("catalog stock distributions", () => {
  it("preserves explicit size quantities and derives their total", () => {
    const entries = catalogStockDistributionEntries({
      stock_distribution: [
        { variant_attributes: { size: "S" }, quantity: 1 },
        { variant_attributes: { size: "XL" }, quantity: 10 },
      ],
      stock_quantity: 999,
    });

    expect(catalogStockDistributionTotal(entries)).toBe(11);
    expect(catalogStockDistributionSummary(entries)).toBe("S ×1 · XL ×10");
  });

  it("provides a one-row compatibility projection for older catalog data", () => {
    expect(catalogStockDistributionEntries({
      attributes: { size: "M" },
      stock_quantity: 3,
    })).toEqual([{ variant_attributes: { size: "M" }, quantity: 3 }]);
  });

  it("preserves a migrated zero total instead of inventing stock", () => {
    expect(catalogStockDistributionEntries({ stock_quantity: 0 })).toEqual([
      { variant_attributes: {}, quantity: 0 },
    ]);
  });

  it("makes a one-photo multi-variant lot explicit in review", () => {
    const item = {
      variant_count: 2,
      unit_count: 11,
      priced_variant_count: 1,
    };

    expect(catalogVariantLotMetrics(item)).toEqual({
      photoCount: 1,
      variantCount: 2,
      unitCount: 11,
      pricedVariantCount: 1,
    });
    expect(catalogVariantLotSummary(item, { includePricing: true }))
      .toBe("1 photo · 2 variants · 11 units · 1/2 priced");
  });
});
