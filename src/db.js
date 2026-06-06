import { createClient } from "@supabase/supabase-js";

// Read the public Supabase credentials injected at build time by Vite.
// These are intentionally client-visible; database Row Level Security is what
// actually protects the data (see supabase/migrations).
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Surface a clear error early rather than letting createClient fail cryptically
// when the .env file (or GitHub Actions secrets) were not configured.
export const isConfigured = Boolean(url && anonKey && !url.includes("YOUR-PROJECT"));

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
