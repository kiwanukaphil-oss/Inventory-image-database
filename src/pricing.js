// ============================================================================
//  Pricing tool — set prices by GROUP, not item by item.
//
//  The unit of pricing is usually a group (e.g. a category × brand, regardless
//  of size), so this surface groups items by a key you pick and gives each group
//  ONE price field that fans out to every item in it. Unpriced groups sort to
//  the top; mixed groups show their range and can be expanded later. One write
//  per group instead of one per item.
//
//  Phase A: flexible group-by + per-group fan-out with Undo. (Attribute band
//  splits and per-item overrides come next.)
// ============================================================================

import { supabase } from "./db.js";
import { loadRefData, categoryPath, fieldLabel, getSetting } from "./data.js";
import { logManyItemActivities } from "./activity.js";
import { toast, trapFocus, openBottomSheet, ICON } from "./ui.js";

// Grouping key chosen last time, remembered across opens (per the "I pick the
// grouping each time" workflow — start sensible, never force a default).
let lastGroupKeys = ["subcategory", "brand"];
// Whether the group-by/scope controls are expanded; collapsed by default to give
// the group list room. Remembered across opens.
let controlsExpanded = false;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CHEVRON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

// The value of a grouping key for an item (mirrors the gallery's facet engine).
// Category levels: `top` = broadest (Clothing), `category` = most specific leaf
// (Formal), `subcategory` = the level that holds all sibling subcategories — the
// parent of the leaf (Pants), so grouping by it prices every pant type together.
// Branches shallower than that (e.g. Fragrance lives at the top) fall back to
// their most specific name, so they still group sensibly.
function valueOf(it, key) {
  if (key === "brand") return it.brand || "";
  const parts = (categoryPath(it.category_id) || "").split(" › ");
  if (key === "top") return parts[0] || "";
  if (key === "category") return parts[parts.length - 1] || "";
  if (key === "subcategory") return parts.length >= 2 ? parts[parts.length - 2] : (parts[parts.length - 1] || "");
  const v = it.attributes?.[key];
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Open the full-screen pricing surface.
 * @param {object} caps     signed-in profile (needs can_edit)
 * @param {Function} onClose called after the overlay closes (e.g. to refresh)
 * @param {object} [opts]    { itemIds } to price only a selected subset
 */
export async function openPricing(caps, onClose, opts = {}) {
  // Show the overlay immediately with a spinner so tapping "Set prices" feels
  // responsive — loading the catalogue (up to 5000 rows) can take a moment.
  // The real content replaces this innerHTML once the data + groups are ready.
  const el = document.createElement("div");
  el.className = "calib pricing";
  el.innerHTML = `<div class="calib-panel"><div class="calib-head"><span>Set prices</span></div>
    <div class="calib-body"><div class="spinner" style="margin:48px auto"></div></div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));

  await loadRefData(); // category tree + field labels drive grouping + labels

  const { data: rows, error } = await supabase
    .from("items")
    .select("id, brand, attributes, category_id, price")
    .limit(5000);
  if (error) {
    // Keep the overlay open with a retry instead of vanishing on a network blip.
    el.querySelector(".calib-body").innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Couldn't load items — check your connection.</div>
      <button class="ghost" id="pgRetry" style="margin-top:10px">Try again</button></div>`;
    el.querySelector("#pgRetry").onclick = () => { el.remove(); openPricing(caps, onClose, opts); };
    return;
  }
  // When launched from a gallery selection, price only those items.
  const idset = opts.itemIds?.length ? new Set(opts.itemIds) : null;
  const items = (rows || []).filter((it) => !idset || idset.has(it.id));
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));

  // Cost lives in the admin-only item_costs table, so only load it (and offer the
  // Cost mode) when the user may view cost. Attached as it.cost for the surface.
  const canViewCost = !!caps.can_view_cost;
  if (canViewCost) {
    const { data: costs } = await supabase.from("item_costs").select("item_id, cost_price");
    for (const c of costs || []) if (byId[c.item_id]) byId[c.item_id].cost = c.cost_price;
  }

  // Available grouping dimensions: base facets + every attribute key in use.
  const attrKeys = [...new Set(items.flatMap((it) => Object.keys(it.attributes || {})))].sort();
  // Sub-category (the "Pants" level) and Category lead, since they're the most
  // useful pricing groupings; Top category trails (often too broad to matter).
  const groupOptions = [
    { key: "subcategory", label: "Sub-category" },
    { key: "category", label: "Category" },
    { key: "top", label: "Top category" },
    { key: "brand", label: "Brand" },
    ...attrKeys.map((k) => ({ key: k, label: fieldLabel(k) })),
  ];
  const validKeys = new Set(groupOptions.map((o) => o.key));
  const groupLabelFor = (k) => groupOptions.find((o) => o.key === k)?.label || fieldLabel(k);
  let groupKeys = lastGroupKeys.filter((k) => validKeys.has(k));
  if (!groupKeys.length) groupKeys = ["category"];

  const cur = getSetting("currency", "");
  const fmt = (n) => (cur ? `${cur} ` : "") + Number(n).toLocaleString();
  let filterText = "";

  // The surface edits one price type at a time. priceOf() returns the active
  // type's value for an item so grouping, state, and fan-out all follow the mode.
  let priceMode = "retail"; // "retail" -> items.price | "cost" -> item_costs.cost_price
  const priceOf = (it) => (priceMode === "cost" ? it.cost ?? null : it.price ?? null);

  // Scope narrows which items the whole surface prices. Each entry is
  // { key, mode:'include'|'exclude', values:Set }; an item must satisfy them all.
  // Example: exclude Brand "X" so no group/band price ever touches X's items.
  const scope = [];
  // Default by intent: opening the whole catalogue from the menu is usually about
  // filling NEW prices (so protect existing ones); opening a hand-picked gallery
  // selection is usually a deliberate edit, so allow overwrite. Toggle either way.
  let onlyUnpriced = !idset;
  // Hide groups where every item is already priced, so the list is just what still
  // needs a price — the page's main job ("setting new prices" is the big use case).
  // Defaults on for the whole catalogue and off for a hand-picked selection (which
  // is usually a deliberate edit of items you already chose, priced or not).
  let hideFullyPriced = !idset;
  const matchesScope = (it) => scope.every((s) => {
    const v = valueOf(it, s.key);
    return s.mode === "include" ? s.values.has(v) : !s.values.has(v);
  });
  const scopedItems = () => items.filter(matchesScope);

  // ---- overlay shell (reuses the calibration overlay layout) --------------
  // el is already created + shown (with a loading spinner) at the top of openPricing.
  const release = trapFocus(el);
  const close = () => {
    document.removeEventListener("keydown", onKey);
    release();
    el.classList.remove("open");
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  };
  // Don't steal Esc from a sheet opened on top (the scope picker closes itself).
  // Esc backs out one level at a time: leave select mode first, then close. Never
  // steal Esc from a sheet/dialog opened on top (it owns Esc while open).
  const onKey = (e) => {
    if (e.key !== "Escape" || document.querySelector(".msheet.open")) return;
    if (selectMode) exitSelect(); else close();
  };
  document.addEventListener("keydown", onKey);

  // Build the current groups from the chosen keys. Each group carries its item
  // ids and the set of distinct prices, which drives its priced/mixed state.
  function buildGroups() {
    const map = new Map(); // label -> { label, ids:[], prices:Set, unpriced:int }
    for (const it of scopedItems()) {
      // Collapse consecutive duplicate segments so a branch that falls back to
      // its own name at two levels reads "Fragrance", not "Fragrance · Fragrance".
      const segs = groupKeys.length ? groupKeys.map((k) => valueOf(it, k) || "—") : ["All items"];
      const label = segs.filter((s, i) => i === 0 || s !== segs[i - 1]).join(" · ");
      if (!map.has(label)) map.set(label, { label, ids: [], prices: new Set(), unpriced: 0 });
      const g = map.get(label);
      g.ids.push(it.id);
      const p = priceOf(it);
      if (p == null) g.unpriced++; else g.prices.add(p);
    }
    // Sort: needs-attention first (unpriced, then mixed), then by size.
    const rank = (g) => (g.unpriced ? 0 : g.prices.size > 1 ? 1 : 2);
    return [...map.values()].sort((a, b) => rank(a) - rank(b) || b.ids.length - a.ids.length);
  }
  let groups = buildGroups();
  // Active band-splits, keyed by group label → { attr, threshold }. Cleared when
  // the grouping changes (labels — and thus groups — become different).
  const splits = new Map();

  // The price state of any set of items (a whole group OR one band): all the same
  // → uniform; none set → unpriced; otherwise mixed (range + unpriced count).
  function priceState(prices, unpriced) {
    if (prices.size === 0) return { kind: "unpriced", text: "unpriced" };
    if (prices.size === 1 && !unpriced) return { kind: "uniform", text: "✓ " + fmt([...prices][0]), value: [...prices][0] };
    const vals = [...prices];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const range = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
    return { kind: "mixed", text: `mixed ${range}${unpriced ? ` · ${unpriced} unpriced` : ""}` };
  }
  const groupState = (g) => priceState(g.prices, g.unpriced);

  // The single value of a field across a set of items, or null if they differ or
  // any is missing — used to show a margin only when a group is cleanly priced.
  function uniformVal(ids, getter) {
    const vals = new Set();
    for (const id of ids) { const v = getter(byId[id]); if (v == null) return null; vals.add(v); }
    return vals.size === 1 ? [...vals][0] : null;
  }
  // Group margin when both retail and cost are uniform across it (admin-only).
  function groupMargin(g) {
    if (!canViewCost) return null;
    const retail = uniformVal(g.ids, (it) => it.price);
    const cost = uniformVal(g.ids, (it) => it.cost);
    if (retail == null || cost == null || cost === 0) return null;
    return { cost, retail, pct: Math.round(((retail - cost) / cost) * 100) };
  }

  // Attributes a group can be split on: those with at least one numeric value in
  // the group (so a threshold is meaningful). Non-numeric values land in a
  // separate "no value" band rather than disqualifying the attribute.
  function numericAttrsForGroup(g) {
    const keys = new Set();
    for (const id of g.ids) for (const k of Object.keys(byId[id].attributes || {})) keys.add(k);
    return [...keys]
      .filter((k) => g.ids.some((id) => {
        const v = byId[id].attributes?.[k];
        return v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v));
      }))
      .map((k) => ({ key: k, label: fieldLabel(k) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // Divide a group into bands at the threshold: ≤ T, > T, and (if any) items with
  // no numeric value for the attribute. Each band carries its own price state.
  function getBands(g, cfg) {
    const T = Number(cfg.threshold);
    const attrLabel = fieldLabel(cfg.attr).toLowerCase();
    const mk = (key, label) => ({ key, label, ids: [], prices: new Set(), unpriced: 0 });
    const le = mk("le", `≤ ${cfg.threshold}`), gt = mk("gt", `> ${cfg.threshold}`), no = mk("no", `no ${attrLabel}`);
    for (const id of g.ids) {
      const raw = byId[id].attributes?.[cfg.attr];
      const v = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
      const band = !Number.isFinite(v) ? no : v <= T ? le : gt;
      band.ids.push(id);
      const p = priceOf(byId[id]);
      if (p == null) band.unpriced++; else band.prices.add(p);
    }
    return [le, gt, no].filter((b) => b.ids.length);
  }

  // Groups currently shown = the scoped groups narrowed by the text filter. This
  // is the single source for the visible count, the summary, and Set all, so they
  // always match exactly what's on screen.
  function visibleGroups() {
    const ft = filterText.trim().toLowerCase();
    return groups.filter((g) =>
      (!hideFullyPriced || g.unpriced > 0) &&
      (!ft || g.label.toLowerCase().includes(ft)));
  }
  // ---- bulk select mode ---------------------------------------------------
  // Pricing the WHOLE visible set at once is destructive, so it lives behind a
  // deliberate selection instead of an always-present "Set all" box. The unit is
  // the group (what's on screen): long-press a card — or the Select button — to
  // enter select mode, then tap / drag-sweep groups and price them from the
  // footer bar. Selection is held by group label (stable across re-render).
  let selectMode = false;
  const selectedLabels = new Set();
  // Long-press enters select mode and that gesture's trailing click would
  // otherwise immediately toggle the pressed card back off; this swallows it.
  // Also used to swallow the click that ends a drag-sweep.
  let suppressClick = false;
  const selectedGroups = () => visibleGroups().filter((g) => selectedLabels.has(g.label));
  const selectedItemIds = () => selectedGroups().flatMap((g) => g.ids);

  function enterSelect(label) {
    selectMode = true;
    if (label) selectedLabels.add(label);
    navigator.vibrate?.(15); // subtle "grab" feedback, matching the gallery
    render();
  }
  function exitSelect() {
    selectMode = false;
    selectedLabels.clear();
    render();
  }
  // Toggle one group from a tap — class + counters only, never a full re-render.
  function toggleGroupSel(card) {
    const label = card.dataset.label;
    const on = !selectedLabels.has(label);
    if (on) selectedLabels.add(label); else selectedLabels.delete(label);
    card.classList.toggle("selected", on);
    navigator.vibrate?.(8);
    updateSelBar();
  }

  // ---- render -------------------------------------------------------------
  function render() {
    const visible = visibleGroups();
    const visibleIds = visible.flatMap((g) => g.ids);
    const visibleCount = visibleIds.length;
    const noun = priceMode === "cost" ? "cost" : "price";
    const totalUnpriced = visibleIds.filter((id) => priceOf(byId[id]) == null).length;
    const excluded = items.length - scopedItems().length;
    // Retail/Cost switch — only when the user may see cost (item_costs is admin-only).
    const modeSwitch = canViewCost ? `<div class="pg-modeswitch">
        <button class="pg-modesw${priceMode === "retail" ? " on" : ""}" data-pricemode="retail">Retail</button>
        <button class="pg-modesw${priceMode === "cost" ? " on" : ""}" data-pricemode="cost">Cost</button>
      </div>` : "";
    const chips = groupOptions.map((o) =>
      `<button class="pg-chip${groupKeys.includes(o.key) ? " on" : ""}" data-gk="${esc(o.key)}">${esc(o.label)}</button>`).join("");

    // Active scope as removable pills (e.g. "Brand ≠ X").
    const scopePills = scope.map((s, i) =>
      `<button class="pg-scopepill" data-scopedel="${i}">${esc(groupLabelFor(s.key))} ${s.mode === "exclude" ? "≠" : "="} ${esc([...s.values].slice(0, 2).join(", "))}${s.values.size > 2 ? `+${s.values.size - 2}` : ""} ✕</button>`).join("");

    const groupCards = visible.map((g) => groupCardHtml(g)).join("");

    // The collapsed controls show just a one-line summary of the grouping/scope.
    const groupSummary = (groupKeys.length ? groupKeys.map(groupLabelFor).join(" · ") : "All items")
      + (scope.length ? ` · ${scope.length} scope${scope.length > 1 ? "s" : ""}` : "");
    const titleText = idset ? `Set prices · ${items.length} selected` : "Set prices";
    const summaryLine = totalUnpriced
      ? `<div class="pg-summary">${totalUnpriced} of ${visibleCount} shown ${totalUnpriced === 1 ? "has" : "have"} no ${noun}${excluded ? ` · ${excluded} excluded by scope` : ""}</div>`
      : `<div class="pg-summary pg-done">All ${visibleCount} shown ${visibleCount === 1 ? "has" : "have"} a ${noun} ✓${excluded ? ` · ${excluded} excluded by scope` : ""}</div>`;

    el.innerHTML = `<div class="calib-panel">
      <div class="calib-head">
        <button class="iconbtn" id="pgX" aria-label="${selectMode ? "Exit selection" : "Close"}">${ICON.x}</button>
        <span>${selectMode ? `<span id="pgSelHeadCount">${selectedGroups().length} selected</span>` : esc(titleText)}</span>
        ${selectMode ? `<span></span>` : `<button class="pg-selectbtn" id="pgSelect" ${visible.length ? "" : "disabled"}>Select</button>`}
      </div>
      <div class="pg-controls">
        ${modeSwitch}
        <button class="pg-collapse" id="pgCollapse" aria-expanded="${controlsExpanded}">
          <span class="pg-collapse-label">Group by</span>
          <span class="pg-collapse-val">${esc(groupSummary)}</span>
          <span class="pg-collapse-chev">${CHEVRON}</span>
        </button>
        ${controlsExpanded ? `
          <div class="pg-hint muted">Tap dimensions to group by — combine as many as you like.</div>
          <div class="pg-chips">${chips}</div>
          <div class="pg-scoperow">${scopePills}<button class="pg-scopeadd" id="pgScopeAdd">＋ Scope</button></div>
        ` : ""}
        <label class="pg-toggle"><input type="checkbox" id="pgHidePriced"${hideFullyPriced ? " checked" : ""}> Show only groups that need a ${noun}</label>
        <label class="pg-toggle"><input type="checkbox" id="pgOnlyUnpriced"${onlyUnpriced ? " checked" : ""}> Only fill items with no ${noun}</label>
        <input id="pgFilter" class="fb-search" type="search" placeholder="Filter groups…" value="${esc(filterText)}">
        ${summaryLine}
      </div>
      <div class="calib-body" id="pgBody">${groupCards || `<div class="muted" style="padding:24px;text-align:center">${hideFullyPriced && !filterText.trim() ? `Every group already has a ${noun} ✓` : "No groups match."}</div>`}</div>
      <div class="calib-foot">${selectMode ? selectBarHtml() : `<button class="ghost" id="pgDone">Done</button>`}</div>
    </div>`;

    // ✕ backs out one level: leave select mode first, then close the overlay.
    el.querySelector("#pgX").onclick = () => { if (selectMode) exitSelect(); else close(); };
    if (selectMode) {
      el.querySelector("#pgSelDone").onclick = exitSelect;
      el.querySelector("#pgSelAll").onclick = toggleSelectAll;
      el.querySelector("#pgSelSet").onclick = setSelectedPrice;
      el.querySelector("#pgSelInput").addEventListener("keydown", (e) => { if (e.key === "Enter") setSelectedPrice(); });
    } else {
      el.querySelector("#pgDone").onclick = close;
      el.querySelector("#pgSelect").onclick = () => enterSelect();
    }
    el.querySelector("#pgFilter").oninput = (e) => {
      filterText = e.target.value; // raw, so the field shows what was typed
      // Full re-render so the count, Set-all label, and groups all reflect the
      // filter together; restore focus + caret to the field afterwards.
      render();
      const f = el.querySelector("#pgFilter");
      if (f) { f.focus(); const n = f.value.length; f.setSelectionRange(n, n); }
    };

    el.querySelectorAll("[data-gk]").forEach((btn) => {
      btn.onclick = () => {
        const k = btn.dataset.gk;
        if (groupKeys.includes(k)) groupKeys = groupKeys.filter((x) => x !== k);
        else groupKeys = [...groupKeys, k];
        lastGroupKeys = groupKeys.slice();
        splits.clear(); // groups change → any band-splits no longer apply
        selectedLabels.clear(); // …and labels change, so any selection is stale
        groups = buildGroups();
        render();
      };
    });

    el.querySelector("#pgCollapse").onclick = () => { controlsExpanded = !controlsExpanded; render(); };
    // Scope + unpriced toggle only exist while the controls are expanded.
    el.querySelector("#pgScopeAdd")?.addEventListener("click", openScopeSheet);
    el.querySelectorAll("[data-scopedel]").forEach((btn) => {
      btn.onclick = () => { scope.splice(Number(btn.dataset.scopedel), 1); splits.clear(); selectedLabels.clear(); groups = buildGroups(); render(); };
    });
    el.querySelector("#pgHidePriced").onchange = (e) => { hideFullyPriced = e.target.checked; render(); };
    el.querySelector("#pgOnlyUnpriced").onchange = (e) => { onlyUnpriced = e.target.checked; render(); };
    el.querySelectorAll("[data-pricemode]").forEach((btn) => {
      btn.onclick = () => { priceMode = btn.dataset.pricemode; groups = buildGroups(); render(); };
    });

    wireBodyInteractions(el.querySelector("#pgBody"));
  }

  // Refresh the select-mode counters/buttons in place — no full render, so the
  // scroll position survives rapid toggling.
  function updateSelBar() {
    const sel = selectedGroups();
    const itemCount = sel.reduce((n, g) => n + g.ids.length, 0);
    const head = el.querySelector("#pgSelHeadCount");
    if (head) head.textContent = `${sel.length} selected`;
    const count = el.querySelector("#pgSelCount");
    if (count) count.textContent = sel.length
      ? `${itemCount} item${itemCount === 1 ? "" : "s"} in ${sel.length} group${sel.length === 1 ? "" : "s"}`
      : "Tap groups to price";
    const setBtn = el.querySelector("#pgSelSet");
    if (setBtn) setBtn.disabled = sel.length === 0;
    const allBtn = el.querySelector("#pgSelAll");
    if (allBtn) {
      const vis = visibleGroups();
      allBtn.textContent = vis.length && vis.every((g) => selectedLabels.has(g.label)) ? "Clear all" : "Select all";
    }
  }

  // Select all visible groups, or clear them if all are already selected.
  function toggleSelectAll() {
    const vis = visibleGroups();
    const allSel = vis.length && vis.every((g) => selectedLabels.has(g.label));
    vis.forEach((g) => allSel ? selectedLabels.delete(g.label) : selectedLabels.add(g.label));
    render();
  }

  // The footer action bar shown only in select mode: select-all + a live count,
  // then the price input that fans to every item in the selected groups.
  function selectBarHtml() {
    const sel = selectedGroups();
    const itemCount = sel.reduce((n, g) => n + g.ids.length, 0);
    const vis = visibleGroups();
    const allSel = vis.length && vis.every((g) => selectedLabels.has(g.label));
    const noun = priceMode === "cost" ? "cost" : "price";
    // Done sits bottom-left, deliberately apart from the destructive Set (bottom-
    // right), so the two are never mis-tapped; the count anchors the middle.
    return `<div class="pg-selbar">
      <div class="pg-selbar-row">
        <button class="pg-selexit" id="pgSelDone">Done</button>
        <span class="pg-selcount" id="pgSelCount">${sel.length
          ? `${itemCount} item${itemCount === 1 ? "" : "s"} in ${sel.length} group${sel.length === 1 ? "" : "s"}`
          : "Tap groups to price"}</span>
        <button class="pg-selall" id="pgSelAll">${allSel ? "Clear all" : "Select all"}</button>
      </div>
      <div class="pg-input">
        ${cur ? `<span class="pg-cur">${esc(cur)}</span>` : ""}
        <input id="pgSelInput" type="number" inputmode="decimal" placeholder="${noun} for selected" aria-label="Price for selected groups">
        <button class="pg-set" id="pgSelSet"${sel.length ? "" : " disabled"}>Set ${noun}</button>
      </div>
    </div>`;
  }

  // Body interactions differ by mode, mirroring the gallery's touch model so a
  // vertical swipe still scrolls. Normal: price/split controls, plus a long-press
  // that drops into select mode. Select: tap toggles a group; long-press (touch)
  // or press-drag (mouse) sweeps a run. Toggles update classes + counters only,
  // never a full re-render, so the scroll position holds.
  function wireBodyInteractions(body) {
    const cardOf = (t) => t && t.closest && t.closest(".pg-group[data-label]");
    let lpTimer = null, lpStart = null, sweep = null;
    const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };

    // click: a tap toggles in select mode; otherwise drives the price/split rows.
    // suppressClick swallows the click that ends a long-press or a sweep.
    body.addEventListener("click", (e) => {
      if (suppressClick) { suppressClick = false; return; }
      const card = cardOf(e.target);
      if (selectMode) { if (card) toggleGroupSel(card); return; }
      const setBtn = e.target.closest("[data-set]");
      if (setBtn) { applyFromSet(setBtn); return; }
      const tog = e.target.closest("[data-splittoggle]");
      if (tog) toggleSplit(tog.closest(".pg-group"));
    });
    body.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.target.matches(".pg-thresh")) commitThreshold(e.target);
      else if (e.target.closest(".pg-input")) applyFromSet(e.target.closest(".pg-input").querySelector("[data-set]"));
    });
    body.addEventListener("change", (e) => {
      const card = e.target.closest(".pg-group");
      if (!card) return;
      const cfg = splits.get(groups[Number(card.dataset.idx)].label);
      if (!cfg) return;
      if (e.target.matches("[data-splitattr]")) { cfg.attr = e.target.value; cfg.threshold = ""; replaceCard(card.dataset.idx); }
      else if (e.target.matches("[data-splitthresh]")) commitThreshold(e.target);
    });

    // -- drag-sweep selection (within select mode) --
    // Toggle one card during a sweep, in the sweep's fixed direction (so dragging
    // back over an already-handled card never flickers it).
    function applySweep(card) {
      const label = card.dataset.label;
      if (sweep.processed.has(label)) return;
      sweep.processed.add(label);
      const on = sweep.action === "add";
      if (on) selectedLabels.add(label); else selectedLabels.delete(label);
      card.classList.toggle("selected", on);
      updateSelBar();
    }
    const onMove = (e) => {
      if (!sweep) return;
      const card = cardOf(document.elementFromPoint(e.clientX, e.clientY));
      if (card) applySweep(card);
    };
    const preventScroll = (e) => { if (sweep) e.preventDefault(); };
    const endSweep = () => {
      if (!sweep) return;
      sweep = null;
      suppressClick = true; // don't let the closing click re-toggle the last card
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", endSweep);
      document.removeEventListener("touchmove", preventScroll, { passive: false });
    };
    // First touched card sets the direction (add if it wasn't selected, else
    // remove); document-scoped listeners keep a sweep alive past the card edges.
    function startSweep(card) {
      sweep = { action: selectedLabels.has(card.dataset.label) ? "remove" : "add", processed: new Set() };
      applySweep(card);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", endSweep);
      document.addEventListener("touchmove", preventScroll, { passive: false });
    }

    body.addEventListener("pointerdown", (e) => {
      const card = cardOf(e.target);
      if (!card) return;
      if (selectMode) {
        // Mouse: press-drag sweeps immediately. Touch/pen: long-press starts a
        // sweep, so a quick vertical swipe still scrolls and a tap still toggles.
        if (e.pointerType === "mouse") { e.preventDefault(); startSweep(card); }
        else { lpStart = { x: e.clientX, y: e.clientY }; lpTimer = setTimeout(() => { lpTimer = null; startSweep(card); }, 380); }
      } else if (e.pointerType !== "mouse") {
        // Touch/pen long-press enters select mode — but never steal a tap aimed at
        // a price input, Set button, or the split dropdown inside the card.
        if (e.target.closest("input,button,select,textarea,a")) return;
        lpStart = { x: e.clientX, y: e.clientY };
        lpTimer = setTimeout(() => { lpTimer = null; suppressClick = true; enterSelect(card.dataset.label); }, 380);
      }
    });
    // Cancel a pending long-press only on real movement (tolerate finger jitter).
    body.addEventListener("pointermove", (e) => {
      if (sweep || !lpTimer || !lpStart) return;
      if (Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 12) cancelLp();
    });
    body.addEventListener("pointerup", cancelLp);
    body.addEventListener("pointercancel", () => { cancelLp(); endSweep(); });
    body.addEventListener("contextmenu", (e) => { if (selectMode) e.preventDefault(); });
  }

  // One price-input row. `bandKey` ties the Set button to a band (else the whole
  // group); `st` is the current price state, which prefills a uniform value.
  function priceRowHtml(name, st, bandKey) {
    const inputVal = st.kind === "uniform" ? st.value : "";
    const ph = st.kind === "mixed" ? "keep / overwrite" : "Set price";
    return `<div class="pg-row">
      <span class="pg-state pg-${st.kind}">${esc(st.text)}</span>
      <div class="pg-input">
        ${cur ? `<span class="pg-cur">${esc(cur)}</span>` : ""}
        <input type="number" inputmode="decimal" placeholder="${ph}" value="${inputVal}" aria-label="Price for ${esc(name)}">
        <button class="pg-set" data-set${bandKey ? ` data-band="${bandKey}"` : ""}>Set</button>
      </div>
    </div>`;
  }

  // The split control: pick a numeric attribute + a threshold to band the group.
  function splitControlsHtml(cfg, cands) {
    const opts = cands.map((c) => `<option value="${esc(c.key)}"${c.key === cfg.attr ? " selected" : ""}>${esc(c.label)}</option>`).join("");
    return `<div class="pg-splitctl">
      <span class="muted">Split by</span>
      <select data-splitattr>${opts}</select>
      <span class="muted">at</span>
      <input type="number" inputmode="decimal" class="pg-thresh" data-splitthresh placeholder="e.g. 40" value="${esc(cfg.threshold)}">
    </div>`;
  }

  // The bands of a split group (or a hint until a threshold is entered).
  function bandsHtml(g, cfg) {
    if (cfg.threshold === "" || !Number.isFinite(Number(cfg.threshold))) {
      return `<div class="pg-bandhint muted">Enter a threshold to split into bands.</div>`;
    }
    return getBands(g, cfg).map((b) => `<div class="pg-band">
      <div class="pg-bandhdr"><span class="pg-bandlabel">${esc(b.label)}</span><span class="pg-count">${b.ids.length}</span></div>
      ${priceRowHtml(b.label, priceState(b.prices, b.unpriced), b.key)}
    </div>`).join("");
  }

  // A group card: either a single price row, or — when split — the split control
  // plus one priced band per threshold side. A "Split by…" toggle appears when
  // the group has any numeric attribute to split on.
  function groupCardHtml(g) {
    const idx = groups.indexOf(g);
    // In select mode a card is just a tappable summary (label · state · count)
    // with a checkmark — no price inputs, since pricing happens from the footer.
    if (selectMode) {
      const st = groupState(g);
      const sel = selectedLabels.has(g.label);
      return `<div class="pg-group pg-selectable${sel ? " selected" : ""}" data-idx="${idx}" data-label="${esc(g.label)}">
        <span class="pg-selcheck">✓</span>
        <div class="pg-selbody">
          <span class="pg-label">${esc(g.label)}</span>
          <span class="pg-state pg-${st.kind}">${esc(st.text)}</span>
        </div>
        <span class="pg-count">${g.ids.length}</span>
      </div>`;
    }
    const cfg = splits.get(g.label);
    const cands = numericAttrsForGroup(g);
    const inner = cfg ? splitControlsHtml(cfg, cands) + bandsHtml(g, cfg) : priceRowHtml(g.label, groupState(g), null);
    const splitToggle = cands.length
      ? `<button class="pg-splitbtn" data-splittoggle>${cfg ? "✕ Remove split" : "Split by…"}</button>`
      : "";
    const m = groupMargin(g);
    const marginLine = m
      ? `<div class="pg-margin">cost ${fmt(m.cost)} · retail ${fmt(m.retail)} · <span class="${m.pct < 0 ? "pg-loss" : ""}">${m.pct >= 0 ? "+" : ""}${m.pct}%</span></div>`
      : "";
    return `<div class="pg-group${cfg ? " pg-split" : ""}" data-idx="${idx}" data-label="${esc(g.label)}">
      <div class="pg-top"><span class="pg-label">${esc(g.label)}</span><span class="pg-count">${g.ids.length}</span></div>
      ${inner}
      ${marginLine}
      ${splitToggle ? `<div class="pg-splitrow">${splitToggle}</div>` : ""}
    </div>`;
  }

  // Toggle a group's split on/off (defaulting to its first numeric attribute).
  function toggleSplit(card) {
    const g = groups[Number(card.dataset.idx)];
    if (splits.has(g.label)) splits.delete(g.label);
    else {
      const cands = numericAttrsForGroup(g);
      if (!cands.length) return;
      splits.set(g.label, { attr: cands[0].key, threshold: "" });
    }
    replaceCard(card.dataset.idx);
  }

  // Commit a typed threshold and re-render the card's bands.
  function commitThreshold(input) {
    const card = input.closest(".pg-group");
    const cfg = splits.get(groups[Number(card.dataset.idx)].label);
    if (cfg) { cfg.threshold = input.value.trim(); replaceCard(card.dataset.idx); }
  }

  // Swap just one group's card in place (keeps the rest of the scroll/list).
  function replaceCard(idx) {
    const card = el.querySelector(`.pg-group[data-idx="${idx}"]`);
    if (card) card.outerHTML = groupCardHtml(groups[Number(idx)]);
  }

  // A price change is risky enough to preview when it spans more than one
  // sub-category (the "fragrances caught with the formal pants" mistake) or when
  // it overwrites an existing price/cost. Clean single-category fills skip it.
  function needsPreview(ids) {
    const subs = new Set(ids.map((id) => valueOf(byId[id], "subcategory")));
    return subs.size > 1 || ids.some((id) => priceOf(byId[id]) != null);
  }

  // Show a composition preview (count · by category · brands · price impact) and
  // resolve true only if the user confirms. Cancel / Esc / backdrop → false.
  function previewConfirm(ids, value) {
    return new Promise((resolve) => {
      const noun = priceMode === "cost" ? "cost" : "price";
      const bySub = {}; const brands = new Set();
      let overwrite = 0, lo = Infinity, hi = -Infinity;
      for (const id of ids) {
        const it = byId[id];
        bySub[valueOf(it, "subcategory") || "—"] = (bySub[valueOf(it, "subcategory") || "—"] || 0) + 1;
        if (it.brand) brands.add(it.brand);
        const c = priceOf(it);
        if (c != null) { overwrite++; lo = Math.min(lo, c); hi = Math.max(hi, c); }
      }
      const subs = Object.entries(bySub).sort((a, b) => b[1] - a[1]);
      const brandList = [...brands].sort();
      const newCount = ids.length - overwrite;
      const subLine = subs.map(([s, n]) => `${esc(s)} — ${n}`).join("<br>");
      const brandLine = brandList.length
        ? `${brandList.length} brand${brandList.length === 1 ? "" : "s"}: ${esc(brandList.slice(0, 5).join(", "))}${brandList.length > 5 ? ` +${brandList.length - 5}` : ""}`
        : "no brand set";
      const impact = overwrite
        ? `${newCount} new · ${overwrite} overwritten (was ${lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`})`
        : `all ${newCount} getting a ${noun} for the first time`;

      const el2 = document.createElement("div");
      el2.className = "msheet dlg";
      el2.innerHTML = `<div class="msheet-panel" role="dialog" aria-modal="true">
        <div class="msheet-head"><span>Set ${noun} ${esc(fmt(value))}?</span></div>
        <div class="msheet-body">
          <div class="pv-count">${ids.length} product${ids.length === 1 ? "" : "s"}</div>
          ${subs.length > 1 ? `<div class="pv-warn">⚠ Spans ${subs.length} categories — check nothing unexpected is included.</div>` : ""}
          <div class="pv-sec">By category</div><div class="pv-list">${subLine}</div>
          <div class="pv-sec">Brands</div><div class="pv-list">${brandLine}</div>
          <div class="pv-sec">Price impact</div><div class="pv-list">${impact}</div>
          <div class="dlg-actions">
            <button class="ghost" data-cancel>Cancel</button>
            <button class="primary" data-ok>Set ${noun}</button>
          </div>
        </div></div>`;
      document.body.appendChild(el2);
      requestAnimationFrame(() => el2.classList.add("open"));
      const release = trapFocus(el2);
      const done = (val) => { document.removeEventListener("keydown", onKey); release(); el2.classList.remove("open"); setTimeout(() => el2.remove(), 200); resolve(val); };
      const onKey = (e) => { if (e.key === "Escape") done(false); };
      document.addEventListener("keydown", onKey);
      el2.addEventListener("click", (e) => { if (e.target === el2) done(false); });
      el2.querySelector("[data-cancel]").onclick = () => done(false);
      el2.querySelector("[data-ok]").onclick = () => done(true);
      requestAnimationFrame(() => el2.querySelector("[data-ok]")?.focus());
    });
  }

  // Single commit path: preview when risky, then write. Used by select-mode bulk
  // set + per-group/band sets.
  async function commitPrice(ids, value) {
    if (!ids.length) return;
    if (needsPreview(ids) && !(await previewConfirm(ids, value))) return;
    await applyPrice(ids, value);
  }

  // Apply one price/cost to every item in the selected groups — the deliberate
  // bulk path that replaced the always-present "Set all" box. Honours "only fill
  // unpriced" and runs through the same preview + Undo as every other write.
  async function setSelectedPrice() {
    const raw = el.querySelector("#pgSelInput").value.trim();
    if (raw === "") { toast("Enter a price first."); return; }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) { toast("Enter a valid price."); return; }
    const noun = priceMode === "cost" ? "cost" : "price";
    let ids = selectedItemIds();
    if (!ids.length) { toast("Select at least one group."); return; }
    if (onlyUnpriced) {
      ids = ids.filter((id) => priceOf(byId[id]) == null);
      if (!ids.length) { toast(`Every selected item already has a ${noun}.`); return; }
    }
    await commitPrice(ids, value);
  }

  // Read the price typed next to a Set button and apply it to the whole group or
  // a single band, depending on whether the button carries a band key.
  async function applyFromSet(setBtn) {
    if (!setBtn) return;
    const card = setBtn.closest(".pg-group");
    const g = groups[Number(card.dataset.idx)];
    const raw = setBtn.closest(".pg-input").querySelector("input").value.trim();
    if (raw === "") { toast("Enter a price first."); return; }
    const price = Number(raw);
    if (!Number.isFinite(price) || price < 0) { toast("Enter a valid price."); return; }
    const bandKey = setBtn.dataset.band;
    let targetIds = g.ids;
    if (bandKey) {
      const band = getBands(g, splits.get(g.label)).find((b) => b.key === bandKey);
      if (!band) return;
      targetIds = band.ids;
    }
    // "Only fill unpriced" protects manually-set exceptions from being overwritten.
    if (onlyUnpriced) {
      targetIds = targetIds.filter((id) => priceOf(byId[id]) == null);
      if (!targetIds.length) { toast(`Those items already have a ${priceMode === "cost" ? "cost" : "price"}.`); return; }
    }
    await commitPrice(targetIds, price);
  }

  // Write the value to whichever price the surface is editing: retail → items.price
  // (one update), cost → item_costs.cost_price (upsert). The mode is captured so a
  // later Undo restores the right field even if the user has switched modes.
  function writePrice(ids, value, mode) {
    if (mode === "cost") {
      return supabase.from("item_costs")
        .upsert(ids.map((id) => ({ item_id: id, cost_price: value })), { onConflict: "item_id" });
    }
    return supabase.from("items").update({ price: value }).in("id", ids);
  }
  const setLocal = (it, value, mode) => { if (mode === "cost") it.cost = value; else it.price = value; };

  // Bulk-write a price to the given items, snapshot prior values for Undo, update
  // local state, and re-render so every group/band state reflects the change.
  async function applyPrice(ids, value) {
    const mode = priceMode;
    const prior = ids.map((id) => ({ id, value: mode === "cost" ? byId[id].cost ?? null : byId[id].price ?? null }));
    const { error } = await writePrice(ids, value, mode);
    if (error) { toast("Couldn't set price: " + error.message); return; }
    const fieldPath = mode === "cost" ? "cost_price" : "price";
    await logManyItemActivities(
      ids,
      "pricing",
      "pricing",
      new Map(prior.map((p) => [p.id, [{ field_path: fieldPath, before: p.value, after: value }]])),
      `Set ${mode === "cost" ? "cost" : "price"} ${fmt(value)}`
    );
    for (const id of ids) setLocal(byId[id], value, mode);
    groups = buildGroups();
    navigator.vibrate?.([12, 40, 12]);
    render();
    const what = mode === "cost" ? "cost" : "price";
    toast(`Set ${what} ${fmt(value)} on ${ids.length} item${ids.length === 1 ? "" : "s"}`, {
      label: "Undo",
      onClick: async () => {
        // Restore prior values (null included, so an item that had no price/cost
        // goes back to having none) in batched writes — one upsert for cost, one
        // update per distinct prior value for retail — instead of one per item.
        if (mode === "cost") {
          const { error: uErr } = await supabase.from("item_costs")
            .upsert(prior.map((p) => ({ item_id: p.id, cost_price: p.value })), { onConflict: "item_id" });
          if (uErr) { toast("Undo failed: " + uErr.message); return; }
        } else {
          const byVal = new Map();
          for (const p of prior) { if (!byVal.has(p.value)) byVal.set(p.value, []); byVal.get(p.value).push(p.id); }
          for (const [v, pids] of byVal) {
            const { error: uErr } = await supabase.from("items").update({ price: v }).in("id", pids);
            if (uErr) { toast("Undo failed: " + uErr.message); return; }
          }
        }
        await logManyItemActivities(
          ids,
          "undo",
          "undo",
          new Map(prior.map((p) => [p.id, [{ field_path: fieldPath, before: value, after: p.value }]])),
          "Undid pricing change"
        );
        for (const p of prior) setLocal(byId[p.id], p.value, mode);
        groups = buildGroups();
        render();
        toast("Price change undone");
      },
    });
  }

  // Scope picker: choose a facet, then include-only or exclude its values. Two
  // steps in one bottom sheet (facet list → value checklist).
  function openScopeSheet() {
    const sh = openBottomSheet("Add scope", "");

    const showFacets = () => {
      sh.body.innerHTML = `<div class="cm-label">Filter by</div>` +
        groupOptions.map((o) => `<button class="menu-item" data-facet="${esc(o.key)}">${esc(o.label)}</button>`).join("");
      sh.body.querySelectorAll("[data-facet]").forEach((b) => { b.onclick = () => showValues(b.dataset.facet); });
    };

    const showValues = (key) => {
      const counts = {};
      for (const it of items) { const v = valueOf(it, key); if (v) counts[v] = (counts[v] || 0) + 1; }
      const values = Object.keys(counts).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      let mode = "exclude"; // excluding a value is the common case (the brand ask)
      const sel = new Set();
      const draw = () => {
        sh.body.innerHTML = `
          <button class="linkbtn" data-back>‹ Back</button>
          <div class="cm-label">${esc(groupLabelFor(key))}</div>
          <div class="pg-modeseg">
            <button class="pg-modebtn${mode === "include" ? " on" : ""}" data-mode="include">Include only</button>
            <button class="pg-modebtn${mode === "exclude" ? " on" : ""}" data-mode="exclude">Exclude</button>
          </div>
          <div class="pg-vallist">${values.map((v) =>
            `<button class="fs-opt${sel.has(v) ? " on" : ""}" data-val="${esc(v)}"><span class="fs-check-box${sel.has(v) ? " on" : ""}">${sel.has(v) ? "✓" : ""}</span><span class="fs-opt-label">${esc(v)}</span><span class="fs-opt-n">${counts[v]}</span></button>`).join("")}</div>
          <button class="primary up-go" data-apply>Add scope</button>`;
        sh.body.querySelector("[data-back]").onclick = showFacets;
        // Mode/value taps update the DOM in place rather than calling draw():
        // a redraw replaces .pg-vallist (the scrolling element), which resets
        // its scroll to the top on every tap.
        sh.body.querySelectorAll("[data-mode]").forEach((b) => {
          b.onclick = () => {
            mode = b.dataset.mode;
            sh.body.querySelectorAll("[data-mode]").forEach((m) => m.classList.toggle("on", m.dataset.mode === mode));
          };
        });
        sh.body.querySelectorAll("[data-val]").forEach((b) => {
          b.onclick = () => {
            const v = b.dataset.val;
            sel.has(v) ? sel.delete(v) : sel.add(v);
            const on = sel.has(v);
            b.classList.toggle("on", on);
            const box = b.querySelector(".fs-check-box");
            box.classList.toggle("on", on);
            box.textContent = on ? "✓" : "";
          };
        });
        sh.body.querySelector("[data-apply]").onclick = () => {
          if (!sel.size) { toast("Pick at least one value."); return; }
          scope.push({ key, mode, values: new Set(sel) });
          splits.clear();
          selectedLabels.clear(); // scope changes the groups, so selection is stale
          groups = buildGroups();
          sh.close();
          render();
        };
      };
      draw();
    };

    showFacets();
  }

  render();
}
