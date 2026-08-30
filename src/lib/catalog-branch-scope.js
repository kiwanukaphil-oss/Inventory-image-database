import { railwayCatalogBranchKey } from "../railwayCatalogConfig.js";

export const ALL_CATALOG_BRANCHES = "all";

/** Return the active branches the authenticated Railway session may use. */
export function availableCatalogBranches(profile = {}) {
  const branchSource = profile.branches?.length
    ? profile.branches
    : profile.branch?.id ? [profile.branch] : [];
  return branchSource
    .filter((branch) => branch?.id && branch.status === "active")
    .map((branch) => ({
      id: branch.id,
      code: branch.code || "Branch",
      name: branch.name || branch.code || "Branch",
      is_default: branch.is_default === true,
      is_user_default: branch.is_user_default === true,
      can_switch_to: branch.can_switch_to !== false,
    }));
}

/** Resolve stale/missing browser state to an authorized, deterministic scope. */
export function resolveCatalogBranchId(profile = {}, storedBranchId = "") {
  const branches = availableCatalogBranches(profile);
  if (
    storedBranchId === ALL_CATALOG_BRANCHES &&
    profile.can_view_all_branches &&
    branches.length > 0
  ) {
    return ALL_CATALOG_BRANCHES;
  }
  if (branches.some((branch) => branch.id === storedBranchId)) return storedBranchId;
  if (branches.some((branch) => branch.id === profile.branch?.id)) return profile.branch.id;
  if (branches.some((branch) => branch.id === profile.default_branch_id)) {
    return profile.default_branch_id;
  }
  return branches.find((branch) => branch.is_user_default)?.id ||
    branches.find((branch) => branch.is_default)?.id ||
    branches[0]?.id ||
    "";
}

/** Read and validate the current Railway scope without exposing auth storage. */
export function readCatalogBranchId(profile = {}, storage = globalThis.localStorage) {
  let storedBranchId = "";
  try { storedBranchId = storage?.getItem(railwayCatalogBranchKey) || ""; } catch {}
  return resolveCatalogBranchId(profile, storedBranchId);
}

export function writeCatalogBranchId(branchId, storage = globalThis.localStorage) {
  try {
    storage?.setItem(railwayCatalogBranchKey, branchId || "");
    globalThis.dispatchEvent?.(new CustomEvent("kline:catalog-branch-changed", {
      detail: { branchId: branchId || "" },
    }));
  } catch {}
}

export function catalogBranchLabel(profile = {}, branchId = "") {
  if (branchId === ALL_CATALOG_BRANCHES) return "All branches";
  return availableCatalogBranches(profile).find((branch) => branch.id === branchId)?.code || "Branch";
}

export const isAllCatalogBranches = (branchId) => branchId === ALL_CATALOG_BRANCHES;
