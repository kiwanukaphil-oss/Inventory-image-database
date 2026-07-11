import { describe, expect, it } from "vitest";
import {
  ALL_POS_BRANCHES,
  branchVariantKey,
  defaultPosBranchId,
  mergeBranchMirror,
  mirrorForItem,
} from "../src/posbranches.js";

const branches = [
  { pos_branch_id: "b-main", code: "MAIN", status: "active", is_default: true, is_enabled: true },
  { pos_branch_id: "b-two", code: "TWO", status: "active", is_default: false, is_enabled: true },
];
const globals = [{ pos_variant_id: "v1", pos_sku: "SKU-1", is_active: true }];
const stock = [
  { pos_branch_id: "b-main", pos_variant_id: "v1", stock_quantity: 2, reorder_level: 3, units_sold: 5, units_returned: 1, units_sold_today: 1, units_sold_7d: 3, mirrored_at: "2026-07-10T10:00:00Z" },
  { pos_branch_id: "b-two", pos_variant_id: "v1", stock_quantity: 8, reorder_level: 2, units_sold: 4, units_returned: 0, units_sold_today: 2, units_sold_7d: 4, mirrored_at: "2026-07-10T10:01:00Z" },
];

describe("POS branch mirror", () => {
  it("resolves the operational default branch", () => {
    expect(defaultPosBranchId(branches)).toBe("b-main");
  });

  it("keeps branch quantities separate", () => {
    expect(mergeBranchMirror(globals, stock, "b-main").get("v1").stock_quantity).toBe(2);
    expect(mergeBranchMirror(globals, stock, "b-two").get("v1").stock_quantity).toBe(8);
  });

  it("builds an intentional all-branch aggregate", () => {
    const row = mergeBranchMirror(globals, stock, ALL_POS_BRANCHES).get("v1");
    expect(row.stock_quantity).toBe(10);
    expect(row.units_sold).toBe(9);
    expect(row.low_branch_count).toBe(1);
  });

  it("uses an item's receipt branch for gallery/editor state", () => {
    const payload = {
      defaultBranchId: "b-main",
      globalByVariant: new Map(globals.map((r) => [r.pos_variant_id, r])),
      byBranchVariant: new Map(stock.map((r) => [branchVariantKey(r.pos_branch_id, r.pos_variant_id), r])),
    };
    expect(mirrorForItem(payload, { pos_variant_id: "v1", pos_branch_id: "b-two" }).stock_quantity).toBe(8);
    expect(mirrorForItem(payload, { pos_variant_id: "v1" }).stock_quantity).toBe(2);
  });
});
