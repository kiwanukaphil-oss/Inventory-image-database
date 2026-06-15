import { supabase } from "./db.js";

function messageOf(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

export function classifyJobError(err) {
  const msg = messageOf(err);
  const low = msg.toLowerCase();
  if (low.includes("overload") || low.includes("busy") || low.includes("529")) return "AI service busy";
  if (low.includes("network") || low.includes("fetch") || low.includes("offline")) return "Network";
  if (low.includes("permission") || low.includes("jwt") || low.includes("unauthorized")) return "Permission";
  if (low.includes("image") || low.includes("photo") || low.includes("vision")) return "Photo unreadable";
  return "Unknown";
}

export async function recordItemJobFailure(itemId, jobType, err, attemptCount = 1) {
  if (!itemId) return;
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
  if (!itemIds?.length) return new Map();
  try {
    const { data, error } = await supabase
      .from("item_jobs")
      .select("id,item_id,job_type,status,error_category,error_message,attempt_count,updated_at")
      .eq("job_type", jobType)
      .eq("status", "failed")
      .in("item_id", itemIds)
      .order("updated_at", { ascending: false });
    if (error) return new Map();
    const byItem = new Map();
    for (const row of data || []) {
      if (!byItem.has(row.item_id)) byItem.set(row.item_id, row);
    }
    return byItem;
  } catch {
    return new Map();
  }
}
