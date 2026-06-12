import { supabase } from "./db.js";
import { loadRefData, loadPosMirror, getSetting } from "./data.js";
import { openEditor } from "./editor.js";

// The Shop tab — answers, not analytics. Each card is a question floor staff
// actually ask, answered with photos and plain words over the read-only POS
// mirror: what sold, what's running low, what's gone, what sells best, what's
// been sitting, and what hasn't reached the shop yet. Money stays out of v1
// (sold counts are floor data; revenue needs the cost capability and a POS
// sales endpoint — deliberately deferred).

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const DAY_MS = 86_400_000;
const SLEEPER_DAYS = 60; // in shop this long with zero sales = markdown candidate

export async function renderShop(view, caps, onChanged) {
  view.innerHTML = `<div class="shop-wrap"><div class="muted" style="padding:20px">Loading shop data…</div></div>`;
  await loadRefData();

  // Items (for photos/identity) + the mirror (for live numbers), joined by
  // pos_variant_id. Duplicate-SKU items share a variant — the FIRST item with
  // an image represents the variant on every card.
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

  // One representative catalog item per POS variant (first = oldest, keeps a
  // stable face per product), plus queue counts for the pipeline card.
  const repByVariant = new Map();
  let queued = 0, errors = 0;
  for (const it of items || []) {
    if (it.status === "approved" && !it.pos_sync_status) queued++;
    if (it.pos_sync_status === "error") errors++;
    if (it.pos_variant_id && !repByVariant.has(it.pos_variant_id)) repByVariant.set(it.pos_variant_id, it);
    else if (it.pos_variant_id && !repByVariant.get(it.pos_variant_id).image_path && it.image_path) {
      repByVariant.set(it.pos_variant_id, it); // prefer a rep that has a photo
    }
  }

  // The variant universe = active mirror rows, each dressed with its rep item.
  const variants = [...posMirror.byVariant.values()]
    .filter((m) => m.is_active !== false)
    .map((m) => ({ m, rep: repByVariant.get(m.pos_variant_id) || null }));

  const soldToday = variants.reduce((s, v) => s + (v.m.units_sold_today || 0), 0);
  const sold7d = variants.reduce((s, v) => s + (v.m.units_sold_7d || 0), 0);

  const low = variants
    .filter((v) => v.m.stock_quantity > 0 && v.m.reorder_level != null && v.m.stock_quantity <= v.m.reorder_level)
    .sort((a, b) => a.m.stock_quantity - b.m.stock_quantity);
  const soldOut = variants
    .filter((v) => v.m.stock_quantity <= 0 && (v.m.units_sold || 0) > 0)
    .sort((a, b) => (b.m.units_sold || 0) - (a.m.units_sold || 0));
  const best = variants
    .filter((v) => (v.m.units_sold_7d || v.m.units_sold || 0) > 0)
    .sort((a, b) => (b.m.units_sold_7d || 0) - (a.m.units_sold_7d || 0) || (b.m.units_sold || 0) - (a.m.units_sold || 0))
    .slice(0, 10);
  const sleepers = variants
    .filter((v) => {
      const since = v.rep?.pos_synced_at ? Date.now() - new Date(v.rep.pos_synced_at).getTime() : 0;
      return v.m.stock_quantity > 0 && (v.m.units_sold || 0) === 0 && since > SLEEPER_DAYS * DAY_MS;
    })
    .sort((a, b) => new Date(a.rep?.pos_synced_at || 0) - new Date(b.rep?.pos_synced_at || 0));

  // Sign thumbnails for every variant any card shows, in one batch.
  const shown = [...new Set([...low, ...soldOut, ...best, ...sleepers].map((v) => v.rep?.image_path).filter(Boolean))];
  const signed = {};
  if (shown.length) {
    const { data: urls } = await supabase.storage.from("product-images").createSignedUrls(shown, 3600);
    (urls || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
  }

  const title = (v) => {
    const name = v.rep ? (v.rep.brand || v.rep.name || v.m.brand_name || "—") : (v.m.product_name || "—");
    const cat = v.rep?.categories?.name || "";
    return { name, cat };
  };
  const thumb = (v) => {
    const url = v.rep?.image_path ? signed[v.rep.image_path] : null;
    return url ? `<img loading="lazy" src="${url}" alt="">` : `<span class="row-noimg">—</span>`;
  };
  // One compact tappable row (photo · name/category · the number that matters).
  const rowHtml = (v, metric) => `
    <div class="shop-row${v.rep ? "" : " norep"}" ${v.rep ? `data-id="${v.rep.id}"` : ""}>
      <div class="shop-thumb">${thumb(v)}</div>
      <div class="shop-main">
        <div class="shop-name">${esc(title(v).name)}</div>
        <div class="shop-sub">${esc([title(v).cat, v.m.pos_sku].filter(Boolean).join(" · "))}</div>
      </div>
      <div class="shop-metric">${metric}</div>
    </div>`;

  const section = (heading, sub, rows, emptyText) => `
    <div class="shop-card">
      <div class="shop-head"><span>${heading}</span><span class="shop-count">${rows.length || ""}</span></div>
      ${sub ? `<div class="shop-subhead">${sub}</div>` : ""}
      ${rows.length ? rows.join("") : `<div class="shop-empty">${emptyText}</div>`}
    </div>`;

  const asOf = posMirror.lastMirror?.finished_at
    ? new Date(posMirror.lastMirror.finished_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const staleMins = posMirror.lastMirror?.finished_at
    ? (Date.now() - new Date(posMirror.lastMirror.finished_at).getTime()) / 60000 : Infinity;

  const daysIn = (v) => v.rep?.pos_synced_at
    ? Math.round((Date.now() - new Date(v.rep.pos_synced_at).getTime()) / DAY_MS) : "?";

  view.innerHTML = `
    <div class="shop-wrap">
      <div class="shop-asof${staleMins > 30 ? " stale" : ""}">
        ${asOf ? `Shop data as of ${esc(asOf)}${staleMins > 30 ? " — may be stale" : ""}` : "No shop data yet — the first sync hasn't run."}
      </div>

      <div class="shop-card shop-today">
        <div class="shop-head"><span>Today at the shop</span></div>
        <div class="shop-bignums">
          <div class="shop-bignum"><div class="n">${soldToday}</div><div class="l">sold today</div></div>
          <div class="shop-bignum"><div class="n">${sold7d}</div><div class="l">sold this week</div></div>
          <div class="shop-bignum"><div class="n">${variants.filter((v) => v.m.stock_quantity > 0).length}</div><div class="l">products in stock</div></div>
        </div>
      </div>

      ${section("Running low", "Restock candidates — at or below their reorder level.",
        low.map((v) => rowHtml(v, `<b>${v.m.stock_quantity}</b> left`)),
        "Nothing running low 🎉")}

      ${section("Sold out", "They were selling — worth reordering.",
        soldOut.map((v) => rowHtml(v, `<b>${v.m.units_sold}</b> sold`)),
        "Nothing sold out.")}

      ${section("Best sellers", "Top movers this week.",
        best.map((v) => rowHtml(v, `<b>${v.m.units_sold_7d || v.m.units_sold}</b> this week`)),
        "No sales recorded yet.")}

      ${section("Sleepers", `In the shop over ${SLEEPER_DAYS} days without a single sale — markdown candidates (reprice in the POS).`,
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

  // Tap any row → that product's editor (its representative catalog item).
  view.querySelector(".shop-wrap").addEventListener("click", (e) => {
    const row = e.target.closest(".shop-row[data-id]");
    if (row) openEditor(row.dataset.id, caps, onChanged);
  });
}
