// @ts-nocheck — Runs on Deno (Supabase Edge runtime), not Node. URL imports and
// the global `Deno` object are valid there; VS Code's Node TS server flags them.
// =============================================================================
// manage-users — Supabase Edge Function (Deno)
//
// Lets a "Manage users" admin create accounts and deactivate/reactivate them
// from inside the app. Uses the service-role key (SERVER-SIDE ONLY) to call the
// Auth Admin API. The caller's JWT is verified and required to have
// can_manage_users (or role=admin) before anything happens.
//
// Actions (POST body):
//   { action: "create",     email, password, role, caps:{...} }
//   { action: "deactivate", user_id }
//   { action: "reactivate", user_id }
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected by
// the platform automatically — no secrets to set for this function.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Self-contained for direct Supabase-dashboard deploy (no CLI bundling of
// _shared). Origin-allowlisted CORS (audit S5): set ALLOWED_ORIGINS to add origins.
const DEFAULT_ALLOWED = "https://klinemen-catalog.com";
function isLocalDevOrigin(origin) {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
    if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
    const m = hostname.match(/^172\.(\d+)\./);
    return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
  } catch {
    return false;
  }
}
function corsHeaders(req) {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || DEFAULT_ALLOWED).split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowed.includes("*")) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && (allowed.includes(origin) || isLocalDevOrigin(origin))) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
const makeJson = (cors) => (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const BAN_FOREVER = "876000h"; // ~100 years
const ALLOWED_ROLES = ["admin", "editor", "viewer", "custom"];
const GRANTABLE_CAPS = ["can_upload", "can_edit", "can_delete", "can_view_cost", "can_manage_users"];

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  const json = makeJson(cors);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  try {
    // --- verify the caller and require "Manage users" ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    const caller = userData?.user;
    if (!caller) return json({ error: "unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: me } = await admin.from("profiles")
      .select("role, can_upload, can_edit, can_delete, can_view_cost, can_manage_users")
      .eq("id", caller.id).maybeSingle();
    if (!me || !(me.can_manage_users || me.role === "admin")) return json({ error: "forbidden" }, 403);
    const callerIsAdmin = me.role === "admin";

    const { action, email, password, role, caps, user_id } = await req.json();

    if (action === "create") {
      // Validate inputs (audit S2): real email + a non-trivial password.
      const emailOk = typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
      if (!emailOk) return json({ error: "A valid email is required." }, 400);
      if (typeof password !== "string" || password.length < 12) {
        return json({ error: "Temporary password must be at least 12 characters." }, 400);
      }

      const wantRole = ALLOWED_ROLES.includes(role) ? role : "viewer";
      const wantCaps = {
        can_upload: !!caps?.can_upload, can_edit: !!caps?.can_edit, can_delete: !!caps?.can_delete,
        can_view_cost: !!caps?.can_view_cost, can_manage_users: !!caps?.can_manage_users,
      };

      // Privilege-amplification guard: a non-admin user-manager may not mint an
      // admin/manager, may not grant cost access, and may not grant any
      // capability they do not themselves hold (audit S2).
      if (!callerIsAdmin) {
        if (wantRole === "admin" || wantCaps.can_manage_users || wantCaps.can_view_cost) {
          return json({ error: "Only an admin can create admins or grant cost / user-management access." }, 403);
        }
        for (const cap of GRANTABLE_CAPS) {
          if (wantCaps[cap] && !me[cap]) return json({ error: `You cannot grant ${cap}, which you don't have.` }, 403);
        }
      }

      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, // usable immediately, no email step
      });
      if (error) return json({ error: error.message }, 400);
      const id = created.user.id;
      const profile = { id, email, role: wantRole, active: true, ...wantCaps };
      const { error: pErr } = await admin.from("profiles").upsert(profile, { onConflict: "id" });
      if (pErr) return json({ error: pErr.message }, 400);
      return json({ ok: true, id });
    }

    if (action === "deactivate" || action === "reactivate") {
      if (!user_id) return json({ error: "user_id required" }, 400);
      if (user_id === caller.id) return json({ error: "You can't change your own account status." }, 400);
      const ban = action === "deactivate";
      const { error } = await admin.auth.admin.updateUserById(user_id, { ban_duration: ban ? BAN_FOREVER : "none" });
      if (error) return json({ error: error.message }, 400);
      await admin.from("profiles").update({ active: !ban }).eq("id", user_id);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("manage-users error", String(e?.stack || e)); // detail server-side only (S11)
    return json({ error: "internal error" }, 500);
  }
});
