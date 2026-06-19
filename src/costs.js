import { supabase } from "./db.js";

const COST_CHUNK = 120;
const COST_CONCURRENCY = 4;

function chunks(values, size = COST_CHUNK) {
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

export async function loadCostPresence(itemIds, { canViewCost = false } = {}) {
  const ids = [...new Set(itemIds || [])].filter(Boolean);
  if (!ids.length) return new Map();

  try {
    const byItem = new Map();
    await mapConcurrent(chunks(ids), COST_CONCURRENCY, async (chunk) => {
      const { data, error } = await supabase.rpc("item_cost_presence", { item_ids: chunk });
      if (error) throw error;
      for (const row of data || []) byItem.set(row.item_id, !!row.has_cost_price);
    });
    if (byItem.size) return byItem;
  } catch (e) {
    // Migration 0025 may not be applied yet. Admins can fall back to item_costs;
    // non-admins get an unknown cost state rather than seeing sensitive values.
    console.warn("cost-presence RPC unavailable, falling back —", e?.message || e); // Q3
  }

  if (!canViewCost) return new Map();

  const byItem = new Map(ids.map((id) => [id, false]));
  try {
    await mapConcurrent(chunks(ids), COST_CONCURRENCY, async (chunk) => {
      const { data, error } = await supabase
        .from("item_costs")
        .select("item_id,cost_price")
        .in("item_id", chunk);
      if (error) throw error;
      for (const row of data || []) byItem.set(row.item_id, row.cost_price !== null && row.cost_price !== undefined);
    });
  } catch (e) {
    console.warn("cost-presence fallback read failed —", e?.message || e); // Q3
    return new Map();
  }
  return byItem;
}
