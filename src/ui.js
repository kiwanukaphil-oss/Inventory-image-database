// =============================================================================
// ui.js — shared, app-styled UI primitives
//
// These replace the browser's native alert()/confirm()/prompt() and the toast +
// bottom-sheet helpers that were previously duplicated across modules. Keeping
// them here means every surface shares one look, one animation, and one dark
// theme — native dialogs broke all three and made an installed PWA feel like a
// raw web page.
//
// Exports: esc, toast, openBottomSheet, confirmSheet, promptSheet.
// =============================================================================

// HTML-escape any value before interpolating it into markup.
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// --- Icons ---------------------------------------------------------------
// One consistent inline-SVG line-icon vocabulary for ALL app chrome (moved here
// from gallery.js so every surface shares it — no more stray ✕/‹/✨/emoji glyphs).
export const ICON = {
  filter: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`,
  // Density toggle: `rows` shows the scan-list affordance, `grid` the card view.
  rows: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8 12.5l2.5 2.5L16 9"/></svg>`,
  tick: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4.5 4.5L19 7.5"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  kebab: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`,
  more: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.7 3.8l3.5 3.5L7.5 20 3 21l1-4.5z"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M11 4l1.8 4.7L17.5 10.5l-4.7 1.8L11 17l-1.8-4.7L4.5 10.5l4.7-1.8z"/><path d="M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`,
  fwd: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
  up: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>`,
  // ---- uploader pick buttons ----
  camera: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3.2L9 5.5h6L16.8 8H20a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9.5A1.5 1.5 0 0 1 4 8z"/><circle cx="12" cy="13.4" r="3.4"/></svg>`,
  image: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16.5l-5.5-5.5L6 20"/></svg>`,
  webcam: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.5" r="5.5"/><circle cx="12" cy="9.5" r="2"/><path d="M12 15v3.5M7 21h10"/></svg>`,
  // ---- appearance picker glyphs ----
  sun: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 7.2 7.2 0 1 0 20 14.5z"/></svg>`,
  auto: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  // ---- bottom-nav glyphs (one consistent line-icon set, replacing emoji) ----
  navGallery: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  navAdd: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  navReview: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>`,
  navExport: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M5 20h14"/></svg>`,
  navShop: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5 5.4 4h13.2L20 9.5"/><path d="M4 9.5h16v2.2a2.3 2.3 0 0 1-2.3 2.3H6.3A2.3 2.3 0 0 1 4 11.7z"/><path d="M5.5 14v6h13v-6"/><path d="M9.5 20v-4.5h5V20"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`,
};

// --- Overlay stacking --------------------------------------------------------
// All overlays are appended to <body> as they open and removed as they close,
// so the LAST one in document order is the top-most. Esc handlers use this so
// that, when dialogs are stacked (e.g. a confirm over the category screen),
// only the top dialog reacts — the ones beneath stay put.
const OVERLAY_SEL = ".msheet, .sheet, .screen, .bulkai, .webcam";
// The lightbox element persists in the DOM after closing (it's reused), so it
// can't take part in the document-order check above — it's tracked by its
// `.open` class instead, and while open it is always the top-most layer.
const LIGHTBOX_OPEN = "#lb.open";
export const lightboxOpen = () => document.querySelector(LIGHTBOX_OPEN) != null;
export function isTopOverlay(el) {
  if (lightboxOpen()) return false; // the lightbox owns Esc while it's up
  const all = document.querySelectorAll(OVERLAY_SEL);
  return all.length === 0 || all[all.length - 1] === el;
}
// True if any modal overlay is currently open (used to suppress background
// shortcuts like "Esc exits selection" while a sheet/dialog is up).
export function anyOverlayOpen() {
  return document.querySelector(OVERLAY_SEL) != null || lightboxOpen();
}

