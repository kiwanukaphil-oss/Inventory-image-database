import { describe, expect, it } from "vitest";
import {
  buildAppUrl,
  defaultFilterForStage,
  parseAppRoute,
  reviewStageForFilter,
} from "../src/lib/navigation-state.js";

describe("navigation state", () => {
  it("restores a Review filter from the URL", () => {
    expect(parseAppRoute("?view=review&queue=price")).toMatchObject({
      view: "review",
      reviewFilter: "price",
    });
  });

  it("falls back safely when route values are invalid", () => {
    expect(parseAppRoute("?view=unknown&queue=unknown", { view: "catalog", reviewFilter: "doubt" }))
      .toMatchObject({ view: "catalog", reviewFilter: "doubt" });
  });

  it("keeps the active Review context in generated URLs", () => {
    expect(buildAppUrl("https://example.test/?share=1", {
      view: "review",
      reviewFilter: "verify",
      itemId: "item-7",
    })).toBe("/?view=review&queue=verify&item=item-7");
  });

  it("maps detailed filters into the three Review stages", () => {
    expect(reviewStageForFilter("price")).toBe("fix");
    expect(reviewStageForFilter("edited")).toBe("verify");
    expect(reviewStageForFilter("ready")).toBe("approve");
    expect(defaultFilterForStage("verify")).toBe("verify");
  });
});
