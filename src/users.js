import { supabase } from "./db.js";

// Users admin screen — for people with can_manage_users. Lists every profile and
// lets you set a role preset or toggle individual capabilities per person.
// Changes are enforced server-side by RLS; this UI just drives the profile rows.

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
  modal.innerHTML = `
    <div class="bulkai-panel users-panel">
      <div class="users-head">
        <h2>Users & permissions</h2>
        <button class="ghost" id="closeUsers">Close</button>
      </div>
      <div id="usersBody"><div class="spinner"></div></div>
      <div class="users-status" id="usersStatus"></div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#closeUsers").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  const body = modal.querySelector("#usersBody");
  const statusEl = modal.querySelector("#usersStatus");
  const notify = (msg) => {
    statusEl.textContent = msg;
    clearTimeout(notify._t);
    notify._t = setTimeout(() => (statusEl.textContent = ""), 2500);
  };

  const selfId = currentCaps.id; // don't let the current admin lock themselves out

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, email, role, can_upload, can_edit, can_delete, can_view_cost, can_manage_users")
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
}

function renderRow(p, isSelf) {
  const preset = presetOf(p);
  return `<div class="user-row" data-id="${p.id}">
    <div class="user-top">
      <span class="user-email">${esc(p.email || p.id.slice(0, 8))}${
        isSelf ? ' <span style="color:var(--muted)">(you)</span>' : ""
      }</span>
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