// --- Focus trap --------------------------------------------------------------
// Keep keyboard focus inside an overlay while it's open, and hand focus back to
// whatever was focused before once it closes — so keyboard and screen-reader
// users can't tab into the page behind a modal and aren't dumped at the top of
// the document on close. Returns a release() to call when the overlay closes.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Stack of active traps so that when overlays nest (e.g. a confirm over a sheet)
// only the top-most trap enforces Tab — otherwise the two fight over focus.
const trapStack = [];
export function trapFocus(container) {
  const prevFocus = document.activeElement;
  trapStack.push(container);
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    if (trapStack[trapStack.length - 1] !== container) return; // a deeper trap owns focus
    const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    // Pull focus back in if it ever escapes, then cycle at the ends.
    if (!container.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    const i = trapStack.lastIndexOf(container);
    if (i >= 0) trapStack.splice(i, 1);
    try { prevFocus?.focus?.(); } catch { /* element gone — ignore */ }
  };
}

// --- Toast --------------------------------------------------------------------
// A single reusable bottom-center toast for transient success/error feedback.
// Re-shows on each call and auto-hides; callers never manage the element.
let toastTimer;
// Optional `action` = { label, onClick } renders an inline button (e.g. "Undo")
// for reversible bulk actions. When present the toast lingers longer so the user
// has time to react, and tapping the action dismisses it.
export function toast(msg, action = null) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    document.body.appendChild(t);
  }
  if (action && action.label) {
    t.innerHTML = `<span class="toast-msg"></span><button class="toast-action" type="button"></button>`;
    t.querySelector(".toast-msg").textContent = msg;
    const btn = t.querySelector(".toast-action");
    btn.textContent = action.label;
    btn.onclick = () => { t.classList.remove("show"); action.onClick?.(); };
  } else {
    t.textContent = msg;
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), action ? 5200 : 2600);
}

