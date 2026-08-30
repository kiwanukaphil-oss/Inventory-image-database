import { describe, expect, it } from "vitest";
import {
  ALL_CATALOG_BRANCHES,
  availableCatalogBranches,
  catalogBranchLabel,
  readCatalogBranchId,
  resolveCatalogBranchId,
  writeCatalogBranchId,
} from "../src/lib/catalog-branch-scope.js";

const profile = {
  branch: { id: "branch-main", code: "MAIN", name: "Main", status: "active" },
  default_branch_id: "branch-main",
  can_view_all_branches: true,
  branches: [
    { id: "branch-main", code: "MAIN", name: "Main", status: "active", is_default: true },
    { id: "branch-two", code: "TWO", name: "Second", status: "active" },
    { id: "branch-closed", code: "OLD", name: "Closed", status: "closed" },
  ],
};

describe("Railway catalog branch scope", () => {
  it("keeps only active authorized branches and resolves stale storage safely", () => {
    expect(availableCatalogBranches(profile).map((branch) => branch.id))
      .toEqual(["branch-main", "branch-two"]);
    expect(resolveCatalogBranchId(profile, "missing")).toBe("branch-main");
    expect(resolveCatalogBranchId(profile, "branch-two")).toBe("branch-two");
  });

  it("allows the explicit all-branches scope only when the session grants it", () => {
    expect(resolveCatalogBranchId(profile, ALL_CATALOG_BRANCHES)).toBe(ALL_CATALOG_BRANCHES);
    expect(resolveCatalogBranchId({ ...profile, can_view_all_branches: false }, ALL_CATALOG_BRANCHES))
      .toBe("branch-main");
    expect(catalogBranchLabel(profile, ALL_CATALOG_BRANCHES)).toBe("All branches");
  });

  it("reads and writes the Railway API branch key", () => {
    const values = new Map([["selected_branch_id", "branch-two"]]);
    const storage = {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
    };
    expect(readCatalogBranchId(profile, storage)).toBe("branch-two");
    writeCatalogBranchId("branch-main", storage);
    expect(values.get("selected_branch_id")).toBe("branch-main");
  });
});
