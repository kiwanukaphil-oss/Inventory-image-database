// @ts-nocheck — Deno (Supabase Edge runtime).
// Shared authorization for the POS sync functions (pos-push / pos-mirror /
// pos-reconcile), which are deployed --no-verify-jwt and therefore must do their
// OWN auth. Resolves audit S4: replaces the non-constant-time `===` secret
// comparison and fails CLOSED when secrets are misconfigured.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Constant-time comparison: SHA-256 both inputs (equal-length 32-byte digests, so
// no early exit leaks length/prefix), then XOR-accumulate. Async because
// crypto.subtle.digest is async.
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * Authorize a caller of a POS sync function. Accepts, in order:
 *   1. the exact service-role key,
 *   2. the dedicated MIRROR_INVOKE_KEY (what cron sends),
 *   3. a signed-in admin / user-manager (the "Sync now" button).
 * Returns { ok: true } or { status, error } to return verbatim.
 *
 * Fails closed: if SERVICE_KEY is missing the function refuses to run; a weak
 * (<32 char) invoke key is allowed but logged so it can be rotated.
 */
export async function authorizePosCaller(
  req: Request,
  env: { SUPABASE_URL: string; SERVICE_KEY: string; ANON_KEY: string },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { SUPABASE_URL, SERVICE_KEY, ANON_KEY } = env;
  if (!SERVICE_KEY || SERVICE_KEY.length < 20) {
    return { ok: false, status: 500, error: "server auth not configured" };
  }
  const invokeKey = Deno.env.get("MIRROR_INVOKE_KEY") || "";
  if (invokeKey && invokeKey.length < 32) {
    console.warn("MIRROR_INVOKE_KEY is shorter than 32 chars — rotate to a stronger value.");
  }

  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer) {
    if (await timingSafeEqual(bearer, SERVICE_KEY)) return { ok: true };
    if (invokeKey && (await timingSafeEqual(bearer, invokeKey))) return { ok: true };
  }

  // Fall back to a signed-in admin / user-manager. Never trust decoded JWT
  // claims here (gateway is not verifying the token for these functions).
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return { ok: false, status: 401, error: "unauthorized" };

  const adminCheck = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: me } = await adminCheck
    .from("profiles").select("role, can_manage_users").eq("id", userData.user.id).maybeSingle();
  if (!me || !(me.can_manage_users || me.role === "admin")) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true };
}
