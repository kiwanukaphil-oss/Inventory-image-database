import { supabase } from "./db.js";

const SOURCE_LABELS = {
  upload: "Uploaded",
  ai: "AI filled",
  manual: "Manual edit",
  bulk: "Bulk edit",
  pricing: "Priced",
  approval: "Approved",
  undo: "Undo",
  shop: "Shop sync",
  system: "System",
  history: "Edited",
};

const FIELD_COLUMNS = ["name", "brand", "price", "stock_quantity", "reorder_level", "status", "category_id", "pos_branch_id"];
const HUMAN_EDIT_SOURCES = new Set(["manual", "bulk", "pricing", "approval", "undo"]);
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const QUERY_CHUNK = 80;
const QUERY_CONCURRENCY = 4;

export function activitySourceLabel(source) {
  return SOURCE_LABELS[source] || source || "Updated";
}

export function activitySourceClass(source) {
  return SOURCE_LABELS[source] ? source : "system";
}

export function fieldKeyFromPath(path) {
  if (!path) return "";
  if (path.startsWith("attributes.")) return path.slice("attributes.".length);
  if (path.startsWith("confidence.")) return path.slice("confidence.".length);
  return path;
}

function normalizeForCompare(v) {
  if (v === undefined) return null;
  if (v === "") return null;
  return v;
}

function sameValue(a, b) {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

function jsonValue(v) {
  return v === undefined ? null : v;
}

// Fields whose VALUES must never be written to item_events: that table is
// readable by every editor (auth_can_edit RLS), but these are admin-only
// (can_view_cost). We still record THAT the field changed (field_path + summary)
// — just never the numbers. Single chokepoint so no caller can leak cost.
const VALUE_REDACTED = new Set(["cost_price"]);
const redactBefore = (c) => (VALUE_REDACTED.has(c.field_path) ? null : jsonValue(c.before));
const redactAfter = (c) => (VALUE_REDACTED.has(c.field_path) ? null : jsonValue(c.after));

function chunks(values, size = QUERY_CHUNK) {
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

export function diffItemValues(before = {}, after = {}) {
  const changes = [];
  for (const key of FIELD_COLUMNS) {
    if (!sameValue(before[key], after[key])) {
      changes.push({ field_path: key, before: jsonValue(before[key]), after: jsonValue(after[key]) });
    }
  }

  const oldAttrs = before.attributes || {};
  const newAttrs = after.attributes || {};
  for (const key of new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)])) {
    if (!sameValue(oldAttrs[key], newAttrs[key])) {
      changes.push({ field_path: `attributes.${key}`, before: jsonValue(oldAttrs[key]), after: jsonValue(newAttrs[key]) });
    }
  }

  const oldConf = before.confidence || {};
  const newConf = after.confidence || {};
  for (const key of new Set([...Object.keys(oldConf), ...Object.keys(newConf)])) {
    if (!sameValue(oldConf[key], newConf[key])) {
      changes.push({ field_path: `confidence.${key}`, before: jsonValue(oldConf[key]), after: jsonValue(newConf[key]) });
    }
  }

  return changes;
}

export async function logItemActivity(itemId, eventType, source, changes = [], summary = "") {
  if (!itemId) return;
  const clean = (changes || []).filter((c) => c && c.field_path);
  const rows = clean.length
    ? clean.map((c) => ({
        item_id: itemId,
        event_type: eventType,
        source,
        field_path: c.field_path,
        before_value: redactBefore(c),
        after_value: redactAfter(c),
        summary,
      }))
    : [{ item_id: itemId, event_type: eventType, source, summary }];
  try {
    const { error } = await supabase.from("item_events").insert(rows);
    if (error) console.warn("item activity logging failed", error.message);
  } catch (e) {
    console.warn("item activity logging failed", e?.message || e);
  }
}

export async function logManyItemActivities(itemIds, eventType, source, changesByItem = new Map(), summary = "") {
  if (!itemIds?.length) return;
  const rows = [];
  for (const id of itemIds) {
    const changes = (changesByItem.get(id) || []).filter((c) => c && c.field_path);
    if (changes.length) {
      for (const c of changes) {
        rows.push({
          item_id: id,
          event_type: eventType,
          source,
          field_path: c.field_path,
          before_value: redactBefore(c),
          after_value: redactAfter(c),
          summary,
        });
      }
    } else {
      rows.push({ item_id: id, event_type: eventType, source, summary });
    }
  }
  try {
    const { error } = await supabase.from("item_events").insert(rows);
    if (error) console.warn("item activity logging failed", error.message);
  } catch (e) {
    console.warn("item activity logging failed", e?.message || e);
  }
}

export async function loadItemActivity(itemId, limit = 40) {
  if (!itemId) return [];
  try {
    const { data, error } = await supabase
      .from("item_events")
      .select("id,item_id,event_type,source,field_path,before_value,after_value,summary,actor,created_at")
      .eq("item_id", itemId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

export async function loadItemActivitySummaries(itemIds) {
  if (!itemIds?.length) return new Map();
  const uniqueIds = [...new Set(itemIds)];
  const rows = [];
  try {
    await mapConcurrent(chunks(uniqueIds), QUERY_CONCURRENCY, async (ids) => {
      const { data, error } = await supabase
        .from("item_events")
        .select("item_id,event_type,source,field_path,summary,actor,created_at")
        .in("item_id", ids)
        .order("created_at", { ascending: false })
        .limit(Math.max(200, ids.length * 12));
      if (error) {
        console.warn("item activity summary failed", error.message);
        return;
      }
      rows.push(...(data || []));
    });
  } catch (e) {
    console.warn("item activity summary failed", e?.message || e);
  }

  rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return summarizeRows(rows);
}

export function hasRecentEdit(item) {
  return !!item?.activity?.recent_edit;
}

// Global recent-activity feed data: the latest events across all items plus a
// lookup of the items they touched (for names). Powers the "Recent activity"
// surface — the audit trail made visible as a trust feature.
export async function loadRecentActivity(limit = 120) {
  const { data: events, error } = await supabase
    .from("item_events")
    .select("id,item_id,event_type,source,field_path,before_value,after_value,summary,actor,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !events?.length) return { events: [], items: new Map() };
  const ids = [...new Set(events.map((e) => e.item_id).filter(Boolean))];
  const items = new Map();
  for (const ch of chunks(ids)) {
    const { data } = await supabase.from("items").select("id, brand, name, image_path, status").in("id", ch);
    for (const it of data || []) items.set(it.id, it);
  }
  return { events, items };
}

function summarizeRows(rows) {
  const map = new Map();
  const now = Date.now();
  for (const row of rows || []) {
    if (!row.item_id) continue;
    if (!map.has(row.item_id)) {
      map.set(row.item_id, {
        latest_at: row.created_at,
        latest_summary: row.summary || activitySourceLabel(row.source),
        latest_source: row.source,
        latest_actor: row.actor || null,
        sources: new Set(),
        event_count: 0,
        field_count: 0,
        recent_edit: false,
      });
    }
    const s = map.get(row.item_id);
    s.sources.add(row.source);
    s.event_count++;
    if (row.field_path) s.field_count++;
    const recent = row.created_at && now - new Date(row.created_at).getTime() <= RECENT_MS;
    if (recent && HUMAN_EDIT_SOURCES.has(row.source)) {
      s.recent_edit = true;
    }
  }
  return map;
}
