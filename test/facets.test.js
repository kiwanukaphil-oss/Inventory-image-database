import { describe, it, expect } from "vitest";
import { shopState, facetValue, buildFacets, searchText, matchesItem } from "../src/lib/facets.js";

const noMirror = () => undefined;

describe("shopState", () => {
  it("derives states from sync columns", () => {
    expect(shopState({ pos_sync_status: null, status: "draft" }, noMirror)).toBe("Not pushed");
    expect(shopState({ pos_sync_status: null, status: "approved" }, noMirror)).toBe("Queued");
    expect(shopState({ pos_sync_status: "error" }, noMirror)).toBe("Sync error");
    expect(shopState({ pos_sync_status: "pending" }, noMirror)).toBe("Sending");
    expect(shopState({ pos_sync_status: "synced", pos_dirty: true }, noMirror)).toBe("Update pending");
  });
  it("uses the mirror for synced items", () => {
    const m = (row) => () => row;
    expect(shopState({ pos_sync_status: "synced" }, m({ is_active: false }))).toBe("Retired");
    expect(shopState({ pos_sync_status: "synced" }, m({ stock_quantity: 0 }))).toBe("Sold out");
    expect(shopState({ pos_sync_status: "synced" }, m({ stock_quantity: 2, reorder_level: 5 }))).toBe("Low stock");
    expect(shopState({ pos_sync_status: "synced" }, m({ stock_quantity: 10, reorder_level: 5 }))).toBe("In shop");
    expect(shopState({ pos_sync_status: "synced" }, noMirror)).toBe("In shop");
  });
});

const resolvers = {
  statusLabel: (s) => ({ draft: "New", "needs-review": "Needs review", approved: "Approved" }[s] || s),
  issueLabel: (it) => it._issue || "Clean",
  issueShort: (it) => it._short || "",
  shopStateOf: (it) => it._shop || "Not pushed",
  categoryPathOf: (id) => ({ c1: "Clothing › Shirts", c2: "Footwear › Sneakers" }[id] || ""),
};

describe("facetValue", () => {
  it("extracts per-key values", () => {
    const it = { brand: "Nike", status: "approved", category_id: "c1", attributes: { color: "Red" }, _issue: "Missing price", _shop: "In shop" };
    expect(facetValue(it, "brand", resolvers)).toBe("Nike");
    expect(facetValue(it, "status", resolvers)).toBe("Approved");
    expect(facetValue(it, "issue", resolvers)).toBe("Missing price");
    expect(facetValue(it, "shop", resolvers)).toBe("In shop");
    expect(facetValue(it, "top", resolvers)).toBe("Clothing");
    expect(facetValue(it, "category", resolvers)).toBe("Shirts");
    expect(facetValue(it, "color", resolvers)).toBe("Red");
    expect(facetValue(it, "missing", resolvers)).toBe("");
  });
});

describe("buildFacets", () => {
  it("keeps only facets with >=2 distinct values, sorted", () => {
    const items = [
      { brand: "Nike", status: "approved", category_id: "c1", attributes: { color: "Red" } },
      { brand: "Puma", status: "approved", category_id: "c2", attributes: { color: "Red" } },
    ];
    const facets = buildFacets(items, { attrKeys: ["color"], fieldLabel: (k) => k, resolvers });
    const keys = facets.map((f) => f.key);
    expect(keys).toContain("brand"); // Nike, Puma
    expect(keys).toContain("top");   // Clothing, Footwear
    expect(keys).not.toContain("status"); // both Approved
    expect(keys).not.toContain("color");  // both Red
    expect(facets.find((f) => f.key === "brand").values).toEqual(["Nike", "Puma"]);
  });
});

describe("searchText", () => {
  it("builds a lowercased haystack", () => {
    const t = searchText({ brand: "Nike", name: "Air", sku: "SKU1", categories: { name: "Shirts" }, attributes: { color: "Red" } }, resolvers);
    expect(t).toContain("nike");
    expect(t).toContain("shirts");
    expect(t).toContain("red");
    expect(t).toContain("sku1");
  });
});

describe("matchesItem", () => {
  const ctx = {
    textOf: (it) => searchText(it, resolvers),
    valueOf: (it, key) => facetValue(it, key, resolvers),
    passesQueue: () => true,
  };
  const base = { id: "1", brand: "Nike", price: 100, created_at: "2026-06-01", attributes: { color: "Red" }, category_id: "c1" };
  const empty = { q: "", itemIds: null, noPrice: false, priceMin: "", priceMax: "", cutoff: null, active: {} };

  it("passes with no criteria", () => expect(matchesItem(base, empty, ctx)).toBe(true));
  it("text search", () => {
    expect(matchesItem(base, { ...empty, q: "nike" }, ctx)).toBe(true);
    expect(matchesItem(base, { ...empty, q: "adidas" }, ctx)).toBe(false);
  });
  it("price range + noPrice", () => {
    expect(matchesItem(base, { ...empty, priceMin: "50", priceMax: "150" }, ctx)).toBe(true);
    expect(matchesItem(base, { ...empty, priceMin: "150" }, ctx)).toBe(false);
    expect(matchesItem({ ...base, price: null }, { ...empty, noPrice: true }, ctx)).toBe(true);
    expect(matchesItem(base, { ...empty, noPrice: true }, ctx)).toBe(false);
  });
  it("can use variant price coverage for the missing-price filter", () => {
    const variantContext = {
      ...ctx,
      hasMissingPrice: (item) => item.pricing_ready !== true,
    };
    expect(matchesItem(
      { ...base, price: null, pricing_ready: true },
      { ...empty, noPrice: true },
      variantContext
    )).toBe(false);
    expect(matchesItem(
      { ...base, price: 100, pricing_ready: false },
      { ...empty, noPrice: true },
      variantContext
    )).toBe(true);
  });
  it("facets: AND across keys, OR within a key", () => {
    const active = { brand: new Set(["Nike", "Puma"]), color: new Set(["Red"]) };
    expect(matchesItem(base, { ...empty, active }, ctx)).toBe(true);
    expect(matchesItem({ ...base, brand: "Adidas" }, { ...empty, active }, ctx)).toBe(false);
    expect(matchesItem(base, { ...empty, active: { color: new Set(["Blue"]) } }, ctx)).toBe(false);
  });
  it("excludeKey ignores that facet (faceted counting)", () => {
    const active = { brand: new Set(["Adidas"]) };
    expect(matchesItem(base, { ...empty, active }, ctx, "brand")).toBe(true);
  });
  it("itemIds restriction", () => {
    expect(matchesItem(base, { ...empty, itemIds: new Set(["1"]) }, ctx)).toBe(true);
    expect(matchesItem(base, { ...empty, itemIds: new Set(["2"]) }, ctx)).toBe(false);
  });
  it("date cutoff (created before cutoff is excluded)", () => {
    expect(matchesItem(base, { ...empty, cutoff: new Date("2026-05-01") }, ctx)).toBe(true);
    expect(matchesItem(base, { ...empty, cutoff: new Date("2026-07-01") }, ctx)).toBe(false);
  });
  it("passesQueue gate", () => {
    expect(matchesItem(base, empty, { ...ctx, passesQueue: () => false })).toBe(false);
  });
});
