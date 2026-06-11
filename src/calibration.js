// ============================================================================
//  Calibration tool — measure whether the AI's per-field confidence actually
//  predicts correctness, so high-confidence uploads can be batch-approved with
//  trust (or not).
//
//  Flow: step through every AI-extracted item one at a time, photo in view, and
//  mark each AI-filled field Correct / Wrong. Verdicts (with the AI's confidence
//  level + value, snapshotted) are written to calibration_marks. At the end it
//  reports accuracy by confidence level and offers to approve the all-correct
//  items in one tap — so this pass doubles as clearing those items.
// ============================================================================

import { supabase } from "./db.js";
import { loadRefData, categoryPath, fieldLabel, AI_BLIND_FIELDS } from "./data.js";
import { toast, trapFocus, openLightbox, lightboxOpen, ICON } from "./ui.js";

const LEVELS = ["High", "Medium", "Low"];

// Resolve the human-facing value the AI produced for a confidence-stamped key.
// brand/name/category live as scalar columns; everything else is an attribute.
function fieldValue(it, key) {
  if (key === "brand") return it.brand;
  if (key === "name") return it.name;
  if (key === "category") return categoryPath(it.category_id);
  return it.attributes?.[key];
}

// The list of judgable AI fields for an item: those with a real confidence level
// and a non-empty value, excluding fields the AI can't read (always-Low noise).
function aiFields(it) {
  const conf = it.confidence || {};
  return Object.entries(conf)
    .filter(([k, lvl]) => LEVELS.includes(lvl) && !AI_BLIND_FIELDS.has(k))
    .map(([k, lvl]) => ({ key: k, label: fieldLabel(k), level: lvl, value: fieldValue(it, k) }))
    .filter((f) => f.value !== null && f.value !== undefined && f.value !== "");
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Open the full-screen calibration flow.
 * @param {object} caps     signed-in profile (needs id + can_edit)
 * @param {Function} onClose called after the overlay closes (e.g. to refresh)
 */
export async function openCalibration(caps, onClose) {
  await loadRefData(); // category tree + field labels drive the field list

  // Load every AI-extracted item (confidence present) plus any existing marks
  // so a resumed pass shows prior verdicts instead of starting blank.
  const { data: rows, error } = await supabase
    .from("items")
    .select("id, brand, name, attributes, confidence, category_id, image_path, status, price")
    .not("confidence", "is", null)
    .order("created_at", { ascending: true });
  if (error) { toast("Couldn't load items: " + error.message); return; }

  // Keep only items that actually have a judgable field.
  const items = (rows || []).map((it) => ({ it, fields: aiFields(it) })).filter((x) => x.fields.length);

  const el = document.createElement("div");
  el.className = "calib";
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));
  const release = trapFocus(el);
  const close = () => {
    document.removeEventListener("keydown", onKey);
    release();
    el.classList.remove("open");
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  };
  // While the photo is zoomed the lightbox owns Esc — don't also close the tool.
  const onKey = (e) => { if (e.key === "Escape" && !lightboxOpen()) close(); };
  document.addEventListener("keydown", onKey);

  if (!items.length) {
    el.innerHTML = `<div class="calib-panel"><div class="calib-head">
        <span>Calibration</span><button class="iconbtn" id="cX" aria-label="Close">${ICON.x}</button></div>
      <div class="calib-empty"><div class="big">🧪</div>
        <div>No AI-extracted items to calibrate yet.</div>
        <div class="muted">Items the AI has filled (with confidence) will appear here.</div></div></div>`;
    el.querySelector("#cX").onclick = close;
    return;
  }

  // Batch-sign all thumbnails up front (one request) for snappy stepping.
  const paths = items.map((x) => x.it.image_path).filter(Boolean);
  const signed = {};
  if (paths.length) {
    const { data: urls } = await supabase.storage.from("product-images").createSignedUrls(paths, 3600);
    (urls || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
  }

  // Pre-load existing verdicts so re-entry resumes where it left off.
  const marks = new Map(); // itemId -> { fieldKey: 'correct' | 'wrong' }
  const { data: prior } = await supabase
    .from("calibration_marks")
    .select("item_id, field, verdict")
    .in("item_id", items.map((x) => x.it.id));
  for (const m of prior || []) {
    if (!marks.has(m.item_id)) marks.set(m.item_id, {});
    marks.get(m.item_id)[m.field] = m.verdict;
  }

  let idx = 0;

  // ---- one item screen ----------------------------------------------------
  function renderItem() {
    const { it, fields } = items[idx];
    const verdicts = marks.get(it.id) || {};
    const url = signed[it.image_path];
    const brand = it.brand || it.name || "—";
    const done = idx + 1, total = items.length;

    const fieldRows = fields.map((f) => {
      const v = verdicts[f.key];
      return `<div class="cf-row" data-field="${esc(f.key)}">
        <div class="cf-info">
          <span class="cf-label">${esc(f.label)}</span>
          <span class="cf-val">${esc(f.value)}</span>
        </div>
        <span class="calib-lvl lvl-${f.level.toLowerCase()}" title="AI confidence">${f.level[0]}</span>
        <div class="cf-seg">
          <button class="cf-ok${v === "correct" ? " on" : ""}" data-v="correct" aria-label="Correct">✓</button>
          <button class="cf-no${v === "wrong" ? " on" : ""}" data-v="wrong" aria-label="Wrong">✕</button>
        </div>
      </div>`;
    }).join("");

    el.innerHTML = `<div class="calib-panel">
      <div class="calib-head">
        <button class="iconbtn" id="cX" aria-label="Close">${ICON.x}</button>
        <span>Calibration · ${done}/${total}</span>
        <button class="linkbtn" id="cAllOk">All correct</button>
      </div>
      <div class="calib-prog"><span style="width:${Math.round((done / total) * 100)}%"></span></div>
      <div class="calib-body">
        <div class="calib-photo">${url
          ? `<img src="${url}" alt="${esc(brand)}">`
          : `<div class="muted">no image</div>`}</div>
        <div class="calib-brand">${esc(brand)}</div>
        <div class="calib-hint muted">Mark each field against the photo. The letter is the AI's confidence.</div>
        <div class="cf-list">${fieldRows}</div>
      </div>
      <div class="calib-foot">
        <button class="ghost" id="cPrev"${idx === 0 ? " disabled" : ""}>Back</button>
        <button class="primary" id="cNext">${idx === total - 1 ? "Finish" : "Next"}</button>
      </div>
    </div>`;

    el.querySelector("#cX").onclick = close;
    el.querySelector("#cPrev").onclick = () => { if (idx > 0) { idx--; renderItem(); } };
    el.querySelector("#cNext").onclick = onNext;
    // Tap the photo to zoom — reading a label off the photo is the whole job here.
    if (url) el.querySelector(".calib-photo").onclick = () => openLightbox([{ url, caption: esc(brand) }], 0);
    el.querySelector("#cAllOk").onclick = () => {
      const v = marks.get(it.id) || {};
      for (const f of fields) v[f.key] = "correct";
      marks.set(it.id, v);
      renderItem();
    };

    // Per-field verdict toggling (delegated).
    el.querySelector(".cf-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-v]");
      if (!btn) return;
      const key = btn.closest(".cf-row").dataset.field;
      const v = marks.get(it.id) || {};
      v[key] = btn.dataset.v;
      marks.set(it.id, v);
      const row = btn.closest(".cf-row");
      row.querySelector(".cf-ok").classList.toggle("on", v[key] === "correct");
      row.querySelector(".cf-no").classList.toggle("on", v[key] === "wrong");
      navigator.vibrate?.(6);
    });
  }

  // Persist the current item's verdicts, then advance (or finish).
  async function onNext() {
    const { it, fields } = items[idx];
    const verdicts = marks.get(it.id) || {};
    const unmarked = fields.filter((f) => !verdicts[f.key]);
    if (unmarked.length) {
      toast(`Mark all ${fields.length} fields first (${unmarked.length} left)`);
      return;
    }
    await saveItemMarks(it, fields, verdicts);
    if (idx === items.length - 1) renderSummary();
    else { idx++; renderItem(); }
  }

  // Upsert one row per field (snapshotting the AI level + value), so the report
  // stays valid even if the item is later edited.
  async function saveItemMarks(it, fields, verdicts) {
    const payload = fields.map((f) => ({
      item_id: it.id,
      field: f.key,
      ai_level: f.level,
      ai_value: String(f.value),
      verdict: verdicts[f.key],
      actor: caps.id || null,
    }));
    const { error } = await supabase
      .from("calibration_marks")
      .upsert(payload, { onConflict: "item_id,field" });
    if (error) toast("Couldn't save marks: " + error.message);
  }

  // ---- summary screen -----------------------------------------------------
  // Accuracy by confidence level across everything marked this session, plus a
  // one-tap approve for the items whose every field came back correct.
  function renderSummary() {
    const byLevel = Object.fromEntries(LEVELS.map((l) => [l, { total: 0, correct: 0 }]));
    const allCorrectItems = []; // all-correct AND priced — eligible to approve
    let noPriceHeld = 0;        // all-correct but unpriced, so can't be approved
    for (const { it, fields } of items) {
      const verdicts = marks.get(it.id);
      if (!verdicts) continue;
      let everyCorrect = true, anyMarked = false;
      for (const f of fields) {
        const v = verdicts[f.key];
        if (!v) { everyCorrect = false; continue; }
        anyMarked = true;
        byLevel[f.level].total++;
        if (v === "correct") byLevel[f.level].correct++; else everyCorrect = false;
      }
      if (anyMarked && everyCorrect && it.status !== "approved") {
        if (it.price != null) allCorrectItems.push(it.id);
        else noPriceHeld++;
      }
    }

    const pct = (c, t) => (t === 0 ? "—" : `${Math.round((100 * c) / t)}%`);
    const levelRows = LEVELS.map((l) => {
      const b = byLevel[l];
      return `<div class="cs-row">
        <span class="calib-lvl lvl-${l.toLowerCase()}">${l[0]}</span>
        <span class="cs-name">${l} confidence</span>
        <span class="cs-rate">${pct(b.correct, b.total)} <span class="muted">(${b.correct}/${b.total})</span></span>
      </div>`;
    }).join("");

    const high = byLevel.High;
    const verdict = high.total < 10
      ? "Too few High-confidence fields marked to conclude — calibrate more items."
      : high.correct / high.total >= 0.95
        ? "High confidence looks trustworthy — batch-approving all-High items is reasonable (keep Undo)."
        : "High confidence is correcting too often to blind-approve — keep a human glance in the loop.";

    el.innerHTML = `<div class="calib-panel">
      <div class="calib-head"><span>Calibration results</span>
        <button class="iconbtn" id="cX" aria-label="Close">${ICON.x}</button></div>
      <div class="calib-body">
        <div class="cs-card">${levelRows}</div>
        <div class="calib-hint">${esc(verdict)}</div>
        ${allCorrectItems.length
          ? `<button class="primary cs-approve" id="cApprove">Approve ${allCorrectItems.length} all-correct item${allCorrectItems.length === 1 ? "" : "s"}</button>`
          : ""}
        ${noPriceHeld
          ? `<div class="calib-hint">${noPriceHeld} all-correct item${noPriceHeld === 1 ? "" : "s"} held back — no price set yet.</div>`
          : ""}
      </div>
      <div class="calib-foot"><button class="ghost" id="cDone">Done</button></div>
    </div>`;

    el.querySelector("#cX").onclick = close;
    el.querySelector("#cDone").onclick = close;
    const ap = el.querySelector("#cApprove");
    if (ap) ap.onclick = async () => {
      ap.disabled = true;
      const { error } = await supabase.from("items").update({ status: "approved" }).in("id", allCorrectItems);
      if (error) { toast("Approve failed: " + error.message); ap.disabled = false; return; }
      toast(`Approved ${allCorrectItems.length} item${allCorrectItems.length === 1 ? "" : "s"}`);
      navigator.vibrate?.([12, 40, 12]);
      ap.textContent = "Approved ✓";
    };
  }

  renderItem();
}
