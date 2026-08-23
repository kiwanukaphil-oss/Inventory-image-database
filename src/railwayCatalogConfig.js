/**
 * Railway Catalog Configuration
 *
 * Keeps the migration adapter explicit: production remains on Supabase until
 * VITE_CATALOG_API_URL is deliberately supplied at build time.
 */

const configuredApiUrl = String(import.meta.env.VITE_CATALOG_API_URL || "").trim();

export const isRailwayCatalogMode = Boolean(configuredApiUrl);
export const railwayCatalogApiUrl = configuredApiUrl.replace(/\/+$/, "");
export const railwayCatalogTokenKey = "kline.catalog.pos-token";
export const railwayCatalogUserKey = "kline.catalog.pos-user";
export const railwayCatalogBranchKey = "selected_branch_id";
