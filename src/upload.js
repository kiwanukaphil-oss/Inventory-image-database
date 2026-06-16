import { supabase } from "./db.js";
import { loadRefData, resolveFields, categoryPath, vocabSuggestions, normalizeValue, normalizeAttributeValue } from "./data.js";
import { compressImage } from "./imageCompress.js";
import { clearItemJobFailures, recordItemJobFailure } from "./joblog.js";
import { diffItemValues, logItemActivity } from "./activity.js";
import { dHash, hammingHex } from "./imagehash.js";
import { toast, trapFocus, ICON } from "./ui.js";

// The Add flow, built for large batches: pick/take many photos (with a preview
// grid you can prune), set fields common to the whole batch once, then upload
// in parallel with a progress bar, Stop, and retry of any failures.

const CONCURRENCY = 5; // parallel uploads
const UPLOAD_DEFAULTS_KEY = "kline.upload.defaults.v2";

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost), so it's
// missing when testing on a phone over the plain-http LAN URL. Fall back to a
// v4 UUID from getRandomValues (or Math.random as a last resort).
function uuid() {
  try { if (globalThis.crypto?.randomUUID) return crypto.randomUUID(); } catch {}
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); }
  catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function loadUploadDefaults() {
  try { return JSON.parse(localStorage.getItem(UPLOAD_DEFAULTS_KEY) || "null") || {}; }
  catch { return {}; }
}

function saveUploadDefaults(common) {
  try {
    localStorage.setItem(UPLOAD_DEFAULTS_KEY, JSON.stringify({
      categoryId: common.categoryId,
      status: common.status,
      brand: common.brand || "",
      attributes: common.attributes || {},
      ai: !!common.ai,
    }));
  } catch {}
}

function clearUploadDefaults() {
  try { localStorage.removeItem(UPLOAD_DEFAULTS_KEY); } catch {}
}

// Pick up any photos shared into the app via the PWA share target (stashed in a
// Cache by public/sw-share.js), hand them to the Add flow, then clear the cache
// so a later visit doesn't re-import them. Safe no-op when nothing was shared.
async function consumeSharedMedia(addFiles) {
  try {
    if (!self.caches) return;
    const cache = await caches.open("shared-media");
    const idx = await cache.match("/shared-media/index.json");
    if (!idx) return;
    const names = await idx.json();
    const files = [];
    for (const name of names) {
      const res = await cache.match(`/shared-media/${name}`);
      if (!res) continue;
      const blob = await res.blob();
      files.push(new File([blob], name.replace(/^shared-\d+-/, "") || "shared.jpg", { type: blob.type || "image/jpeg" }));
    }
    const keys = await cache.keys();
    await Promise.all(keys.map((k) => cache.delete(k)));
    if (files.length) addFiles(files);
  } catch { /* caches API unavailable / blocked — ignore */ }
}

