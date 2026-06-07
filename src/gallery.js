import { supabase } from "./db.js";
import { signOut } from "./auth.js";
import { openEditor } from "./editor.js";
import { renderUpload } from "./upload.js";
import { loadRefData, refreshRefData, resolveFields, categoryPath, fieldLabel, getSetting, normalizeValue, vocabSuggestions } from "./data.js";
import { openBulkAi } from "./bulkai.js";
import { openUsers } from "./users.js";
import { renderExport } from "./exportcsv.js";
import { openCategoryManager } from "./categories_admin.js";
import { toast, openBottomSheet, confirmSheet, promptSheet, trapFocus, anyOverlayOpen } from "./ui.js";

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
  { id: "find", label: "Find", ico: "🔎" },
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
        <button class="iconbtn" id="menuBtn" aria-label="Menu">${ICON.kebab}</button>
      </header>
      <div class="offline-banner" id="offlineBanner" hidden>● Offline — changes need a connection</div>
      <main class="content" id="view"></main>
      <button class="fab-top" id="fabTop" hidden aria-label="Back to top">${ICON.up}</button>
      <nav class="bottomnav" id="nav"></nav>
    </div>`;

  const view = mount.querySelector("#view");
  const nav = mount.querySelector("#nav");

  // Build bottom nav buttons.
  nav.innerHTML = NAV.map(
    (n) => `<button data-view="${n.id}"><span class="ico">${n.ico}</span>${n.label}</button>`
  ).join("");

  let currentViewId = "gallery";
  function setView(id) {
    currentViewId = id;
    window.scrollTo(0, 0);
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
    else if (id === "export") renderExport(view, caps);
    else if (id === "find") renderFind(view, caps);
    else renderComingSoon(view, id);
  }

  // Shop-wide settings (currency for now), gated to user-managers.
  function openSettings() {
    const cur = getSetting("currency", "");
    const sh = openBottomSheet("Settings", `
      <div class="sheet-sec">Currency</div>
      <div class="cm-label">Prefix shown before prices (e.g. UGX, $, KSh)</div>
      <input id="setCurrency" value="${esc(cur)}" placeholder="e.g. UGX">
      <button class="primary up-go" id="setSave">Save</button>`);
    sh.body.querySelector("#setSave").onclick = async () => {
      const v = sh.body.querySelector("#setCurrency").value.trim();
      const { error } = await supabase.from("app_settings").upsert({ key: "currency", value: v });
      if (error) { toast("Save failed: " + error.message); return; }
      sh.close();
      toast("Currency saved");
      refreshRefData();
      await loadRefData();
      setView(currentViewId); // re-render so prices show the new prefix
    };
  }

  // Account / admin menu (⋮) — keeps the top bar clean; Sign out lives at the bottom.
  mount.querySelector("#menuBtn").onclick = () => {
    const admin = caps.can_manage_users
      ? `<button class="menu-item" data-m="users">Users & permissions</button>
         <button class="menu-item" data-m="cats">Categories & fields</button>
         <button class="menu-item" data-m="settings">Settings</button>`
      : "";
    const sh = openBottomSheet(caps.email || "Account",
      `<div class="menu-sub">Signed in as ${esc(role)}</div>
       ${admin}
       <button class="menu-item danger" data-m="signout">Sign out</button>`);
    sh.body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-m]");
      if (!b) return;
      sh.close();
      if (b.dataset.m === "users") openUsers(caps);
      else if (b.dataset.m === "cats") openCategoryManager(caps);
      else if (b.dataset.m === "settings") openSettings();
      else if (b.dataset.m === "signout") { await signOut(); onSignOut(); }
    });
  };

  nav.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    // Tapping the already-active tab scrolls back to top (mobile convention).
    if (btn.dataset.view === currentViewId) window.scrollTo({ top: 0, behavior: "smooth" });
    else setView(btn.dataset.view);
  });

  // Offline banner — toggled by the browser's connectivity events.
  const banner = mount.querySelector("#offlineBanner");
  const setOnline = () => { banner.hidden = navigator.onLine; };
  window.addEventListener("online", setOnline);
  window.addEventListener("offline", setOnline);
  setOnline();

  // Back-to-top: appears once you've scrolled down a bit.
  const fab = mount.querySelector("#fabTop");
  const onScroll = () => { fab.hidden = window.scrollY < 500; };
  window.addEventListener("scroll", onScroll, { passive: true });
  fab.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  onScroll();

  setView("gallery");
}

// Escape user-provided text before injecting into innerHTML (brands/colours can
// contain &, <, quotes — e.g. "Jery & Sluo").
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Format a price with thousands separators + the shop's currency prefix (if set).
function fmtPrice(v) {
  const n = Number(v);
  const s = Number.isFinite(n) ? n.toLocaleString() : esc(v);
  const cur = getSetting("currency", "");
  return cur ? `${esc(cur)} ${s}` : s;
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

// Hard caps on how many rows each browse surface loads at once. Exposed so the
// UI can warn when a result set is truncated rather than silently hiding items.
const GALLERY_LIMIT = 1000;
const FIND_LIMIT = 2000;

// A grid of shimmering placeholder cards shown while data loads, so the screen
// shows the eventual layout immediately instead of a lone centered spinner.
function skeletonGrid(n = 8) {
  const card = `<div class="card sk-card" aria-hidden="true">
      <div class="thumb"></div>
      <div class="body"><div class="sk-line w70"></div><div class="sk-line w45"></div></div>
    </div>`;
  return `<div class="grid">${card.repeat(n)}</div>`;
}

// Remember the gallery's search + filters for the session (until reload).
const galState = { q: "", stFilter: "all", dtFilter: "all", needsReview: false };
// True if an item has any field marked Low confidence.
const hasLowConf = (it) => it.confidence && Object.values(it.confidence).some((v) => v === "Low");
let _galEsc = null; // current Esc handler, so we don't stack listeners on re-render

// Fade each thumbnail in over its shimmer once the image has loaded, so the
// grid layout never jumps as photos arrive.
function fadeInImages(container) {
  container.querySelectorAll(".thumb").forEach((thumb) => {
    const img = thumb.querySelector("img");
    if (!img) { thumb.classList.add("loaded"); return; }
    if (img.complete) thumb.classList.add("loaded");
    else img.addEventListener("load", () => thumb.classList.add("loaded"), { once: true });
  });
}

// Small inline icons for a cleaner, premium toolbar.
const ICON = {
  filter: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8 12.5l2.5 2.5L16 9"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  kebab: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`,
  up: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>`,
};

// A reusable bottom sheet (filters, status picker, more-actions menu).
// (openBottomSheet now lives in ui.js — imported above.)

// Premium gallery: clean top bar (search · filters · select), active-filter
// pills, and a contextual selection action bar (replaces the app nav while
// selecting). Tapping a card opens the editor; tapping its photo the lightbox.
async function renderGallery(view, caps) {
  const canEdit = !!caps.can_edit;
  const canDelete = !!caps.can_delete;
  const appNav = document.querySelector(".bottomnav");
  if (appNav) appNav.style.display = ""; // restore if a prior selection hid it
  view.innerHTML = skeletonGrid();
  await loadRefData(); // category tree + field definitions drive the card summary
  const { data, error } = await supabase
    .from("items")
    .select("id, name, brand, sku, price, status, image_path, attributes, confidence, category_id, created_at, categories(name)")
    .order("created_at", { ascending: false })
    .limit(GALLERY_LIMIT);

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

  view.innerHTML = `
    <div class="galtop">
      <div class="ghdr" id="hdrNormal">
        <input id="q" class="fb-search" type="search" placeholder="Search…" value="${esc(galState.q)}">
        <button class="iconbtn" id="filterBtn" aria-label="Filters">${ICON.filter}<span class="fdot" id="fdot" hidden></span></button>
        ${canEdit ? `<button class="iconbtn" id="selectBtn" aria-label="Select">${ICON.check}</button>` : ""}
      </div>
      <div class="ghdr ghdr-sel" id="hdrSelect" hidden>
        <button class="iconbtn" id="selExit" aria-label="Cancel">${ICON.x}</button>
        <span class="selcount" id="selCount" aria-live="polite">0 selected</span>
        <span class="spacer"></span>
        <button class="linkbtn" id="selAll">Select all</button>
      </div>
      <div class="active-pills" id="pills"></div>
      <div class="count" id="count"></div>
    </div>
    <div class="grid" id="grid"></div>
    ${canEdit ? `<div class="actionbar" id="actionbar" hidden>
      <button class="ab-btn" id="abAi"><span class="ab-ico">✨</span>AI-fill</button>
      <button class="ab-btn" id="abEdit"><span class="ab-ico">✎</span>Edit</button>
      <button class="ab-btn" id="abMore"><span class="ab-ico">⋯</span>More</button>
      <button class="ab-btn" id="abDone"><span class="ab-ico">✓</span>Done</button>
    </div>` : ""}`;

  const grid = view.querySelector("#grid");
  const countEl = view.querySelector("#count");
  const pillsEl = view.querySelector("#pills");
  const qEl = view.querySelector("#q");
  const hdrNormal = view.querySelector("#hdrNormal");
  const hdrSelect = view.querySelector("#hdrSelect");
  const actionbar = view.querySelector("#actionbar");
  let q = galState.q;
  let stFilter = galState.stFilter;
  let dtFilter = galState.dtFilter;
  let needsReview = galState.needsReview;
  let filtered = []; // current filtered rows, used by bulk actions

  // Re-render after an edit/bulk action without losing the user's scroll place.
  const refresh = () => {
    const y = window.scrollY;
    return renderGallery(view, caps).then(() => window.scrollTo(0, y));
  };

  // ---- selection mode (phone-gallery style multi-select) ----
  const byId = Object.fromEntries(data.map((d) => [d.id, d]));
  const selected = new Set();
  let selectionMode = false;

  function updateSelBar() {
    const n = selected.size;
    const c = hdrSelect.querySelector("#selCount");
    if (c) c.textContent = `${n} selected`;
    ["abAi", "abEdit", "abMore"].forEach((id) => {
      const el = view.querySelector("#" + id);
      if (el) el.disabled = n === 0;
    });
  }
  function enterSelection() {
    if (!canEdit) return;
    selectionMode = true;
    navigator.vibrate?.(15); // subtle "grab" feedback on mobile
    grid.classList.add("selecting");
    hdrNormal.hidden = true;
    hdrSelect.hidden = false;
    pillsEl.hidden = true;
    countEl.hidden = true;
    if (actionbar) actionbar.hidden = false;
    if (appNav) appNav.style.display = "none"; // one bottom bar at a time
    updateSelBar();
  }
  function exitSelection() {
    selectionMode = false;
    selected.clear();
    grid.classList.remove("selecting");
    grid.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    hdrSelect.hidden = true;
    hdrNormal.hidden = false;
    pillsEl.hidden = false;
    countEl.hidden = false;
    if (actionbar) actionbar.hidden = true;
    if (appNav) appNav.style.display = "";
  }
  function clearSel() {
    selected.clear();
    grid.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    updateSelBar();
  }
  function toggleSelect(id, cardEl) {
    if (selected.has(id)) { selected.delete(id); cardEl?.classList.remove("selected"); }
    else { selected.add(id); cardEl?.classList.add("selected"); }
    navigator.vibrate?.(8);
    updateSelBar();
  }

  // Status badge colour per workflow state.
  const stClass = { draft: "st-draft", "needs-review": "st-review", approved: "st-ok", flag: "st-flag" };

  function draw() {
    const cutoff = dateCutoff(dtFilter);
    const rows = data.filter((it) => {
      if (stFilter !== "all" && it.status !== stFilter) return false;
      if (needsReview && !(it.status === "flag" || it.status === "needs-review" || hasLowConf(it))) return false;
      if (cutoff && (!it.created_at || new Date(it.created_at) < cutoff)) return false;
      if (!q) return true;
      const hay = [it.brand, it.name, it.sku, it.categories?.name,
        ...Object.values(it.attributes || {})].join(" ").toLowerCase();
      return hay.includes(q);
    });
    filtered = rows; // expose current filtered set for bulk actions
    galState.q = q; galState.stFilter = stFilter; galState.dtFilter = dtFilter; galState.needsReview = needsReview; // remember for the session

    // Note when the load hit the row cap so a truncated set never looks complete.
    const capped = data.length >= GALLERY_LIMIT;
    const countNote = capped ? ` · <span class="cap-note">showing the first ${GALLERY_LIMIT.toLocaleString()} — refine to see all</span>` : "";

    // Search/filters matched nothing — show an actionable empty state rather than
    // a blank grid. (The "no items at all" case is handled earlier, on load.)
    if (rows.length === 0) {
      countEl.innerHTML = `0 of ${data.length} item${data.length === 1 ? "" : "s"}${countNote}`;
      grid.innerHTML = `<div class="empty"><div class="big">🔍</div>
        <div>No items match your search or filters.</div>
        <button class="ghost" id="clearFiltersBtn" style="margin-top:10px">Clear filters</button></div>`;
      grid._slides = [];
      grid.querySelector("#clearFiltersBtn").onclick = () => {
        q = ""; stFilter = "all"; dtFilter = "all"; needsReview = false;
        if (qEl) qEl.value = "";
        draw(); pills();
      };
      return;
    }

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
          ${inner}<span class="selcheck">✓</span>${hasLowConf(it) ? '<span class="lowdot" title="Has a low-confidence field"></span>' : ""}</div>`;
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
    countEl.innerHTML = `${rows.length} of ${data.length} item${data.length === 1 ? "" : "s"}${countNote}`;
    grid._slides = slides;
    fadeInImages(grid);
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
    if (card) openEditor(card.dataset.id, caps, refresh);
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

  // ---- active filter pills + filters sheet ----
  function pills() {
    const out = [];
    if (needsReview) out.push(`<button class="apill" data-clear="nr">Needs review ✕</button>`);
    if (stFilter !== "all") out.push(`<button class="apill" data-clear="st">Status: ${esc(stFilter)} ✕</button>`);
    if (dtFilter !== "all") {
      const lbl = DATE_FILTERS.find((d) => d.v === dtFilter)?.label || dtFilter;
      out.push(`<button class="apill" data-clear="dt">${esc(lbl)} ✕</button>`);
    }
    pillsEl.innerHTML = out.join("");
    const dot = view.querySelector("#fdot");
    if (dot) dot.hidden = stFilter === "all" && dtFilter === "all" && !needsReview;
  }
  pillsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear]");
    if (!b) return;
    if (b.dataset.clear === "st") stFilter = "all";
    else if (b.dataset.clear === "dt") dtFilter = "all";
    else if (b.dataset.clear === "nr") needsReview = false;
    draw(); pills();
  });

  function openFilters() {
    const body = `
      <div class="sheet-sec">Review</div>
      <div class="chips"><button class="schip ${needsReview ? "on" : ""}" data-nr>Needs review (flagged / low-confidence)</button></div>
      <div class="sheet-sec">Status</div>
      <div class="chips">${STATUSES.map((s) => `<button class="schip ${stFilter === s ? "on" : ""}" data-st="${s}">${s === "all" ? "All" : esc(s)}</button>`).join("")}</div>
      <div class="sheet-sec">Added</div>
      <div class="chips">${DATE_FILTERS.map((d) => `<button class="schip ${dtFilter === d.v ? "on" : ""}" data-dt="${d.v}">${esc(d.label)}</button>`).join("")}</div>
      <button class="ghost sheet-clear" data-fclear>Clear filters</button>`;
    const sh = openBottomSheet("Filters", body);
    sh.body.addEventListener("click", (e) => {
      const st = e.target.closest("[data-st]");
      const dt = e.target.closest("[data-dt]");
      if (st) stFilter = st.dataset.st;
      else if (dt) dtFilter = dt.dataset.dt;
      else if (e.target.closest("[data-nr]")) needsReview = !needsReview;
      else if (e.target.closest("[data-fclear]")) { stFilter = "all"; dtFilter = "all"; needsReview = false; }
      else return;
      sh.body.querySelectorAll("[data-st]").forEach((x) => x.classList.toggle("on", x.dataset.st === stFilter));
      sh.body.querySelectorAll("[data-dt]").forEach((x) => x.classList.toggle("on", x.dataset.dt === dtFilter));
      sh.body.querySelector("[data-nr]")?.classList.toggle("on", needsReview);
      draw(); pills();
    });
  }

  // ---- wiring: top bar ----
  qEl.addEventListener("input", () => { q = qEl.value.trim().toLowerCase(); draw(); });
  view.querySelector("#filterBtn").onclick = openFilters;
  const selectBtn = view.querySelector("#selectBtn");
  if (selectBtn) selectBtn.onclick = enterSelection;

  // Bulk-edit common fields across the selection. Only the fields you fill are
  // applied; category-specific fields appear when the whole selection is one
  // category. Cost is gated by can_view_cost.
  function openBulkEdit() {
    if (!selected.size) return;
    const ids = [...selected];
    const items = ids.map((id) => byId[id]).filter(Boolean);
    const cats = new Set(items.map((it) => it.category_id));
    const sameCat = cats.size === 1 ? [...cats][0] : null;
    const catFields = sameCat ? resolveFields(sameCat) : [];
    const canCost = !!caps.can_view_cost;
    const UNCH = "— unchanged —";

    let body = `
      <div class="be-note muted">Only the fields you fill are applied to the ${ids.length} selected item${ids.length === 1 ? "" : "s"}.</div>
      <div class="cm-label">Status</div>
      <select id="be-status"><option value="">${UNCH}</option>${["draft", "needs-review", "approved", "flag"].map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
      <div class="cm-label">Brand</div>
      <input id="be-brand" list="dl-brand" placeholder="${UNCH}">
      <datalist id="dl-brand">${vocabSuggestions("brand").map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
      <div class="cm-label">Retail price</div>
      <input id="be-price" type="number" inputmode="decimal" placeholder="${UNCH}">
      ${canCost ? `<div class="cm-label">Cost price</div><input id="be-cost" type="number" inputmode="decimal" placeholder="${UNCH}">` : ""}
      <div class="cm-label">Stock quantity</div>
      <input id="be-stock" type="number" inputmode="numeric" placeholder="${UNCH}">
      <div class="cm-label">Reorder level</div>
      <input id="be-reorder" type="number" inputmode="numeric" placeholder="${UNCH}">`;

    if (sameCat && catFields.length) {
      body += `<div class="sheet-sec">${esc(categoryPath(sameCat))} fields</div>`;
      for (const f of catFields) {
        body += `<div class="cm-label">${esc(f.label)}</div>`;
        if (f.type === "select" && Array.isArray(f.options) && f.options.length) {
          body += `<select class="be-attr" data-key="${esc(f.key)}" data-type="${esc(f.type)}" data-vocab="${esc(f.vocab || "")}"><option value="">${UNCH}</option>${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;
        } else {
          const t = f.type === "number" ? "number" : "text";
          const dl = f.vocab ? ` list="be-dl-${esc(f.vocab)}"` : "";
          body += `<input class="be-attr" data-key="${esc(f.key)}" data-type="${esc(f.type)}" data-vocab="${esc(f.vocab || "")}" type="${t}"${dl} placeholder="${UNCH}">`;
          if (f.vocab) body += `<datalist id="be-dl-${esc(f.vocab)}">${vocabSuggestions(f.vocab).map((o) => `<option value="${esc(o)}">`).join("")}</datalist>`;
        }
      }
    } else if (cats.size > 1) {
      body += `<div class="be-note muted">Category-specific fields are hidden because the selection spans multiple categories.</div>`;
    }
    body += `<button class="primary up-go" id="be-apply">Apply to ${ids.length} item${ids.length === 1 ? "" : "s"}</button>`;

    const sh = openBottomSheet("Edit selected", body);
    sh.body.querySelector("#be-apply").onclick = async () => {
      const col = {};
      const st = sh.body.querySelector("#be-status").value;
      if (st) col.status = st;
      const brand = sh.body.querySelector("#be-brand").value.trim();
      if (brand) col.brand = normalizeValue("brand", brand);
      const price = sh.body.querySelector("#be-price").value.trim();
      if (price !== "") col.price = Number(price);
      const stock = sh.body.querySelector("#be-stock").value.trim();
      if (stock !== "") col.stock_quantity = Number(stock);
      const reorder = sh.body.querySelector("#be-reorder").value.trim();
      if (reorder !== "") col.reorder_level = Number(reorder);
      const costEl = sh.body.querySelector("#be-cost");
      const costVal = costEl && costEl.value.trim() !== "" ? Number(costEl.value.trim()) : undefined;

      const attrChanges = {};
      sh.body.querySelectorAll(".be-attr").forEach((el) => {
        let v = el.value.trim();
        if (v === "") return;
        if (el.dataset.vocab) v = normalizeValue(el.dataset.vocab, v);
        attrChanges[el.dataset.key] = el.dataset.type === "number" ? Number(v) : v;
      });

      if (!Object.keys(col).length && costVal === undefined && !Object.keys(attrChanges).length) {
        toast("Enter at least one field to apply."); return;
      }
      sh.close();
      try {
        if (Object.keys(col).length) {
          const { error } = await supabase.from("items").update(col).in("id", ids);
          if (error) throw error;
        }
        if (costVal !== undefined) {
          const { error } = await supabase.from("item_costs")
            .upsert(ids.map((id) => ({ item_id: id, cost_price: costVal })), { onConflict: "item_id" });
          if (error) throw error;
        }
        if (Object.keys(attrChanges).length) {
          // jsonb attributes must merge per item (each has its own existing values).
          for (const it of items) {
            const merged = { ...(it.attributes || {}), ...attrChanges };
            const { error } = await supabase.from("items").update({ attributes: merged }).eq("id", it.id);
            if (error) throw error;
          }
        }
        toast(`Updated ${ids.length} item${ids.length === 1 ? "" : "s"}`);
      } catch (e) {
        toast("Bulk edit failed: " + (e.message || e));
      }
      refresh();
    };
  }

  // ---- wiring: selection header + action bar ----
  if (canEdit) {
    view.querySelector("#selExit").onclick = exitSelection;
    view.querySelector("#abDone").onclick = exitSelection; // exit from the bottom too
    view.querySelector("#selAll").onclick = () => {
      for (const it of filtered) selected.add(it.id);
      grid.querySelectorAll(".card[data-id]").forEach((c) => c.classList.add("selected"));
      updateSelBar();
    };
    view.querySelector("#abAi").onclick = () => {
      if (!selected.size) return;
      const items = [...selected].map((id) => byId[id]).filter(Boolean);
      openBulkAi(items, caps, refresh);
    };
    view.querySelector("#abEdit").onclick = openBulkEdit;
    view.querySelector("#abMore").onclick = () => {
      if (!selected.size) return;
      const body = `
        <button class="menu-item" data-clearsel>Clear selection</button>
        ${canDelete ? `<button class="menu-item danger" data-del>Delete ${selected.size} item(s)</button>` : ""}`;
      const sh = openBottomSheet("More actions", body);
      sh.body.addEventListener("click", async (e) => {
        if (e.target.closest("[data-clearsel]")) { sh.close(); clearSel(); return; }
        if (e.target.closest("[data-del]")) {
          const ids = [...selected];
          const ok = await confirmSheet({
            title: `Delete ${ids.length} item${ids.length === 1 ? "" : "s"}?`,
            message: "The selected items and their photos will be permanently deleted. This cannot be undone.",
            confirmText: "Delete",
            danger: true,
          });
          if (!ok) return;
          sh.close();
          const paths = ids.map((id) => byId[id]?.image_path).filter(Boolean);
          const { error } = await supabase.from("items").delete().in("id", ids);
          if (error) { toast("Delete failed: " + error.message); return; }
          if (paths.length) await supabase.storage.from("product-images").remove(paths);
          toast(`Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}`);
          refresh();
        }
      });
    };
  }

  // Esc exits selection mode (the lightbox handles its own Esc). Replace any
  // prior handler so listeners don't accumulate across re-renders.
  if (_galEsc) document.removeEventListener("keydown", _galEsc);
  // Esc exits selection — but not while a sheet/dialog is open (it owns Esc then).
  _galEsc = (e) => { if (e.key === "Escape" && selectionMode && !anyOverlayOpen()) exitSelection(); };
  document.addEventListener("keydown", _galEsc);

  draw();
  pills();
}

// ---- Find tab: faceted finder (AND across facets / OR within), group-by, saved views ----
// Saved views live in the `saved_views` table (per-user), so they sync across devices.
async function renderFind(view, caps) {
  view.innerHTML = skeletonGrid();
  await loadRefData();
  const { data, error } = await supabase
    .from("items")
    .select("id, name, brand, sku, price, status, image_path, attributes, category_id, created_at")
    .order("created_at", { ascending: false })
    .limit(FIND_LIMIT);
  if (error) {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div><div>Couldn't load items.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message)}</div></div>`;
    return;
  }

  // This user's saved views (empty if the table isn't there yet).
  const { data: svData } = await supabase.from("saved_views").select("id, name, payload").order("created_at");
  let savedViews = svData || [];

  // Signed thumbnails (batched).
  const paths = data.filter((d) => d.image_path).map((d) => d.image_path);
  const signed = {};
  if (paths.length) {
    const { data: urls } = await supabase.storage.from("product-images").createSignedUrls(paths, 3600);
    (urls || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
  }

  // The value of a given facet key for an item.
  const valueOf = (it, key) => {
    if (key === "brand") return it.brand || "";
    if (key === "status") return it.status || "";
    if (key === "top") return (categoryPath(it.category_id) || "").split(" › ")[0] || "";
    if (key === "category") return (categoryPath(it.category_id) || "").split(" › ").pop() || "";
    const v = it.attributes?.[key];
    return v === null || v === undefined ? "" : String(v);
  };

  // Build the facet list: base fields + every attribute key present, keeping
  // only facets that actually have ≥2 distinct values (otherwise nothing to filter).
  const attrKeys = [...new Set(data.flatMap((it) => Object.keys(it.attributes || {})))];
  const candidates = [
    { key: "top", label: "Top category" },
    { key: "category", label: "Category" },
    { key: "brand", label: "Brand" },
    { key: "status", label: "Status" },
    ...attrKeys.map((k) => ({ key: k, label: fieldLabel(k) })),
  ];
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const facets = [];
  for (const f of candidates) {
    const values = [...new Set(data.map((it) => valueOf(it, f.key)).filter(Boolean))].sort(cmp);
    if (values.length >= 2) facets.push({ ...f, values });
  }
  const facetByKey = Object.fromEntries(facets.map((f) => [f.key, f]));

  const active = {}; // facetKey -> Set(values); AND across keys, OR within a key
  const facetFilter = {}; // facetKey -> typed text to narrow that facet's chips
  let q = "";
  let groupBy = "none";
  let priceMin = "", priceMax = "", datePreset = "all"; // range filters

  view.innerHTML = `
    <div class="find">
      <input id="fq" class="fb-search" type="search" placeholder="Search…">
      <div class="find-row">
        <select id="groupBy">
          <option value="none">No grouping</option>
          ${facets.map((f) => `<option value="${f.key}">Group: ${esc(f.label)}</option>`).join("")}
        </select>
        <button class="ghost" id="saveViewBtn">★ Save view</button>
      </div>
      <div class="find-ranges">
        <input id="pMin" class="rng" type="number" inputmode="numeric" placeholder="Min price">
        <input id="pMax" class="rng" type="number" inputmode="numeric" placeholder="Max price">
        <select id="dPreset">${DATE_FILTERS.map((d) => `<option value="${d.v}">${d.label}</option>`).join("")}</select>
      </div>
      <div class="saved-views" id="savedViews"></div>
      <div class="active-chips" id="activeChips"></div>
      <div class="count" id="fcount"></div>
      <div class="facets" id="facets"></div>
      <div class="find-results" id="findResults"></div>
    </div>`;

  const fq = view.querySelector("#fq");
  const groupSel = view.querySelector("#groupBy");
  const facetsEl = view.querySelector("#facets");
  const activeChipsEl = view.querySelector("#activeChips");
  const resultsEl = view.querySelector("#findResults");
  const countEl = view.querySelector("#fcount");
  const savedEl = view.querySelector("#savedViews");
  const pMin = view.querySelector("#pMin");
  const pMax = view.querySelector("#pMax");
  const dPreset = view.querySelector("#dPreset");

  const textMatch = (it) =>
    !q || [it.brand, it.name, it.sku, ...Object.values(it.attributes || {})].join(" ").toLowerCase().includes(q);
  function matches(it, excludeKey) {
    if (!textMatch(it)) return false;
    if (priceMin !== "" && (it.price == null || it.price < Number(priceMin))) return false;
    if (priceMax !== "" && (it.price == null || it.price > Number(priceMax))) return false;
    const cutoff = dateCutoff(datePreset);
    if (cutoff && (!it.created_at || new Date(it.created_at) < cutoff)) return false;
    for (const k in active) {
      if (k === excludeKey) continue;
      const set = active[k];
      if (set && set.size && !set.has(valueOf(it, k))) return false;
    }
    return true;
  }

  function cardHtml(it, slides) {
    const url = signed[it.image_path];
    let slot = -1;
    const variant = summarizeItem(it);
    const title = it.brand || it.name || "—";
    if (url) { slot = slides.length; slides.push({ url, caption: esc([title, variant].filter(Boolean).join(" · ")) }); }
    const thumb = url
      ? `<div class="thumb" data-slide="${slot}"><img loading="lazy" src="${url}" alt="${esc(title)}"></div>`
      : `<div class="thumb"><span style="color:var(--muted);font-size:12px">no image</span></div>`;
    return `<div class="card" data-id="${it.id}">${thumb}<div class="body">
      <div class="cbrand">${esc(title)}</div>
      ${variant ? `<div class="cattr">${esc(variant)}</div>` : ""}
      ${it.price != null ? `<div class="cprice">${fmtPrice(it.price)}</div>` : ""}
    </div></div>`;
  }

  function renderActiveChips() {
    const chips = [];
    for (const k in active) for (const v of active[k]) {
      chips.push(`<button class="achip" data-facet="${esc(k)}" data-val="${esc(v)}">${esc(facetByKey[k]?.label || k)}: ${esc(v)} ✕</button>`);
    }
    activeChipsEl.innerHTML = chips.length
      ? chips.join("") + `<button class="achip clear" id="clearAll">Clear all</button>`
      : "";
  }

  function renderFacets() {
    facetsEl.innerHTML = facets.map((f) => {
      const sel = active[f.key];
      const ff = facetFilter[f.key] || "";
      // Counts reflect all OTHER active facets (standard faceted counts).
      const base = data.filter((it) => matches(it, f.key));
      const counts = {};
      for (const it of base) { const v = valueOf(it, f.key); if (v) counts[v] = (counts[v] || 0) + 1; }
      const chips = f.values.map((v) => {
        const on = sel?.has(v);
        const n = counts[v] || 0;
        if (n === 0 && !on) return ""; // hide values that can't combine with current filters
        const hide = ff && !v.toLowerCase().includes(ff); // type-to-filter
        return `<button class="chip ${on ? "on" : ""}"${hide ? ' style="display:none"' : ""} data-facet="${esc(f.key)}" data-val="${esc(v)}">${esc(v)} <span class="chipn">${n}</span></button>`;
      }).join("");
      // Only long facets get a type-to-filter box.
      const filterInput = f.values.length > 8
        ? `<input class="facet-filter" type="search" data-facet="${esc(f.key)}" placeholder="Type to filter ${esc(f.label.toLowerCase())}…" value="${esc(ff)}">`
        : "";
      const badge = sel?.size ? ` <span class="gcount">${sel.size}</span>` : "";
      return `<details class="facet"${sel?.size || ff ? " open" : ""}><summary>${esc(f.label)}${badge}</summary>${filterInput}<div class="chips">${chips}</div></details>`;
    }).join("");
  }

  function renderResults() {
    const results = data.filter((it) => matches(it, null));
    const capped = data.length >= FIND_LIMIT;
    const countNote = capped ? ` · <span class="cap-note">showing the first ${FIND_LIMIT.toLocaleString()} — refine to see all</span>` : "";
    countEl.innerHTML = `${results.length} result${results.length === 1 ? "" : "s"}${countNote}`;
    const slides = [];
    let html;
    if (groupBy === "none") {
      html = `<div class="grid">${results.map((it) => cardHtml(it, slides)).join("")}</div>`;
    } else {
      const groups = new Map();
      for (const it of results) {
        const g = valueOf(it, groupBy) || "—";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(it);
      }
      html = [...groups.keys()].sort(cmp).map((g) =>
        `<details class="grp grp1" open><summary>${esc(g)} <span class="gcount">${groups.get(g).length}</span></summary>
          <div class="grid">${groups.get(g).map((it) => cardHtml(it, slides)).join("")}</div></details>`
      ).join("");
    }
    if (results.length) {
      resultsEl.innerHTML = html;
    } else {
      // Offer a reset only if something is actually narrowing the results.
      const anyFilter = q || priceMin || priceMax || datePreset !== "all"
        || Object.keys(active).some((k) => active[k]?.size);
      resultsEl.innerHTML = `<div class="empty"><div class="big">🔍</div>
        <div>No matches.</div>
        ${anyFilter ? `<button class="ghost" id="fClear" style="margin-top:10px">Clear all filters</button>` : ""}</div>`;
      const fc = resultsEl.querySelector("#fClear");
      if (fc) fc.onclick = () => {
        for (const k in active) delete active[k];
        q = ""; fq.value = "";
        priceMin = ""; pMin.value = "";
        priceMax = ""; pMax.value = "";
        datePreset = "all"; dPreset.value = "all";
        refresh();
      };
    }
    resultsEl._slides = slides;
    fadeInImages(resultsEl);
  }

  function renderSavedViews() {
    savedEl.innerHTML = savedViews
      .map((v) => `<span class="sview" data-apply="${v.id}">${esc(v.name)}<span class="sx" data-del="${v.id}">✕</span></span>`)
      .join("");
  }

  const refresh = () => { renderActiveChips(); renderFacets(); renderResults(); };

  function toggleVal(key, val) {
    if (!active[key]) active[key] = new Set();
    if (active[key].has(val)) { active[key].delete(val); if (!active[key].size) delete active[key]; }
    else active[key].add(val);
    refresh();
  }

  facetsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-facet]");
    if (chip) toggleVal(chip.dataset.facet, chip.dataset.val);
  });
  // Type-to-filter a facet's chips in place (keeps focus / keyboard open).
  facetsEl.addEventListener("input", (e) => {
    const inp = e.target.closest(".facet-filter");
    if (!inp) return;
    const key = inp.dataset.facet;
    const t = inp.value.trim().toLowerCase();
    facetFilter[key] = t;
    inp.closest(".facet").querySelectorAll(".chip[data-facet]").forEach((c) => {
      c.style.display = c.dataset.val.toLowerCase().includes(t) ? "" : "none";
    });
  });
  activeChipsEl.addEventListener("click", (e) => {
    if (e.target.closest("#clearAll")) { for (const k in active) delete active[k]; refresh(); return; }
    const chip = e.target.closest(".achip[data-facet]");
    if (chip) toggleVal(chip.dataset.facet, chip.dataset.val);
  });
  resultsEl.addEventListener("click", (e) => {
    const thumb = e.target.closest(".thumb[data-slide]");
    if (thumb) { openLightbox(resultsEl._slides, Number(thumb.dataset.slide)); return; }
    const card = e.target.closest(".card[data-id]");
    if (card) openEditor(card.dataset.id, caps, () => {
      const y = window.scrollY;
      return renderFind(view, caps).then(() => window.scrollTo(0, y)); // keep place after edit
    });
  });
  fq.addEventListener("input", () => { q = fq.value.trim().toLowerCase(); refresh(); });
  groupSel.addEventListener("change", () => { groupBy = groupSel.value; renderResults(); });
  pMin.addEventListener("input", () => { priceMin = pMin.value.trim(); refresh(); });
  pMax.addEventListener("input", () => { priceMax = pMax.value.trim(); refresh(); });
  dPreset.addEventListener("change", () => { datePreset = dPreset.value; refresh(); });

  // Saved views (cloud-synced via the saved_views table; per-user).
  view.querySelector("#saveViewBtn").onclick = async () => {
    const name = await promptSheet({
      title: "Save this view",
      label: "View name",
      placeholder: "e.g. Low stock, New arrivals",
      confirmText: "Save view",
    });
    if (!name) return;
    const serial = {};
    for (const k in active) serial[k] = [...active[k]];
    const payload = { active: serial, q, groupBy, priceMin, priceMax, datePreset };
    const { data, error } = await supabase.from("saved_views")
      .insert({ name, payload }).select("id, name, payload").single();
    if (error) { toast("Couldn't save view: " + error.message); return; }
    savedViews.push(data);
    renderSavedViews();
    toast("View saved");
  };
  savedEl.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      const sv = savedViews.find((x) => x.id === id);
      const ok = await confirmSheet({
        title: "Delete saved view?",
        message: sv ? `“${sv.name}” will be removed from all your devices.` : "",
        confirmText: "Delete",
        danger: true,
      });
      if (!ok) return;
      const { error } = await supabase.from("saved_views").delete().eq("id", id);
      if (error) { toast("Couldn't delete view: " + error.message); return; }
      savedViews = savedViews.filter((v) => v.id !== id);
      renderSavedViews();
      toast("View deleted");
      return;
    }
    const sv = e.target.closest(".sview[data-apply]");
    if (!sv) return;
    const v = savedViews.find((x) => x.id === sv.dataset.apply);
    if (!v) return;
    const p = v.payload || {};
    for (const k in active) delete active[k];
    for (const k in (p.active || {})) active[k] = new Set(p.active[k]);
    q = p.q || ""; fq.value = q;
    groupBy = p.groupBy || "none"; groupSel.value = facetByKey[groupBy] ? groupBy : "none";
    priceMin = p.priceMin || ""; pMin.value = priceMin;
    priceMax = p.priceMax || ""; pMax.value = priceMax;
    datePreset = p.datePreset || "all"; dPreset.value = datePreset;
    refresh();
  });

  renderSavedViews();
  refresh();
}

