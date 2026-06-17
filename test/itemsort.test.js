import { describe, it, expect } from "vitest";
import { sortItems } from "../src/lib/itemsort.js";

const rows = [
  { id: "a", price: 300, stock_quantity: 1, brand: "Zara", name: null },
  { id: "b", price: 100, stock_quantity: 5, brand: "Acme", name: null },
  { id: "c", price: null, stock_quantity: null, brand: null, name: "Nameless" },
];

const ids = (r) => r.map((x) => x.id);

describe("sortItems", () => {
  it("does not mutate the input and 'new' is a no-op", () => {
    const out = sortItems(rows, "new");
    expect(ids(out)).toEqual(["a", "b", "c"]);
    expect(ids(rows)).toEqual(["a", "b", "c"]); // original untouched
  });
  it("'old' reverses", () => {
    expect(ids(sortItems(rows, "old"))).toEqual(["c", "b", "a"]);
  });
  it("price asc/desc, nulls last", () => {
    expect(ids(sortItems(rows, "price-asc"))).toEqual(["b", "a", "c"]);
    expect(ids(sortItems(rows, "price-desc"))).toEqual(["a", "b", "c"]);
  });
  it("stock asc/desc, nulls last", () => {
    expect(ids(sortItems(rows, "stock-asc"))).toEqual(["a", "b", "c"]);
    expect(ids(sortItems(rows, "stock-desc"))).toEqual(["b", "a", "c"]);
  });
  it("brand A–Z falls back to name", () => {
    expect(ids(sortItems(rows, "brand"))).toEqual(["b", "c", "a"]); // Acme, Nameless, Zara
  });
  it("unknown sort key returns insertion order (copy)", () => {
    expect(ids(sortItems(rows, "???"))).toEqual(["a", "b", "c"]);
  });
});
