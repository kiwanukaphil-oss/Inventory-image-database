import { describe, expect, it } from "vitest";
import { classifyVerificationRisk, verificationRiskRank } from "../src/lib/review-risk.js";

describe("verification risk", () => {
  it("keeps Low-confidence items out of bulk verification", () => {
    const risk = classifyVerificationRisk([{ key: "brand", level: "Low" }]);
    expect(risk.level).toBe("critical");
    expect(risk.bulkEligible).toBe(false);
  });

  it("treats several Medium fields as critical", () => {
    const doubts = ["brand", "colour", "fit"].map((key) => ({ key, level: "Medium" }));
    expect(classifyVerificationRisk(doubts).level).toBe("critical");
  });

  it("allows one or two Medium-only fields into the quick batch", () => {
    const risk = classifyVerificationRisk([
      { key: "brand", level: "Medium" },
      { key: "colour", level: "Medium" },
    ]);
    expect(risk.level).toBe("quick");
    expect(risk.bulkEligible).toBe(true);
  });

  it("orders critical items before quick and recent checks", () => {
    expect(verificationRiskRank({ level: "critical" })).toBeLessThan(verificationRiskRank({ level: "quick" }));
    expect(verificationRiskRank({ level: "quick" })).toBeLessThan(verificationRiskRank({ level: "recent" }));
  });
});
