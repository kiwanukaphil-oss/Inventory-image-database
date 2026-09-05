// Pure sort for the browse/review grid: rows + sort key in, sorted copy out.
// No DOM, no closure state — unit-tested in test/itemsort.test.js. First slice of
// the gallery.js decomposition (Q1): lift the pure logic out of the god-function.
import { catalogPriceRange } from './pricing-workspace.js';

/** Sort by the lowest/highest sellable price, keeping missing values last. */
const compareEffectivePrice = (descending) => (a,b) => {
  const left = catalogPriceRange(a)[descending ? 'max' : 'min'];
  const right = catalogPriceRange(b)[descending ? 'max' : 'min'];
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return descending ? right-left : left-right;
};

const numAsc = (key) => (a, b) => {
  const x = a[key], y = b[key];
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return x - y;
};
const numDesc = (key) => (a, b) => {
  const x = a[key], y = b[key];
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return y - x;
};

// rows are assumed loaded newest-first, so "new" is a no-op and "old" reverses.
// Nulls always sort last. Returns a new array (never mutates the input).
export function sortItems(rows, sortBy) {
  const r = rows.slice();
  if (sortBy === "old") r.reverse();
  else if (sortBy === "price-asc") r.sort(compareEffectivePrice(false));
  else if (sortBy === "price-desc") r.sort(compareEffectivePrice(true));
  else if (sortBy === "stock-asc") r.sort(numAsc("stock_quantity"));
  else if (sortBy === "stock-desc") r.sort(numDesc("stock_quantity"));
  else if (sortBy === "brand") r.sort((a, b) =>
    (a.brand || a.name || "").localeCompare(b.brand || b.name || "", undefined, { numeric: true }));
  return r;
}