// --- Bottom sheet -------------------------------------------------------------
// Generic slide-up sheet with a title, close affordance, and a body you fill in.
// Returns { el, close, body } so callers can wire up their own controls and
// dismiss programmatically. Closes on backdrop tap or the ✕ button.
export function openBottomSheet(title, bodyHtml) {
  const el = document.createElement("div");
  el.className = "msheet";
  el.innerHTML = `<div class="msheet-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="msheet-head"><span>${esc(title)}</span><button class="iconbtn" data-x aria-label="Close">${ICON.x}</button></div>
      <div class="msheet-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));
  const release = trapFocus(el);
  const close = () => {
    document.removeEventListener("keydown", onKey);
    release();
    el.classList.remove("open");
    setTimeout(() => el.remove(), 200);
  };
  // Esc dismisses, matching the click-on-backdrop affordance (top overlay only).
  const onKey = (e) => { if (e.key === "Escape" && isTopOverlay(el)) close(); };
  document.addEventListener("keydown", onKey);
  el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-x]")) close(); });
  // Focus the first interactive control so keyboard users start inside the sheet.
  requestAnimationFrame(() => el.querySelector(FOCUSABLE)?.focus());
  return { el, close, body: el.querySelector(".msheet-body") };
}

// --- Lightbox -------------------------------------------------------------
// A single reusable full-screen image viewer with keyboard + swipe navigation.
// Moved here from gallery.js so the editor and calibration photos can zoom too.
// Callers pass slides as [{ url, caption }] with captions ALREADY HTML-escaped.
let lbState = { slides: [], i: 0, el: null };

function ensureLightbox() {
  if (lbState.el) return lbState.el;
  const lb = document.createElement("div");
  lb.id = "lb";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-label", "Image viewer");
  lb.innerHTML = `
    <button class="lb-close" aria-label="Close">${ICON.x}</button>
    <button class="lb-nav lb-prev" aria-label="Previous">${ICON.back}</button>
    <img id="lbimg" alt="">
    <button class="lb-nav lb-next" aria-label="Next">${ICON.fwd}</button>
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

export function openLightbox(slides, i) {
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
// Single-slide mode (an editor/calibration photo) hides the prev/next arrows.
function paintLightbox() {
  const s = lbState.slides[lbState.i];
  if (!s) return;
  const img = lbState.el.querySelector("#lbimg");
  img.src = s.url;
  img.alt = s.caption || "Product photo"; // describe the image for screen readers
  const single = lbState.slides.length <= 1;
  lbState.el.querySelectorAll(".lb-nav").forEach((b) => { b.hidden = single; });
  lbState.el.querySelector("#lbcap").innerHTML = single
    ? (s.caption || "")
    : `${s.caption} <span style="color:var(--muted)">· ${lbState.i + 1}/${lbState.slides.length}</span>`;
}

// --- Confirm ------------------------------------------------------------------
// App-styled replacement for window.confirm(). Resolves true if the user
// confirms, false if they cancel / dismiss. Set danger:true for destructive
// actions (red confirm button). Supports Enter (confirm) and Esc (cancel).
export function confirmSheet({
  title = "Are you sure?",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "msheet dlg";
    el.innerHTML = `<div class="msheet-panel" role="dialog" aria-modal="true">
        <div class="msheet-head"><span>${esc(title)}</span></div>
        <div class="msheet-body">
          ${message ? `<p class="dlg-msg">${esc(message)}</p>` : ""}
          <div class="dlg-actions">
            <button class="ghost" data-cancel>${esc(cancelText)}</button>
            <button class="${danger ? "danger" : "primary"}" data-ok>${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    const release = trapFocus(el);

    // Resolve once, then animate out and clean up the listener + node.
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      release();
      el.classList.remove("open");
      setTimeout(() => el.remove(), 200);
      resolve(result);
    };
    const onKey = (e) => {
      if (!isTopOverlay(el)) return; // ignore while a deeper dialog is on top
      if (e.key === "Escape") finish(false);
      else if (e.key === "Enter") finish(true);
    };
    document.addEventListener("keydown", onKey);
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest("[data-cancel]")) finish(false);
      else if (e.target.closest("[data-ok]")) finish(true);
    });
    // Focus the confirm button so keyboard/SR users land on the primary action.
    requestAnimationFrame(() => el.querySelector("[data-ok]")?.focus());
  });
}

// --- Prompt -------------------------------------------------------------------
// App-styled replacement for window.prompt(). Resolves the trimmed string on
// confirm, or null on cancel/dismiss. When required (default), the confirm
// button stays disabled until the field is non-empty. Enter confirms, Esc cancels.
export function promptSheet({
  title = "",
  message = "",
  label = "",
  placeholder = "",
  value = "",
  confirmText = "Save",
  cancelText = "Cancel",
  inputType = "text",
  required = true,
} = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "msheet dlg";
    el.innerHTML = `<div class="msheet-panel" role="dialog" aria-modal="true">
        <div class="msheet-head"><span>${esc(title)}</span></div>
        <div class="msheet-body">
          ${message ? `<p class="dlg-msg">${esc(message)}</p>` : ""}
          ${label ? `<label class="dlg-label" for="dlgInput">${esc(label)}</label>` : ""}
          <input id="dlgInput" type="${esc(inputType)}" placeholder="${esc(placeholder)}" value="${esc(value)}" />
          <div class="dlg-actions">
            <button class="ghost" data-cancel>${esc(cancelText)}</button>
            <button class="primary" data-ok>${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    const release = trapFocus(el);

    const input = el.querySelector("#dlgInput");
    const okBtn = el.querySelector("[data-ok]");
    // Keep the confirm button in sync with whether the field has content.
    const sync = () => { okBtn.disabled = required && !input.value.trim(); };
    sync();
    input.addEventListener("input", sync);

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      release();
      el.classList.remove("open");
      setTimeout(() => el.remove(), 200);
      resolve(result);
    };
    const submit = () => {
      const v = input.value.trim();
      if (required && !v) return; // guard against Enter on an empty field
      finish(v);
    };
    const onKey = (e) => {
      if (!isTopOverlay(el)) return; // ignore while a deeper dialog is on top
      if (e.key === "Escape") finish(null);
      else if (e.key === "Enter") submit();
    };
    document.addEventListener("keydown", onKey);
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest("[data-cancel]")) finish(null);
      else if (e.target.closest("[data-ok]")) submit();
    });
    // Focus + select existing text so renaming is a one-tap overwrite.
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}
