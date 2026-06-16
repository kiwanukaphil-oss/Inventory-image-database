import { supabase } from "./db.js";

// Single source of truth for the POS sync buckets. Both the Shop "ops home"
// health strip (which already has every item in memory) and the Sync Center
// (which only wants live counts) derive from these predicates, so the two can
// never disagree — previously they computed "update needed" differently
// (shop: any pos_dirty; sync center: synced AND pos_dirty). The synced-and-dirty
// reading wins: an item that's dirty but not yet in the shop is still "queued".
export const SYNC_BUCKETS = {
  queued:  { label: "Queued to send",
             item: (it) => it.status === "approved" && !it.pos_sync_status,
             query: (q) => q.eq("status", "approved").is("pos_sync_status", null) },
  sending: { label: "Sending / awaiting POS approval",
             item: (it) => it.pos_sync_status === "pending" || it.pos_sync_status === "awaiting_approval",
             query: (q) => q.in("pos_sync_status", ["pending", "awaiting_approval"]) },
  errors:  { label: "Errors",
             item: (it) => it.pos_sync_status === "error",
             query: (q) => q.eq("pos_sync_status", "error") },
  dirty:   { label: "Update needed",
             item: (it) => it.pos_sync_status === "synced" && it.pos_dirty === true,
             query: (q) => q.eq("pos_sync_status", "synced").eq("pos_dirty", true) },
  inShop:  { label: "In the shop",
             item: (it) => it.pos_sync_status === "synced",
             query: (q) => q.eq("pos_sync_status", "synced") },
};

// Count buckets from an in-memory item list (Shop already loads every item).
export function syncCountsFromItems(items) {
  const counts = {};
  for (const key of Object.keys(SYNC_BUCKETS)) counts[key] = 0;
  for (const it of items || []) {
    for (const key of Object.keys(SYNC_BUCKETS)) if (SYNC_BUCKETS[key].item(it)) counts[key]++;
  }
  return counts;
}

// Count buckets straight from the DB (Sync Center doesn't load the items). Each
// is a head-only exact count, run in parallel.
export async function loadSyncCounts(keys = Object.keys(SYNC_BUCKETS)) {
  const entries = await Promise.all(keys.map(async (key) => {
    const { count } = await SYNC_BUCKETS[key].query(
      supabase.from("items").select("id", { count: "exact", head: true })
    );
    return [key, count || 0];
  }));
  return Object.fromEntries(entries);
}
