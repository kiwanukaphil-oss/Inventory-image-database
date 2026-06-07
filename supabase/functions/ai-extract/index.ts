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

// Default to Opus for the most reliable reads of small/stylised product text.
// Override with the ANTHROPIC_MODEL secret to economise at volume
// (claude-sonnet-4-6 ~half the cost; claude-haiku-4-5 cheapest).
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-4-8";

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
          visible_text: { type: "string", description: "Every piece of text you can read in the image, transcribed verbatim." },
          values: { type: "object", properties: valueProps },
          confidence: { type: "object", properties: confProps },
        },
        required: ["values"],
      },
    };

    const fieldList = fields.map((f: any) => `${f.label} (${f.key})`).join(", ");
    const prompt =
      `This is a photo of a retail product (category: "${category}"). ` +
      `Carefully read EVERY piece of visible text — on the box, bottle, tags, labels and any handwriting.\n` +
      `Step 1: transcribe all of that text verbatim into "visible_text".\n` +
      `Step 2: using only what you read, fill "values": brand, ${fieldList}.\n` +
      `Guidance:\n` +
      `- brand: the maker/brand exactly as printed; keep look-alike/knock-off names as printed (do NOT normalise toward a famous brand).\n` +
      `- name (Product name): the product's FULL name as printed, INCLUDING any variant/flanker — ` +
      `e.g. "Polo Red", "Stronger With You Intensely", "Sauvage Elixir", "Diamonds". ` +
      `It is usually the largest text after the brand; read it in full. Omit only for generic garments with no model name.\n` +
      `- For fragrances the brand, product name, concentration (EDT/EDP/Parfum) and size (in ml) are almost always clearly printed — read and fill them.\n` +
      `- scent_family is a CLASSIFICATION that is NOT printed on the box (e.g. Woody, Amber/Oriental, ` +
      `Fresh, Citrus, Aromatic/Fougère, Floral, Gourmand, Leather, Chypre, Aquatic). Once you've ` +
      `identified the exact fragrance from its brand + product name, infer its scent family from your ` +
      `general knowledge of that fragrance. If you don't recognise the specific fragrance, leave it ` +
      `blank — do not guess. Mark any inferred scent_family as Medium or Low confidence.\n` +
      `- COLOUR CAPTION OVERRIDE: if the image has a caption, overlay, sticker or handwritten note stating a COLOUR, that stated colour is authoritative — use it for the colour field even if the item looks like a different colour in the photo.\n` +
      `- PHOTOGRAPHER'S NOTE: a small paper/note is sometimes placed in the shot listing extra details (e.g. material, fit, size, composition) for things not obvious on the tag — read it and use those details to fill the matching fields.\n` +
      `- OTHER LANGUAGES: tags are often partly or fully in another language (commonly Chinese). Read and translate them, and extract any useful details (material, size, composition, care, etc.) the photographer may have overlooked. Keep the original text in visible_text and put the interpreted English value in the field.\n` +
      `- If a field genuinely cannot be determined, OMIT it entirely — do NOT output placeholder values ` +
      `like "unknown", "n/a", "none", "unspecified" or "-". Leaving it out is correct. Use Low confidence ` +
      `only for values you do provide but are unsure of.\n` +
      `- Treat stylised logos as lower confidence. Give per-field confidence High / Medium / Low. Call record_fields.`;

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

    // Drop placeholder/empty values so they stay BLANK (keeps "fill empty" usable).
    const PLACEHOLDER = new Set([
      "", "unknown", "n/a", "na", "none", "null", "-", "--", "n.a.",
      "not visible", "not specified", "not shown", "unspecified", "unknown brand",
    ]);
    const cleanValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.values || {})) {
      if (v === null || v === undefined) continue;
      if (PLACEHOLDER.has(String(v).trim().toLowerCase())) continue;
      cleanValues[k] = v;
    }
    return json({ values: cleanValues, confidence: result.confidence || {}, usage: data.usage });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
