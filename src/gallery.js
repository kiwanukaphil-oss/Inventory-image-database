import { supabase } from "./db.js";
import { signOut } from "./auth.js";
import { openEditor } from "./editor.js";
import { renderUpload } from "./upload.js";
import { loadRefData, resolveFields } from "./data.js";
import { openBulkAi } from "./bulkai.js";
import { openUsers } from "./users.js";

// Build the at-a-glance summary line for a card from its category's own field
// definitions, so each category shows the fields that matter to it (a pant shows
// colour/size/fit/style; a fragrance shows volume/concentration/gender/…).
function summarizeItem(it) {
  const attrs = it.attributes || {};
  const parts = [];
  for (const f of resolveFields(it.category_id)) {
    const v = attrs[f.key];
    if (v === null || v === undefined || v === "") continue;
    if (f.type === "boolean") {
      if (v === true || v === "true") parts.push(f.label);
    } else {
      // Append a unit when the field label carries one in parentheses
      // (e.g. "Volume (ml)" -> "100 ml", "Size (EU)" -> "42 EU"). Plain-worded
      // values (Dark Blue, Slim, EDP) stay as-is.
      const unit = (f.label.match(/\(([^)]+)\)/) || [])[1];
      parts.push(unit ? `${v} ${unit}` : String(v));
    }
  }
  return parts.join(" · ");
}

// The authenticated app shell: top bar, bottom nav, and the gallery view with
// search + status filtering. Tapping a card opens the category-driven editor;
// tapping its photo opens the lightbox. Upload, grouping, and bulk ops land
// in later phases.

const NAV = [
  { id: "gallery", label: "Gallery", ico: "▦" },
  { id: "add", label: "Add", ico: "＋" },
  { id: "groups", label: "Groups", ico: "☰" },
  { id: "export", label: "Export", ico: "⤓" },
];

/**
 * Render the full app shell for a signed-in user.
 * @param {HTMLElement} mount  root element
 * @param {object} profile     { id, email, role }
 * @param {Function} onSignOut callback to re-render the login screen
 */
