import "./styles.css";
import { isConfigured } from "./db.js";
import { onAuthChange, getMyProfile, signOut } from "./auth.js";
import { renderLogin } from "./login.js";
import { renderApp } from "./gallery.js";

const mount = document.getElementById("app");

// Guard: if the Supabase env vars are missing the whole app is dead in the
// water, so show an actionable message instead of a blank screen.
if (!isConfigured) {
  mount.innerHTML = `<div class="auth"><div class="card">
    <h1>Setup needed</h1>
    <p class="sub">Supabase credentials are not configured.</p>
    <p style="font-size:13px;color:var(--muted)">
      Copy <code>.env.example</code> to <code>.env</code> and fill in
      <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>
      (or set them as GitHub Actions secrets for the deployed build), then rebuild.
    </p>
  </div></div>`;
} else {
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
      renderApp(mount, profile, () => signOut()); // sign-out UI handled by onAuthChange
    } catch (err) {
      renderError(err);
    }
  }

  function renderError(err) {
    renderedUid = undefined; // allow a retry to re-render
    mount.innerHTML = `<div class="auth"><div class="card">
      <h1>Something went wrong</h1>
      <p class="sub">${(err && err.message) || "Unexpected error."}</p>
      <button class="primary" id="reloadBtn">Reload</button>
    </div></div>`;
    mount.querySelector("#reloadBtn").onclick = () => location.reload();
  }

  // onAuthChange fires INITIAL_SESSION on load (with or without a session), then
  // SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED. We defer to a fresh task so we are
  // not running Supabase calls inside the auth callback (deadlock fix).
  onAuthChange((_event, session) => {
    setTimeout(() => route(session), 0);
  });
}
