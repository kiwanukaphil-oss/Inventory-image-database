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
    if (id === "gallery") renderGallery(view);
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

// Escape user-provided text before injecting into innerHTML (brands/colours can
// contain &, <, quotes — e.g. "Jery & Sluo").
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Fetch items, resolve signed thumbnail URLs (the bucket is private), render the
// card grid, and wire the lightbox. Editing lands in Phase 3.
async function renderGallery(view) {
  view.innerHTML = `<div class="spinner"></div>`;
  const { data, error, count } = await supabase
    .from("items")
    .select("id, name, brand, sku, status, image_path, attributes, categories(name)", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Couldn't load items.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message)}</div></div>`;
    return;
  }
  if (!data || data.length === 0) {
    view.innerHTML = `<div class="empty"><div class="big">📭</div>
      <div>No items yet.</div>
      <div style="color:var(--muted);font-size:13px">
        ${count === 0 ? "The catalogue is empty — run the seed importer or add photos." : ""}
      </div></div>`;
    return;
  }

  // Batch-create signed URLs for all thumbnails in one request.
  const paths = data.filter((d) => d.image_path).map((d) => d.image_path);
  const signed = {};
  if (paths.length) {
    const { data: urls } = await supabase.storage
      .from("product-images")
      .createSignedUrls(paths, 3600);
    (urls || []).forEach((u) => {
      if (u.signedUrl) signed[u.path] = u.signedUrl;
    });
  }

  // Keep an ordered list of viewable images for lightbox navigation.
  const slides = [];
  const cards = data
    .map((it) => {
      const url = signed[it.image_path];
      const cat = it.categories?.name || "";
      const attrs = it.attributes || {};
      const bits = [attrs.color, attrs.size].filter(Boolean).join(" · ");
      const title = it.name || it.brand || "—";
      let slideIdx = -1;
      if (url) {
        slideIdx = slides.length;
        slides.push({ url, caption: `${esc(title)}${bits ? " · " + esc(bits) : ""}` });
      }
      const thumb = url
        ? `<div class="thumb" data-slide="${slideIdx}"><img loading="lazy" src="${url}" alt="${esc(title)}"></div>`
        : `<div class="thumb"><span style="color:var(--muted);font-size:12px">no image</span></div>`;
      return `<div class="card">
        ${thumb}
        <div class="body">
          <div style="font-size:12px;color:var(--muted)">${esc(cat)}</div>
          <div>${esc(title)}${bits ? " · " + esc(bits) : ""}</div>
        </div>
      </div>`;
    })
    .join("");

  view.innerHTML = `<div style="color:var(--muted);font-size:12px;margin-bottom:8px">
      ${count} item${count === 1 ? "" : "s"}
    </div><div class="grid">${cards}</div>`;

  // Clicking a thumbnail opens the lightbox at that slide.
  view.querySelectorAll(".thumb[data-slide]").forEach((el) => {
    el.addEventListener("click", () => openLightbox(slides, Number(el.dataset.slide)));
  });
}

function renderComingSoon(view, id) {
  const labels = { add: "Add photos", groups: "Grouping", export: "CSV export" };
  view.innerHTML = `<div class="empty"><div class="big">🚧</div>
    <div>${labels[id] || id} arrives in a later phase.</div></div>`;
}

// ---------------------------------------------------------------------------
// Lightbox — a single reusable overlay with keyboard + swipe navigation.
// ---------------------------------------------------------------------------
let lbState = { slides: [], i: 0, el: null };

function ensureLightbox() {
  if (lbState.el) return lbState.el;
  const lb = document.createElement("div");
  lb.id = "lb";
  lb.innerHTML = `
    <button class="lb-close" aria-label="Close">✕</button>
    <button class="lb-nav lb-prev" aria-label="Previous">‹</button>
    <img id="lbimg" alt="">
    <button class="lb-nav lb-next" aria-label="Next">›</button>
    <div class="lb-cap" id="lbcap"></div>`;
  document.body.appendChild(lb);

  lb.querySelector(".lb-close").onclick = closeLightbox;
  lb.querySelector(".lb-prev").onclick = () => moveLightbox(-1);
  lb.querySelector(".lb-next").onclick = () => moveLightbox(1);
  lb.addEventListener("click", (e) => { if (e.target === lb) closeLightbox(); });

  // Touch swipe (mobile) — horizontal drag to move between images.
  let startX = 0;
  lb.addEventListener("touchstart", (e) => { startX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) moveLightbox(dx < 0 ? 1 : -1);
  });

  document.addEventListener("keydown", (e) => {
    if (!lb.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowRight") moveLightbox(1);
    else if (e.key === "ArrowLeft") moveLightbox(-1);
  });

  lbState.el = lb;
  return lb;
}

function openLightbox(slides, i) {
  ensureLightbox();
  lbState.slides = slides;
  lbState.i = i;
  paintLightbox();
  lbState.el.classList.add("open");
}
function closeLightbox() { lbState.el?.classList.remove("open"); }
function moveLightbox(d) {
  const n = lbState.slides.length;
  if (!n) return;
  lbState.i = (lbState.i + d + n) % n;
  paintLightbox();
}
function paintLightbox() {
  const s = lbState.slides[lbState.i];
  if (!s) return;
  lbState.el.querySelector("#lbimg").src = s.url;
  lbState.el.querySelector("#lbcap").innerHTML =
    `${s.caption} <span style="color:var(--muted)">· ${lbState.i + 1}/${lbState.slides.length}</span>`;
}
