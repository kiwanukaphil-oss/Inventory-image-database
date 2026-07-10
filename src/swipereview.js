import { supabase } from "./db.js";
import { openEditor } from "./editor.js";
import { getItemReadiness } from "./readiness.js";
import { approvalBlockerText, confirmApprovalWarnings } from "./approval.js";
import { logItemActivity } from "./activity.js";
import { getSetting } from "./data.js";
import { esc, toast, trapFocus, isTopOverlay, ICON } from "./ui.js";

// Swipe-review stack — the uncertain pile as a one-card-at-a-time deck.
//   swipe right / Approve  → approve (only if nothing blocks it)
//   swipe left  / Flag     → mark as a problem
//   swipe up    / Fix      → open the editor focused on the blocking issue
// Gestures are the delight layer; the three buttons are the reliable path
// (touch gesture handling can't be assumed on every device). Undo reverts the
// last approve/flag. Reuses the readiness engine + editor fix-mode wholesale.


export async function openSwipeReview(items, caps, opts = {}) {
  const queue = (items || []).slice();
  if (!queue.length) { toast("Nothing to review here."); return; }

  const cur = getSetting("currency", "");
  const fmtPrice = (n) => (cur ? `${cur} ` : "") + Number(n).toLocaleString();

  // Sign only the current and next photos. Large queues open quickly and keep
  // one card of look-ahead without doing storage work for the whole deck.
  const signed = {};

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
  const approveBtn = ov.querySelector("#swApprove");
  let acting = false;
  let closed = false;
  let renderSeq = 0;
  const changedIds = new Set();

  const readinessOf = (it) => getItemReadiness(it, { forApproval: true, canViewCost: !!caps.can_view_cost });

  async function ensureSigned(indices) {
    const paths = [...new Set(indices
      .map((i) => queue[i]?.image_path)
      .filter((path) => path && !signed[path]))];
    if (!paths.length) return;
    const { data } = await supabase.storage.from("product-images").createSignedUrls(paths, 3600);
    (data || []).forEach((entry) => { if (entry.signedUrl) signed[entry.path] = entry.signedUrl; });
  }

  function paintApproveAffordance() {
    if (!approveBtn) return;
    const label = approveBtn.querySelector("span");
    const it = queue[idx];
    if (!it || idx >= queue.length) {
      approveBtn.disabled = true;
      approveBtn.title = "";
      if (label) label.textContent = "Approve";
      return;
    }
    const r = readinessOf(it);
    const blocked = r.blockers.length > 0;
    approveBtn.disabled = acting || blocked;
    approveBtn.title = blocked ? `Fix before approval: ${approvalBlockerText(r) || r.primary?.label || "not ready"}` : "";
    if (label) label.textContent = blocked ? "Blocked" : r.warnings.length ? "Review & approve" : "Approve";
  }

  function setActing(next) {
    acting = next;
    paintApproveAffordance();
  }

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
    paintApproveAffordance();
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
  async function render() {
    const seq = ++renderSeq;
    if (idx >= queue.length) { renderDone(); return; }
    await ensureSigned([idx, idx + 1]);
    if (closed || seq !== renderSeq || idx >= queue.length) return;
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
    if (acting) return;
    const it = queue[idx];
    if (!it) return;
    const r = readinessOf(it);
    if (!r.canApprove) { snapBack(); toast(`Can't approve: ${approvalBlockerText(r) || r.primary?.detail || r.primary?.label || "not ready"}`); return; }
    setActing(true);
    if (!(await confirmApprovalWarnings(r))) { setActing(false); snapBack(); return; }
    const prevStatus = it.status;
    const { error } = await supabase.from("items").update({ status: "approved" }).eq("id", it.id);
    if (error) { setActing(false); snapBack(); toast("Couldn't approve: " + error.message); return; }
    history.push({ id: it.id, prevStatus, action: "approve" });
    changedIds.add(it.id);
    approved++;
    it.status = "approved";
    logItemActivity(it.id, "status", "approval",
      [{ field_path: "status", before: prevStatus, after: "approved" }], "Approved in swipe review").catch(() => {});
    navigator.vibrate?.(12);
    flyOut("approve", () => { setActing(false); advance(); });
  }

  async function doFlag() {
    if (acting) return;
    const it = queue[idx];
    if (!it) return;
    setActing(true);
    const prevStatus = it.status;
    const { error } = await supabase.from("items").update({ status: "flag" }).eq("id", it.id);
    if (error) { setActing(false); snapBack(); toast("Couldn't flag: " + error.message); return; }
    history.push({ id: it.id, prevStatus, action: "flag" });
    changedIds.add(it.id);
    flagged++;
    it.status = "flag";
    logItemActivity(it.id, "status", "manual",
      [{ field_path: "status", before: prevStatus, after: "flag" }], "Flagged in swipe review").catch(() => {});
    navigator.vibrate?.(12);
    flyOut("flag", () => { setActing(false); advance(); });
  }

  // Fix pauses the deck. Cancelling keeps the current card; saving advances to
  // the next item and reports only this changed id to the parent Review view.
  function doFix() {
    if (acting) return;
    const it = queue[idx];
    if (!it) return;
    setActing(true);
    const r = readinessOf(it);
    let saved = false;
    openEditor(it.id, caps, () => {
      saved = true;
      changedIds.add(it.id);
    }, {
      focusIssue: r.primary?.issue,
      onClose: () => {
        setActing(false);
        if (saved) flyOut("fix", advance);
        else snapBack();
      },
    }).catch((error) => {
      setActing(false);
      snapBack();
      toast("Couldn't open item: " + (error.message || error));
    });
  }

  async function undo() {
    if (acting) return;
    const last = history.pop();
    if (!last) return;
    setActing(true);
    // Step back to the reverted item and restore its status.
    const { error } = await supabase.from("items").update({ status: last.prevStatus }).eq("id", last.id);
    if (error) { toast("Couldn't undo: " + error.message); history.push(last); setActing(false); return; }
    const qi = queue.findIndex((it) => it.id === last.id);
    if (qi >= 0) { queue[qi].status = last.prevStatus; idx = qi; }
    if (last.action === "approve") approved = Math.max(0, approved - 1);
    if (last.action === "flag") flagged = Math.max(0, flagged - 1);
    changedIds.add(last.id);
    setActing(false);
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
    if (closed) return;
    if (acting) { toast("Finish the current action before closing."); return; }
    closed = true;
    document.removeEventListener("keydown", onKey);
    release();
    ov.remove();
    if (changedIds.size) opts.onChanged?.([...changedIds]);
  }
  const onKey = (e) => {
    if (!isTopOverlay(ov)) return;
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
