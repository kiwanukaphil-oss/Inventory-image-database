// Pure sort for the browse/review grid: rows + sort key in, sorted copy out.
// No DOM, no closure state — unit-tested in test/itemsort.test.js. First slice of
// the gallery.js decomposition (Q1): lift the pure logic out of the god-function.

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
  else if (sortBy === "price-asc") r.sort(numAsc("price"));
  else if (sortBy === "price-desc") r.sort(numDesc("price"));
  else if (sortBy === "stock-asc") r.sort(numAsc("stock_quantity"));
  else if (sortBy === "stock-desc") r.sort(numDesc("stock_quantity"));
  else if (sortBy === "brand") r.sort((a, b) =>
    (a.brand || a.name || "").localeCompare(b.brand || b.name || "", undefined, { numeric: true }));
  return r;
}
