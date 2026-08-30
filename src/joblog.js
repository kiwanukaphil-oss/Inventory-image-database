import { supabase } from "./db.js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";

const JOB_CHUNK = 80;
const JOB_CONCURRENCY = 4;

function messageOf(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

function chunks(values, size = JOB_CHUNK) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function mapConcurrent(values, limit, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const i = next++;
      await worker(values[i], i);
    }
  });
  await Promise.all(workers);
}

export function classifyJobError(err) {
  const msg = messageOf(err);
  const low = msg.toLowerCase();
  const isShop = low.includes("shop") || low.includes("pos") || low.includes("variant") || low.includes("product");
  if ((low.includes("not found") || low.includes("missing")) &&
      (low.includes("image") || low.includes("photo") || low.includes("storage") || low.includes("object"))) return "Missing image";
  if (low.includes("rate limit") || low.includes("rate-limit") || low.includes("too many") || low.includes("429") || low.includes("quota")) return "Rate limited";
  if (low.includes("timeout") || low.includes("timed out") || low.includes("aborted")) return "Timeout";
  if (low.includes("overload") || low.includes("busy") || low.includes("529")) return "AI service busy";
  if (low.includes("network") || low.includes("fetch") || low.includes("offline") || low.includes("connection")) return "Network offline";
  if (low.includes("permission") || low.includes("jwt") || low.includes("unauthorized") || low.includes("forbidden") || low.includes("rls")) return "Permission denied";
  if (isShop && (low.includes("reject") || low.includes("invalid") || low.includes("validation") || low.includes("422"))) return "Shop rejected item";
  if (isShop && (low.includes("service") || low.includes("503") || low.includes("502") || low.includes("500"))) return "Shop service unavailable";
  if (low.includes("edge function") || low.includes("non-2xx") || low.includes("503") || low.includes("502") || low.includes("500")) return "Service unavailable";
  if (low.includes("image") || low.includes("photo") || low.includes("vision") || low.includes("read") || low.includes("parse")) return "AI could not read photo";
  return "Unknown technical error";
}

const ERROR_HELP = {
  "AI service busy": "Retry shortly; the AI provider is overloaded.",
  "AI could not read photo": "Retake or crop the photo, then retry AI fill.",
  "Missing image": "The item photo is missing. Re-upload the photo before retrying.",
  "Network offline": "Reconnect and retry the job.",
  "Permission denied": "Use an editor or admin account, or check permissions.",
  "Rate limited": "Wait a short while, then retry fewer items.",
  "Timeout": "Retry the job; if it repeats, use a smaller batch.",
  "Service unavailable": "Retry later; the server or edge function did not complete.",
  "Shop rejected item": "Fix the item details, price, SKU, or stock, then retry shop sync.",
  "Shop service unavailable": "Retry when the POS service is reachable.",
  "Unknown technical error": "Retry once; if it repeats, inspect the technical detail.",
};

export function jobErrorHelp(category) {
  return ERROR_HELP[category] || ERROR_HELP["Unknown technical error"];
}

export async function recordItemJobFailure(itemId, jobType, err, attemptCount = 1) {
  if (!itemId) return;
  // Railway records the complete provider attempt and outcome server-side. The
  // browser ledger below exists only for rollback builds using the legacy DB.
  if (isRailwayCatalogMode) return;
  const error_message = messageOf(err).slice(0, 1000);
  const error_category = classifyJobError(err);
  try {
    await supabase.from("item_jobs").insert({
      item_id: itemId,
      job_type: jobType,
      status: "failed",
      error_category,
      error_message,
      attempt_count: attemptCount,
    });
  } catch {
    // The app may be running before the migration is applied; never let logging
    // failure break the user's actual workflow.
  }
}

export async function clearItemJobFailures(itemId, jobType) {
  if (!itemId) return;
  if (isRailwayCatalogMode) return;
  try {
    await supabase
      .from("item_jobs")
      .update({ status: "succeeded" })
      .eq("item_id", itemId)
      .eq("job_type", jobType)
      .eq("status", "failed");
  } catch {}
}

export async function loadLatestFailedJobs(itemIds, jobType) {
  if (isRailwayCatalogMode) return new Map();
  const ids = [...new Set(itemIds || [])].filter(Boolean);
  if (!ids.length) return new Map();
  try {
    const rows = [];
    await mapConcurrent(chunks(ids), JOB_CONCURRENCY, async (chunk) => {
      const { data, error } = await supabase
        .from("item_jobs")
        .select("id,item_id,job_type,status,error_category,error_message,attempt_count,updated_at")
        .eq("job_type", jobType)
        .eq("status", "failed")
        .in("item_id", chunk)
        .order("updated_at", { ascending: false });
      if (error) return;
      rows.push(...(data || []));
    });
    rows.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    const byItem = new Map();
    for (const row of rows) {
      if (!byItem.has(row.item_id)) byItem.set(row.item_id, row);
    }
    return byItem;
  } catch {
    return new Map();
  }
}
