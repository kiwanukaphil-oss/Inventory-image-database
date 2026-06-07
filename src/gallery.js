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
import { installAvailable, canPromptInstall, promptInstall, isIOS } from "./install.js";

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
  { id: "review", label: "Review", ico: "⚑", badge: true },
  { id: "export", label: "Export", ico: "⤓" },
];

// Update the Review tab's count badge (needs-review + low-confidence items).
function setReviewBadge(count) {
  const b = document.getElementById("reviewBadge");
  if (!b) return;
  b.textContent = count > 99 ? "99+" : String(count);
  b.hidden = !count;
}

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
    (n) => `<button data-view="${n.id}"><span class="ico">${n.ico}</span>${n.label}${
      n.badge ? `<span class="navbadge" id="reviewBadge" hidden></span>` : ""
    }</button>`
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
    else if (id === "review") renderReview(view, caps);
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
    const install = installAvailable() ? `<button class="menu-item" data-m="install">Install app</button>` : "";
    const sh = openBottomSheet(caps.email || "Account",
      `<div class="menu-sub">Signed in as ${esc(role)}</div>
       ${admin}
       ${install}
       <button class="menu-item danger" data-m="signout">Sign out</button>`);
    sh.body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-m]");
      if (!b) return;
      if (b.dataset.m === "install") { sh.close(); installApp(); return; }
      sh.close();
      if (b.dataset.m === "users") openUsers(caps);
      else if (b.dataset.m === "cats") openCategoryManager(caps);
      else if (b.dataset.m === "settings") openSettings();
      else if (b.dataset.m === "signout") { await signOut(); onSignOut(); }
    });
  };

  // Install to home screen: use the native prompt where available, otherwise
  // (iOS Safari) show the manual Share-sheet instructions.
  async function installApp() {
    if (canPromptInstall()) {
      const accepted = await promptInstall();
      if (accepted) toast("Installing K-LINE MEN…");
    } else if (isIOS()) {
      await confirmSheet({
        title: "Add to Home Screen",
        message: "In Safari, tap the Share button, then choose “Add to Home Screen” to install K-LINE MEN.",
        confirmText: "Got it",
        cancelText: "Close",
      });
    }
  }

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

// TODO(remove): no longer used since Status became a facet in the unified browse
// surface (Step 4). Kept briefly in case a status quick-filter is wanted back.
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

// Sort options for the unified browse surface.
const SORTS = [
  { v: "new", label: "Newest first" },
  { v: "old", label: "Oldest first" },
  { v: "price-desc", label: "Price: high → low" },
  { v: "price-asc", label: "Price: low → high" },
  { v: "stock-asc", label: "Stock: low → high" },
  { v: "stock-desc", label: "Stock: high → low" },
  { v: "brand", label: "Brand A–Z" },
];

// Session-remembered view state, kept separate per surface so the Gallery and
// Review tabs don't clobber each other's search/filters/sort. `active` holds
// facet selections serialised as arrays (rehydrated to Sets on render).
const browseState = {
  gallery: { q: "", needsReview: false, sortBy: "new", priceMin: "", priceMax: "", datePreset: "all", active: {} },
  review:  { q: "", needsReview: true,  sortBy: "new", priceMin: "", priceMax: "", datePreset: "all", active: {} },
};

