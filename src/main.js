import "@fontsource-variable/inter"; // self-hosted (offline-capable PWA), no external request
import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { isConfigured } from "./db.js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";
import { buildRailwayCatalogProfile } from "./lib/railway-catalog-ui.js";
import { initTheme } from "./theme.js";

// Resolve light/dark/system and keep the status bar in sync. index.html applies
// the saved theme inline before paint (no flash); this re-asserts it and starts
// listening for OS appearance changes.
initTheme();

// Register the service worker without allowing it to reload an active task.
// A persistent prompt lets the user choose a safe moment to restart instead.
let applyAppUpdate = () => Promise.resolve();
applyAppUpdate = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (document.getElementById("appUpdatePrompt")) return;
    const prompt = document.createElement("div");
    prompt.id = "appUpdatePrompt";
    prompt.className = "app-update";
    prompt.setAttribute("role", "status");
    prompt.innerHTML = `<span><b>Update ready</b><small>Finish any open task, then restart safely.</small></span>
      <button type="button">Restart app</button>`;
    prompt.querySelector("button").onclick = async (event) => {
      const openTask = document.querySelector(".sheet, .swipe, .screen, .bulkai, .burst, .msheet");
      if (openTask) {
        event.currentTarget.textContent = "Close task first";
        setTimeout(() => { event.currentTarget.textContent = "Restart app"; }, 1800);
        return;
      }
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "Restarting...";
      await applyAppUpdate(true);
    };
    document.body.appendChild(prompt);
  },
});
import "./install.js"; // capture beforeinstallprompt early (side-effect import)
import { onAuthChange, getMyProfile, signOut } from "./auth.js";
import { renderLogin } from "./login.js";
import { renderApp } from "./gallery.js";
import { installGlobalErrorHandlers, reportError } from "./errorlog.js";

const mount = document.getElementById("app");

// Guard: if the Supabase env vars are missing the whole app is dead in the
// water, so show an actionable message instead of a blank screen.
if (!isConfigured) {
  mount.innerHTML = `<div class="auth"><div class="card">
    <h1>Setup needed</h1>
    <p class="sub">Catalog backend credentials are not configured.</p>
    <p style="font-size:13px;color:var(--muted)">
      Copy <code>.env.example</code> to <code>.env</code> and fill in
      <code>VITE_CATALOG_API_URL</code>, or the existing
      <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>,
      then rebuild.
    </p>
  </div></div>`;
} else {
  // Capture uncaught errors / rejections to the durable error sink (P4).
  installGlobalErrorHandlers();

  // Show a spinner until the first auth event resolves (avoids a black screen
  // during session restore).
  mount.innerHTML = `<div class="spinner"></div>`;

  // Track the currently-rendered user so token refreshes (same user) don't
  // needlessly re-render the whole app and reset the view.
  let renderedUid;

  async function route(session) {
    const uid = session?.user?.id ?? null;
    if (renderedUid !== undefined && uid === renderedUid) return; // no identity change
    renderedUid = uid;
    try {
      if (!session) {
        renderLogin(mount, () => {}); // sign-in success is handled by onAuthChange
        return;
      }
      const profile = await getMyProfile();
      // Railway now exposes the narrow AI extraction capability separately.
      // General mutation controls stay hidden until their own API slices arrive.
      const renderedProfile = isRailwayCatalogMode
        ? buildRailwayCatalogProfile(profile)
        : profile;
      renderApp(mount, renderedProfile, () => signOut()); // sign-out UI handled by onAuthChange
    } catch (err) {
      renderError(err);
    }
  }

  function renderError(err) {
    reportError("main.route", err); // durable record of the top-level failure (P4)
    renderedUid = undefined; // allow a retry to re-render
    mount.innerHTML = `<div class="auth"><div class="card">
      <h1>Something went wrong</h1>
      <p class="sub"></p>
      <button class="primary" id="reloadBtn">Reload</button>
    </div></div>`;
    // Remote error text is data, never executable markup.
    mount.querySelector(".sub").textContent = (err && err.message) || "Unexpected error.";
    mount.querySelector("#reloadBtn").onclick = () => location.reload();
  }

  // onAuthChange fires INITIAL_SESSION on load (with or without a session), then
  // SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED. We defer to a fresh task so we are
  // not running Supabase calls inside the auth callback (deadlock fix).
  onAuthChange((_event, session) => {
    setTimeout(() => route(session), 0);
  });
}
