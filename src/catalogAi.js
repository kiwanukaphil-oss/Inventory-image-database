/**
 * Catalog AI Adapter
 *
 * Routes every AI-fill entry point through the Railway catalog backend, which
 * owns inference and fill-empty persistence.
 */

import { requestRailwayCatalog } from "./railwayCatalogApi.js";

/**
 * Analyze one item through Railway. The server deliberately ignores client
 * field/category authority and applies only still-empty values.
 */
export async function extractCatalogItemWithAi({ itemId, branchId }) {
  const payload = await requestRailwayCatalog(
    `/catalog/items/${encodeURIComponent(itemId)}/ai-extract`,
    { method: "POST", body: { only_empty: true }, branchId }
  );
  return payload.data;
}
