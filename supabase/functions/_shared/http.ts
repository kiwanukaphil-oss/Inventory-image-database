// @ts-nocheck — Deno (Supabase Edge runtime).
// Shared HTTP helpers for all edge functions: an ORIGIN-ALLOWLISTED CORS header
// set (replaces the old wildcard `*` that sat on admin + paid endpoints — audit
// S5) and a JSON responder.
//
// Configure ALLOWED_ORIGINS as a comma-separated list (e.g.
// "https://klinemen-catalog.com,http://localhost:5173"). Defaults to the
// production PWA origin if unset. Requests with no Origin header (cron / direct
// invoke-key callers) are unaffected — CORS is a browser-only control.

const DEFAULT_ALLOWED = "https://klinemen-catalog.com";

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || DEFAULT_ALLOWED)
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  // Reflect the caller's origin only when it is explicitly allowlisted. A
  // literal "*" entry opts back into wildcard (not recommended for these
  // privileged endpoints).
  if (allowed.includes("*")) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export const makeJson = (cors: Record<string, string>) =>
  (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
