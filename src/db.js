import { isRailwayCatalogConfigured } from "./railwayCatalogConfig.js";

// CANDIDATE FOR REMOVAL: legacy source modules still import this compatibility
// name while they are retained as rollback evidence. It is intentionally local
// and incapable of creating a network client. Any accidental legacy path fails
// closed instead of contacting the retired provider.
const retiredProviderError = () => {
  throw new Error("The legacy catalog provider is retired. Use the Railway API.");
};

export const isSupabaseConfigured = false;
export const isConfigured = isRailwayCatalogConfigured;
export const supabase = new Proxy({}, { get: retiredProviderError });
