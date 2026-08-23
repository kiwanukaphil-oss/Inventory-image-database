import { signIn } from "./auth.js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";

// Eye / crossed-eye glyphs for the show-password toggle.
const EYE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.9A10.8 10.8 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.4 17.4 0 0 1-3.2 3.9M6.4 6.6A16.8 16.8 0 0 0 2 12s3.5 6.5 10 6.5a10.7 10.7 0 0 0 4.2-.85"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

/**
 * Render the login screen into the given mount element.
 * onSuccess is called after a successful sign-in so main.js can swap to the app.
 */
export function renderLogin(mount, onSuccess) {
  mount.innerHTML = `
    <div class="auth">
      <form class="card" id="loginForm" autocomplete="on">
        <h1>K-LINE MEN <span style="color:var(--muted);font-weight:400">Catalog</span></h1>
        <p class="sub">Photograph stock, let AI read each item, then price it for your shop — one photo, one unit.</p>
        <label for="email">${isRailwayCatalogMode ? "Username" : "Email"}</label>
        <input id="email" type="${isRailwayCatalogMode ? "text" : "email"}" ${isRailwayCatalogMode ? "" : 'inputmode="email"'} autocomplete="username" required />
        <label for="password">Password</label>
        <div class="pwwrap">
          <input id="password" type="password" autocomplete="current-password" required />
          <button type="button" class="pwtoggle" id="pwToggle" aria-label="Show password" aria-pressed="false">${EYE}</button>
        </div>
        <button class="primary" type="submit" id="submitBtn">Sign in</button>
        <div class="msg" id="msg"></div>
        <button type="button" class="linkbtn forgot" id="forgotBtn">Forgot password?</button>
        <div class="forgot-help" id="forgotHelp" hidden>
          Ask a “Manage users” admin to set you a new temporary password from
          <b>Users &amp; permissions</b>, then sign in and it’ll work right away.
        </div>
      </form>
    </div>`;

  const form = mount.querySelector("#loginForm");
  const msg = mount.querySelector("#msg");
  const btn = mount.querySelector("#submitBtn");

  // No self-service reset (this app deliberately doesn't depend on email
  // delivery) — reveal how to get an admin to reset the password instead.
  const forgotHelp = mount.querySelector("#forgotHelp");
  mount.querySelector("#forgotBtn").onclick = () => { forgotHelp.hidden = !forgotHelp.hidden; };

  // Show/hide the password — phone keyboards make blind typing error-prone, and
  // there's no self-service reset to fall back on.
  const pw = mount.querySelector("#password");
  const pwToggle = mount.querySelector("#pwToggle");
  pwToggle.onclick = () => {
    const show = pw.type === "password";
    pw.type = show ? "text" : "password";
    pwToggle.innerHTML = show ? EYE_OFF : EYE;
    pwToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    pwToggle.setAttribute("aria-pressed", String(show));
    pw.focus();
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.className = "msg";
    msg.textContent = "";
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await signIn(form.email.value.trim(), form.password.value);
      onSuccess();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err?.message || "Sign-in failed.";
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
}
