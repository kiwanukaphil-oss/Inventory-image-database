// @ts-nocheck — This runs on Deno (Supabase Edge runtime), not Node. URL imports
// and the global `Deno` object are valid there; VS Code's Node TypeScript server
// flags them as errors, so type-checking is disabled for this file. It deploys
// and runs correctly as written.
// =============================================================================
// ai-extract — Supabase Edge Function (Deno)
//
// Reads a product photo with Claude (vision) and returns suggested field values
// + per-field confidence for the user to confirm. The Anthropic API key lives
// ONLY here (set as the ANTHROPIC_API_KEY secret) and never reaches the browser.
//
// Request (POST, with the caller's Supabase JWT in Authorization):
//   { item_id: string, category: string,
//     fields: [{ key, label, type?, options? }] }
// Response:
//   { values: { brand?, <key>?: ... }, confidence: { <key>: "High"|"Medium"|"Low" } }
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected by
// the platform automatically. Only ANTHROPIC_API_KEY must be set by you.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MODEL = "claude-haiku-4-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

  try {
    // --- verify the caller and require editor/admin role ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: profile } = await admin
      .from("profiles").select("role").eq("id", user.id).single();
    if (!profile || !["editor", "admin"].includes(profile.role)) {
      return json({ error: "forbidden" }, 403);
    }

    // --- inputs ---
    const { item_id, category, fields } = await req.json();
    if (!item_id || !Array.isArray(fields)) return json({ error: "bad request" }, 400);

    const { data: item } = await admin
      .from("items").select("image_path").eq("id", item_id).single();
    if (!item?.image_path) return json({ error: "item has no image" }, 400);

    // Short-lived signed URL so Claude can fetch the private image.
    const { data: signed } = await admin.storage
      .from("product-images").createSignedUrl(item.image_path, 600);
    if (!signed?.signedUrl) return json({ error: "could not sign image url" }, 500);

    // --- build the forced-JSON tool schema from the category's fields ---
    const valueProps: Record<string, unknown> = {
      brand: { type: "string", description: "Brand exactly as printed on the tag" },
    };
    const confProps: Record<string, unknown> = {
      brand: { type: "string", enum: ["High", "Medium", "Low"] },
    };
    for (const f of fields) {
      if (f.key === "brand") continue;
      valueProps[f.key] =
        Array.isArray(f.options) && f.options.length
          ? { type: "string", enum: f.options, description: f.label }
          : { type: "string", description: f.label };
      confProps[f.key] = { type: "string", enum: ["High", "Medium", "Low"] };
    }

    const tool = {
      name: "record_fields",
      description: "Record the product fields read from the image, with per-field confidence.",
      input_schema: {
        type: "object",
        properties: {
          values: { type: "object", properties: valueProps },
          confidence: { type: "object", properties: confProps },
        },
        required: ["values"],
      },
    };

    const fieldList = fields.map((f: any) => `${f.label} (${f.key})`).join(", ");
    const prompt =
      `This is a photo of a men's retail product in the category "${category}". ` +
      `Read the visible tags, care labels, printed text, and any handwriting, and extract: ` +
      `brand, ${fieldList}. Rules:\n` +
      `- Use the brand name EXACTLY as printed on the tag. Keep look-alike/knock-off names as printed; ` +
      `do NOT normalise toward a famous brand.\n` +
      `- Treat stylised brand logos (not printed text) as Low confidence.\n` +
      `- If the garment shows an overlay/handwritten colour caption, that colour wins.\n` +
      `- Only report a field if you can actually see it; omit fields you cannot determine. ` +
      `Prefer omitting over guessing.\n` +
      `- Give per-field confidence: High / Medium / Low. Call record_fields with the result.`;

    // --- call Claude ---
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [tool],
        tool_choice: { type: "tool", name: "record_fields" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: signed.signedUrl } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: "anthropic error", detail: data }, 502);

    const toolUse = (data.content || []).find((b: any) => b.type === "tool_use");
    const result = toolUse?.input ?? { values: {}, confidence: {} };
    return json({ values: result.values || {}, confidence: result.confidence || {}, usage: data.usage });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
