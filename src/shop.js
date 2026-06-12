import { supabase } from "./db.js";
import { loadRefData, loadPosMirror, getSetting, categoryPath } from "./data.js";
import { openEditor } from "./editor.js";
import { ICON } from "./ui.js";

// The Shop tab — answers, not analytics. Each card is a question floor staff
// actually ask, answered with photos and plain words over the read-only POS
// mirror. Unlike the gallery (one photo = one unit, by the evidence rule),
// everything here is compressed to ONE ROW PER SKU/variant — a report counts
// products, not photos. Filters (search / category / brand) apply across every
// card, sections cap their rows with a "Show all", and Running low carries the
// actual reorder signal: sell-rate and weeks of cover. Money stays out of v1
// beyond the selling price already on the tag.

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const DAY_MS = 86_400_000;
const SLEEPER_DAYS = 60; // in shop this long with zero sales = markdown candidate
const SECTION_CAP = 6;   // rows shown per section before "Show all"

// Filter/view state survives tab switches within the session (same pattern as
// the gallery's browseState).
const state = { q: "", top: "", brand: "", bestWindow: "7d", expanded: new Set() };

export async function renderShop(view, caps, onChanged) {
  view.innerHTML = `<div class="shop-wrap"><div class="muted" style="padding:20px">Loading shop data…</div></div>`;
  await loadRefData();

  const [{ data: items, error }, posMirror] = await Promise.all([
    supabase
      .from("items")
      .select("id, name, brand, sku, status, image_path, attributes, category_id, pos_sync_status, pos_variant_id, pos_synced_at, categories(name)")
      .order("created_at", { ascending: true }),
    loadPosMirror().catch(() => ({ byVariant: new Map(), lastMirror: null })),
  ]);
  if (error) {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div><div>Couldn't load shop data.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message)}</div></div>`;
    return;
  }

  // One representative catalog item per POS variant (oldest with a photo) —
  // duplicate-SKU photos collapse here; the report counts products, not photos.
  const repByVariant = new Map();
  let queued = 0, errors = 0;
  for (const it of items || []) {
    if (it.status === "approved" && !it.pos_sync_status) queued++;
    if (it.pos_sync_status === "error") errors++;
    if (!it.pos_variant_id) continue;
    const cur = repByVariant.get(it.pos_variant_id);
    if (!cur || (!cur.image_path && it.image_path)) repByVariant.set(it.pos_variant_id, it);
  }

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
    const subLine = (v) => {
      const bits = [v.rep?.categories?.name, v.m.pos_sku];
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
    const daysIn = (v) => v.rep?.pos_synced_at
      ? Math.round((Date.now() - new Date(v.rep.pos_synced_at).getTime()) / DAY_MS) : "?";

    const bestToggle = `
      <span class="shop-toggle">
        <button class="shop-tgl${state.bestWindow === "7d" ? " on" : ""}" data-best="7d">Week</button>
        <button class="shop-tgl${state.bestWindow === "all" ? " on" : ""}" data-best="all">All time</button>
      </span>`;

    const filtered = state.q || state.top || state.brand;

    view.innerHTML = `
      <div class="shop-wrap">
        <div class="shop-filterbar">
          <input id="shopQ" class="fb-search" type="search" placeholder="Search the shop…" value="${esc(state.q)}">
          <select id="shopBrand" class="shop-brandsel" aria-label="Brand">
            <option value="">All brands</option>
            ${brands.map((b) => `<option value="${esc(b)}"${state.brand === b ? " selected" : ""}>${esc(b)}</option>`).join("")}
          </select>
        </div>
        ${tops.length > 1 ? `<div class="shop-chips">
          <button class="shop-chip${!state.top ? " on" : ""}" data-top="">All</button>
          ${tops.map((t) => `<button class="shop-chip${state.top === t ? " on" : ""}" data-top="${esc(t)}">${esc(t)}</button>`).join("")}
        </div>` : ""}
        <div class="shop-asof${staleMins > 30 ? " stale" : ""}">
          <span>${asOf ? `Shop data as of ${esc(asOf)}${staleMins > 30 ? " — may be stale" : ""}` : "No shop data yet — the first sync hasn't run."}</span>
          <button class="shop-refresh" id="shopRefresh" aria-label="Refresh">${ICON.refresh || "↻"}</button>
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
            ${errors ? `<span class="warn"><b>${errors}</b> failed — see ⋮ → Shop sync</span>` : ""}
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
    });
    let qTimer;
    wrap.querySelector("#shopQ").addEventListener("input", (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); draw(); keepSearchFocus(); }, 200);
    });
    wrap.querySelector("#shopBrand").onchange = (e) => { state.brand = e.target.value; draw(); };
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
