import { describe, it, expect } from "vitest";
import {
  getSizeValue, normalizeStyleCode, getGroupKey, resolveProductName,
  normalizeGender, buildVariantAttributes,
} from "../src/lib/sku.js";

describe("getSizeValue", () => {
  it("finds the first size-like attribute", () => {
    expect(getSizeValue({ size: "32" })).toBe("32");
    expect(getSizeValue({ waist: 34 })).toBe("34");
    expect(getSizeValue({ volume_ml: "90" })).toBe("90");
    expect(getSizeValue({ color: "Red" })).toBeNull();
  });
});

describe("normalizeStyleCode", () => {
  it("uppercases + strips non-alphanumerics; folds format variants", () => {
    expect(normalizeStyleCode("3388-21")).toBe("338821");
    expect(normalizeStyleCode("338821")).toBe("338821"); // same group as 3388-21
    expect(normalizeStyleCode("a1b2")).toBe("A1B2");
    expect(normalizeStyleCode("")).toBeNull();
    expect(normalizeStyleCode("---")).toBeNull();
  });
});

describe("getGroupKey", () => {
  const item = { brand: "Cobb", category_id: "c1", attributes: { style: "807-26", color: "Blue", size: "32" } };
  it("keys on brand|category|colour|style when style+size present", () => {
    expect(getGroupKey(item)).toBe("cobb|c1|blue|80726");
  });
  it("is null without a style or without a size (item stays standalone)", () => {
    expect(getGroupKey({ ...item, attributes: { color: "Blue", size: "32" } })).toBeNull();
    expect(getGroupKey({ ...item, attributes: { style: "807-26", color: "Blue" } })).toBeNull();
  });
  it("folds case/whitespace + style format so variants collapse", () => {
    const a = getGroupKey({ brand: " Cobb ", category_id: "c1", attributes: { style: "807-26", color: "Blue", size: "32" } });
    const b = getGroupKey({ brand: "cobb", category_id: "c1", attributes: { style: "80726", color: "blue", size: "34" } });
    expect(a).toBe(b); // same product, different sizes
  });
});

describe("resolveProductName", () => {
  it("keeps an explicit name; appends colour for grouped products lacking it", () => {
    expect(resolveProductName({ name: "Dior Sauvage", attributes: { color: "Blue" } })).toBe("Dior Sauvage");
    expect(resolveProductName({ name: "Dior Sauvage", attributes: { color: "Blue" } }, { dropSize: true })).toBe("Dior Sauvage — Blue");
    expect(resolveProductName({ name: "Dior Sauvage Blue", attributes: { color: "Blue" } }, { dropSize: true })).toBe("Dior Sauvage Blue"); // already has colour
  });
  it("synthesizes from brand + category + colour/size", () => {
    const item = { brand: "Cobb", categories: { name: "Cargo Pants" }, attributes: { color: "Khaki", size: "34" } };
    expect(resolveProductName(item)).toBe("Cobb Cargo Pants — Khaki / 34");
    expect(resolveProductName(item, { dropSize: true })).toBe("Cobb Cargo Pants — Khaki");
  });
  it("falls back to 'Unnamed item'", () => {
    expect(resolveProductName({})).toBe("Unnamed item");
  });
});

describe("normalizeGender", () => {
  it("maps synonyms to the POS set, else null", () => {
    expect(normalizeGender("Man")).toBe("men");
    expect(normalizeGender("WOMENS")).toBe("women");
    expect(normalizeGender("unisex")).toBe("unisex");
    expect(normalizeGender("alien")).toBeNull();
    expect(normalizeGender("")).toBeNull();
    expect(normalizeGender(null)).toBeNull();
  });
});

describe("buildVariantAttributes", () => {
  it("excludes product-level attrs (gender/material), drops empties, stringifies", () => {
    expect(buildVariantAttributes({ size: 32, color: "Red", gender: "men", material: "cotton", note: "" }))
      .toEqual({ size: "32", color: "Red" });
    expect(buildVariantAttributes({})).toEqual({});
  });
});
