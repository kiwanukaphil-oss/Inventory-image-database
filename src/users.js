import { supabase } from "./db.js";
import { toast, confirmSheet, trapFocus, isTopOverlay } from "./ui.js";

// Users admin screen — for people with can_manage_users. Create login accounts,
// set role/capabilities, and deactivate/reactivate accounts. Account create and
// status changes go through the manage-users Edge Function (service-role,
// server-side); capability edits write the profile row directly (RLS-enforced).

const PRESETS = {
  admin:  { can_upload: true,  can_edit: true,  can_delete: true,  can_view_cost: true,  can_manage_users: true },
  editor: { can_upload: true,  can_edit: true,  can_delete: false, can_view_cost: false, can_manage_users: false },
  viewer: { can_upload: false, can_edit: false, can_delete: false, can_view_cost: false, can_manage_users: false },
};
const CAPS = [
  { k: "can_upload", label: "Upload" },
  { k: "can_edit", label: "Edit" },
  { k: "can_delete", label: "Delete" },
  { k: "can_view_cost", label: "See cost" },
  { k: "can_manage_users", label: "Manage users" },
];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Which preset (if any) the current capability set matches.
function presetOf(p) {
  for (const [name, caps] of Object.entries(PRESETS)) {
    if (CAPS.every((c) => !!p[c.k] === caps[c.k])) return name;
  }
  return "custom";
}

export async function openUsers(currentCaps) {
  if (!currentCaps?.can_manage_users) return;

  const modal = document.createElement("div");
  modal.className = "bulkai"; // reuse the centered-modal backdrop
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Users & permissions");
  modal.innerHTML = `
    <div class="bulkai-panel users-panel">
      <div class="users-head">
        <h2>Users & permissions</h2>
        <button class="ghost" id="closeUsers">Close</button>
      </div>
      <div class="user-add">
        <div class="user-add-row">
          <input id="newEmail" type="email" placeholder="email@example.com" autocomplete="off">
          <input id="newPass" type="text" placeholder="temporary password" autocomplete="off">
          <select id="newRole">
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
          <button class="primary" id="addUserBtn">Add user</button>
        </div>
        <div class="muted" style="font-size:12px">Creates a login immediately; share the email + temporary password with them.</div>
      </div>
      <div id="usersBody"><div class="spinner"></div></div>
    </div>`;
  document.body.appendChild(modal);
  const releaseFocus = trapFocus(modal);
  const close = () => { releaseFocus(); document.removeEventListener("keydown", onKey); modal.remove(); };
  const onKey = (e) => { if (e.key === "Escape" && isTopOverlay(modal)) close(); };
  document.addEventListener("keydown", onKey);
  modal.querySelector("#closeUsers").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  requestAnimationFrame(() => modal.querySelector("#newEmail")?.focus());

  const body = modal.querySelector("#usersBody");
  // Feedback goes through the app-wide toast (this screen used to have its own
  // little status strip — the only surface that did).
  const notify = toast;

  const selfId = currentCaps.id; // don't let the current admin lock themselves out

  // Call the manage-users Edge Function and surface any error.
  async function callManage(payload) {
    const { data, error } = await supabase.functions.invoke("manage-users", { body: payload });
    if (error) { notify("Failed: " + error.message); return null; }
    if (data?.error) { notify("Failed: " + data.error); return null; }
    return data;
  }

  // (Re)load the user list and wire its controls.
  async function loadList() {
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("id, email, role, active, can_upload, can_edit, can_delete, can_view_cost, can_manage_users")
      .order("email");
    if (error) {
      body.innerHTML = `<div class="empty"><div>Couldn't load users.</div>
        <div style="color:var(--muted);font-size:13px">${esc(error.message)}</div></div>`;
      return;
    }
    body.innerHTML = profiles.map((p) => renderRow(p, p.id === selfId)).join("");

    // Toggle a single capability → mark role 'custom'.
    body.querySelectorAll("input[data-cap]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        const row = cb.closest(".user-row");
        const update = { role: "custom" };
        row.querySelectorAll("input[data-cap]").forEach((x) => (update[x.dataset.cap] = x.checked));
        await save(row.dataset.id, update, row, notify);
      });
    });

    // Apply a preset → set role + the preset's capabilities.
    body.querySelectorAll("select[data-preset]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const row = sel.closest(".user-row");
        const preset = sel.value;
        if (preset === "custom") return;
        const update = { role: preset, ...PRESETS[preset] };
        row.querySelectorAll("input[data-cap]").forEach((x) => (x.checked = PRESETS[preset][x.dataset.cap]));
        await save(row.dataset.id, update, row, notify);
      });
    });

    // Deactivate / reactivate an account (bans/unbans the login server-side).
    body.querySelectorAll("button[data-deact]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.deact;
        const isActive = btn.dataset.active === "true"; // current state of the account
        if (isActive) {
          const ok = await confirmSheet({
            title: "Deactivate account?",
            message: "They won't be able to log in until the account is reactivated.",
            confirmText: "Deactivate",
            danger: true,
          });
          if (!ok) return;
        }
        btn.disabled = true;
        const res = await callManage({ action: isActive ? "deactivate" : "reactivate", user_id: id });
        if (res) { notify(isActive ? "Deactivated" : "Reactivated"); loadList(); }
        else btn.disabled = false;
      });
    });
  }

  // Add-user form.
  modal.querySelector("#addUserBtn").onclick = async () => {
    const email = modal.querySelector("#newEmail").value.trim();
    const password = modal.querySelector("#newPass").value;
    const role = modal.querySelector("#newRole").value;
    if (!email || !password) { notify("Enter an email and a temporary password."); return; }
    if (password.length < 6) { notify("Password must be at least 6 characters."); return; }
    const btn = modal.querySelector("#addUserBtn");
    btn.disabled = true; btn.textContent = "Adding…";
    const res = await callManage({ action: "create", email, password, role, caps: PRESETS[role] });
    btn.disabled = false; btn.textContent = "Add user";
    if (res) {
      notify("User created");
      modal.querySelector("#newEmail").value = "";
      modal.querySelector("#newPass").value = "";
      loadList();
    }
  };

  loadList();
}

