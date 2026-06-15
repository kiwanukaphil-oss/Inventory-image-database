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

const FIELD_COLUMNS = ["name", "brand", "price", "stock_quantity", "reorder_level", "status", "category_id"];
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const QUERY_CHUNK = 80;

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

function chunks(values, size = QUERY_CHUNK) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
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
          before_value: jsonValue(c.before),
          after_value: jsonValue(c.after),
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
    for (const ids of chunks(uniqueIds)) {
      const { data, error } = await supabase
        .from("item_events")
        .select("item_id,event_type,source,field_path,summary,actor,created_at")
        .in("item_id", ids)
        .order("created_at", { ascending: false })
        .limit(Math.max(200, ids.length * 12));
      if (error) {
        console.warn("item activity summary failed", error.message);
        continue;
      }
      rows.push(...(data || []));
    }
  } catch (e) {
    console.warn("item activity summary failed", e?.message || e);
  }

  rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const map = summarizeRows(rows);
  const missing = uniqueIds.filter((id) => !map.has(id));
  if (missing.length) {
    const fallback = await loadAuditActivitySummaries(missing);
    for (const [id, summary] of fallback) if (!map.has(id)) map.set(id, summary);
  }
  return map;
}

export function hasRecentEdit(item) {
  return !!item?.activity?.recent_edit;
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
    if (recent && ["manual", "bulk", "pricing", "approval", "undo", "history"].includes(row.source)) {
      s.recent_edit = true;
    }
  }
  return map;
}

async function loadAuditActivitySummaries(itemIds) {
  const rows = [];
  try {
    for (const ids of chunks(itemIds)) {
      const { data, error } = await supabase
        .from("audit_log")
        .select("item_id,change_type,field,actor,created_at,notes")
        .eq("change_type", "edit")
        .in("item_id", ids)
        .order("created_at", { ascending: false })
        .limit(Math.max(200, ids.length * 8));
      if (error) {
        console.warn("audit activity fallback failed", error.message);
        continue;
      }
      rows.push(...(data || []).map((r) => ({
        item_id: r.item_id,
        event_type: "manual_edit",
        source: "history",
        field_path: r.field,
        summary: r.notes || "Edited in field history",
        actor: r.actor || null,
        created_at: r.created_at,
      })));
    }
  } catch (e) {
    console.warn("audit activity fallback failed", e?.message || e);
  }
  rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return summarizeRows(rows);
}
