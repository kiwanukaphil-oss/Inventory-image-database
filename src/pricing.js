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
import { toast, trapFocus, openBottomSheet } from "./ui.js";

// Grouping key chosen last time, remembered across opens (per the "I pick the
// grouping each time" workflow — start sensible, never force a default).
let lastGroupKeys = ["subcategory", "brand"];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
 */
export async function openPricing(caps, onClose) {
  await loadRefData(); // category tree + field labels drive grouping + labels

  const { data: rows, error } = await supabase
    .from("items")
    .select("id, brand, attributes, category_id, price")
    .limit(5000);
  if (error) { toast("Couldn't load items: " + error.message); return; }
  const items = rows || [];
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));

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

  // Scope narrows which items the whole surface prices. Each entry is
  // { key, mode:'include'|'exclude', values:Set }; an item must satisfy them all.
  // Example: exclude Brand "X" so no group/band price ever touches X's items.
  const scope = [];
  let onlyUnpriced = false; // when on, applying a price fills only unpriced items
  const matchesScope = (it) => scope.every((s) => {
    const v = valueOf(it, s.key);
    return s.mode === "include" ? s.values.has(v) : !s.values.has(v);
  });
  const scopedItems = () => items.filter(matchesScope);

  // ---- overlay shell (reuses the calibration overlay layout) --------------
  const el = document.createElement("div");
  el.className = "calib pricing";
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));
  const release = trapFocus(el);
  const close = () => {
    document.removeEventListener("keydown", onKey);
    release();
    el.classList.remove("open");
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  };
  // Don't steal Esc from a sheet opened on top (the scope picker closes itself).
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".msheet.open")) close(); };
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
      if (it.price == null) g.unpriced++; else g.prices.add(it.price);
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
      if (byId[id].price == null) band.unpriced++; else band.prices.add(byId[id].price);
    }
    return [le, gt, no].filter((b) => b.ids.length);
  }

  // ---- render -------------------------------------------------------------
  function render() {
    const inScope = scopedItems();
    const priced = groups.filter((g) => groupState(g).kind === "uniform").length;
    const totalUnpriced = inScope.filter((it) => it.price == null).length;
    const excluded = items.length - inScope.length;
    const chips = groupOptions.map((o) =>
      `<button class="pg-chip${groupKeys.includes(o.key) ? " on" : ""}" data-gk="${esc(o.key)}">${esc(o.label)}</button>`).join("");

    // Active scope as removable pills (e.g. "Brand ≠ X").
    const scopePills = scope.map((s, i) =>
      `<button class="pg-scopepill" data-scopedel="${i}">${esc(groupLabelFor(s.key))} ${s.mode === "exclude" ? "≠" : "="} ${esc([...s.values].slice(0, 2).join(", "))}${s.values.size > 2 ? `+${s.values.size - 2}` : ""} ✕</button>`).join("");

    const visible = groups.filter((g) => !filterText || g.label.toLowerCase().includes(filterText));
    const groupCards = visible.map((g) => groupCardHtml(g)).join("");

    el.innerHTML = `<div class="calib-panel">
      <div class="calib-head">
        <button class="iconbtn" id="pgX" aria-label="Close">✕</button>
        <span>Set prices</span>
        <span class="muted" style="font-size:12px">${priced}/${groups.length} groups</span>
      </div>
      <div class="pg-controls">
        <div class="pg-bylabel muted">Group by</div>
        <div class="pg-chips">${chips}</div>
        <div class="pg-scoperow">
          ${scopePills}
          <button class="pg-scopeadd" id="pgScopeAdd">＋ Scope</button>
        </div>
        <input id="pgFilter" class="fb-search" type="search" placeholder="Filter groups…" value="${esc(filterText)}">
        <label class="pg-toggle"><input type="checkbox" id="pgOnlyUnpriced"${onlyUnpriced ? " checked" : ""}> Only fill unpriced items</label>
        ${totalUnpriced ? `<div class="pg-summary">${totalUnpriced} item${totalUnpriced === 1 ? "" : "s"} still unpriced${excluded ? ` · ${excluded} excluded` : ""}</div>` : `<div class="pg-summary pg-done">Every in-scope item has a price ✓${excluded ? ` · ${excluded} excluded` : ""}</div>`}
      </div>
      <div class="calib-body" id="pgBody">${groupCards || `<div class="muted" style="padding:24px;text-align:center">No groups match.</div>`}</div>
      <div class="calib-foot"><button class="ghost" id="pgDone">Done</button></div>
    </div>`;

    el.querySelector("#pgX").onclick = close;
    el.querySelector("#pgDone").onclick = close;
    el.querySelector("#pgFilter").oninput = (e) => {
      filterText = e.target.value.trim().toLowerCase();
      // Re-render just the body so the input keeps focus.
      const body = el.querySelector("#pgBody");
      const vis = groups.filter((g) => !filterText || g.label.toLowerCase().includes(filterText));
      body.innerHTML = vis.length ? vis.map((g) => groupCardHtml(g)).join("") : `<div class="muted" style="padding:24px;text-align:center">No groups match.</div>`;
    };

    el.querySelectorAll("[data-gk]").forEach((btn) => {
      btn.onclick = () => {
        const k = btn.dataset.gk;
        if (groupKeys.includes(k)) groupKeys = groupKeys.filter((x) => x !== k);
        else groupKeys = [...groupKeys, k];
        lastGroupKeys = groupKeys.slice();
        splits.clear(); // groups change → any band-splits no longer apply
        groups = buildGroups();
        render();
      };
    });

    el.querySelector("#pgScopeAdd").onclick = openScopeSheet;
    el.querySelectorAll("[data-scopedel]").forEach((btn) => {
      btn.onclick = () => { scope.splice(Number(btn.dataset.scopedel), 1); splits.clear(); groups = buildGroups(); render(); };
    });
    el.querySelector("#pgOnlyUnpriced").onchange = (e) => { onlyUnpriced = e.target.checked; };

    const body = el.querySelector("#pgBody");
    // Set buttons (whole group or a band) + the "Split by…" toggle.
    body.addEventListener("click", (e) => {
      const setBtn = e.target.closest("[data-set]");
      if (setBtn) { applyFromSet(setBtn); return; }
      const tog = e.target.closest("[data-splittoggle]");
      if (tog) toggleSplit(tog.closest(".pg-group"));
    });
    // Enter commits a price (in a price input) or a threshold (in the split box).
    body.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.target.matches(".pg-thresh")) commitThreshold(e.target);
      else if (e.target.closest(".pg-input")) applyFromSet(e.target.closest(".pg-input").querySelector("[data-set]"));
    });
    // Attribute select change + threshold commit (blur) recompute the bands.
    body.addEventListener("change", (e) => {
      const card = e.target.closest(".pg-group");
      if (!card) return;
      const cfg = splits.get(groups[Number(card.dataset.idx)].label);
      if (!cfg) return;
      if (e.target.matches("[data-splitattr]")) { cfg.attr = e.target.value; cfg.threshold = ""; replaceCard(card.dataset.idx); }
      else if (e.target.matches("[data-splitthresh]")) commitThreshold(e.target);
    });
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
    const cfg = splits.get(g.label);
    const cands = numericAttrsForGroup(g);
    const inner = cfg ? splitControlsHtml(cfg, cands) + bandsHtml(g, cfg) : priceRowHtml(g.label, groupState(g), null);
    const splitToggle = cands.length
      ? `<button class="pg-splitbtn" data-splittoggle>${cfg ? "✕ Remove split" : "Split by…"}</button>`
      : "";
    return `<div class="pg-group${cfg ? " pg-split" : ""}" data-idx="${idx}">
      <div class="pg-top"><span class="pg-label">${esc(g.label)}</span><span class="pg-count">${g.ids.length}</span></div>
      ${inner}
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
      targetIds = targetIds.filter((id) => byId[id].price == null);
      if (!targetIds.length) { toast("Those items already have prices."); return; }
    }
    await applyPrice(targetIds, price);
  }

  // Bulk-write a price to the given items, snapshot prior prices for Undo, update
  // local state, and re-render so every group/band state reflects the change.
  async function applyPrice(ids, price) {
    const prior = ids.map((id) => ({ id, price: byId[id].price }));
    const { error } = await supabase.from("items").update({ price }).in("id", ids);
    if (error) { toast("Couldn't set price: " + error.message); return; }
    for (const id of ids) byId[id].price = price;
    groups = buildGroups();
    navigator.vibrate?.([12, 40, 12]);
    render();
    toast(`Set ${fmt(price)} on ${ids.length} item${ids.length === 1 ? "" : "s"}`, {
      label: "Undo",
      onClick: async () => {
        for (const p of prior) await supabase.from("items").update({ price: p.price }).eq("id", p.id);
        for (const p of prior) byId[p.id].price = p.price;
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
        sh.body.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = () => { mode = b.dataset.mode; draw(); }; });
        sh.body.querySelectorAll("[data-val]").forEach((b) => { b.onclick = () => { const v = b.dataset.val; sel.has(v) ? sel.delete(v) : sel.add(v); draw(); }; });
        sh.body.querySelector("[data-apply]").onclick = () => {
          if (!sel.size) { toast("Pick at least one value."); return; }
          scope.push({ key, mode, values: new Set(sel) });
          splits.clear();
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
