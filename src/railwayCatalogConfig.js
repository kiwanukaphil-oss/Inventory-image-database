/**
 * Railway Catalog Configuration
 *
 * Keeps the consolidated backend explicit. VITE_CATALOG_API_URL selects the
 * Railway POS API; an unset value exists only for rollback-window builds.
 */

const configuredApiUrl = String(import.meta.env.VITE_CATALOG_API_URL || "").trim();

export const isRailwayCatalogMode = Boolean(configuredApiUrl);
export const railwayCatalogApiUrl = configuredApiUrl.replace(/\/+$/, "");
export const railwayCatalogTokenKey = "kline.catalog.pos-token";
export const railwayCatalogUserKey = "kline.catalog.pos-user";
export const railwayCatalogBranchKey = "selected_branch_id";
