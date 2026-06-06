import { supabase } from "./db.js";

// Thin auth layer over Supabase. The app uses email + password (simple, works
// offline-installed, no email-deliverability dependency for day-to-day login).
// Role information lives in the `profiles` table and is fetched after sign-in.

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export function onAuthChange(callback) {
  // Fires on initial load, sign-in, sign-out, and token refresh.
  // IMPORTANT: callers must NOT run awaited Supabase calls synchronously inside
  // this callback — supabase-js holds an auth lock during it, and doing so can
  // deadlock on session restore (blank screen on refresh). main.js defers its
  // work with setTimeout(…, 0) to release the lock first.
  return supabase.auth.onAuthStateChange((event, session) => callback(event, session));
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
// Derive capabilities from a role — used as a fallback when the capability
// columns don't exist yet (migration 0008 not applied), so access isn't lost.
function capsFromRole(role) {
  const elevated = role === "admin" || role === "editor";
  return {
    can_upload: elevated,
    can_edit: elevated,
    can_delete: role === "admin",
    can_view_cost: role === "admin",
    can_manage_users: role === "admin",
  };
}

export async function getMyProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Preferred: read explicit capabilities (after migration 0008).
  const full = await supabase
    .from("profiles")
    .select("id, email, role, can_upload, can_edit, can_delete, can_view_cost, can_manage_users")
    .eq("id", user.id)
    .single();
  if (!full.error && full.data) return full.data;

  // Fallback: capability columns missing → derive from role so admins/editors
  // aren't downgraded to viewer just because the migration hasn't run yet.
  const basic = await supabase.from("profiles").select("id, email, role").eq("id", user.id).single();
  const role = basic.data?.role || "viewer";
  return { id: user.id, email: user.email, role, ...capsFromRole(role) };
}
