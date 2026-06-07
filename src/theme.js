// =============================================================================
// theme.js — light / dark / system appearance.
//
// The stylesheet ships dark as its default (:root) and carries a full light
// palette under :root[data-theme="light"]. This module is the single source of
// truth for which one is active: it reads the saved preference, resolves
// "system" against the OS setting, writes data-theme onto <html>, and keeps the
// <meta name="theme-color"> (the iOS/Android status-bar tint) in sync so an
// installed PWA never shows a dark bar over a light app or vice-versa.
//
// index.html applies the resolved theme inline before first paint to avoid a
// flash; this module re-applies it on load (idempotent) and owns every change
// thereafter. Preference is one of: "light" | "dark" | "system".
// =============================================================================

const STORE_KEY = "klm-theme";
const THEMES = ["light", "dark", "system"];

const mq = window.matchMedia("(prefers-color-scheme: light)");

// Read the stored preference, defaulting to "system" so a fresh install follows
// the device — the premium default, and what users expect in 2025.
export function getThemePref() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return THEMES.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

// Collapse a preference to the concrete theme actually painted ("light"|"dark").
export function resolveTheme(pref = getThemePref()) {
  if (pref === "light" || pref === "dark") return pref;
  return mq.matches ? "light" : "dark";
}

// Apply a concrete theme to the document + status bar. Kept separate from
// preference handling so the inline boot script can call the same logic.
function paint(theme) {
  const root = document.documentElement;
  // Dark is the stylesheet default; only tag the element when we go light, so
  // the attribute stays meaningful and CSS specificity is predictable.
  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");

  // Mirror to the OS so form controls, scrollbars, and the URL bar match.
  root.style.colorScheme = theme;

  // Sync the status-bar color to whatever --theme-color the active theme defines.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const c = getComputedStyle(root).getPropertyValue("--theme-color").trim();
    if (c) meta.setAttribute("content", c);
  }
}

// Persist a new preference and repaint. Returns the resolved concrete theme.
export function setThemePref(pref) {
  if (!THEMES.includes(pref)) pref = "system";
  try { localStorage.setItem(STORE_KEY, pref); } catch { /* private mode — runtime-only */ }
  const theme = resolveTheme(pref);
  paint(theme);
  return theme;
}

// Wire everything up: paint the current preference and, while it's "system",
// follow live OS changes (e.g. the user flips their phone to dark at sunset).
export function initTheme() {
  paint(resolveTheme());
  const onSystemChange = () => { if (getThemePref() === "system") paint(resolveTheme()); };
  // addEventListener is the modern API; older Safari only has addListener.
  if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);
}