export function renderApp(mount, profile, onSignOut) {
  // `caps` (the profile object) is the source of truth for what the UI exposes;
  // the database independently enforces the same via RLS.
  const caps = profile || {};
  const role = caps.role || "viewer";
  mount.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <h1>K-LINE MEN <span style="color:var(--muted);font-weight:400">Catalog</span></h1>
        <span class="rolechip ${role}">${role}</span>
        <span class="spacer"></span>
        ${caps.can_manage_users ? `<button class="ghost" id="usersBtn">Users</button>` : ""}
        <button class="ghost" id="signOutBtn">Sign out</button>
      </header>
      <main class="content" id="view"></main>
      <nav class="bottomnav" id="nav"></nav>
    </div>`;

  const view = mount.querySelector("#view");
  const nav = mount.querySelector("#nav");

  // Build bottom nav buttons.
  nav.innerHTML = NAV.map(
    (n) => `<button data-view="${n.id}"><span class="ico">${n.ico}</span>${n.label}</button>`
  ).join("");

  function setView(id) {
    nav.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === id)
    );
    if (id === "gallery") renderGallery(view, caps);
    else if (id === "add")
      renderUpload(view, caps, () => {
        nav.querySelector('button[data-view="gallery"]').classList.add("active");
        nav.querySelector('button[data-view="add"]').classList.remove("active");
        renderGallery(view, caps);
      });
    else renderComingSoon(view, id);
  }

  const usersBtn = mount.querySelector("#usersBtn");
  if (usersBtn) usersBtn.onclick = () => openUsers(caps);

  nav.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) setView(btn.dataset.view);
  });

  mount.querySelector("#signOutBtn").addEventListener("click", async () => {
    await signOut();
    onSignOut();
  });

  setView("gallery");
}

// Escape user-provided text before injecting into innerHTML (brands/colours can
// contain &, <, quotes — e.g. "Jery & Sluo").
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Format a price with thousands separators (no currency symbol assumed).
function fmtPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : esc(v);
}

// Short date for display (upload/added date = created_at).
function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d) ? "" : d.toLocaleDateString();
}

// Date-filter presets → earliest allowed date (null = no limit).
const DATE_FILTERS = [
  { v: "all", label: "Any date" },
  { v: "today", label: "Today" },
  { v: "7d", label: "Last 7 days" },
  { v: "30d", label: "Last 30 days" },
];
function dateCutoff(v) {
  if (v === "all" || !v) return null;
  const d = new Date();
  if (v === "today") d.setHours(0, 0, 0, 0);
  else if (v === "7d") d.setDate(d.getDate() - 7);
  else if (v === "30d") d.setDate(d.getDate() - 30);
  return d;
}

const STATUSES = ["all", "draft", "needs-review", "approved", "flag"];

// Fetch items + signed thumbnails, render a filterable card grid. Tapping a
// card opens the editor; tapping its photo opens the lightbox.
async function renderGallery(view, caps) {
  const canEdit = !!caps.can_edit;
  view.innerHTML = `<div class="spinner"></div>`;
  await loadRefData(); // category tree + field definitions drive the card summary
  const { data, error } = await supabase
    .from("items")
    .select("id, name, brand, sku, price, status, image_path, attributes, confidence, category_id, created_at, categories(name)")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Couldn't load items.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message)}</div></div>`;
    return;
  }
  if (!data || data.length === 0) {
    view.innerHTML = `<div class="empty"><div class="big">📭</div>
      <div>No items yet.</div>
      <div style="color:var(--muted);font-size:13px">Run the seed importer or add photos.</div></div>`;
    return;
  }

  // Batch-create signed URLs for all thumbnails in one request.
  const paths = data.filter((d) => d.image_path).map((d) => d.image_path);
  const signed = {};
  if (paths.length) {
    const { data: urls } = await supabase.storage
      .from("product-images")
      .createSignedUrls(paths, 3600);
    (urls || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
  }

  // Filter bar + containers.
  view.innerHTML = `
    <div class="filterbar">
      <input id="q" class="fb-search" type="search" placeholder="Search brand / colour / SKU / type…">
      <div class="fb-controls">
        <select id="statusFilter">
          ${STATUSES.map((s) => `<option value="${s}">${s === "all" ? "All statuses" : s}</option>`).join("")}
        </select>
        <select id="dateFilter">
          ${DATE_FILTERS.map((d) => `<option value="${d.v}">${d.label}</option>`).join("")}
        </select>
        ${canEdit ? `<button class="ghost" id="selectBtn" title="Select items">Select</button>` : ""}
        ${canEdit ? `<button class="ghost aifill" id="aiFillBtn" title="AI-fill filtered items">✨ AI-fill</button>` : ""}
      </div>
    </div>
    <div class="count" id="count"></div>
    <div class="grid" id="grid"></div>
    ${canEdit ? `<div class="selbar" id="selbar" hidden>
      <span id="selCount">0 selected</span>
      <span class="spacer"></span>
      <button class="ghost" id="selAll">All</button>
      <button class="ghost" id="selClear">Clear</button>
      <button class="primary" id="selAi">✨ AI-fill</button>
      <button class="ghost" id="selDone">Done</button>
    </div>` : ""}`;

  const grid = view.querySelector("#grid");
  const countEl = view.querySelector("#count");
  const qEl = view.querySelector("#q");
  const stEl = view.querySelector("#statusFilter");
  const dtEl = view.querySelector("#dateFilter");
  let filtered = []; // current filtered rows, used by bulk AI-fill

  // ---- selection mode (phone-gallery style multi-select) ----
  const byId = Object.fromEntries(data.map((d) => [d.id, d]));
  const selected = new Set();
  let selectionMode = false;
  const selbar = view.querySelector("#selbar");

  function updateSelBar() {
    if (!selbar) return;
    const n = selected.size;
    view.querySelector("#selCount").textContent = `${n} selected`;
    view.querySelector("#selAi").disabled = n === 0;
  }
  function enterSelection() {
    selectionMode = true;
    grid.classList.add("selecting");
    if (selbar) selbar.hidden = false;
    updateSelBar();
  }
  function exitSelection() {
    selectionMode = false;
    selected.clear();
    grid.classList.remove("selecting");
    grid.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    if (selbar) selbar.hidden = true;
  }
  function toggleSelect(id, cardEl) {
    if (selected.has(id)) { selected.delete(id); cardEl?.classList.remove("selected"); }
    else { selected.add(id); cardEl?.classList.add("selected"); }
    updateSelBar();
  }

  // Status badge colour per workflow state.
  const stClass = { draft: "st-draft", "needs-review": "st-review", approved: "st-ok", flag: "st-flag" };

  function draw() {
    const q = qEl.value.trim().toLowerCase();
    const st = stEl.value;
    const cutoff = dateCutoff(dtEl.value);
    const rows = data.filter((it) => {
      if (st !== "all" && it.status !== st) return false;
      if (cutoff && (!it.created_at || new Date(it.created_at) < cutoff)) return false;
      if (!q) return true;
      const hay = [it.brand, it.name, it.sku, it.categories?.name,
        ...Object.values(it.attributes || {})].join(" ").toLowerCase();
      return hay.includes(q);
    });
    filtered = rows; // expose current filtered set for bulk actions

    // Slides for the lightbox follow the currently filtered, ordered rows.
    const slides = [];
    grid.innerHTML = rows
      .map((it) => {
        const url = signed[it.image_path];
        const cat = it.categories?.name || "";
        // Category-driven summary: shows each category's own fields.
        const variant = summarizeItem(it);
        const brand = it.brand || it.name || "—";
        const caption = [brand, variant].filter(Boolean).join(" · ");
        let slideIdx = -1;
        if (url) {
          slideIdx = slides.length;
          slides.push({ url, caption: esc(caption) });
        }
        const inner = url
          ? `<img loading="lazy" src="${url}" alt="${esc(brand)}">`
          : `<span style="color:var(--muted);font-size:12px">no image</span>`;
        const thumb = `<div class="thumb"${url ? ` data-slide="${slideIdx}"` : ""}>
          ${inner}<span class="selcheck">✓</span></div>`;
        return `<div class="card${selected.has(it.id) ? " selected" : ""}" data-id="${it.id}">
          ${thumb}
          <div class="body">
            <div class="cardtop">
              <span style="font-size:12px;color:var(--muted)">${esc(cat)}</span>
              <span class="stbadge ${stClass[it.status] || ""}">${esc(it.status)}</span>
            </div>
            <div class="cbrand">${esc(brand)}</div>
            ${variant ? `<div class="cattr">${esc(variant)}</div>` : ""}
            <div class="cmeta">
              ${it.price != null ? `<span class="cprice">${fmtPrice(it.price)}</span>` : "<span></span>"}
              <span class="cdate">${fmtDate(it.created_at)}</span>
            </div>
          </div>
        </div>`;
      })
      .join("");
    countEl.textContent = `${rows.length} of ${data.length} item${data.length === 1 ? "" : "s"}`;
    grid._slides = slides;
  }

  // ---- selection interactions: tap, shift-click range, drag/slide sweep ----
  const cardIndex = (card) => [...grid.querySelectorAll(".card[data-id]")].indexOf(card);
  let anchorIndex = null;      // last single-selected card, for shift-range
  let suppressClick = false;   // swallow the click that ends a long-press / drag
  let drag = null;             // { action:'add'|'remove', processed:Set }
  let lpTimer = null;
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };

  function setSelected(card, on) {
    const id = card.dataset.id;
    if (on) { selected.add(id); card.classList.add("selected"); }
    else { selected.delete(id); card.classList.remove("selected"); }
  }
  function rangeSelect(toIndex) {
    const cards = [...grid.querySelectorAll(".card[data-id]")];
    let [a, b] = [anchorIndex ?? toIndex, toIndex].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) cards[i] && setSelected(cards[i], true);
    updateSelBar();
  }
  const preventScroll = (e) => { if (drag) e.preventDefault(); };
  function applyDrag(card) {
    const id = card.dataset.id;
    if (drag.processed.has(id)) return;
    drag.processed.add(id);
    setSelected(card, drag.action === "add");
    updateSelBar();
  }
  function docMove(e) {
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const card = el && el.closest && el.closest(".card[data-id]");
    if (card) applyDrag(card);
  }
  function startDrag(card) {
    if (!selectionMode) enterSelection();
    const willSelect = !selected.has(card.dataset.id);
    drag = { action: willSelect ? "add" : "remove", processed: new Set() };
    anchorIndex = cardIndex(card);
    applyDrag(card);
    // Document-scoped so a sweep keeps working past the grid edge, and these are
    // removed on drag end (no per-render listener buildup).
    document.addEventListener("touchmove", preventScroll, { passive: false });
    document.addEventListener("pointermove", docMove);
    document.addEventListener("pointerup", endDrag);
  }
  function endDrag() {
    if (!drag) return;
    drag = null;
    document.removeEventListener("touchmove", preventScroll, { passive: false });
    document.removeEventListener("pointermove", docMove);
    document.removeEventListener("pointerup", endDrag);
    suppressClick = true;
  }

  grid.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const card = e.target.closest(".card[data-id]");
    if (selectionMode) {
      if (!card) return;
      if (e.shiftKey && anchorIndex !== null) rangeSelect(cardIndex(card));
      else { toggleSelect(card.dataset.id, card); anchorIndex = cardIndex(card); }
      return;
    }
    const thumb = e.target.closest(".thumb[data-slide]");
    if (thumb) { openLightbox(grid._slides, Number(thumb.dataset.slide)); return; }
    if (card) openEditor(card.dataset.id, caps, () => renderGallery(view, caps));
  });

  let lpStart = null;
  grid.addEventListener("pointerdown", (e) => {
    if (!canEdit) return;
    const card = e.target.closest(".card[data-id]");
    if (!card) return;
    if (e.pointerType === "mouse") {
      // Mouse in selection mode: shift = range (let click handle it); else drag.
      if (selectionMode && !e.shiftKey) { e.preventDefault(); startDrag(card); }
    } else {
      // Touch/pen: long-press to begin selection + sweep (so scrolling still works).
      lpStart = { x: e.clientX, y: e.clientY };
      lpTimer = setTimeout(() => { lpTimer = null; startDrag(card); }, 380);
    }
  });
  // Cancel the long-press only on real movement (tolerate finger jitter); a held
  // finger that barely moves still triggers selection.
  grid.addEventListener("pointermove", (e) => {
    if (drag || !lpTimer || !lpStart) return;
    if (Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 12) cancelLp();
  });
  grid.addEventListener("pointerup", cancelLp);
  grid.addEventListener("pointercancel", () => { cancelLp(); endDrag(); });
  // Suppress the browser long-press context menu inside the grid.
  grid.addEventListener("contextmenu", (e) => e.preventDefault());

  // Toolbar Select button + selection action bar.
  const selectBtn = view.querySelector("#selectBtn");
  if (selectBtn) selectBtn.onclick = () => (selectionMode ? exitSelection() : enterSelection());
  if (selbar) {
    view.querySelector("#selDone").onclick = exitSelection;
    view.querySelector("#selClear").onclick = () => {
      selected.clear();
      grid.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
      updateSelBar();
    };
    view.querySelector("#selAll").onclick = () => {
      for (const it of filtered) selected.add(it.id);
      grid.querySelectorAll(".card[data-id]").forEach((c) => c.classList.add("selected"));
      updateSelBar();
    };
    view.querySelector("#selAi").onclick = () => {
      const items = [...selected].map((id) => byId[id]).filter(Boolean);
      if (items.length) openBulkAi(items, caps, () => renderGallery(view, caps));
    };
  }

  qEl.addEventListener("input", draw);
  stEl.addEventListener("change", draw);
  dtEl.addEventListener("change", draw);

  const aiFillBtn = view.querySelector("#aiFillBtn");
  if (aiFillBtn) {
    aiFillBtn.onclick = () =>
      openBulkAi(filtered, caps, () => renderGallery(view, caps));
  }

  draw();
}

