import { describe, expect, it } from "vitest";
import {
  catalogItemNeedsPricing,
  selectCatalogPricingItems,
  summarizeCatalogPricingItems,
  summarizeCatalogVariantValues,
} from "../src/lib/catalog-pricing-plan.js";

const unpricedLot = {
  id: "lot-a",
  pricing_ready: false,
  cost_ready: false,
  variant_count: 2,
  total_units: 6,
  variant_lines: [
    { variant_attributes: { size: "S" }, quantity: 1 },
    { variant_attributes: { size: "XL" }, quantity: 5 },
  ],
};

describe("Railway catalog pricing plan", () => {
  it("includes secondary price blockers independently of AI or detail blockers", () => {
    expect(catalogItemNeedsPricing({
      pricing_ready: false,
      readiness_issue: "ai",
    })).toBe(true);
  });

  it("defaults to incomplete unpublished items but respects explicit selections", () => {
    const priced = { id: "priced", pricing_ready: true, cost_ready: true };
    const published = { id: "published", pricing_ready: false, is_published: true };
    const items = [unpricedLot, priced, published];

    expect(selectCatalogPricingItems(items).map(({ id }) => id)).toEqual(["lot-a"]);
    expect(selectCatalogPricingItems(items, { itemIds: ["priced"] }).map(({ id }) => id))
      .toEqual(["priced"]);
  });

  it("includes cost-only gaps for users who can maintain costs", () => {
    const item = { id: "cost-gap", pricing_ready: true, cost_ready: false };
    expect(selectCatalogPricingItems([item], { includeCosts: false })).toEqual([]);
    expect(selectCatalogPricingItems([item], { includeCosts: true })).toEqual([item]);
  });

  it("summarizes photos, variants, units, and size impact", () => {
    expect(summarizeCatalogPricingItems([unpricedLot])).toEqual({
      itemCount: 1,
      variantCount: 2,
      unitCount: 6,
    });
    expect(summarizeCatalogVariantValues([unpricedLot])).toEqual([
      { value: "S", itemCount: 1, variantCount: 1, unitCount: 1 },
      { value: "XL", itemCount: 1, variantCount: 1, unitCount: 5 },
    ]);
  });
});
