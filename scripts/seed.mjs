// ============================================================================
//  Seed importer — one-time load of the existing pants catalogue into Supabase.
//
//  For each row in pants_products.xlsx "Image map": resolve its photo on disk,
//  compress it to WebP, upload to the product-images Storage bucket, and insert
//  an `items` row under the right pant-type subcategory (brand -> column;
//  colour/size/style/material -> attributes). Cost (from the Variants sheet) is
//  written to the admin-only item_costs table.
//
//  Run with:  npm run seed
//  Requires .env to contain VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
//  (The service-role key is a TRUSTED key for this local admin script only — it
//  bypasses RLS so the import can write costs/storage. It is never shipped to
//  the browser and lives only in your gitignored .env.)
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx"; // SheetJS is CommonJS; default import exposes readFile/utils
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || SERVICE_KEY.includes("PASTE_YOUR")) {
  console.error(
    "Missing env. Ensure .env has VITE_SUPABASE_URL and a real " +
      "SUPABASE_SERVICE_ROLE_KEY (Supabase -> Project Settings -> API keys -> service_role)."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "product-images";
const XLSX_PATH = join(ROOT, "pants_products.xlsx");

// Map each image folder on disk to its pant-type subcategory slug.
const FOLDER_TO_SLUG = {
  "Cargo Pants": "pants-cargo",
  Khaki: "pants-khaki",
  Formal_pants: "pants-formal",
  Linen: "pants-linen",
  Flat_front: "pants-flat-front",
  "Relaxed_Draw string": "pants-relaxed",
};

const CONCURRENCY = 5; // parallel image jobs; modest to avoid rate limits

/** Build filename -> { folder, slug, fullpath } by scanning the image folders. */
function buildImageIndex() {
  const index = {};
  for (const [folder, slug] of Object.entries(FOLDER_TO_SLUG)) {
    const dir = join(ROOT, folder);
    if (!existsSync(dir)) {
      console.warn(`  (folder not found, skipping: ${folder})`);
      continue;
    }
    for (const fn of readdirSync(dir)) {
      if (/\.(jpe?g|png|webp)$/i.test(fn)) {
        index[fn] = { folder, slug, fullpath: join(dir, fn) };
      }
    }
  }
  return index;
}

/** Read an xlsx sheet into an array of row objects keyed by header. */
function readSheet(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet not found: ${name}`);
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

const s = (v) => (v === null || v === undefined ? "" : String(v).trim());

async function main() {
  if (!existsSync(XLSX_PATH)) {
    console.error(`Spreadsheet not found at ${XLSX_PATH}`);
    process.exit(1);
  }

  // 1. Resolve category ids for the pant-type subcategories.
  const slugs = Object.values(FOLDER_TO_SLUG);
  const { data: cats, error: catErr } = await supabase
    .from("categories")
    .select("id, slug")
    .in("slug", slugs);
  if (catErr) throw catErr;
  const slugToId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const missing = slugs.filter((sl) => !slugToId[sl]);
  if (missing.length) {
    console.error(
      `Missing categories: ${missing.join(", ")}. Run migration 0004 first.`
    );
    process.exit(1);
  }

  // 2. Load the spreadsheet: Image map (per photo) + Variants (price/cost/stock).
  const wb = XLSX.readFile(XLSX_PATH);
  const imageMap = readSheet(wb, "Image map");
  const variants = readSheet(wb, "Variants");
  const variantBySku = Object.fromEntries(
    variants.filter((v) => v.sku).map((v) => [String(v.sku), v])
  );

  // 3. Index images on disk.
  const imageIndex = buildImageIndex();

  // 4. Skip rows already seeded (idempotent re-runs), keyed by original_filename.
  const { data: existing } = await supabase
    .from("items")
    .select("original_filename");
  const seen = new Set((existing || []).map((r) => r.original_filename));

  // Build the work list, flagging unresolved images.
  const jobs = [];
  let unresolved = 0;
  for (const row of imageMap) {
    const fn = s(row.image_file);
    if (!fn) continue;
    if (seen.has(fn)) continue; // already imported
    const img = imageIndex[fn];
    if (!img) {
      unresolved++;
      console.warn(`  ! no image on disk for: ${fn}`);
      continue;
    }
    jobs.push({ row, fn, img });
  }

  console.log(
    `Image map rows: ${imageMap.length} | to import: ${jobs.length} | ` +
      `already seeded: ${seen.size} | unresolved: ${unresolved}`
  );
  if (!jobs.length) {
    console.log("Nothing to import. Done.");
    return;
  }

  // 5. Process with limited concurrency.
  let done = 0;
  let failed = 0;
  async function processJob({ row, fn, img }) {
    try {
      const id = randomUUID();
      const objectPath = `${img.slug}/${id}.webp`;

      // Compress to WebP (longest edge 1280, quality 80) for fast mobile loads.
      const webp = await sharp(readFileSync(img.fullpath))
        .rotate() // honour EXIF orientation
        .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      const up = await supabase.storage
        .from(BUCKET)
        .upload(objectPath, webp, { contentType: "image/webp", upsert: true });
      if (up.error) throw up.error;

      // Category-specific fields go into attributes; drop blanks.
      const attributes = {};
      for (const [k, v] of Object.entries({
        color: s(row.color),
        size: s(row.size),
        style: s(row.style),
        material: s(row.material),
      })) {
        if (v) attributes[k] = v;
      }

      const variant = variantBySku[s(row.variant_sku)] || {};
      const itemRow = {
        id,
        category_id: slugToId[img.slug],
        brand: s(row.brand) || null,
        sku: s(row.variant_sku) || null,
        price: variant.price ?? null,
        stock_quantity: variant.stock_quantity ?? null,
        reorder_level: variant.reorder_level ?? null,
        status: "needs-review",
        image_path: objectPath,
        original_filename: fn,
        attributes,
        confidence: {},
      };

      const ins = await supabase.from("items").insert(itemRow);
      if (ins.error) throw ins.error;

      // Cost -> admin-only table (only when present).
      if (variant.cost_price !== null && variant.cost_price !== undefined) {
        const c = await supabase
          .from("item_costs")
          .insert({ item_id: id, cost_price: variant.cost_price });
        if (c.error) throw c.error;
      }

      done++;
      if (done % 20 === 0 || done === jobs.length) {
        console.log(`  ...${done}/${jobs.length} imported`);
      }
    } catch (err) {
      failed++;
      console.error(`  x failed ${fn}: ${err.message || err}`);
    }
  }

  // Simple concurrency pool.
  const queue = [...jobs];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await processJob(queue.shift());
  });
  await Promise.all(workers);

  console.log(`\nDone. Imported ${done}, failed ${failed}, unresolved ${unresolved}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
