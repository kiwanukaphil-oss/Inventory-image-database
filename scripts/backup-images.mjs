// ============================================================================
//  Product-image backup — incremental copy of the product-images Storage
//  bucket to a local folder (default: inside OneDrive, so the backup gets an
//  automatic offsite copy via OneDrive sync).
//
//  Supabase's daily database backups do NOT include Storage objects, only
//  their metadata — this script is what actually preserves the photos.
//  With the one-photo-one-unit stock rule, every image is a business record.
//
//  Behaviour:
//    - Downloads only objects that are missing locally or whose size changed.
//    - NEVER deletes local files: an image removed from the bucket stays in
//      the backup (append-only, matches the audit-over-efficiency posture).
//    - Appends a one-line summary per run to backup.log in the destination.
//
//  Run with:  npm run backup:images        (uses production .env.prod.local)
//  Override destination with IMAGE_BACKUP_DIR in the environment.
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, existsSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env. Run via `npm run backup:images` so .env.prod.local is loaded.");
  process.exit(1);
}

const BUCKET = "product-images";
const BACKUP_ROOT =
  process.env.IMAGE_BACKUP_DIR ||
  join(process.env.USERPROFILE || process.env.HOME, "OneDrive", "Backups", "klinemen-product-images");
const LIST_PAGE_SIZE = 1000;
const DOWNLOAD_CONCURRENCY = 5; // modest parallelism to stay clear of rate limits

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/**
 * Recursively walk the bucket and return every object as { path, size }.
 * Storage's list() is per-folder and paginated, so each folder is drained
 * page by page; entries without an id are subfolders and are descended into.
 */
async function listAllBucketObjects(prefix = "") {
  const objects = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: LIST_PAGE_SIZE, offset });
    if (error) throw new Error(`list("${prefix}") failed: ${error.message}`);
    if (!data?.length) break;
    for (const entry of data) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        objects.push(...(await listAllBucketObjects(entryPath)));
      } else {
        objects.push({ path: entryPath, size: entry.metadata?.size ?? null });
      }
    }
    if (data.length < LIST_PAGE_SIZE) break;
  }
  return objects;
}

/** An object needs downloading if it's absent locally or its byte size differs. */
function isMissingOrChanged(obj) {
  const localPath = join(BACKUP_ROOT, obj.path);
  if (!existsSync(localPath)) return true;
  if (obj.size !== null && statSync(localPath).size !== obj.size) return true;
  return false;
}

/** Download one object and write it under BACKUP_ROOT, creating folders as needed. */
async function downloadObjectToBackup(obj) {
  const { data, error } = await supabase.storage.from(BUCKET).download(obj.path);
  if (error) throw new Error(`download("${obj.path}") failed: ${error.message}`);
  const localPath = join(BACKUP_ROOT, obj.path);
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
}

/**
 * Run the whole backup: inventory the bucket, pick out missing/changed
 * objects, download them with bounded concurrency, and log the outcome.
 * Exits non-zero if any download failed so a scheduler can flag the run.
 */
async function runIncrementalBackup() {
  const startedAt = new Date().toISOString();
  mkdirSync(BACKUP_ROOT, { recursive: true });

  const objects = await listAllBucketObjects();
  const pending = objects.filter(isMissingOrChanged);
  console.log(`Bucket has ${objects.length} objects; ${pending.length} to download.`);

  let downloaded = 0;
  const failures = [];
  const queue = [...pending];
  async function downloadWorker() {
    for (let obj = queue.shift(); obj; obj = queue.shift()) {
      try {
        await downloadObjectToBackup(obj);
        downloaded++;
      } catch (err) {
        failures.push(`${obj.path}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, downloadWorker));

  const summary =
    `${startedAt} bucket=${objects.length} downloaded=${downloaded} ` +
    `failed=${failures.length} dest=${BACKUP_ROOT}`;
  appendFileSync(join(BACKUP_ROOT, "backup.log"), summary + "\n");
  console.log(summary);
  if (failures.length) {
    console.error("Failed objects:\n" + failures.join("\n"));
    process.exit(1);
  }
}

await runIncrementalBackup();