// Fallback for any unrouted nav id (all current tabs are implemented).
function renderComingSoon(view, id) {
  view.innerHTML = `<div class="empty"><div class="big">🚧</div>
    <div>${esc(id)} is coming soon.</div></div>`;
}

// ---------------------------------------------------------------------------
// Lightbox — a single reusable overlay with keyboard + swipe navigation.
// ---------------------------------------------------------------------------
let lbState = { slides: [], i: 0, el: null };

function ensureLightbox() {
  if (lbState.el) return lbState.el;
  const lb = document.createElement("div");
  lb.id = "lb";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-label", "Image viewer");
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
  lbState.release = trapFocus(lbState.el); // keep focus in the viewer; restore on close
  requestAnimationFrame(() => lbState.el.querySelector(".lb-close")?.focus());
}
function closeLightbox() {
  lbState.release?.();
  lbState.release = null;
  lbState.el?.classList.remove("open");
}
function moveLightbox(d) {
  const n = lbState.slides.length;
  if (!n) return;
  lbState.i = (lbState.i + d + n) % n;
  paintLightbox();
}
function paintLightbox() {
  const s = lbState.slides[lbState.i];
  if (!s) return;
  const img = lbState.el.querySelector("#lbimg");
  img.src = s.url;
  img.alt = s.caption || "Product photo"; // describe the image for screen readers
  lbState.el.querySelector("#lbcap").innerHTML =
    `${s.caption} <span style="color:var(--muted)">· ${lbState.i + 1}/${lbState.slides.length}</span>`;
}
