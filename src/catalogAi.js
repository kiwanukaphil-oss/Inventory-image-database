/**
 * Catalog AI Adapter
 *
 * Routes every AI-fill entry point through the active catalog backend. Railway
 * owns inference and fill-empty persistence; the legacy path is retained only
 * for rollback builds during the approved observation window.
 */

import { supabase } from "./db.js";
import { requestRailwayCatalog } from "./railwayCatalogApi.js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";

/** Preserve useful rollback-provider errors without leaking response objects. */
function legacyEdgeErrorMessage(body, fallback = "") {
  if (!body || typeof body !== "object") return fallback;
  const detail = body.detail;
  const detailMessage =
    detail?.error?.message ||
    detail?.message ||
    (typeof detail === "string" ? detail : "");
  const status = body.anthropic_status ? ` (${body.anthropic_status})` : "";
  const attempts = body.attempts > 1 ? ` after ${body.attempts} attempts` : "";
  if (body.error && detailMessage) {
    return `${body.error}${status}: ${detailMessage}${attempts}`;
  }
  return body.error || detailMessage || fallback;
}

/**
 * Analyze one item through Railway, or through the rollback-only legacy Edge
 * Function when the build has not enabled Railway mode. Railway deliberately
 * ignores client field/category authority and applies only still-empty values.
 */
export async function extractCatalogItemWithAi({ itemId, category, fields, branchId }) {
  if (isRailwayCatalogMode) {
    const payload = await requestRailwayCatalog(
      `/catalog/items/${encodeURIComponent(itemId)}/ai-extract`,
      { method: "POST", body: { only_empty: true }, branchId }
    );
    return payload.data;
  }

  // CANDIDATE FOR REMOVAL: rollback-only provider after the Railway AI soak
  // window. Do not delete until production reconciliation is explicitly approved.
  const { data, error } = await supabase.functions.invoke("ai-extract", {
    body: { item_id: itemId, category, fields },
  });
  if (error) {
    let detail = error.message;
    try {
      const context = error.context?.clone ? error.context.clone() : error.context;
      detail = legacyEdgeErrorMessage(await context.json(), detail);
    } catch {}
    throw new Error(detail);
  }
  if (data?.error) throw new Error(legacyEdgeErrorMessage(data, data.error));
  return data;
}
