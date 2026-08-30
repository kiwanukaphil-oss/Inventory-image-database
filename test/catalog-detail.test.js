import { describe, expect, it } from "vitest";
import {
  catalogDetailFieldRows,
  catalogItemTitle,
  evidenceSourceLabel,
} from "../src/lib/catalog-detail.js";

describe("catalog detail presentation", () => {
  it("does not repeat a brand already present in the product name", () => {
    expect(catalogItemTitle({ brand: "Hugo & Victor", name: "HUGO & VICTOR Formal Shirt" }))
      .toBe("HUGO & VICTOR Formal Shirt");
    expect(catalogItemTitle({ brand: "Acme", name: "Oxford Shirt" }))
      .toBe("Acme Oxford Shirt");
  });

  it("keeps missing category fields visible with confidence and evidence metadata", () => {
    const rows = catalogDetailFieldRows({
      attributes: { color: "Blue and white", legacy_cut: "Tailored" },
      confidence: { color: "Medium" },
      ai_field_evidence: {
        color: { source: "visual_observation", observation: "Blue and white stripes" },
      },
    }, [
      { key: "color", label: "Color", required: true },
      { key: "material", label: "Material", required: false },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({ key: "color", missing: false, confidence: "Medium" }),
      expect.objectContaining({ key: "material", missing: true }),
      expect.objectContaining({ key: "legacy_cut", label: "Legacy Cut" }),
    ]);
    expect(evidenceSourceLabel("visual_inference")).toBe("Visual inference");
  });
});
