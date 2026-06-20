import { esc, openBottomSheet } from "./ui.js";
import { openEditor } from "./editor.js";
import { loadRecentActivity, activitySourceLabel, activitySourceClass, fieldKeyFromPath } from "./activity.js";

// The global "Recent activity" feed — turns the item_events audit trail (who
// changed what, when) into a visible, tappable trust surface. Opened from Quick
// actions and Settings → Data tools. Each row deep-links into the item's editor.


// "just now" / "5m ago" / "3h ago" / "2d ago".
function relTime(iso) {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Day bucket header: Today / Yesterday / "Mon, Jun 9".
function dayLabel(iso) {
  const d = new Date(iso);
  const midnight = (x) => { const c = new Date(x); c.setHours(0, 0, 0, 0); return c; };
  const diff = Math.round((midnight(Date.now()) - midnight(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtVal(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

function rowHtml(e, items) {
  const it = items.get(e.item_id);
  const name = it ? ([it.brand, it.name].filter(Boolean).join(" · ") || "Untitled item") : "Item";
  const field = e.field_path ? fieldKeyFromPath(e.field_path) : "";
  const detail = field === "cost_price"
    ? "Cost updated" // admin-only value — never render the numbers
    : field
      ? `${esc(field)}: ${esc(fmtVal(e.before_value))} → ${esc(fmtVal(e.after_value))}`
      : esc(e.summary || activitySourceLabel(e.source));
  return `<button class="menu-item act-row" data-open="${esc(e.item_id)}">
    <span class="source-pill src-${esc(activitySourceClass(e.source))}">${esc(activitySourceLabel(e.source))}</span>
    <span class="act-copy"><b>${esc(name)}</b><span>${detail}</span></span>
    <span class="act-time">${esc(relTime(e.created_at))}</span>
  </button>`;
}

export function openActivityFeed(caps) {
  const sh = openBottomSheet("Recent activity", `<div class="muted" style="padding:14px">Loading…</div>`);
  let sourceFilter = "all";
  let cached = null;

  // Re-rendered on retry; reused as the editor's refresh so an edit made from the
  // feed reflects when you return to it.
  async function render() {
    try {
      cached = await loadRecentActivity(120);
    } catch {
      sh.body.innerHTML = `<div class="empty"><div class="big">⚠️</div>
        <div>Couldn't load activity — check your connection.</div>
        <button class="ghost" id="actRetry" style="margin-top:10px">Try again</button></div>`;
      sh.body.querySelector("#actRetry").onclick = render;
      return;
    }
    renderContent();
  }

  function renderContent() {
    const data = cached || { events: [], items: new Map() };
    const { events, items } = data;
    if (!events.length) {
      sh.body.innerHTML = `<div class="empty"><div class="big">🕊️</div>
        <div>No activity yet — edits, approvals and shop syncs will show up here.</div></div>`;
      return;
    }
    const sources = [...new Set(events.map((e) => e.source || "system"))]
      .sort((a, b) => activitySourceLabel(a).localeCompare(activitySourceLabel(b)));
    const visible = sourceFilter === "all"
      ? events
      : events.filter((e) => (e.source || "system") === sourceFilter);
    const filters = `<div class="act-filters">
      <button class="act-filter${sourceFilter === "all" ? " on" : ""}" data-actfilter="all">All</button>
      ${sources.map((src) => `<button class="act-filter${sourceFilter === src ? " on" : ""}" data-actfilter="${esc(src)}">${esc(activitySourceLabel(src))}</button>`).join("")}
    </div>`;
    let html = "", lastDay = null;
    for (const e of visible) {
      const day = dayLabel(e.created_at);
      if (day !== lastDay) { html += `<div class="sheet-sec act-day">${esc(day)}</div>`; lastDay = day; }
      html += rowHtml(e, items);
    }
    sh.body.innerHTML = filters + (html || `<div class="sync-empty">No ${esc(activitySourceLabel(sourceFilter).toLowerCase())} activity in the latest ${events.length} events.</div>`);
    sh.body.querySelectorAll("[data-actfilter]").forEach((b) => (b.onclick = () => {
      sourceFilter = b.dataset.actfilter;
      renderContent();
    }));
    sh.body.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => {
      sh.close();
      openEditor(b.dataset.open, caps, () => {});
    }));
  }
  render();
}
