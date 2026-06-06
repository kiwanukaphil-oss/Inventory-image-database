import "./styles.css";
import { isConfigured } from "./db.js";
import { getSession, onAuthChange, getMyProfile } from "./auth.js";
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
  // Render the right surface for the current session, and re-render whenever
  // auth state changes (sign-in, sign-out, token refresh).
  async function route() {
    const session = await getSession();
    if (!session) {
      renderLogin(mount, route);
      return;
    }
    const profile = await getMyProfile();
    renderApp(mount, profile, route);
  }

  onAuthChange(() => route());
  route();
}
