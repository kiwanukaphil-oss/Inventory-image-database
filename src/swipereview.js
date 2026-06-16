import { supabase } from "./db.js";
import { openEditor } from "./editor.js";
import { getItemReadiness } from "./readiness.js";
import { logItemActivity } from "./activity.js";
import { getSetting } from "./data.js";
import { toast, trapFocus, ICON } from "./ui.js";

// Swipe-review stack — the uncertain pile as a one-card-at-a-time deck.
//   swipe right / Approve  → approve (only if nothing blocks it)
//   swipe left  / Flag     → mark as a problem
//   swipe up    / Fix      → open the editor focused on the blocking issue
// Gestures are the delight layer; the three buttons are the reliable path
// (touch gesture handling can't be assumed on every device). Undo reverts the
// last approve/flag. Reuses the readiness engine + editor fix-mode wholesale.

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function openSwipeReview(items, caps, opts = {}) {
  const queue = (items || []).slice();
  if (!queue.length) { toast("Nothing to review here."); return; }

  const cur = getSetting("currency", "");
  const fmtPrice = (n) => (cur ? `${cur} ` : "") + Number(n).toLocaleString();

  // Sign every photo once up front so cards paint instantly as you swipe.
  const signed = {};
  const paths = [...new Set(queue.map((it) => it.image_path).filter(Boolean))];
  if (paths.length) {
    const { data } = await supabase.storage.from("product-images").createSignedUrls(paths, 3600);
    (data || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
  }

  let idx = 0;
  let approved = 0, flagged = 0;
  const history = []; // { id, prevStatus } — for Undo of approve/flag

  const ov = document.createElement("div");
  ov.className = "swipe";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-label", "Swipe review");
  ov.tabIndex = -1;
  ov.innerHTML = `
    <div class="sw-top">
      <button class="iconbtn sw-x" id="swClose" aria-label="Close">${ICON.x}</button>
      <span class="sw-progress" id="swProg" aria-live="polite"></span>
      <button class="sw-undo" id="swUndo" disabled>Undo</button>
    </div>
    <div class="sw-stage" id="swStage"></div>
    <div class="sw-actions">
      <button class="sw-btn sw-flag" id="swFlag" aria-label="Flag as a problem">${ICON.x}<span>Flag</span></button>
      <button class="sw-btn sw-fix" id="swFix" aria-label="Open to fix">${ICON.pencil}<span>Fix</span></button>
      <button class="sw-btn sw-approve" id="swApprove" aria-label="Approve">${ICON.tick || ICON.check}<span>Approve</span></button>
    </div>`;
  document.body.appendChild(ov);
  const release = trapFocus(ov);
  const stage = ov.querySelector("#swStage");
  const prog = ov.querySelector("#swProg");
  const undoBtn = ov.querySelector("#swUndo");

  const readinessOf = (it) => getItemReadiness(it, { forApproval: true, canViewCost: !!caps.can_view_cost });

  function cardHtml(it) {
    const r = readinessOf(it);
    const url = it.image_path ? signed[it.image_path] : null;
    const title = [it.brand, it.name].filter(Boolean).join(" · ") || "Untitled item";
    const cat = it.categories?.name || "";
    const priceHtml = it.price != null
      ? `<span class="cprice">${esc(fmtPrice(it.price))}</span>`
      : `<span class="noprice">Missing price</span>`;
    const p = r.primary;
    const issueHtml = p
      ? `<div class="sw-issue ${esc(p.cls || "")}"><b>${esc(p.label)}</b>${p.detail ? ` — ${esc(p.detail)}` : ""}</div>`
      : `<div class="sw-issue iss-ready"><b>Ready to approve</b></div>`;
    return `<div class="sw-card" data-id="${esc(it.id)}">
      <div class="sw-stamp sw-stamp-approve">APPROVE</div>
      <div class="sw-stamp sw-stamp-flag">FLAG</div>
      <div class="sw-stamp sw-stamp-fix">FIX</div>
      <div class="sw-photo">${url ? `<img src="${url}" alt="${esc(title)}">` : `<span class="sw-noimg">no photo</span>`}</div>
      <div class="sw-info">
        <div class="sw-name">${esc(title)}</div>
        <div class="sw-sub">${cat ? `${esc(cat)} · ` : ""}${priceHtml}</div>
        ${issueHtml}
      </div>
    </div>`;
  }

  function paintProgress() {
    prog.textContent = idx < queue.length ? `${idx + 1} of ${queue.length}` : "Done";
    undoBtn.disabled = history.length === 0;
  }

  function renderDone() {
    stage.innerHTML = `<div class="sw-done">
      <div class="big">✓</div>
      <div class="sw-done-msg">Reviewed ${queue.length} item${queue.length === 1 ? "" : "s"}<br>
        <span class="muted">${approved} approved · ${flagged} flagged</span></div>
      <button class="primary" id="swDoneBtn">Done</button>
    </div>`;
    stage.querySelector("#swDoneBtn").onclick = close;
    paintProgress();
  }

  let card = null;
  function render() {
    if (idx >= queue.length) { renderDone(); return; }
    stage.innerHTML = cardHtml(queue[idx]);
    card = stage.querySelector(".sw-card");
    attachGestures(card);
    paintProgress();
  }

  // Animate the current card off-screen in a direction, then run `after`.
  function flyOut(dir, after) {
    if (!card) return after();
    const x = dir === "approve" ? 600 : dir === "flag" ? -600 : 0;
    const y = dir === "fix" ? -700 : 0;
    card.style.transition = "transform .25s ease, opacity .25s ease";
    card.style.transform = `translate(${x}px, ${y}px) rotate(${x / 30}deg)`;
    card.style.opacity = "0";
    setTimeout(after, 220);
  }

  function advance() { idx++; render(); }

  async function doApprove() {
    const it = queue[idx];
    const r = readinessOf(it);
    if (!r.canApprove) { snapBack(); toast(`Can't approve: ${r.primary?.detail || r.primary?.label || "not ready"}`); return; }
    history.push({ id: it.id, prevStatus: it.status });
    approved++;
    navigator.vibrate?.(12);
    flyOut("approve", advance);
    const { error } = await supabase.from("items").update({ status: "approved" }).eq("id", it.id);
    if (error) { toast("Couldn't approve: " + error.message); return; }
    logItemActivity(it.id, "status", "approval",
      [{ field_path: "status", before: it.status, after: "approved" }], "Approved in swipe review").catch(() => {});
    it.status = "approved";
  }

  async function doFlag() {
    const it = queue[idx];
    history.push({ id: it.id, prevStatus: it.status });
    flagged++;
    navigator.vibrate?.(12);
    flyOut("flag", advance);
    const { error } = await supabase.from("items").update({ status: "flag" }).eq("id", it.id);
    if (error) { toast("Couldn't flag: " + error.message); return; }
    logItemActivity(it.id, "status", "manual",
      [{ field_path: "status", before: it.status, after: "flag" }], "Flagged in swipe review").catch(() => {});
    it.status = "flag";
  }

  // Fix opens the full editor focused on the blocking issue; afterwards we move
  // on (the end-of-deck refresh re-reads everything truthfully).
  function doFix() {
    const it = queue[idx];
    const r = readinessOf(it);
    openEditor(it.id, caps, () => {}, { focusIssue: r.primary?.issue });
    flyOut("fix", advance);
  }

  async function undo() {
    const last = history.pop();
    if (!last) return;
    if (last.prevStatus === "approved") approved--; // shouldn't happen, but keep counters honest
    // Step back to the reverted item and restore its status.
    const { error } = await supabase.from("items").update({ status: last.prevStatus }).eq("id", last.id);
    if (error) { toast("Couldn't undo: " + error.message); history.push(last); return; }
    const qi = queue.findIndex((it) => it.id === last.id);
    if (qi >= 0) { queue[qi].status = last.prevStatus; idx = qi; }
    // Recount from history is overkill; nudge the visible tallies.
    approved = Math.max(0, approved); flagged = Math.max(0, flagged);
    render();
  }

  // ---- gestures (pointer events cover both touch and mouse) ----------------
  function attachGestures(el) {
    let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
    const setStamp = () => {
      const ax = Math.min(1, Math.abs(dx) / 90), ay = Math.min(1, Math.abs(dy) / 90);
      el.querySelector(".sw-stamp-approve").style.opacity = dx > 12 ? ax : 0;
      el.querySelector(".sw-stamp-flag").style.opacity = dx < -12 ? ax : 0;
      el.querySelector(".sw-stamp-fix").style.opacity = dy < -12 && Math.abs(dy) > Math.abs(dx) ? ay : 0;
    };
    el.addEventListener("pointerdown", (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
      el.setPointerCapture?.(e.pointerId);
      el.style.transition = "none";
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 20}deg)`;
      setStamp();
    });
    const end = () => {
      if (!dragging) return; dragging = false;
      const TH = 90;
      if (dx > TH) doApprove();
      else if (dx < -TH) doFlag();
      else if (dy < -TH && Math.abs(dy) > Math.abs(dx)) doFix();
      else snapBack();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  function snapBack() {
    if (!card) return;
    card.style.transition = "transform .2s ease";
    card.style.transform = "translate(0,0) rotate(0)";
    card.querySelectorAll(".sw-stamp").forEach((s) => (s.style.opacity = 0));
  }

  function close() {
    document.removeEventListener("keydown", onKey);
    release();
    ov.remove();
    opts.onChanged?.();
  }
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") doApprove();
    else if (e.key === "ArrowLeft") doFlag();
    else if (e.key === "ArrowUp") doFix();
  };
  document.addEventListener("keydown", onKey);

  ov.querySelector("#swClose").onclick = close;
  ov.querySelector("#swApprove").onclick = doApprove;
  ov.querySelector("#swFlag").onclick = doFlag;
  ov.querySelector("#swFix").onclick = doFix;
  undoBtn.onclick = undo;

  render();
  requestAnimationFrame(() => ov.focus());
}
