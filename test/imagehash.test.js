import { describe, it, expect } from "vitest";
import { hammingHex } from "../src/imagehash.js";

describe("hammingHex (near-duplicate guard)", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingHex("00ff00ff00ff00ff", "00ff00ff00ff00ff")).toBe(0);
  });
  it("counts differing bits per hex nibble", () => {
    expect(hammingHex("0", "1")).toBe(1); // 0000 vs 0001
    expect(hammingHex("0", "f")).toBe(4); // 0000 vs 1111
    expect(hammingHex("f", "0")).toBe(4);
    expect(hammingHex("0f", "00")).toBe(4);
  });
  it("treats null / empty / mismatched length as max distance (64)", () => {
    expect(hammingHex("", "abc")).toBe(64);
    expect(hammingHex(null, "abc")).toBe(64);
    expect(hammingHex("ab", "abc")).toBe(64);
  });
});