// True if an item has any field marked Low confidence.
const hasLowConf = (it) => it.confidence && Object.values(it.confidence).some((v) => v === "Low");
// Triage predicate: flagged / explicitly needs-review / has a low-confidence field.
const needsReviewItem = (it) => it.status === "flag" || it.status === "needs-review" || hasLowConf(it);
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
async function renderGallery(view, caps, opts = {}) {
  const review = !!opts.review; // Review tab = this surface pre-filtered to triage
  const state = review ? browseState.review : browseState.gallery;
  const canEdit = !!caps.can_edit;
  const canDelete = !!caps.can_delete;
  const appNav = document.querySelector(".bottomnav");
  if (appNav) appNav.style.display = ""; // restore if a prior selection hid it
  view.innerHTML = skeletonGrid();
  await loadRefData(); // category tree + field definitions drive the card summary
  const { data, error } = await supabase
    .from("items")
    .select("id, name, brand, sku, price, stock_quantity, status, image_path, attributes, confidence, category_id, created_at, categories(name)")
    .order("created_at", { ascending: false })
    .limit(GALLERY_LIMIT);

  if (error) {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Couldn't load items.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message)}</div></div>`;
    return;
  }

  // Keep the Review tab's badge in sync on every load (any surface refreshes it).
  setReviewBadge((data || []).filter(needsReviewItem).length);

  if (!data || data.length === 0) {
    view.innerHTML = `<div class="empty"><div class="big">📭</div>
      <div>${review ? "Nothing to review." : "No items yet."}</div>
      <div style="color:var(--muted);font-size:13px">${review ? "New uploads needing attention will appear here." : "Run the seed importer or add photos."}</div></div>`;
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

  // This user's saved views (cloud-synced; empty if the table isn't there yet).
  const { data: svData } = await supabase.from("saved_views").select("id, name, payload").order("created_at");
  let savedViews = svData || [];

  // ---- faceting engine (ported from the old Find tab) ----
  // The value of a given facet key for an item.
  const valueOf = (it, key) => {
    if (key === "brand") return it.brand || "";
    if (key === "status") return it.status || "";
    if (key === "top") return (categoryPath(it.category_id) || "").split(" › ")[0] || "";
    if (key === "category") return (categoryPath(it.category_id) || "").split(" › ").pop() || "";
    const v = it.attributes?.[key];
    return v === null || v === undefined ? "" : String(v);
  };
  // Base fields + every attribute key present, keeping only facets with ≥2 values.
  const attrKeys = [...new Set(data.flatMap((it) => Object.keys(it.attributes || {})))];
  const facetCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const facets = [];
  for (const f of [
    { key: "top", label: "Top category" },
    { key: "category", label: "Category" },
    { key: "brand", label: "Brand" },
    { key: "status", label: "Status" },
    ...attrKeys.map((k) => ({ key: k, label: fieldLabel(k) })),
  ]) {
    const values = [...new Set(data.map((it) => valueOf(it, f.key)).filter(Boolean))].sort(facetCmp);
    if (values.length >= 2) facets.push({ ...f, values });
  }
  const facetByKey = Object.fromEntries(facets.map((f) => [f.key, f]));

  // ---- view state (restored from the session, per surface) ----
  let q = state.q;
  let needsReview = review ? true : state.needsReview; // Review tab forces it on
  let sortBy = state.sortBy;
  let priceMin = state.priceMin, priceMax = state.priceMax, datePreset = state.datePreset;
  const active = {}; // facetKey -> Set(values); AND across keys, OR within a key
  for (const k in (state.active || {})) if (facetByKey[k]) active[k] = new Set(state.active[k]);
  const facetFilter = {}; // facetKey -> typed text to narrow that facet's value list
  let filtered = []; // current filtered+sorted rows, for bulk actions

  view.innerHTML = `
    <div class="galtop">
      <div class="ghdr" id="hdrNormal">
        <input id="q" class="fb-search" type="search" placeholder="Search…" value="${esc(q)}">
        <button class="iconbtn" id="filterBtn" aria-label="Filters &amp; sort">${ICON.filter}<span class="fcount" id="fcount" hidden></span></button>
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
    <div class="results" id="grid"></div>
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

  // Persist the current view state for this surface (so tab switches keep place).
  const saveState = () => {
    state.q = q; state.needsReview = needsReview; state.sortBy = sortBy;
    state.priceMin = priceMin; state.priceMax = priceMax;
    state.datePreset = datePreset;
    state.active = {};
    for (const k in active) if (active[k]?.size) state.active[k] = [...active[k]];
  };

  // Re-render after an edit/bulk action without losing the user's scroll place.
  const refresh = () => {
    const y = window.scrollY;
    return renderGallery(view, caps, opts).then(() => window.scrollTo(0, y));
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

  // Free-text search across brand/name/sku/category + all attribute values.
  const textMatch = (it) => !q || [it.brand, it.name, it.sku, it.categories?.name,
    ...Object.values(it.attributes || {})].join(" ").toLowerCase().includes(q);

  // Does an item pass all active filters? excludeKey lets a facet's own counts
  // ignore its own selection (standard faceted counting).
  function matches(it, excludeKey) {
    if (!textMatch(it)) return false;
    if (needsReview && !needsReviewItem(it)) return false;
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

  // Sort comparators that always push blank (null) numbers to the end.
  const numAsc = (key) => (a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1; if (y == null) return -1;
    return x - y;
  };
  const numDesc = (key) => (a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1; if (y == null) return -1;
    return y - x;
  };
  function applySort(rows) {
    const r = rows.slice(); // data is loaded newest-first, so "new" needs no sort
    if (sortBy === "old") r.reverse();
    else if (sortBy === "price-asc") r.sort(numAsc("price"));
    else if (sortBy === "price-desc") r.sort(numDesc("price"));
    else if (sortBy === "stock-asc") r.sort(numAsc("stock_quantity"));
    else if (sortBy === "stock-desc") r.sort(numDesc("stock_quantity"));
    else if (sortBy === "brand") r.sort((a, b) =>
      (a.brand || a.name || "").localeCompare(b.brand || b.name || "", undefined, { numeric: true }));
    return r;
  }

  // Status badge colour per workflow state.
  const stClass2 = stClass; // (alias kept to minimise churn below)

  // One product card.
  function cardHtml(it, slides) {
    const url = signed[it.image_path];
    const cat = it.categories?.name || "";
    const variant = summarizeItem(it); // category-driven summary line
    const brand = it.brand || it.name || "—";
    let slideIdx = -1;
    if (url) { slideIdx = slides.length; slides.push({ url, caption: esc([brand, variant].filter(Boolean).join(" · ")) }); }
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
          <span class="stbadge ${stClass2[it.status] || ""}">${esc(it.status)}</span>
        </div>
        <div class="cbrand">${esc(brand)}</div>
        ${variant ? `<div class="cattr">${esc(variant)}</div>` : ""}
        <div class="cmeta">
          ${it.price != null ? `<span class="cprice">${fmtPrice(it.price)}</span>` : "<span></span>"}
          <span class="cdate">${fmtDate(it.created_at)}</span>
        </div>
      </div>
    </div>`;
  }

  function draw() {
    const rows = applySort(data.filter((it) => matches(it, null)));
    filtered = rows;          // expose current filtered+sorted set for bulk actions
    saveState();

    // Note when the load hit the row cap so a truncated set never looks complete.
    const capped = data.length >= GALLERY_LIMIT;
    const countNote = capped ? ` · <span class="cap-note">showing the first ${GALLERY_LIMIT.toLocaleString()} — refine to see all</span>` : "";

    // Filters matched nothing → actionable empty state (not a blank grid).
    if (rows.length === 0) {
      countEl.innerHTML = `0 of ${data.length} item${data.length === 1 ? "" : "s"}${countNote}`;
      grid.innerHTML = `<div class="empty"><div class="big">${review ? "✓" : "🔍"}</div>
        <div>${review ? "Nothing needs review right now." : "No items match your search or filters."}</div>
        ${(q || filterCount()) ? `<button class="ghost" id="clearFiltersBtn" style="margin-top:10px">Clear filters</button>` : ""}</div>`;
      grid._slides = [];
      const cf = grid.querySelector("#clearFiltersBtn");
      if (cf) cf.onclick = clearAllFilters;
      return;
    }

    // Slides for the lightbox follow the currently filtered, ordered rows.
    const slides = [];
    grid.innerHTML = `<div class="grid">${rows.map((it) => cardHtml(it, slides)).join("")}</div>`;
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

  // ---- active filters: pill strip + the "Filters & sort" sheet ----
  // How many narrowing filters are active (drives the Filters-button badge).
  function filterCount() {
    let n = 0;
    for (const k in active) if (active[k]?.size) n += active[k].size;
    if (priceMin || priceMax) n++;
    if (datePreset !== "all") n++;
    if (needsReview && !review) n++;
    return n;
  }
  // Reset filters (not sort/group, which are view options). Review keeps triage.
  function clearAllFilters() {
    q = ""; if (qEl) qEl.value = "";
    for (const k in active) delete active[k];
    for (const k in facetFilter) delete facetFilter[k];
    priceMin = ""; priceMax = ""; datePreset = "all";
    if (!review) needsReview = false;
    draw(); pills();
  }

  // The horizontal strip of removable chips below the search box.
  function pills() {
    const out = [];
    if (sortBy !== "new") out.push(`<button class="apill view" data-clear="sort">Sorted: ${esc(SORTS.find((s) => s.v === sortBy)?.label || sortBy)} ✕</button>`);
    for (const k in active) for (const v of active[k]) {
      out.push(`<button class="apill" data-facet="${esc(k)}" data-val="${esc(v)}">${esc(facetByKey[k]?.label || k)}: ${esc(v)} ✕</button>`);
    }
    if (priceMin || priceMax) out.push(`<button class="apill" data-clear="price">Price: ${esc(priceMin || "0")}–${esc(priceMax || "∞")} ✕</button>`);
    if (datePreset !== "all") out.push(`<button class="apill" data-clear="dt">${esc(DATE_FILTERS.find((d) => d.v === datePreset)?.label || datePreset)} ✕</button>`);
    pillsEl.innerHTML = out.join("");
    const badge = view.querySelector("#fcount");
    if (badge) { const n = filterCount(); badge.textContent = n; badge.hidden = !n; }
  }
  pillsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear], [data-facet]");
    if (!b) return;
    if (b.dataset.facet) active[b.dataset.facet]?.delete(b.dataset.val);
    else if (b.dataset.clear === "price") { priceMin = ""; priceMax = ""; }
    else if (b.dataset.clear === "dt") datePreset = "all";
    else if (b.dataset.clear === "sort") sortBy = "new";
    draw(); pills();
  });

  // The "Filters & sort" sheet — a clean drill-down (master list → focused
  // picker), designed for non-technical mobile users: one consistent row idiom,
  // one decision per screen, current value shown on each row. Live-applies to
  // the grid behind it; the footer shows the live result count.
  function openFilters() {
    const matchCount = () => data.filter((it) => matches(it, null)).length;
    const PRIMARY = ["category", "brand"]; // shown directly; the rest go under "More"
    const moreFacets = facets.filter((f) => !PRIMARY.includes(f.key));
    const priceLabel = () => (priceMin || priceMax)
      ? `${fmtPrice(priceMin || 0)}–${priceMax ? fmtPrice(priceMax) : "∞"}` : "Any";
    const dateLabel = () => DATE_FILTERS.find((d) => d.v === datePreset)?.label || "Any date";
    const facetSummary = (f) => {
      const sel = active[f.key];
      return sel?.size ? `${[...sel].slice(0, 2).join(", ")}${sel.size > 2 ? ` +${sel.size - 2}` : ""}` : "Any";
    };
    const moreSummary = () => {
      const n = moreFacets.reduce((s, f) => s + (active[f.key]?.size || 0), 0);
      return n ? `${n} selected` : "Any";
    };

    // ---- sheet shell with a master/detail head ----
    const el = document.createElement("div");
    el.className = "msheet filter-sheet";
    el.innerHTML = `<div class="msheet-panel" role="dialog" aria-modal="true" aria-label="Filters and sort">
        <div class="msheet-head">
          <button class="iconbtn" id="fsBack" aria-label="Back" hidden>‹</button>
          <span id="fsTitle">Filters &amp; sort</span>
          <button class="iconbtn" id="fsX" aria-label="Close">✕</button>
        </div>
        <div class="msheet-body" id="fsBody"></div>
        <div class="fs-foot">
          <button class="ghost" id="fsClear">Clear all</button>
          <button class="primary" id="fsShow"></button>
        </div>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    const release = trapFocus(el);
    const bodyEl = el.querySelector("#fsBody");
    const titleEl = el.querySelector("#fsTitle");
    const backBtn = el.querySelector("#fsBack");
    const showBtn = el.querySelector("#fsShow");

    const close = () => { document.removeEventListener("keydown", onKey); release(); el.classList.remove("open"); setTimeout(() => el.remove(), 200); };
    let currentBack = null; // where the head back-button goes (null = at master)
    const onKey = (e) => { if (e.key === "Escape" && isTopOverlay(el)) (currentBack ? currentBack() : close()); };
    document.addEventListener("keydown", onKey);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
    el.querySelector("#fsX").onclick = close;
    el.querySelector("#fsClear").onclick = () => { clearAllFilters(); showMaster(); };
    showBtn.onclick = close;

    const refreshShow = () => { const n = matchCount(); showBtn.textContent = `Show ${n} result${n === 1 ? "" : "s"}`; };
    // Apply changes to the grid behind the sheet, then refresh the footer count.
    const apply = () => { draw(); pills(); refreshShow(); };

    // Navigate into a detail view (sets the head back-target).
    function go(renderFn, backFn) { currentBack = backFn; backBtn.hidden = false; renderFn(); }
    backBtn.onclick = () => (currentBack ? currentBack() : showMaster());

    const rowLink = (id, label, val) =>
      `<button class="fs-link" data-go="${esc(id)}"><span class="fs-label">${esc(label)}</span><span class="fs-val">${esc(val)} ›</span></button>`;
    const optRow = (attrs, label, on, n) =>
      `<button class="fs-opt${on ? " on" : ""}" ${attrs}>${
        n === undefined
          ? `<span class="fs-opt-label">${esc(label)}</span>${on ? '<span class="fs-check">✓</span>' : ""}`
          : `<span class="fs-check-box${on ? " on" : ""}">${on ? "✓" : ""}</span><span class="fs-opt-label">${esc(label)}</span><span class="fs-opt-n">${n}</span>`
      }</button>`;

    // ---- MASTER list ----
    function showMaster() {
      currentBack = null; backBtn.hidden = true; titleEl.textContent = "Filters & sort";
      let html = `<div class="fs-list">${rowLink("sort", "Sort", SORTS.find((s) => s.v === sortBy)?.label || "Newest")}</div>`;
      html += `<div class="fs-list">`;
      for (const k of PRIMARY) if (facetByKey[k]) html += rowLink("facet:" + k, facetByKey[k].label, facetSummary(facetByKey[k]));
      html += rowLink("price", "Price", priceLabel());
      html += rowLink("date", "Added", dateLabel());
      html += `</div>`;
      if (moreFacets.length) html += `<div class="fs-list">${rowLink("more", "More filters", moreSummary())}</div>`;
      html += `<div class="fs-list">${rowLink("saved", "Saved views", savedViews.length ? `${savedViews.length}` : "None")}</div>`;
      bodyEl.innerHTML = html;
      refreshShow();
    }

    // ---- SORT detail (single choice) ----
    function showSort() {
      titleEl.textContent = "Sort";
      bodyEl.innerHTML = `<div class="fs-list">${SORTS.map((s) =>
        optRow(`data-sort="${s.v}"`, s.label, sortBy === s.v)).join("")}</div>`;
    }

    // ---- PRICE detail ----
    function showPrice() {
      titleEl.textContent = "Price";
      bodyEl.innerHTML = `<div class="fs-detail">
        <label class="cm-label" for="fsMin">Minimum price</label>
        <input id="fsMin" class="rng" type="number" inputmode="numeric" placeholder="No minimum" value="${esc(priceMin)}">
        <label class="cm-label" for="fsMax">Maximum price</label>
        <input id="fsMax" class="rng" type="number" inputmode="numeric" placeholder="No maximum" value="${esc(priceMax)}">
      </div>`;
      requestAnimationFrame(() => bodyEl.querySelector("#fsMin")?.focus());
    }

    // ---- ADDED (date) detail (single choice) ----
    function showDate() {
      titleEl.textContent = "Added";
      bodyEl.innerHTML = `<div class="fs-list">${DATE_FILTERS.map((d) =>
        optRow(`data-dt="${d.v}"`, d.label, datePreset === d.v)).join("")}</div>`;
    }

    // ---- MORE filters: list of the remaining facets ----
    function showMore() {
      titleEl.textContent = "More filters";
      bodyEl.innerHTML = `<div class="fs-list">${moreFacets.map((f) =>
        rowLink("facet:" + f.key, f.label, facetSummary(f))).join("")}</div>`;
    }

    // ---- FACET detail (multi-select checklist with live counts) ----
    let curFacet = null;
    function renderFacet() {
      const f = curFacet;
      const sel = active[f.key];
      const ff = facetFilter[f.key] || "";
      const base = data.filter((it) => matches(it, f.key));
      const counts = {};
      for (const it of base) { const v = valueOf(it, f.key); if (v) counts[v] = (counts[v] || 0) + 1; }
      const rows = f.values.map((v) => {
        const on = sel?.has(v); const n = counts[v] || 0;
        if (n === 0 && !on) return "";
        if (ff && !v.toLowerCase().includes(ff)) return "";
        return optRow(`data-facet="${esc(f.key)}" data-val="${esc(v)}"`, v, on, n);
      }).join("");
      const search = f.values.length > 8
        ? `<input class="facet-filter" type="search" placeholder="Search ${esc(f.label.toLowerCase())}…" value="${esc(ff)}">`
        : "";
      bodyEl.innerHTML = `<div class="fs-detail">${search}<div class="fs-list">${rows || `<div class="muted" style="padding:14px">No matches.</div>`}</div></div>`;
    }
    function showFacet(f, backFn) { curFacet = f; titleEl.textContent = f.label; go(renderFacet, backFn); }

    // ---- SAVED VIEWS detail ----
    function showSaved() {
      titleEl.textContent = "Saved views";
      const list = savedViews.length
        ? savedViews.map((v) => `<div class="fs-opt sv-row" data-apply="${v.id}">
            <span class="fs-opt-label">${esc(v.name)}</span>
            <button class="sx" data-del="${v.id}" aria-label="Delete view">✕</button></div>`).join("")
        : `<div class="muted" style="padding:14px">No saved views yet.</div>`;
      bodyEl.innerHTML = `<div class="fs-detail">
        <div class="fs-list">${list}</div>
        <button class="ghost" id="fsSaveView" style="margin-top:12px">★ Save current view</button>
      </div>`;
    }

    // ---- one delegated click handler for the whole sheet body ----
    bodyEl.addEventListener("click", async (e) => {
      const nav = e.target.closest("[data-go]");
      if (nav) {
        const id = nav.dataset.go;
        if (id === "sort") go(showSort, showMaster);
        else if (id === "price") go(showPrice, showMaster);
        else if (id === "date") go(showDate, showMaster);
        else if (id === "more") go(showMore, showMaster);
        else if (id === "saved") go(showSaved, showMaster);
        else if (id.startsWith("facet:")) {
          const f = facetByKey[id.slice(6)];
          if (f) showFacet(f, PRIMARY.includes(f.key) ? showMaster : showMore);
        }
        return;
      }
      const sort = e.target.closest("[data-sort]");
      if (sort) { sortBy = sort.dataset.sort; apply(); showMaster(); return; }
      const dt = e.target.closest("[data-dt]");
      if (dt) { datePreset = dt.dataset.dt; apply(); showMaster(); return; }
      const chip = e.target.closest("[data-facet][data-val]");
      if (chip) {
        const k = chip.dataset.facet, v = chip.dataset.val;
        (active[k] = active[k] || new Set()).has(v) ? active[k].delete(v) : active[k].add(v);
        if (!active[k].size) delete active[k];
        apply(); renderFacet(); // counts shift, so re-render this list
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        const v = savedViews.find((x) => x.id === del.dataset.del);
        const ok = await confirmSheet({ title: "Delete saved view?", message: v ? `“${v.name}” will be removed from all your devices.` : "", confirmText: "Delete", danger: true });
        if (!ok) return;
        const { error } = await supabase.from("saved_views").delete().eq("id", del.dataset.del);
        if (error) { toast("Couldn't delete view: " + error.message); return; }
        savedViews = savedViews.filter((x) => x.id !== del.dataset.del);
        showSaved(); toast("View deleted");
        return;
      }
      const applyV = e.target.closest("[data-apply]");
      if (applyV) {
        const v = savedViews.find((x) => x.id === applyV.dataset.apply);
        if (!v) return;
        const p = v.payload || {};
        for (const k in active) delete active[k];
        for (const k in (p.active || {})) if (facetByKey[k]) active[k] = new Set(p.active[k]);
        q = p.q || ""; if (qEl) qEl.value = q;
        sortBy = p.sortBy && SORTS.some((s) => s.v === p.sortBy) ? p.sortBy : "new";
        priceMin = p.priceMin || ""; priceMax = p.priceMax || ""; datePreset = p.datePreset || "all";
        apply(); showMaster(); toast(`Applied “${v.name}”`);
        return;
      }
      if (e.target.closest("#fsSaveView")) {
        const name = await promptSheet({ title: "Save this view", label: "View name", placeholder: "e.g. Low stock, New arrivals", confirmText: "Save view" });
        if (!name) return;
        const serial = {};
        for (const k in active) if (active[k]?.size) serial[k] = [...active[k]];
        const payload = { active: serial, q, sortBy, priceMin, priceMax, datePreset };
        const { data: created, error } = await supabase.from("saved_views").insert({ name, payload }).select("id, name, payload").single();
        if (error) { toast("Couldn't save view: " + error.message); return; }
        savedViews.push(created); showSaved(); toast("View saved");
      }
    });

    // price + facet-search inputs (delegated)
    bodyEl.addEventListener("input", (e) => {
      if (e.target.id === "fsMin") { priceMin = e.target.value.trim(); apply(); }
      else if (e.target.id === "fsMax") { priceMax = e.target.value.trim(); apply(); }
      else if (e.target.classList.contains("facet-filter") && curFacet) {
        facetFilter[curFacet.key] = e.target.value.trim().toLowerCase();
        renderFacet();
        const again = bodyEl.querySelector(".facet-filter");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      }
    });

    showMaster();
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


// The Review tab is the unified browse surface, pre-filtered to triage items
// (flagged / needs-review / low-confidence). Reuses renderGallery with review:true.
function renderReview(view, caps) { return renderGallery(view, caps, { review: true }); }

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
