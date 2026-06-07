// =============================================================================
// install.js — "Add to Home Screen" support.
//
// On Chrome/Edge/Android the browser fires `beforeinstallprompt`; we stash it so
// the app can offer a one-tap install from the account menu instead of relying
// on the browser's own (easily-missed) prompt. iOS Safari doesn't support that
// event, so there we detect iOS and show manual Share-sheet instructions.
//
// Imported for its side effects early in main.js so the event isn't missed.
// =============================================================================

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // suppress the mini-infobar; we trigger it ourselves
  deferredPrompt = e;
});
window.addEventListener("appinstalled", () => { deferredPrompt = null; });

// Already running as an installed PWA?
export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;

// iOS Safari (no beforeinstallprompt — needs manual Share → Add to Home Screen).
export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

// True if there's a native prompt waiting to be shown.
export const canPromptInstall = () => !!deferredPrompt;

// Should the "Install app" menu item appear at all?
export const installAvailable = () =>
  !isStandalone() && (canPromptInstall() || isIOS());

// Fire the native install prompt; resolves true if the user accepted.
export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome === "accepted";
}
