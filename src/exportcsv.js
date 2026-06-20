import { supabase } from "./db.js";
import { loadRefData, categoryPath } from "./data.js";

// On-demand CSV export. Two flavours:
//  - Current catalogue: one row per item, universal columns + every attribute
//    key seen (flattened), category path, and cost (only if the user can see it).
//  - Change log: the audit_log (mirrors the old applied_changes_log.csv shape).

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(cols, rows) {
  return [cols.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
}
function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const today = () => new Date().toISOString().slice(0, 10);

export async function renderExport(view, caps) {
  await loadRefData();
  const ITEM_EXPORT_CAP = 10000;
  const LOG_EXPORT_CAP = 50000;
  view.innerHTML = `
    <div class="uploader export-tool">
      <h2 class="up-h">Export CSV</h2>
      <p class="picked" style="text-align:left">Download a catalog snapshot or audit log. Cost values are included only for users who can view cost.</p>
      <div class="export-note">Catalog exports cap at ${ITEM_EXPORT_CAP.toLocaleString()} rows. Change-log exports cap at ${LOG_EXPORT_CAP.toLocaleString()} rows. The status line warns if a cap is hit.</div>
      <button class="primary up-go export-action" id="expCurrent">
        <b>Catalog snapshot</b><span>Current item fields, attributes, category path, images, and timestamps</span>
      </button>
      ${caps.can_edit ? `<button class="ghost up-go export-action" id="expAudit">
        <b>Change log</b><span>Audit trail rows for edits and operational events</span>
      </button>` : ""}
      <div class="progress" id="expStatus"></div>
    </div>`;

  const statusEl = view.querySelector("#expStatus");
  const setStatus = (m) => (statusEl.textContent = m);

  view.querySelector("#expCurrent").onclick = async () => {
    setStatus("Preparing catalogue…");
    try {
      const { data: items, error } = await supabase
        .from("items")
        .select("id, category_id, name, brand, sku, status, price, stock_quantity, reorder_level, image_path, attributes, created_at, updated_at")
        .order("created_at", { ascending: true })
        .limit(ITEM_EXPORT_CAP);
      if (error) throw error;

      // Cost only when permitted (RLS also enforces this).
      let costMap = {};
      if (caps.can_view_cost) {
        const { data: costs } = await supabase.from("item_costs").select("item_id, cost_price");
        costMap = Object.fromEntries((costs || []).map((c) => [c.item_id, c.cost_price]));
      }

      const attrKeys = [...new Set(items.flatMap((it) => Object.keys(it.attributes || {})))].sort();
      const cols = [
        "category", "name", "brand", "sku", "status", "price",
        ...(caps.can_view_cost ? ["cost_price"] : []),
        "stock_quantity", "reorder_level", ...attrKeys, "image_path", "created_at", "updated_at",
      ];
      const rows = items.map((it) => {
        const r = {
          category: categoryPath(it.category_id),
          name: it.name, brand: it.brand, sku: it.sku, status: it.status, price: it.price,
          stock_quantity: it.stock_quantity, reorder_level: it.reorder_level,
          image_path: it.image_path, created_at: it.created_at, updated_at: it.updated_at,
        };
        if (caps.can_view_cost) r.cost_price = costMap[it.id] ?? "";
        for (const k of attrKeys) r[k] = it.attributes?.[k] ?? "";
        return cols.map((c) => r[c]);
      });

      download(`kline-catalogue-${today()}.csv`, toCsv(cols, rows));
      // P5: never let a truncated export look complete.
      const capped = items.length >= ITEM_EXPORT_CAP;
      setStatus(`Downloaded ${rows.length} items.${capped ? ` ⚠ Only the first ${ITEM_EXPORT_CAP.toLocaleString()} — the catalogue is larger.` : ""}`);
    } catch (e) {
      setStatus("Export failed: " + (e?.message || e));
    }
  };

  const auditBtn = view.querySelector("#expAudit");
  if (auditBtn) auditBtn.onclick = async () => {
    setStatus("Preparing change log…");
    try {
      const cols = ["created_at", "item_id", "change_type", "field", "before", "after", "sku_before", "sku_after", "actor", "notes"];
      const { data: log, error } = await supabase
        .from("audit_log").select(cols.join(", ")).order("created_at", { ascending: true }).limit(LOG_EXPORT_CAP);
      if (error) throw error;
      const rows = (log || []).map((r) => cols.map((c) => r[c]));
      download(`kline-changelog-${today()}.csv`, toCsv(cols, rows));
      const capped = (log || []).length >= LOG_EXPORT_CAP;
      setStatus(`Downloaded ${rows.length} changes.${capped ? ` ⚠ Only the first ${LOG_EXPORT_CAP.toLocaleString()} — older history not included.` : ""}`);
    } catch (e) {
      setStatus("Export failed: " + (e?.message || e));
    }
  };
}
