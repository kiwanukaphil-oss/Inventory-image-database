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
};

const FIELD_COLUMNS = ["name", "brand", "price", "stock_quantity", "reorder_level", "status", "category_id"];
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

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
        before_value: jsonValue(c.before),
        after_value: jsonValue(c.after),
        summary,
      }))
    : [{ item_id: itemId, event_type: eventType, source, summary }];
  try { await supabase.from("item_events").insert(rows); } catch {}
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
          before_value: jsonValue(c.before),
          after_value: jsonValue(c.after),
          summary,
        });
      }
    } else {
      rows.push({ item_id: id, event_type: eventType, source, summary });
    }
  }
  try { await supabase.from("item_events").insert(rows); } catch {}
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
  try {
    const { data, error } = await supabase
      .from("item_events")
      .select("item_id,event_type,source,field_path,summary,actor,created_at")
      .in("item_id", itemIds)
      .order("created_at", { ascending: false })
      .limit(Math.min(6000, Math.max(400, itemIds.length * 12)));
    if (error) return new Map();

    const map = new Map();
    const now = Date.now();
    for (const row of data || []) {
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
      if (recent && ["manual", "bulk", "pricing", "approval", "undo"].includes(row.source)) {
        s.recent_edit = true;
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function hasRecentEdit(item) {
  return !!item?.activity?.recent_edit;
}
