import { signIn } from "./auth.js";

/**
 * Render the login screen into the given mount element.
 * onSuccess is called after a successful sign-in so main.js can swap to the app.
 */
export function renderLogin(mount, onSuccess) {
  mount.innerHTML = `
    <div class="auth">
      <form class="card" id="loginForm" autocomplete="on">
        <h1>K-LINE MEN <span style="color:var(--muted);font-weight:400">Catalog</span></h1>
        <p class="sub">Sign in to view and edit the catalogue.</p>
        <label for="email">Email</label>
        <input id="email" type="email" inputmode="email" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" required />
        <button class="primary" type="submit" id="submitBtn">Sign in</button>
        <div class="msg" id="msg"></div>
      </form>
    </div>`;

  const form = mount.querySelector("#loginForm");
  const msg = mount.querySelector("#msg");
  const btn = mount.querySelector("#submitBtn");

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
