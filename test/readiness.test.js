import { describe, it, expect } from "vitest";
import {
  missingCoreFields,
  aiDoubtFields,
  hasAiSignal,
  getItemReadiness,
  matchesReadinessQueue,
  statusLabel,
} from "../src/lib/readiness-core.js";

describe("missingCoreFields", () => {
  it("flags photo, name and details when empty", () => {
    expect(missingCoreFields({}, [])).toEqual(expect.arrayContaining(["photo", "category", "name", "details"]));
  });
  it("flags required category fields that are absent", () => {
    const item = { image_path: "x", category_id: "shirts", name: "Shirt", attributes: { color: "Red" } };
    const fields = [
      { key: "size", label: "Size", required: true },
      { key: "color", label: "Colour", required: true },
    ];
    expect(missingCoreFields(item, fields)).toEqual(["Size"]); // colour present, size missing
  });
  it("is empty when complete", () => {
    const item = { image_path: "x", category_id: "shirts", name: "Shirt", attributes: { size: "M" } };
    expect(missingCoreFields(item, [{ key: "size", label: "Size", required: true }])).toEqual([]);
  });
  it("accepts a confirmed per-line size distribution as the required size", () => {
    const item = {
      image_path: "x",
      category_id: "shirts",
      name: "Shirt",
      attributes: { color: "Blue" },
      stock_distribution_source: "human_confirmed",
      variant_lines: [
        { variant_attributes: { size: "S" }, quantity: 1 },
        { variant_attributes: { size: "XL" }, quantity: 5 },
      ],
    };
    expect(missingCoreFields(item, [
      { key: "size", label: "Size", required: true },
      { key: "color", label: "Color", required: true },
    ])).toEqual([]);
  });
});

describe("aiDoubtFields", () => {
  it("returns Low/Medium confidence fields, excluding AI-blind keys", () => {
    const item = { confidence: { brand: "High", color: "Low", fit: "Medium" } };
    expect(aiDoubtFields(item, new Set(["fit"]))).toEqual([{ key: "color", level: "Low" }]);
  });
});

describe("hasAiSignal", () => {
  it("true when brand/name/attributes/confidence present", () => {
    expect(hasAiSignal({ brand: "Nike" })).toBe(true);
    expect(hasAiSignal({ attributes: { color: "Red" } })).toBe(true);
    expect(hasAiSignal({ confidence: { brand: "High" } })).toBe(true);
  });
  it("false when nothing present", () => {
    expect(hasAiSignal({ attributes: {}, confidence: {} })).toBe(false);
  });
});

describe("getItemReadiness", () => {
  const complete = {
    status: "needs-review",
    image_path: "x",
    category_id: "shirts",
    name: "Shirt",
    attributes: { size: "M" },
    price: 100,
    has_cost_price: true,
    confidence: { brand: "High" },
  };
  const fields = [{ key: "size", label: "Size", required: true }];

  it("is ready when all blockers clear", () => {
    const r = getItemReadiness(complete, { fields });
    expect(r.isReady).toBe(true);
    expect(r.canApprove).toBe(true);
    expect(r.blockers).toEqual([]);
  });
  it("moves a checked AI item to ready without approving its status", () => {
    const awaitingCheck = { ...complete, confidence: { brand: "Medium" } };
    expect(getItemReadiness(awaitingCheck, { fields }).issue).toBe("doubt");
    const checked = { ...awaitingCheck, confidence: { brand: "High" } };
    const readiness = getItemReadiness(checked, { fields });
    expect(checked.status).toBe("needs-review");
    expect(readiness.issue).toBe("ready");
    expect(readiness.canApprove).toBe(true);
  });
  it("blocks on missing price", () => {
    const r = getItemReadiness({ ...complete, price: null }, { fields });
    expect(r.canApprove).toBe(false);
    expect(r.blockers.some((b) => b.issue === "price")).toBe(true);
  });
  it("accepts complete per-line retail overrides without an item default", () => {
    const variantPriced = {
      ...complete,
      price: null,
      pricing_ready: true,
      variant_lines: [
        { quantity: 1, effective_price: 100 },
        { quantity: 1, effective_price: 120 },
      ],
    };
    expect(getItemReadiness(variantPriced, { fields }).canApprove).toBe(true);
  });
  it("blocks on missing category", () => {
    const r = getItemReadiness({ ...complete, category_id: null }, { fields });
    expect(r.canApprove).toBe(false);
    expect(r.blockers.some((b) => b.issue === "missing")).toBe(true);
  });
  it("blocks on missing cost and tailors the message by canViewCost", () => {
    const admin = getItemReadiness({ ...complete, has_cost_price: false }, { fields });
    expect(admin.blockers.some((b) => b.label === "Missing cost price")).toBe(true);
    const viewer = getItemReadiness({ ...complete, has_cost_price: false }, { fields, canViewCost: false });
    expect(viewer.blockers.some((b) => b.label === "Cost price needed")).toBe(true);
  });
  it("approved + clean sync has no ambient blockers", () => {
    expect(getItemReadiness({ ...complete, status: "approved" }, { fields }).blockers).toEqual([]);
  });
  it("approved + sync error surfaces a sync issue", () => {
    const r = getItemReadiness({ ...complete, status: "approved", pos_sync_status: "error" }, { fields });
    expect(r.issue).toBe("sync");
  });
  it("blocks when a photo exists but AI has not read it", () => {
    const noSignal = {
      status: "needs-review", image_path: "x", category_id: "shirts", name: "", brand: "",
      attributes: {}, confidence: {}, price: 100, has_cost_price: true,
    };
    expect(getItemReadiness(noSignal, { fields: [] }).blockers.some((b) => b.issue === "ai")).toBe(true);
  });

  it("keeps a secondary missing-price blocker in the price queue", () => {
    const readiness = getItemReadiness({
      status: "draft",
      image_path: "x",
      category_id: "shirts",
      name: "",
      brand: "",
      attributes: {},
      confidence: {},
      pricing_ready: false,
      cost_ready: false,
    }, { fields: [] });

    expect(readiness.issue).toBe("ai");
    expect(matchesReadinessQueue(readiness, "price")).toBe(true);
    expect(matchesReadinessQueue(readiness, "ai")).toBe(true);
    expect(matchesReadinessQueue(readiness, "work")).toBe(true);
  });
});

describe("statusLabel", () => {
  it("maps known statuses and passes through unknown", () => {
    expect(statusLabel("approved")).toBe("Approved");
    expect(statusLabel("needs-review")).toBe("Needs review");
    expect(statusLabel("weird")).toBe("weird");
  });
});
