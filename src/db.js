import { createClient } from "@supabase/supabase-js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";

// CANDIDATE FOR REMOVAL: legacy rollback client retained through the Railway
// observation window. New production capabilities must use the POS API.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Surface a clear error early rather than letting createClient fail cryptically
// when the .env file (or GitHub Actions secrets) were not configured.
export const isSupabaseConfigured = Boolean(url && anonKey && !url.includes("YOUR-PROJECT"));
export const isConfigured = isRailwayCatalogMode || isSupabaseConfigured;

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
