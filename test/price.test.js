import { describe, it, expect } from "vitest";
import { parsePrice, costFromRetail, marginPercent } from "../src/lib/price.js";

describe("parsePrice (R1)", () => {
  it("accepts valid non-negative numbers", () => {
    expect(parsePrice("100")).toBe(100);
    expect(parsePrice("0")).toBe(0);
    expect(parsePrice(" 2500 ")).toBe(2500);
    expect(parsePrice("12.5")).toBe(12.5);
    expect(parsePrice(40)).toBe(40);
  });
  it("treats blank as unset (null), not zero", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("   ")).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
  });
  it("rejects negative and non-finite input", () => {
    expect(parsePrice("-5")).toBeNull();
    expect(parsePrice("-0.01")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
    expect(parsePrice("NaN")).toBeNull();
    expect(parsePrice("Infinity")).toBeNull();
    expect(parsePrice("1e999")).toBeNull(); // overflows to Infinity
  });
});

describe("costFromRetail", () => {
  it("pct mode rounds a percentage of retail", () => {
    expect(costFromRetail(100, { mode: "pct", value: 50 })).toBe(50);
    expect(costFromRetail(101, { mode: "pct", value: 50 })).toBe(51); // 50.5 -> 51
    expect(costFromRetail(33, { mode: "pct", value: 33 })).toBe(11); // 10.89 -> 11
    expect(costFromRetail(100, { mode: "pct", value: 0 })).toBe(0);
  });
  it("fixed mode returns the flat value regardless of retail", () => {
    expect(costFromRetail(100, { mode: "fixed", value: 40 })).toBe(40);
    expect(costFromRetail(999, { mode: "fixed", value: 0 })).toBe(0);
    expect(costFromRetail(null, { mode: "fixed", value: 40 })).toBe(40);
  });
  it("returns null for invalid value / retail / mode", () => {
    expect(costFromRetail(null, { mode: "pct", value: 50 })).toBeNull();
    expect(costFromRetail(-100, { mode: "pct", value: 50 })).toBeNull();
    expect(costFromRetail(100, { mode: "pct", value: -1 })).toBeNull();
    expect(costFromRetail(100, { mode: "pct", value: "x" })).toBeNull();
    expect(costFromRetail(100, { mode: "bogus", value: 50 })).toBeNull();
  });
});

describe("marginPercent (R4 surface)", () => {
  it("computes a rounded margin", () => {
    expect(marginPercent(150, 100)).toBe(50);
    expect(marginPercent(100, 100)).toBe(0);
    expect(marginPercent(80, 100)).toBe(-20); // below cost
  });
  it("returns null when cost is missing or non-positive", () => {
    expect(marginPercent(100, 0)).toBeNull();
    expect(marginPercent(100, null)).toBeNull();
    expect(marginPercent(null, 100)).toBeNull();
  });
});
