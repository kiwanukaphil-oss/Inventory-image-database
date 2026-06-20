import { supabase } from "./db.js";
import { loadRefData, loadPosMirror, getSetting, categoryPath } from "./data.js";
import { openEditor } from "./editor.js";
import { openSyncCenter } from "./synccenter.js";
import { syncCountsFromItems } from "./syncstate.js";
import { esc, ICON, openBottomSheet } from "./ui.js";

// The Shop tab — answers, not analytics. Each card is a question floor staff
// actually ask, answered with photos and plain words over the read-only POS
// mirror. Unlike the gallery (one photo = one unit, by the evidence rule),
// everything here is compressed to ONE ROW PER SKU/variant — a report counts
// products, not photos. Filters (search / category / brand) apply across every
// card, sections cap their rows with a "Show all", and Running low carries the
// actual reorder signal: sell-rate and weeks of cover. Money stays out of v1
// beyond the selling price already on the tag.


const DAY_MS = 86_400_000;
const SLEEPER_DAYS = 60; // in shop this long with zero sales = markdown candidate
const SECTION_CAP = 6;   // rows shown per section before "Show all"
const SHOP_ITEM_CAP = 10000; // explicit cap (P5): the report was relying on PostgREST's silent default

// Filter/view state survives tab switches within the session (same pattern as
// the gallery's browseState).
const state = { q: "", top: "", brand: "", bestWindow: "7d", expanded: new Set() };

async function loadLatestSyncRun(kind) {
  const { data } = await supabase
    .from("pos_sync_runs")
    .select("finished_at, ok, error, summary")
    .eq("kind", kind)
    .order("started_at", { ascending: false })
    .limit(1);
  return (data || [])[0] || null;
}