function renderComingSoon(view, id) {
  const labels = { add: "Add photos", groups: "Grouping", export: "CSV export" };
  view.innerHTML = `<div class="empty"><div class="big">🚧</div>
    <div>${labels[id] || id} arrives in a later phase.</div></div>`;
}

// ---------------------------------------------------------------------------
// Lightbox — a single reusable overlay with keyboard + swipe navigation.
// ---------------------------------------------------------------------------
let lbState = { slides: [], i: 0, el: null };

function ensureLightbox() {
  if (lbState.el) return lbState.el;
  const lb = document.createElement("div");
  lb.id = "lb";
  lb.innerHTML = `
    <button class="lb-close" aria-label="Close">✕</button>
    <button class="lb-nav lb-prev" aria-label="Previous">‹</button>
    <img id="lbimg" alt="">
    <button class="lb-nav lb-next" aria-label="Next">›</button>
    <div class="lb-cap" id="lbcap"></div>`;
  document.body.appendChild(lb);

  lb.querySelector(".lb-close").onclick = closeLightbox;
  lb.querySelector(".lb-prev").onclick = () => moveLightbox(-1);
  lb.querySelector(".lb-next").onclick = () => moveLightbox(1);
  lb.addEventListener("click", (e) => { if (e.target === lb) closeLightbox(); });

  // Touch swipe (mobile) — horizontal drag to move between images.
  let startX = 0;
  lb.addEventListener("touchstart", (e) => { startX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) moveLightbox(dx < 0 ? 1 : -1);
  });

  document.addEventListener("keydown", (e) => {
    if (!lb.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowRight") moveLightbox(1);
    else if (e.key === "ArrowLeft") moveLightbox(-1);
  });

  lbState.el = lb;
  return lb;
}

function openLightbox(slides, i) {
  ensureLightbox();
  lbState.slides = slides;
  lbState.i = i;
  paintLightbox();
  lbState.el.classList.add("open");
}
function closeLightbox() { lbState.el?.classList.remove("open"); }
function moveLightbox(d) {
  const n = lbState.slides.length;
  if (!n) return;
  lbState.i = (lbState.i + d + n) % n;
  paintLightbox();
}
function paintLightbox() {
  const s = lbState.slides[lbState.i];
  if (!s) return;
  lbState.el.querySelector("#lbimg").src = s.url;
  lbState.el.querySelector("#lbcap").innerHTML =
    `${s.caption} <span style="color:var(--muted)">· ${lbState.i + 1}/${lbState.slides.length}</span>`;
}
