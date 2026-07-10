// Pure pricing math — shared by the pricing tools and the editor, and unit-tested
// in test/price.test.js. NO DOM / NO Supabase imports: keep this module pure so
// it is trivially testable and reusable.
//
// Currency precision (R4): prices are treated as WHOLE units — the shop uses a
// no-decimal currency (e.g. UGX), so costFromRetail rounds to an integer. If a
// decimal currency is ever configured, move this module to integer-cents
// arithmetic (and add tests for the rounding) rather than floating-point.

// Remove visual thousands separators before numeric work. The UI may display
// "12,500" while storage and comparisons still use 12500.
export function stripPriceGrouping(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/,/g, "").trim();
}

// Format a partially typed price for display without changing its numeric
// meaning. Invalid text is left alone so validation can still show an error.
export function formatPriceInput(raw) {
  const source = String(raw ?? "");
  const s = stripPriceGrouping(source);
  if (s === "") return "";
  const sign = s.startsWith("-") ? "-" : "";
  const body = sign ? s.slice(1) : s;
  if (!/^\d*\.?\d*$/.test(body)) return source;
  const hasDecimal = body.includes(".");
  const [whole, decimal = ""] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${hasDecimal ? "." + decimal : ""}`;
}

// Parse a user-entered price/cost into a non-negative finite number, or null if
// blank/invalid/negative (audit R1). Blank means "unset", not zero.
export function parsePrice(raw) {
  const s = stripPriceGrouping(raw);
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// Cost for a given retail under a cost rule. mode 'pct' = a percentage of retail
// (rounded to a whole unit); mode 'fixed' = a flat cost (retail-independent).
// Returns null when the rule/retail is invalid. Mirrors the guided-pricing rule.
export function costFromRetail(retail, { mode, value } = {}) {
  const v = parsePrice(value);
  if (v === null) return null;
  if (mode === "fixed") return v;
  if (mode === "pct") {
    // Guard null/undefined/"" explicitly — Number(null) is 0, not NaN, which
    // would otherwise sneak a "missing retail" through as a 0 cost.
    if (retail === null || retail === undefined || retail === "") return null;
    const r = parsePrice(retail);
    if (r === null) return null;
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
  const r = parsePrice(retail);
  const c = parsePrice(cost);
  if (r === null || c === null || c <= 0) return null;
  return Math.round(((r - c) / c) * 100);
}
