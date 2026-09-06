/**
 * Railway Catalog API Client
 *
 * Responsible for authenticated JSON requests from the catalog PWA to the POS
 * API. Bucket and database credentials never enter this browser module.
 */

import {
  railwayCatalogApiUrl,
  railwayCatalogBranchKey,
  railwayCatalogTokenKey,
} from "./railwayCatalogConfig.js";

export class RailwayCatalogApiError extends Error {
  constructor(message, status, details, retryAfterMs = 0) {
    super(message);
    this.name = "RailwayCatalogApiError";
    this.status = status;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMilliseconds(headerValue) {
  if (!headerValue) return 0;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryTime = Date.parse(headerValue);
  return Number.isFinite(retryTime) ? Math.max(0, retryTime - Date.now()) : 0;
}

/**
 * Send a bounded JSON request using the POS JWT and selected branch. Callers can
 * disable auth only for login; all catalog endpoints use both headers.
 */
export async function requestRailwayCatalog(path, options = {}) {
  const { method = "GET", body, authenticated = true, branchId } = options;
  const headers = { Accept: "application/json" };
  const isMultipartBody = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isMultipartBody) headers["Content-Type"] = "application/json";

  if (authenticated) {
    const token = localStorage.getItem(railwayCatalogTokenKey);
    if (!token) throw new RailwayCatalogApiError("Authentication required.", 401);
    headers.Authorization = `Bearer ${token}`;
    const effectiveBranchId = branchId || localStorage.getItem(railwayCatalogBranchKey);
    if (effectiveBranchId) headers["X-Branch-Id"] = effectiveBranchId;
  }

  let response;
  try {
    response = await fetch(`${railwayCatalogApiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : isMultipartBody ? body : JSON.stringify(body),
    });
  } catch (error) {
    throw new RailwayCatalogApiError(
      error?.message || "Could not reach the catalog service.",
      0
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RailwayCatalogApiError(
      payload.message || `Catalog request failed (${response.status}).`,
      response.status,
      payload.details,
      retryAfterMilliseconds(response.headers.get("Retry-After"))
    );
  }
  return payload;
}
