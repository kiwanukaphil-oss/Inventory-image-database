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

// --- Overlay stacking --------------------------------------------------------
// All overlays are appended to <body> as they open and removed as they close,
// so the LAST one in document order is the top-most. Esc handlers use this so
// that, when dialogs are stacked (e.g. a confirm over the category screen),
// only the top dialog reacts — the ones beneath stay put.
const OVERLAY_SEL = ".msheet, .sheet, .screen, .bulkai, .webcam";
export function isTopOverlay(el) {
  const all = document.querySelectorAll(OVERLAY_SEL);
  return all.length === 0 || all[all.length - 1] === el;
}
// True if any modal overlay is currently open (used to suppress background
// shortcuts like "Esc exits selection" while a sheet/dialog is up).
export function anyOverlayOpen() {
  return document.querySelector(OVERLAY_SEL) != null;
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
export function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// --- Bottom sheet -------------------------------------------------------------
// Generic slide-up sheet with a title, close affordance, and a body you fill in.
// Returns { el, close, body } so callers can wire up their own controls and
// dismiss programmatically. Closes on backdrop tap or the ✕ button.
export function openBottomSheet(title, bodyHtml) {
  const el = document.createElement("div");
  el.className = "msheet";
  el.innerHTML = `<div class="msheet-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="msheet-head"><span>${esc(title)}</span><button class="iconbtn" data-x aria-label="Close">✕</button></div>
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