// Run the vision extractor on a freshly-uploaded item and fill any fields that
// are still empty (never overrides the batch-common values the user set).
async function aiFillItem(id, common) {
  const defs = [
    { key: "brand", label: "Brand" },
    { key: "name", label: "Product name" },
    ...resolveFields(common.categoryId).map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, vocab: f.vocab })),
  ];
  const { data, error } = await supabase.functions.invoke("ai-extract", {
    body: { item_id: id, category: categoryPath(common.categoryId), fields: defs },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  if (!data?.values) throw new Error("AI returned no values.");

  const vocabByKey = { brand: "brand" };
  const typeByKey = {};
  for (const d of defs) { if (d.vocab) vocabByKey[d.key] = d.vocab; typeByKey[d.key] = d.type; }

  const attributes = { ...common.attributes };
  const confidence = {};
  let brand = common.brand;
  let name = null;
  let filled = 0; // fields the AI actually set (drives the needs-review promotion)
  for (const [key, raw] of Object.entries(data.values)) {
    if (raw === null || raw === undefined || raw === "") continue;
    let val = String(raw);
    if (vocabByKey[key]) val = normalizeValue(vocabByKey[key], val);
    if (key === "brand") { if (!brand) { brand = val; filled++; } if (data.confidence?.brand) confidence.brand = data.confidence.brand; continue; }
    if (key === "name") { if (!name) { name = val; filled++; } if (data.confidence?.name) confidence.name = data.confidence.name; continue; }
    if (attributes[key] !== undefined && attributes[key] !== "") continue; // keep batch-common values
    val = normalizeAttributeValue(common.categoryId, key, val);
    attributes[key] = typeByKey[key] === "number" ? Number(val) : val;
    if (data.confidence?.[key]) confidence[key] = data.confidence[key];
    filled++;
  }
  const update = { brand, name, attributes, confidence };
  // Same rule as bulk AI-fill: an AI-touched draft surfaces in Review rather
  // than sitting silently as a confident-but-unchecked draft.
  if (filled && common.status === "draft") update.status = "needs-review";
  const before = {
    id,
    category_id: common.categoryId,
    brand: common.brand,
    name: null,
    attributes: common.attributes || {},
    confidence: {},
    status: common.status,
    stock_quantity: 1,
  };
  const { error: upErr } = await supabase.from("items").update(update).eq("id", id);
  if (upErr) throw upErr;
  if (filled) {
    await logItemActivity(
      id,
      "ai_fill",
      "ai",
      diffItemValues(before, { ...before, ...update }),
      `AI filled ${filled} field${filled === 1 ? "" : "s"} after upload`
    );
  }
  await clearItemJobFailures(id, "ai_fill");
  // Return what the AI read so live surfaces (burst filmstrip) can show it.
  return { brand, name, filled, confidence };
}

// Leaf categories (no children) are where items actually go.
function leafCategories(cache) {
  const hasChild = new Set(cache.categories.filter((c) => c.parent_id).map((c) => c.parent_id));
  return cache.categories
    .filter((c) => !hasChild.has(c.id))
    .map((c) => ({ id: c.id, path: categoryPath(c.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function renderUpload(view, caps, onDone) {
  if (!caps?.can_upload) {
    view.innerHTML = `<div class="empty"><div class="big">🔒</div>
      <div>You don't have permission to add items.</div></div>`;
    return;
  }

  const canEdit = !!caps.can_edit; // AI extraction requires editor/admin
  const cache = await loadRefData();
  const leaves = leafCategories(cache);
  let uploadDefaults = loadUploadDefaults();
  if (!leaves.some((l) => l.id === uploadDefaults.categoryId)) uploadDefaults = {};
  const entries = []; // { key, file, url }
  const seen = new Set(); // dedupe key set
  let stopFlag = false;
  let wakeLock = null;

  view.innerHTML = `
    <div class="uploader">
      <h2 class="up-h">Add photos</h2>
      <div class="pickrow" id="pickRow">
        <label class="pickbtn">
          <input id="camInput" type="file" accept="image/*" capture="environment" hidden>
          <span class="big">${ICON.camera}</span><span>Take photo</span>
        </label>
        <label class="pickbtn">
          <input id="libInput" type="file" accept="image/*" multiple hidden>
          <span class="big">${ICON.image}</span><span>Choose photos</span>
        </label>
        <button type="button" class="pickbtn pickbtn-hero" id="webcamBtn">
          <span class="big">${ICON.camera}</span><span>Burst capture</span>
          <span class="pickbtn-sub">snap each unit, hands-free</span>
        </button>
      </div>

      <div id="composeArea">
        <div id="picked" class="picked"></div>
        <div class="up-grid" id="grid"></div>

        <div id="batchForm" style="display:none">
          <div class="field-sec">Common to all photos in this batch</div>
          <div class="frow">
            <label for="catSel">Category</label>
            <div class="fctl">
              <select id="catSel"><option value="">Choose…</option>
                ${leaves.map((l) => `<option value="${l.id}"${uploadDefaults.categoryId === l.id ? " selected" : ""}>${esc(l.path)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div id="commonFields"></div>
          <div class="frow">
            <label for="statusSel">Status</label>
            <div class="fctl">
              <select id="statusSel"><option value="draft"${uploadDefaults.status !== "needs-review" ? " selected" : ""}>draft</option><option value="needs-review"${uploadDefaults.status === "needs-review" ? " selected" : ""}>needs-review</option></select>
            </div>
          </div>
          ${canEdit ? `<label class="cm-check up-ai"><input type="checkbox" id="aiAfter"${uploadDefaults.ai ? " checked" : ""}> <span class="ai-ico">${ICON.sparkle}</span> Auto AI-fill fields after upload <span class="muted">(slower; per-photo cost; AI-filled items go to Review)</span></label>` : ""}
          <div class="up-defaults" id="upDefaults" ${uploadDefaults.categoryId ? "" : "hidden"}>
            <span>Using last batch defaults.</span>
            <button type="button" class="linkbtn" id="clearDefaults">Clear</button>
          </div>
          <button class="primary up-go" id="uploadBtn" disabled>Upload</button>
          <div class="up-hint muted" id="upHint"></div>
        </div>
      </div>

      <div id="runArea" hidden>
        <div class="field-sec">Uploading…</div>
        <div class="up-bar"><div id="barFill"></div></div>
        <div class="up-stats" id="runStats" aria-live="polite"></div>
        <button class="danger up-go" id="stopBtn">Stop</button>
      </div>

      <div id="doneArea" hidden>
        <div class="up-done" id="doneMsg"></div>
        <div class="up-actions" id="doneActions"></div>
      </div>

      <datalist id="dl-brand">${vocabSuggestions("brand").map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
    </div>`;

  const $ = (sel) => view.querySelector(sel);
  const camInput = $("#camInput");
  const libInput = $("#libInput");
  const pickRow = $("#pickRow");
  const composeArea = $("#composeArea");
  const runArea = $("#runArea");
  const doneArea = $("#doneArea");
  const pickedEl = $("#picked");
  const gridEl = $("#grid");
  const batchForm = $("#batchForm");
  const catSel = $("#catSel");
  const commonFields = $("#commonFields");
  const uploadBtn = $("#uploadBtn");
  const defaultsEl = $("#upDefaults");
  $("#clearDefaults")?.addEventListener("click", () => {
    clearUploadDefaults();
    uploadDefaults = {};
    if (defaultsEl) defaultsEl.hidden = true;
    toast("Upload defaults cleared");
  });

  function setMode(m) {
    pickRow.hidden = m !== "compose";
    composeArea.hidden = m !== "compose";
    runArea.hidden = m !== "running";
    doneArea.hidden = m !== "done";
  }

  // ---- selection ----
  const keyOf = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  function addFiles(list) {
    for (const f of list) {
      const key = keyOf(f);
      if (seen.has(key)) continue; // de-dupe
      seen.add(key);
      entries.push({ key, file: f, url: URL.createObjectURL(f) });
    }
    renderPicked();
    renderGrid();
    batchForm.style.display = entries.length ? "block" : "none";
    refreshEnabled();
  }
  function removeFile(key) {
    const i = entries.findIndex((e) => e.key === key);
    if (i < 0) return;
    URL.revokeObjectURL(entries[i].url);
    entries.splice(i, 1);
    seen.delete(key);
    renderPicked();
    renderGrid();
    batchForm.style.display = entries.length ? "block" : "none";
    refreshEnabled();
  }
  function clearAll() {
    entries.forEach((e) => URL.revokeObjectURL(e.url));
    entries.length = 0;
    seen.clear();
    renderPicked();
    renderGrid();
    batchForm.style.display = "none";
    refreshEnabled();
  }
  function renderPicked() {
    pickedEl.innerHTML = entries.length
      ? `${entries.length} photo${entries.length === 1 ? "" : "s"} selected · <a href="#" id="clearPick">clear all</a>`
      : "";
    const c = $("#clearPick");
    if (c) c.onclick = (e) => { e.preventDefault(); clearAll(); };
  }
  function renderGrid() {
    gridEl.innerHTML = entries
      .map((e) => `<div class="up-thumb" data-key="${esc(e.key)}">
        <img loading="lazy" src="${e.url}" alt="">
        <button class="up-x" data-rm="${esc(e.key)}" aria-label="Remove">${ICON.x}</button>
      </div>`).join("");
    gridEl.querySelectorAll("[data-rm]").forEach((b) =>
      (b.onclick = () => removeFile(b.dataset.rm)));
  }
  camInput.addEventListener("change", () => { addFiles([...camInput.files]); camInput.value = ""; });
  libInput.addEventListener("change", () => { addFiles([...libInput.files]); libInput.value = ""; });

  // Burst capture: a full-screen, stay-open camera built for the core workflow
  // (one photo = one unit, many per session). Tap the big shutter to snap each
  // unit — the camera stays live, each frame uploads immediately and the AI reads
  // it in the background, so its filmstrip tile self-identifies (brand · name +
  // confidence) while you keep shooting. Needs a secure context (HTTPS/localhost)
  // and a connection; otherwise it falls back to the queued "Take photo" path.
  view.querySelector("#webcamBtn").onclick = () => openBurstCapture();

  async function openBurstCapture() {
    // Live burst reads each photo as you shoot, so it needs the category up front
    // (this also fixes "category only choosable after the session") and a live
    // connection. Without either, fall back to the queued "Take photo" path.
    const common = gatherCommon();
    if (!common) { toast("Pick a category first — burst reads each photo as you shoot."); catSel?.focus(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { toast("Camera not available here — use “Take photo”."); return; }
    if (!navigator.onLine) { toast("You're offline — live burst needs a connection. Use “Take photo” to queue units."); return; }
    const burstCommon = { ...common, ai: true }; // self-ID is the whole point of burst
    let stream;
    try {
      // Prefer the rear camera at a high resolution; compressImage downscales later.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e) {
      console.error("camera open failed", e);
      toast("Couldn't open the camera — check the permission in your browser, or use “Take photo”.");
      return;
    }

    const ov = document.createElement("div");
    ov.className = "burst";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "Burst capture");
    ov.tabIndex = -1;
    ov.innerHTML = `
      <video id="bcVid" autoplay playsinline muted></video>
      <div class="burst-flash" id="bcFlash"></div>
      <div class="burst-top">
        <button class="burst-x" id="bcClose" aria-label="Close camera (Esc)">${ICON.x}</button>
        <span class="burst-count" id="bcCount" aria-live="polite">Tap the shutter to start</span>
      </div>
      <div class="burst-bottom">
        <div class="burst-strip" id="bcStrip"></div>
        <div class="burst-controls">
          <button class="burst-undo" id="bcUndo" disabled>Undo</button>
          <button class="burst-shutter" id="bcShutter" aria-label="Capture photo"></button>
          <button class="burst-done primary" id="bcDone">Done</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const releaseFocus = trapFocus(ov);
    const vid = ov.querySelector("#bcVid");
    vid.srcObject = stream;

    // One entry per snapped unit, uploaded + AI-read immediately. Each tile in the
    // filmstrip reflects its phase: uploading -> reading -> the brand/name the AI
    // recognised (with a confidence dot), or an error to re-shoot.
    const session = [];
    const countEl = ov.querySelector("#bcCount");
    const stripEl = ov.querySelector("#bcStrip");
    const undoBtn = ov.querySelector("#bcUndo");
    const flashEl = ov.querySelector("#bcFlash");

    // Worst per-field confidence drives the tile's dot colour (amber/red = check).
    const worstConf = (confidence) => {
      const vals = Object.values(confidence || {});
      if (vals.some((v) => v === "Low")) return "low";
      if (vals.some((v) => v === "Medium")) return "medium";
      return vals.length ? "high" : "";
    };

    function tileHtml(s) {
      const busy = s.state === "uploading" || s.state === "reading";
      const overlay = busy ? `<span class="bt-spin" aria-hidden="true"></span>`
        : s.state === "err" ? `<span class="bt-err" title="Couldn't save — re-shoot">!</span>`
        : s.label ? `<span class="bt-label">${esc(s.label)}</span>` : "";
      const dot = (s.state === "done" && s.conf) ? `<span class="bt-dot bt-${s.conf}"></span>` : "";
      const phase = s.state === "uploading" ? "Saving" : s.state === "reading" ? "Reading…" : "";
      return `<div class="bt bt-${s.state}">
        <img src="${s.url}" alt="${esc(s.label || "captured unit")}">
        ${overlay}${dot}${s.dup ? `<span class="bt-dup" title="Possible repeat of the previous shot">≈</span>` : ""}${phase ? `<span class="bt-phase">${phase}</span>` : ""}</div>`;
    }

    function paintBurst() {
      const n = session.length;
      const reading = session.filter((s) => s.state === "uploading" || s.state === "reading").length;
      countEl.textContent = n ? `${n} captured${reading ? ` · ${reading} reading…` : ""}` : "Tap the shutter to start";
      undoBtn.disabled = n === 0;
      stripEl.innerHTML = session.slice(-6).reverse().map(tileHtml).join("");
    }

    async function snap() {
      if (!vid.videoWidth) { toast("Camera still focusing — try again."); return; }
      const c = document.createElement("canvas");
      c.width = vid.videoWidth; c.height = vid.videoHeight;
      c.getContext("2d").drawImage(vid, 0, 0);
      // Near-duplicate guard: flag ONLY a recent, near-identical frame. A
      // deliberate next identical unit is shot after a pause to swap the item, so
      // this catches an accidental double-tap without nagging on legitimately
      // identical stock (one photo = one unit).
      const hash = dHash(c);
      const last = session[session.length - 1];
      const looksDup = !!(last && last.hash && (Date.now() - last.t) < 4000 && hammingHex(last.hash, hash) <= 6);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
      if (!blob) return;
      const file = new File([blob], `capture-${session.length}-${blob.size}.jpg`, { type: "image/jpeg" });
      const s = { url: URL.createObjectURL(blob), state: "uploading", label: "", conf: "", id: null, path: null, hash, t: Date.now(), dup: looksDup };
      session.push(s);
      paintBurst();
      navigator.vibrate?.(looksDup ? [10, 40, 10] : 15);
      flashEl.classList.remove("on"); void flashEl.offsetWidth; flashEl.classList.add("on");
      if (looksDup) toast("Looks like the unit you just shot — Undo if it's a repeat.", { label: "Undo", onClick: undoLast });
      try {
        const res = await uploadOne({ file }, burstCommon, () => { s.state = "reading"; paintBurst(); });
        s.id = res.id; s.path = res.path; s.state = "done";
        if (res.ai) { s.label = [res.ai.brand, res.ai.name].filter(Boolean).join(" · "); s.conf = worstConf(res.ai.confidence); }
      } catch (e) {
        s.state = "err";
        console.error("burst upload failed", e);
        toast("Couldn't save that photo — check your connection and re-shoot.");
      }
      paintBurst();
    }

    // Undo removes the last unit — including deleting it server-side if it already
    // uploaded — so the captured count never overstates real stock.
    async function undoLast() {
      const s = session.pop();
      paintBurst();
      navigator.vibrate?.(8);
      if (!s) return;
      if (!s.id) { if (s.url) URL.revokeObjectURL(s.url); return; } // not uploaded yet
      try {
        const { error } = await supabase.from("items").delete().eq("id", s.id);
        if (error) throw error;
        if (s.path) await supabase.storage.from("product-images").remove([s.path]);
        if (s.url) URL.revokeObjectURL(s.url); // free the thumb only once the row is really gone
      } catch (e) {
        // R3: the unit is still in the DB — re-surfacing it keeps the captured
        // count honest (a silent drop would understate real stock + orphan a row
        // that can reach Review/POS). Keep the thumb (url not revoked) and let
        // the user retry.
        console.error("burst undo delete failed", e);
        session.push(s);
        paintBurst();
        toast("Couldn't remove that unit — it's still saved. Tap Undo to retry.");
      }
    }

    const close = () => {
      releaseFocus();
      stream.getTracks().forEach((t) => t.stop());
      session.forEach((s) => s.url && URL.revokeObjectURL(s.url));
      ov.remove();
      // Units are already uploaded + queued for Review (AI promotes them there).
      const ids = session.filter((s) => s.id).map((s) => s.id);
      if (ids.length) onDone?.({ view: "review", itemIds: ids });
    };

    ov.querySelector("#bcShutter").onclick = snap;
    ov.querySelector("#bcUndo").onclick = undoLast;
    ov.querySelector("#bcClose").onclick = close;
    ov.querySelector("#bcDone").onclick = close;
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      // Space/Enter as a hardware-shutter style trigger for keyboards.
      else if ((e.key === " " || e.key === "Enter") && e.target === ov) { e.preventDefault(); snap(); }
    });
    requestAnimationFrame(() => ov.querySelector("#bcShutter")?.focus());
  }

  // When a category is chosen, render its (optional) common fields + brand.
  catSel.addEventListener("change", () => {
    const fields = catSel.value ? resolveFields(catSel.value) : [];
    commonFields.innerHTML =
      `<div class="frow"><label for="c-brand">Brand</label>
         <div class="fctl"><input id="c-brand" data-ck="brand" list="dl-brand"></div></div>` +
      fields.map((f) => {
        const dl = f.vocab ? ` list="dl-${f.vocab}"` : "";
        if (f.vocab && !view.querySelector(`#dl-${f.vocab}`)) {
          const d = document.createElement("datalist");
          d.id = `dl-${f.vocab}`;
          d.innerHTML = vocabSuggestions(f.vocab).map((o) => `<option value="${esc(o)}">`).join("");
          view.querySelector(".uploader").appendChild(d);
        }
        const type = f.type === "number" ? "number" : "text";
        return `<div class="frow"><label for="c-${f.key}">${esc(f.label)}</label>
          <div class="fctl"><input id="c-${f.key}" type="${type}"${dl}
            data-ck="${f.key}" data-vocab="${f.vocab || ""}" data-type="${f.type}"></div></div>`;
      }).join("");
    refreshEnabled();
  });
  function applyUploadDefaultsToFields() {
    if (!uploadDefaults.categoryId || catSel.value !== uploadDefaults.categoryId) return;
    const fieldByKey = (key) => [...commonFields.querySelectorAll("[data-ck]")]
      .find((el) => el.dataset.ck === key);
    const brandEl = fieldByKey("brand");
    if (brandEl && uploadDefaults.brand) brandEl.value = uploadDefaults.brand;
    for (const [key, value] of Object.entries(uploadDefaults.attributes || {})) {
      const el = fieldByKey(key);
      if (el && value !== null && value !== undefined) el.value = value;
    }
  }
  if (uploadDefaults.categoryId) {
    catSel.dispatchEvent(new Event("change"));
    applyUploadDefaultsToFields();
  }

  function refreshEnabled() {
    uploadBtn.disabled = !(entries.length && catSel.value);
    uploadBtn.textContent = entries.length ? `Upload ${entries.length}` : "Upload";
    const hintEl = $("#upHint");
    if (hintEl) hintEl.textContent = entries.length && !catSel.value ? "Choose a category to enable upload." : "";
  }

  // Gather the batch-common values once.
  function gatherCommon() {
    const categoryId = catSel.value;
    if (!categoryId) return null;
    const attributes = {};
    let brand = null;
    commonFields.querySelectorAll("[data-ck]").forEach((el) => {
      let val = el.value.trim();
      if (!val) return;
      if (el.dataset.ck === "brand") { brand = normalizeValue("brand", val); return; }
      if (el.dataset.vocab) val = normalizeValue(el.dataset.vocab, val);
      val = normalizeAttributeValue(categoryId, el.dataset.ck, val);
      attributes[el.dataset.ck] = el.dataset.type === "number" ? Number(val) : val;
    });
    return {
      categoryId, slug: cache.byId[categoryId]?.slug || "misc", status: $("#statusSel").value,
      brand, attributes, ai: !!$("#aiAfter")?.checked,
    };
  }

  // Upload one photo and create its item. onUploaded(id) fires after the row
  // exists but before AI runs, so the burst filmstrip can flip to "reading…".
  // Returns the new id/path plus the AI result (for live self-ID surfaces).
  async function uploadOne(entry, common, onUploaded) {
    const { blob, ext, oversize } = await compressImage(entry.file);
    // R6: only reject the absurd case (couldn't compress AND still huge); normal
    // fallbacks upload as-is. Prevents silently storing a 10MB+ phone photo.
    if (oversize) throw new Error("Photo is too large and couldn't be compressed — use a smaller image.");
    const id = uuid();
    const path = `${common.slug}/${id}.${ext}`;
    const up = await supabase.storage.from("product-images")
      .upload(path, blob, { contentType: blob.type || "image/webp", upsert: false });
    if (up.error) throw up.error;
    const ins = await supabase.from("items").insert({
      id, category_id: common.categoryId, brand: common.brand,
      attributes: common.attributes, status: common.status,
      image_path: path, original_filename: entry.file.name,
      // One photo = one unit (workflow rule): every physical unit gets its own
      // photo as evidence, so the receipt quantity is always 1 — never a total.
      stock_quantity: 1,
    });
    if (ins.error) throw ins.error;
    await logItemActivity(id, "upload", "upload", [], "Uploaded product photo");
    onUploaded?.(id);
    // Opt-in: read the photo and fill any still-empty fields. Soft-fails — the
    // photo is already saved, so an AI hiccup never fails the upload.
    if (common.ai) {
      try {
        const ai = await aiFillItem(id, common);
        return { id, path, aiFailed: false, aiError: "", ai };
      } catch (e) {
        await recordItemJobFailure(id, "ai_fill", e);
        console.error("ai-fill failed", e);
        return { id, path, aiFailed: true, aiError: e?.message || String(e), ai: null };
      }
    }
    return { id, path, aiFailed: false, aiError: "", ai: null };
  }

  const barFill = $("#barFill");
  const runStats = $("#runStats");
  const stopBtn = $("#stopBtn");
  function paintRun(p, total, done, failed, aiFailed = 0) {
    if (!barFill?.isConnected) return;
    barFill.style.width = `${total ? Math.round((p / total) * 100) : 0}%`;
    runStats.innerHTML = `${p}/${total} processed · <b>${done}</b> added${aiFailed ? ` · <span style="color:var(--review-txt)">${aiFailed} AI issue${aiFailed === 1 ? "" : "s"}</span>` : ""}${failed ? ` · <span style="color:var(--flag-txt)">${failed} failed</span>` : ""}`;
  }

  async function startUpload(list) {
    const common = gatherCommon();
    if (!common) { toast("Choose a category first."); return; }
    if (!navigator.onLine) { toast("You're offline — connect to upload. The batch is kept; tap Upload again when you're back online."); return; }
    saveUploadDefaults(common);
    uploadDefaults = loadUploadDefaults();
    if (defaultsEl) defaultsEl.hidden = false;
    stopFlag = false;
    stopBtn.disabled = false;
    stopBtn.textContent = "Stop";
    setMode("running");
    const total = list.length;
    let done = 0, failed = 0, aiFailed = 0, processed = 0, firstError = "", firstAiError = "", pausedOffline = false;
    const uploadedIds = [];
    const doneEntries = [];
    const aiFailedIds = [];
    paintRun(0, total, 0, 0);

    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* best effort */ }

    let idx = 0;
    const worker = async () => {
      while (!stopFlag) {
        const i = idx++;
        if (i >= list.length) return;
        const entry = list[i];
        try {
          const result = await uploadOne(entry, common);
          done++;
          uploadedIds.push(result.id);
          doneEntries.push(entry);
          if (result.aiFailed) {
            aiFailed++;
            aiFailedIds.push(result.id);
            if (!firstAiError) firstAiError = result.aiError;
          }
        }
        catch (err) {
          // Lost connection mid-batch: pause and resume automatically on reconnect.
          if (!navigator.onLine) { pausedOffline = true; stopFlag = true; break; }
          failed++;
          if (!firstError) firstError = err?.message || String(err);
          console.error("upload failed", entry.file.name, err);
        }
        processed++;
        paintRun(processed, total, done, failed, aiFailed);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    try { await wakeLock?.release(); } catch {} wakeLock = null;

    // Drop the successfully-uploaded photos from the batch (failed/unprocessed stay).
    for (const e of doneEntries) {
      URL.revokeObjectURL(e.url);
      const k = entries.findIndex((x) => x.key === e.key);
      if (k >= 0) entries.splice(k, 1);
      seen.delete(e.key);
    }

    // Paused because the connection dropped — auto-resume the rest on reconnect.
    if (pausedOffline && entries.length) {
      if (doneArea?.isConnected) {
        setMode("done");
        $("#doneMsg").innerHTML = `Paused — you're offline. <b>${done}</b> added${aiFailed ? `; ${aiFailed} need AI retry` : ""}; ${entries.length} will resume automatically when you're back online.`;
        $("#doneActions").innerHTML = "";
      }
      window.addEventListener("online", () => startUpload(entries.slice()), { once: true });
      return;
    }
    finishUpload({ added: done, failed, aiFailed, firstError, firstAiError, uploadedIds, aiFailedIds });
  }

  function finishUpload({ added, failed, aiFailed, firstError, firstAiError, uploadedIds = [], aiFailedIds = [] }) {
    if (!doneArea?.isConnected) return; // user navigated away mid-upload
    setMode("done");
    if (added) navigator.vibrate?.([12, 40, 12]); // affirmative "batch done" buzz
    const remaining = entries.length;
    $("#doneMsg").innerHTML =
      `<div class="up-summary">
        <span class="up-stat ok"><b>${added}</b><small>Added</small></span>
        ${aiFailed ? `<span class="up-stat warn"><b>${aiFailed}</b><small>AI issue${aiFailed === 1 ? "" : "s"}</small></span>` : ""}
        ${failed ? `<span class="up-stat bad"><b>${failed}</b><small>Upload failed</small></span>` : ""}
        ${remaining ? `<span class="up-stat"><b>${remaining}</b><small>Remaining</small></span>` : ""}
      </div>` +
      (firstAiError ? `<div class="up-err">AI issue: ${esc(firstAiError)}</div>` : "") +
      (firstError ? `<div class="up-err">Upload failed: ${esc(firstError)}</div>` : "");
    const acts = [];
    if (remaining > 0) acts.push(`<button class="primary up-go" data-d="retry">Upload remaining ${remaining}</button>`);
    if (aiFailedIds.length) acts.push(`<button class="primary up-go" data-d="ai">Review AI issues</button>`);
    if (uploadedIds.length) acts.push(`<button class="${aiFailedIds.length ? "ghost" : "primary"} up-go" data-d="batch">Review this batch</button>`);
    acts.push(`<button class="ghost up-go" data-d="more">Add more photos</button>`);
    acts.push(`<button class="ghost up-go" data-d="gallery">View gallery</button>`);
    $("#doneActions").innerHTML = acts.join("");
    $("#doneActions").querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => {
      if (b.dataset.d === "retry") startUpload(entries.slice());
      else if (b.dataset.d === "more") { setMode("compose"); renderPicked(); renderGrid(); refreshEnabled(); }
      else {
        entries.forEach((e) => URL.revokeObjectURL(e.url));
        onDone?.({
          view: b.dataset.d === "batch" || b.dataset.d === "ai" ? "review" : "gallery",
          itemIds: b.dataset.d === "ai" ? aiFailedIds : uploadedIds,
          issue: b.dataset.d === "ai" ? "ai" : undefined,
        });
      }
    }));
  }

  stopBtn.onclick = () => { stopFlag = true; stopBtn.disabled = true; stopBtn.textContent = "Stopping…"; };
  uploadBtn.addEventListener("click", () => startUpload(entries.slice()));

  setMode("compose");
  consumeSharedMedia(addFiles); // import any photos shared into the app (PWA share target)
}
