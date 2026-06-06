import { supabase } from "./db.js";

// Thin auth layer over Supabase. The app uses email + password (simple, works
// offline-installed, no email-deliverability dependency for day-to-day login).
// Role information lives in the `profiles` table and is fetched after sign-in.

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export function onAuthChange(callback) {
  // Fires on sign-in, sign-out, and token refresh so the UI can re-render.
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

/**
 * Fetch the signed-in user's role from the profiles table.
 * Defaults to 'viewer' if no profile row is found yet, so a brand-new user
 * never accidentally gets elevated access before an admin assigns a role.
 */
export async function getMyProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, role")
    .eq("id", user.id)
    .single();
  if (error || !data) return { id: user.id, email: user.email, role: "viewer" };
  return data;
}
