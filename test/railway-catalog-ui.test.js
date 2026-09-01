import { describe, expect, it } from "vitest";
import {
  buildRailwayCatalogProfile,
  canRunCatalogAi,
  canSelectCatalogItems,
  selectRailwayCatalogNavigation,
} from "../src/lib/railway-catalog-ui.js";

describe("Railway catalog capability surface", () => {
  it("restores intake without exposing unfinished general mutation controls", () => {
    const profile = buildRailwayCatalogProfile({
      role: "admin",
      can_upload: true,
      can_edit: true,
      can_delete: true,
      can_view_cost: true,
      can_manage_users: true,
      can_publish: true,
      can_ai_extract: true,
    });

    expect(profile).toMatchObject({
      role: "admin",
      can_upload: true,
      can_ai_extract: true,
      can_select: true,
      can_price: true,
      can_edit: false,
      can_delete: false,
      can_view_cost: true,
      can_manage_users: false,
      can_publish: true,
    });
    expect(canSelectCatalogItems(profile)).toBe(true);
    expect(canRunCatalogAi(profile, true)).toBe(true);
  });

  it("enables selection for pricing without exposing unsupported general editing", () => {
    const profile = buildRailwayCatalogProfile({
      can_upload: true,
      can_edit: true,
      can_ai_extract: false,
    });

    expect(canSelectCatalogItems(profile)).toBe(true);
    expect(canRunCatalogAi(profile, true)).toBe(false);
    expect(profile.can_price).toBe(true);
    expect(profile.can_edit).toBe(false);
  });

  it("shows Home and Add for upload-capable Railway users but keeps Shop hidden", () => {
    const navItems = ["today", "catalog", "add", "review", "shop"].map((id) => ({ id }));
    expect(selectRailwayCatalogNavigation(navItems, { can_upload: true }).map(({ id }) => id))
      .toEqual(["today", "catalog", "add", "review"]);
    expect(selectRailwayCatalogNavigation(navItems, { can_upload: false }).map(({ id }) => id))
      .toEqual(["today", "catalog", "review"]);
  });
});