export async function renderShop(view, caps, onChanged) {
  view.innerHTML = `<div class="shop-wrap"><div class="shop-skel">${
    Array.from({ length: 5 }, () => `<div class="shop-card"><div class="sk-line w45"></div><div class="sk-line w70"></div></div>`).join("")
  }</div></div>`;
  await loadRefData();

  const [{ data: items, error }, posMirror, reconcileRun] = await Promise.all([
    supabase
      .from("items")
      .select("id, name, brand, sku, status, image_path, attributes, category_id, pos_sync_status, pos_variant_id, pos_synced_at, pos_dirty, categories(name)")
      .order("created_at", { ascending: true })
      .limit(SHOP_ITEM_CAP),
    loadPosMirror().catch(() => ({ byVariant: new Map(), lastMirror: null })),
    loadLatestSyncRun("reconcile").catch(() => null),
  ]);
  if (error) {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div><div>Couldn't load shop data.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message)}</div></div>`;
    return;
  }
  // P5: an aggregate report over a truncated set would mislead — flag it.
  const truncated = (items || []).length >= SHOP_ITEM_CAP;
  if (truncated) console.warn("shop: item set hit the cap", SHOP_ITEM_CAP);

  // One representative catalog item per POS variant (oldest with a photo) —
  // duplicate-SKU photos collapse here; the report counts products, not photos.
  const repByVariant = new Map();
  for (const it of items || []) {
    if (!it.pos_variant_id) continue;
    const cur = repByVariant.get(it.pos_variant_id);
    if (!cur || (!cur.image_path && it.image_path)) repByVariant.set(it.pos_variant_id, it);
  }
  // Sync bucket counts come from the shared single source (syncstate.js) so the
  // Shop strip and the Sync Center can never disagree.
  const { queued, errors, sending, dirty, inShop } = syncCountsFromItems(items || []);
  const driftFindings = Array.isArray(reconcileRun?.summary?.findings)
    ? reconcileRun.summary.findings
    : [];

  // The variant universe, dressed for filtering: top-level category + brand.
  const all = [...posMirror.byVariant.values()]
    .filter((m) => m.is_active !== false)
    .map((m) => {
      const rep = repByVariant.get(m.pos_variant_id) || null;
      return {
        m, rep,
        top: rep ? (categoryPath(rep.category_id) || "").split(" › ")[0] : "",
        brand: (rep?.brand || m.brand_name || "").trim(),
        text: [rep?.brand, rep?.name, m.product_name, m.brand_name, m.pos_sku, rep?.categories?.name]
          .filter(Boolean).join(" ").toLowerCase(),
      };
    });

  const tops = [...new Set(all.map((v) => v.top).filter(Boolean))].sort();
  const brands = [...new Set(all.map((v) => v.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const cur = getSetting("currency", "");
  const fmtPrice = (p) => p == null ? "" : `${cur ? cur + " " : ""}${Number(p).toLocaleString()}`;

  function draw() {
    const variants = all.filter((v) =>
      (!state.q || v.text.includes(state.q)) &&
      (!state.top || v.top === state.top) &&
      (!state.brand || v.brand === state.brand)
    );

    const soldToday = variants.reduce((s, v) => s + (v.m.units_sold_today || 0), 0);
    const sold7d = variants.reduce((s, v) => s + (v.m.units_sold_7d || 0), 0);

    const low = variants
      .filter((v) => v.m.stock_quantity > 0 && v.m.reorder_level != null && v.m.stock_quantity <= v.m.reorder_level)
      .sort((a, b) => a.m.stock_quantity - b.m.stock_quantity);
    const soldOut = variants
      .filter((v) => v.m.stock_quantity <= 0 && (v.m.units_sold || 0) > 0)
      .sort((a, b) => (b.m.units_sold || 0) - (a.m.units_sold || 0));
    const best = variants
      .filter((v) => (state.bestWindow === "7d" ? v.m.units_sold_7d : v.m.units_sold) > 0)
      .sort((a, b) => state.bestWindow === "7d"
        ? (b.m.units_sold_7d || 0) - (a.m.units_sold_7d || 0)
        : (b.m.units_sold || 0) - (a.m.units_sold || 0))
      .slice(0, 10);
    const sleepers = variants
      .filter((v) => {
        const since = v.rep?.pos_synced_at ? Date.now() - new Date(v.rep.pos_synced_at).getTime() : 0;
        return v.m.stock_quantity > 0 && (v.m.units_sold || 0) === 0 && since > SLEEPER_DAYS * DAY_MS;
      })
      .sort((a, b) => new Date(a.rep?.pos_synced_at || 0) - new Date(b.rep?.pos_synced_at || 0));

    const title = (v) => v.rep ? (v.rep.brand || v.rep.name || v.m.brand_name || "—") : (v.m.product_name || "—");
    // Caption = the SKU's components in human form (category · colour · size),
    // NOT the SKU itself — that's a machine identifier (all-caps, repeats the
    // category, truncates the price off the line). Brand is omitted: it's the
    // row title directly above. The raw SKU stays one tap away in the editor.
    const subLine = (v) => {
      const attrs = v.rep?.attributes || {};
      const size = ["size", "size_eu", "waist"].map((k) => attrs[k]).find(Boolean)
        || (attrs.volume_ml ? `${attrs.volume_ml} ml` : null);
      const bits = v.rep
        ? [v.rep.categories?.name, attrs.color, size]
        : [v.m.pos_sku]; // no catalog twin — the SKU is all we know
      const price = fmtPrice(v.m.price);
      if (price) bits.push(price);
      return bits.filter(Boolean).join(" · ");
    };
    const thumb = (v) => {
      const url = v.rep?.image_path ? signed[v.rep.image_path] : null;
      return url ? `<img loading="lazy" src="${url}" alt="">` : `<span class="row-noimg">—</span>`;
    };
    const rowHtml = (v, metric) => `
      <div class="shop-row${v.rep ? "" : " norep"}" ${v.rep ? `data-id="${v.rep.id}"` : ""}>
        <div class="shop-thumb">${thumb(v)}</div>
        <div class="shop-main">
          <div class="shop-name">${esc(title(v))}</div>
          <div class="shop-sub">${esc(subLine(v))}</div>
          ${v.rep ? "" : `<div class="shop-readonly">POS-only row - read-only here</div>`}
        </div>
        <div class="shop-metric">${metric}</div>
      </div>`;

    // ≈ weeks of stock left at the current week's sell-rate — the reorder signal.
    const coverNote = (v) => {
      const rate = v.m.units_sold_7d || 0;
      if (!rate) return "";
      const weeks = v.m.stock_quantity / rate;
      return `<div class="shop-cover">sells ${rate}/wk · ≈${weeks < 1 ? "<1" : Math.round(weeks)} wk left</div>`;
    };

    // A section capped at SECTION_CAP rows with a "Show all (N)" expander.
    const section = (key, heading, sub, rows, emptyText, extraHead = "") => {
      const open = state.expanded.has(key);
      const shown = open ? rows : rows.slice(0, SECTION_CAP);
      return `
      <div class="shop-card">
        <div class="shop-head"><span>${heading}</span>${extraHead}<span class="shop-count">${rows.length || ""}</span></div>
        ${sub ? `<div class="shop-subhead">${sub}</div>` : ""}
        ${shown.length ? shown.join("") : `<div class="shop-empty">${emptyText}</div>`}
        ${rows.length > SECTION_CAP
          ? `<button class="shop-showall" data-expand="${key}">${open ? "Show fewer" : `Show all (${rows.length})`}</button>`
          : ""}
      </div>`;
    };

    const asOf = posMirror.lastMirror?.finished_at
      ? new Date(posMirror.lastMirror.finished_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
    const staleMins = posMirror.lastMirror?.finished_at
      ? (Date.now() - new Date(posMirror.lastMirror.finished_at).getTime()) / 60000 : Infinity;
    const mirrorProblem = !asOf || posMirror.lastMirror?.ok === false || staleMins > 30;
    const syncBits = [];
    if (!asOf) syncBits.push("no shop numbers yet");
    else if (posMirror.lastMirror?.ok === false) syncBits.push("shop numbers failed");
    else if (staleMins > 30) syncBits.push("shop numbers stale");
    if (queued) syncBits.push(`${queued} waiting to send`);
    if (sending) syncBits.push(`${sending} sending`);
    if (dirty) syncBits.push(`${dirty} update needed`);
    if (errors) syncBits.push(`${errors} shop issue${errors === 1 ? "" : "s"}`);
    if (driftFindings.length) syncBits.push(`${driftFindings.length} drift finding${driftFindings.length === 1 ? "" : "s"}`);
    const recoveryTone = errors || posMirror.lastMirror?.ok === false || !asOf ? " bad" : mirrorProblem || dirty || driftFindings.length ? " warn" : "";
    const recoveryHtml = syncBits.length
      ? `<div class="shop-recovery${recoveryTone}">
          <div><b>Shop recovery</b><span>${esc(syncBits.slice(0, 4).join(" · "))}${syncBits.length > 4 ? ` · +${syncBits.length - 4} more` : ""}</span></div>
          <button class="ghost" data-synccenter>${caps.can_manage_users ? "Open Sync Center" : "View Sync Center"}</button>
        </div>`
      : "";
    const daysIn = (v) => v.rep?.pos_synced_at
      ? Math.round((Date.now() - new Date(v.rep.pos_synced_at).getTime()) / DAY_MS) : "?";

    const bestToggle = `
      <span class="shop-toggle">
        <button class="shop-tgl${state.bestWindow === "7d" ? " on" : ""}" data-best="7d">Week</button>
        <button class="shop-tgl${state.bestWindow === "all" ? " on" : ""}" data-best="all">All time</button>
      </span>`;

    const filtered = state.q || state.top || state.brand;
    const openBrandPicker = () => {
      const options = [{ label: "All brands", value: "" }, ...brands.map((b) => ({ label: b, value: b }))];
      const sheet = openBottomSheet("Brand", `
        <div class="shop-brandlist">
          ${options.map((opt) => `<button type="button" class="shop-brandrow${state.brand === opt.value ? " on" : ""}" data-brand="${esc(opt.value)}">
            <span>${esc(opt.label)}</span>
            <span class="shop-brandmark">${state.brand === opt.value ? ICON.tick : ""}</span>
          </button>`).join("")}
        </div>`);
      sheet.body.querySelectorAll("[data-brand]").forEach((btn) => {
        btn.onclick = () => {
          state.brand = btn.dataset.brand || "";
          sheet.close();
          draw();
        };
      });
    };

    view.innerHTML = `
      <div class="shop-wrap">
        <div class="shop-filterbar">
          <input id="shopQ" class="fb-search" type="search" placeholder="Search the shop…" value="${esc(state.q)}">
          <button id="shopBrand" type="button" class="shop-brandbtn" aria-label="Brand filter" aria-haspopup="dialog">
            <span>${esc(state.brand || "All brands")}</span>
            <span class="shop-brandchev" aria-hidden="true">v</span>
          </button>
        </div>
        ${tops.length > 1 ? `<div class="shop-chips">
          <button class="shop-chip${!state.top ? " on" : ""}" data-top="">All</button>
          ${tops.map((t) => `<button class="shop-chip${state.top === t ? " on" : ""}" data-top="${esc(t)}">${esc(t)}</button>`).join("")}
        </div>` : ""}
        <div class="shop-asof${staleMins > 30 ? " stale" : ""}">
          <span>${asOf ? `Shop data as of ${esc(asOf)}${staleMins > 30 ? " — may be stale" : ""}` : "No shop data yet — the first sync hasn't run."}${truncated ? ` · ⚠ first ${SHOP_ITEM_CAP.toLocaleString()} items only` : ""}</span>
          <button class="shop-refresh" id="shopRefresh" aria-label="Refresh">${ICON.refresh || "↻"}</button>
        </div>
        ${recoveryHtml}

        <div class="shop-health">
          <span><b>${inShop}</b><small>In shop</small></span>
          <button data-synccenter><b>${queued}</b><small>Queued</small></button>
          <button data-synccenter><b>${sending}</b><small>Sending</small></button>
          <button data-synccenter class="${dirty ? "warn" : ""}"><b>${dirty}</b><small>Update needed</small></button>
          <button data-synccenter class="${errors ? "bad" : ""}"><b>${errors}</b><small>Shop issues</small></button>
        </div>

        <div class="shop-card shop-today">
          <div class="shop-head"><span>${filtered ? "Selection" : "Today at the shop"}</span></div>
          <div class="shop-bignums">
            <div class="shop-bignum"><div class="n">${soldToday}</div><div class="l">sold today</div></div>
            <div class="shop-bignum"><div class="n">${sold7d}</div><div class="l">sold this week</div></div>
            <div class="shop-bignum"><div class="n">${variants.filter((v) => v.m.stock_quantity > 0).length}</div><div class="l">products in stock</div></div>
          </div>
        </div>

        ${section("low", "Running low", "Restock candidates — at or below their reorder level.",
          low.map((v) => rowHtml(v, `<b>${v.m.stock_quantity}</b> left${coverNote(v)}`)),
          filtered ? "Nothing running low in this selection." : "Nothing running low 🎉")}

        ${section("out", "Sold out", "They were selling — worth reordering.",
          soldOut.map((v) => rowHtml(v, `<b>${v.m.units_sold}</b> sold`)),
          "Nothing sold out.")}

        ${section("best", "Best sellers", state.bestWindow === "7d" ? "Top movers this week." : "Top movers, all time.",
          best.map((v) => rowHtml(v, `<b>${state.bestWindow === "7d" ? v.m.units_sold_7d : v.m.units_sold}</b> sold`)),
          "No sales recorded yet.", bestToggle)}

        ${section("sleep", "Sleepers", `In the shop over ${SLEEPER_DAYS} days without a single sale — markdown candidates (reprice in the POS).`,
          sleepers.map((v) => rowHtml(v, `<b>${daysIn(v)}</b> days`)),
          "No sleepers — everything has moved.")}

        <div class="shop-card">
          <div class="shop-head"><span>Waiting to go to the shop</span></div>
          <div class="shop-pipeline">
            <span><b>${queued}</b> approved, going on the next sync</span>
            ${sending ? `<span><b>${sending}</b> being sent or awaiting POS approval</span>` : ""}
            ${dirty ? `<span class="warn"><b>${dirty}</b> in-shop item${dirty === 1 ? "" : "s"} need synced updates</span>` : ""}
            ${errors ? `<span class="warn"><b>${errors}</b> failed — open Sync Center</span>` : ""}
            ${driftFindings.length ? `<span class="warn"><b>${driftFindings.length}</b> drift finding${driftFindings.length === 1 ? "" : "s"} from the last check</span>` : ""}
          </div>
        </div>
      </div>`;

    // ---- wiring (rebuilt per draw since innerHTML replaces the tree) ----
    const wrap = view.querySelector(".shop-wrap");
    wrap.addEventListener("click", (e) => {
      const exp = e.target.closest("[data-expand]");
      if (exp) {
        const k = exp.dataset.expand;
        state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
        draw(); return;
      }
      const tgl = e.target.closest("[data-best]");
      if (tgl) { state.bestWindow = tgl.dataset.best; draw(); return; }
      const chip = e.target.closest("[data-top]");
      if (chip) { state.top = chip.dataset.top; draw(); return; }
      const row = e.target.closest(".shop-row[data-id]");
      if (row) openEditor(row.dataset.id, caps, onChanged);
      if (e.target.closest("[data-synccenter]")) openSyncCenter(caps, () => renderShop(view, caps, onChanged));
    });
    let qTimer;
    wrap.querySelector("#shopQ").addEventListener("input", (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); draw(); keepSearchFocus(); }, 200);
    });
    wrap.querySelector("#shopBrand")?.addEventListener("click", openBrandPicker);
    wrap.querySelector("#shopRefresh").onclick = () => renderShop(view, caps, onChanged);
    function keepSearchFocus() {
      const q = view.querySelector("#shopQ");
      if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
  }

  // Sign thumbnails once for every variant that has a representative photo —
  // sections share the pool, so filtering/expanding never refetches.
  const paths = [...new Set([...repByVariant.values()].map((r) => r.image_path).filter(Boolean))];
  const signed = {};
  if (paths.length) {
    const { data: urls } = await supabase.storage.from("product-images").createSignedUrls(paths, 3600);
    (urls || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
  }

  draw();
}