function renderRow(p, isSelf) {
  const preset = presetOf(p);
  const inactive = p.active === false;
  return `<div class="user-row${inactive ? " inactive" : ""}" data-id="${p.id}">
    <div class="user-top">
      <span class="user-email">${esc(p.email || p.id.slice(0, 8))}${
        isSelf ? ' <span style="color:var(--muted)">(you)</span>' : ""
      }${inactive ? ' <span class="user-off">inactive</span>' : ""}</span>
      <select data-preset ${isSelf ? "disabled" : ""}>
        ${["admin", "editor", "viewer", "custom"]
          .map((r) => `<option value="${r}" ${preset === r ? "selected" : ""}>${r}</option>`)
          .join("")}
      </select>
    </div>
    <div class="user-caps">
      ${CAPS.map((c) => {
        // Keep your own "Manage users" on so you can't lock yourself out.
        const lock = isSelf && c.k === "can_manage_users";
        return `<label><input type="checkbox" data-cap="${c.k}" ${p[c.k] ? "checked" : ""} ${
          lock ? "checked disabled" : ""
        }> ${c.label}</label>`;
      }).join("")}
    </div>
    ${isSelf ? "" : `<div class="user-actions">
      <button class="ghost user-deact" data-deact="${p.id}" data-active="${!inactive}">${inactive ? "Reactivate" : "Deactivate"}</button>
    </div>`}
  </div>`;
}

async function save(id, update, row, notify) {
  const { error } = await supabase.from("profiles").update(update).eq("id", id);
  if (error) {
    notify("Save failed: " + error.message);
    return;
  }
  // Keep the preset dropdown in sync with the resulting capability set.
  const sel = row.querySelector("select[data-preset]");
  const caps = {};
  row.querySelectorAll("input[data-cap]").forEach((x) => (caps[x.dataset.cap] = x.checked));
  sel.value = presetOf(caps);
  notify("Saved");
}
