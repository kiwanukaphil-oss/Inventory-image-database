import { describe, expect, it } from "vitest";
import {
  buildRailwayCatalogProfile,
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
      can_edit: false,
      can_delete: false,
      can_view_cost: false,
      can_manage_users: false,
      can_publish: false,
    });
  });

  it("shows Home and Add for upload-capable Railway users but keeps Shop hidden", () => {
    const navItems = ["today", "catalog", "add", "review", "shop"].map((id) => ({ id }));
    expect(selectRailwayCatalogNavigation(navItems, { can_upload: true }).map(({ id }) => id))
      .toEqual(["today", "catalog", "add", "review"]);
    expect(selectRailwayCatalogNavigation(navItems, { can_upload: false }).map(({ id }) => id))
      .toEqual(["today", "catalog", "review"]);
  });
});
