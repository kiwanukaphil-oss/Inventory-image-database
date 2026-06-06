import { supabase } from "./db.js";
import { signOut } from "./auth.js";

// Phase 1: the authenticated app shell with a top bar, a bottom nav, and a
// gallery view that fetches items (currently zero) to prove the end-to-end
// authenticated read path works. Editing, upload, grouping, and bulk ops are
// layered on in later phases.

const NAV = [
  { id: "gallery", label: "Gallery", ico: "▦" },
  { id: "add", label: "Add", ico: "＋" },
  { id: "groups", label: "Groups", ico: "☰" },
  { id: "export", label: "Export", ico: "⤓" },
];

/**
 * Render the full app shell for a signed-in user.
 * @param {HTMLElement} mount  root element
 * @param {object} profile     { id, email, role }
 * @param {Function} onSignOut callback to re-render the login screen
 */
export function renderApp(mount, profile, onSignOut) {
  const role = profile?.role || "viewer";
  mount.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <h1>K-LINE MEN <span style="color:var(--muted);font-weight:400">Catalog</span></h1>
        <span class="rolechip ${role}">${role}</span>
        <span class="spacer"></span>
        <button class="ghost" id="signOutBtn">Sign out</button>
      </header>
      <main class="content" id="view"></main>
      <nav class="bottomnav" id="nav"></nav>
    </div>`;

  const view = mount.querySelector("#view");
  const nav = mount.querySelector("#nav");

  // Build bottom nav buttons.
  nav.innerHTML = NAV.map(
    (n) => `<button data-view="${n.id}"><span class="ico">${n.ico}</span>${n.label}</button>`
  ).join("");

  function setView(id) {
    nav.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === id)
    );
    if (id === "gallery") renderGallery(view, role);
    else renderComingSoon(view, id);
  }

  nav.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) setView(btn.dataset.view);
  });

  mount.querySelector("#signOutBtn").addEventListener("click", async () => {
    await signOut();
    onSignOut();
  });

  setView("gallery");
}

// Fetch and render items. In Phase 1 this confirms an authenticated query
// succeeds and renders the empty state; Phase 2 fills it with seeded cards.
async function renderGallery(view, role) {
  view.innerHTML = `<div class="spinner"></div>`;
  // Select universal columns + the flexible attributes blob; category-specific
  // values (color, size, etc.) now live inside `attributes` per the category model.
  const { data, error, count } = await supabase
    .from("items")
    .select("id, name, brand, sku, status, image_path, attributes, categories(name)", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) {
    view.innerHTML = `<div class="empty">
      <div class="big">⚠️</div>
      <div>Couldn't load items.</div>
      <div style="color:var(--muted);font-size:13px">${error.message}</div>
    </div>`;
    return;
  }

  if (!data || data.length === 0) {
    view.innerHTML = `<div class="empty">
      <div class="big">📭</div>
      <div>No items yet.</div>
      <div style="color:var(--muted);font-size:13px">
        ${count === 0 ? "The catalogue is empty — run the seed importer (Phase 2) or add photos." : ""}
      </div>
    </div>`;
    return;
  }

  // Minimal card render; full editable card (driven by category_fields) lands
  // in Phase 3. For now show category + brand/name + a couple of attributes.
  view.innerHTML = `<div class="grid">${data
    .map((it) => {
      const cat = it.categories?.name || "";
      const attrs = it.attributes || {};
      const bits = [attrs.color, attrs.size].filter(Boolean).join(" · ");
      return `<div class="card">
        <div class="thumb"></div>
        <div class="body">
          <div style="font-size:12px;color:var(--muted)">${cat}</div>
          <div>${it.name || it.brand || "—"}${bits ? " · " + bits : ""}</div>
        </div>
      </div>`;
    })
    .join("")}</div>`;
}

function renderComingSoon(view, id) {
  const labels = { add: "Add photos", groups: "Grouping", export: "CSV export" };
  view.innerHTML = `<div class="empty">
    <div class="big">🚧</div>
    <div>${labels[id] || id} arrives in a later phase.</div>
  </div>`;
}
