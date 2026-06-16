// Pure pricing math — shared by the pricing tools and the editor, and unit-tested
// in test/price.test.js. NO DOM / NO Supabase imports: keep this module pure so
// it is trivially testable and reusable.

// Parse a user-entered price/cost into a non-negative finite number, or null if
// blank/invalid/negative (audit R1). Blank means "unset", not zero.
export function parsePrice(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// Cost for a given retail under a cost rule. mode 'pct' = a percentage of retail
// (rounded to a whole unit); mode 'fixed' = a flat cost (retail-independent).
// Returns null when the rule/retail is invalid. Mirrors the guided-pricing rule.
export function costFromRetail(retail, { mode, value } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;
  if (mode === "fixed") return v;
  if (mode === "pct") {
    // Guard null/undefined/"" explicitly — Number(null) is 0, not NaN, which
    // would otherwise sneak a "missing retail" through as a 0 cost.
    if (retail === null || retail === undefined || retail === "") return null;
    const r = Number(retail);
    if (!Number.isFinite(r) || r < 0) return null;
    return Math.round((r * v) / 100);
  }
  return null;
}

// Margin percentage from retail + cost, rounded. null when cost is missing or
// non-positive (margin undefined); a negative result means selling below cost.
export function marginPercent(retail, cost) {
  // Number(null) is 0, so reject missing inputs before coercing.
  if (retail === null || retail === undefined || retail === "") return null;
  if (cost === null || cost === undefined || cost === "") return null;
  const r = Number(retail);
  const c = Number(cost);
  if (!Number.isFinite(r) || !Number.isFinite(c) || c <= 0) return null;
  return Math.round(((r - c) / c) * 100);
}
