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

const BAN_FOREVER = "876000h"; // ~100 years

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
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
    const { data: me } = await admin.from("profiles").select("role, can_manage_users").eq("id", caller.id).single();
    if (!me || !(me.can_manage_users || me.role === "admin")) return json({ error: "forbidden" }, 403);

    const { action, email, password, role, caps, user_id } = await req.json();

    if (action === "create") {
      if (!email || !password) return json({ error: "Email and a temporary password are required." }, 400);
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, // usable immediately, no email step
      });
      if (error) return json({ error: error.message }, 400);
      const id = created.user.id;
      const profile = {
        id, email, role: role || "viewer", active: true,
        can_upload: !!caps?.can_upload, can_edit: !!caps?.can_edit, can_delete: !!caps?.can_delete,
        can_view_cost: !!caps?.can_view_cost, can_manage_users: !!caps?.can_manage_users,
      };
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
    return json({ error: String(e?.message || e) }, 500);
  }
});
