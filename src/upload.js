import { supabase } from "./db.js";
import { loadRefData, resolveFields, categoryPath, vocabSuggestions, normalizeValue } from "./data.js";
import { compressImage } from "./imageCompress.js";

// The Add flow, built for large batches: pick/take many photos (with a preview
// grid you can prune), set fields common to the whole batch once, then upload
// in parallel with a progress bar, Stop, and retry of any failures.

const CONCURRENCY = 5; // parallel uploads

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
  if (error || data?.error || !data?.values) return;

  const vocabByKey = { brand: "brand" };
  const typeByKey = {};
  for (const d of defs) { if (d.vocab) vocabByKey[d.key] = d.vocab; typeByKey[d.key] = d.type; }

  const attributes = { ...common.attributes };
  const confidence = {};
  let brand = common.brand;
  let name = null;
  for (const [key, raw] of Object.entries(data.values)) {
    if (raw === null || raw === undefined || raw === "") continue;
    let val = String(raw);
    if (vocabByKey[key]) val = normalizeValue(vocabByKey[key], val);
    if (key === "brand") { if (!brand) brand = val; if (data.confidence?.brand) confidence.brand = data.confidence.brand; continue; }
    if (key === "name") { if (!name) name = val; if (data.confidence?.name) confidence.name = data.confidence.name; continue; }
    if (attributes[key] !== undefined && attributes[key] !== "") continue; // keep batch-common values
    attributes[key] = typeByKey[key] === "number" ? Number(val) : val;
    if (data.confidence?.[key]) confidence[key] = data.confidence[key];
  }
  await supabase.from("items").update({ brand, name, attributes, confidence }).eq("id", id);
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
          <span class="big">📷</span><span>Take photo</span>
        </label>
        <label class="pickbtn">
          <input id="libInput" type="file" accept="image/*" multiple hidden>
          <span class="big">🖼️</span><span>Choose photos</span>
        </label>
        <button type="button" class="pickbtn" id="webcamBtn">
          <span class="big">📸</span><span>Webcam</span>
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
                ${leaves.map((l) => `<option value="${l.id}">${esc(l.path)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div id="commonFields"></div>
          <div class="frow">
            <label for="statusSel">Status</label>
            <div class="fctl">
              <select id="statusSel"><option value="draft" selected>draft</option><option value="needs-review">needs-review</option></select>
            </div>
          </div>
          ${canEdit ? `<label class="cm-check up-ai"><input type="checkbox" id="aiAfter"> ✨ Auto AI-fill fields after upload <span class="muted">(slower; per-photo cost)</span></label>` : ""}
          <button class="primary up-go" id="uploadBtn" disabled>Upload</button>
        </div>
      </div>

      <div id="runArea" hidden>
        <div class="field-sec">Uploading…</div>
        <div class="up-bar"><div id="barFill"></div></div>
        <div class="up-stats" id="runStats"></div>
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
        <button class="up-x" data-rm="${esc(e.key)}" aria-label="Remove">✕</button>
      </div>`).join("");
    gridEl.querySelectorAll("[data-rm]").forEach((b) =>
      (b.onclick = () => removeFile(b.dataset.rm)));
  }
  camInput.addEventListener("change", () => { addFiles([...camInput.files]); camInput.value = ""; });
  libInput.addEventListener("change", () => { addFiles([...libInput.files]); libInput.value = ""; });

  // Webcam capture (mainly for desktop; needs HTTPS/localhost). Snap multiple
  // frames, each added to the batch; the stream stops on close.
  view.querySelector("#webcamBtn").onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { alert("Camera not available in this browser/context."); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
    catch (e) { alert("Couldn't access the camera: " + (e?.message || e)); return; }
    const ov = document.createElement("div");
    ov.className = "webcam";
    ov.innerHTML = `<div class="webcam-inner">
        <video id="wcVid" autoplay playsinline></video>
        <div class="webcam-bar">
          <button class="ghost" id="wcClose">Close</button>
          <span id="wcCount" class="muted"></span>
          <button class="primary" id="wcSnap">Capture</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const vid = ov.querySelector("#wcVid");
    vid.srcObject = stream;
    let snapped = 0;
    const close = () => { stream.getTracks().forEach((t) => t.stop()); ov.remove(); };
    ov.querySelector("#wcClose").onclick = close;
    ov.querySelector("#wcSnap").onclick = () => {
      const c = document.createElement("canvas");
      c.width = vid.videoWidth; c.height = vid.videoHeight;
      c.getContext("2d").drawImage(vid, 0, 0);
      c.toBlob((blob) => {
        if (!blob) return;
        addFiles([new File([blob], `webcam-${snapped}-${blob.size}.jpg`, { type: "image/jpeg" })]);
        snapped++;
        ov.querySelector("#wcCount").textContent = `${snapped} captured`;
      }, "image/jpeg", 0.92);
    };
  };

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

  function refreshEnabled() {
    uploadBtn.disabled = !(entries.length && catSel.value);
    uploadBtn.textContent = entries.length ? `Upload ${entries.length}` : "Upload";
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
      attributes[el.dataset.ck] = el.dataset.type === "number" ? Number(val) : val;
    });
    return {
      categoryId, slug: cache.byId[categoryId]?.slug || "misc", status: $("#statusSel").value,
      brand, attributes, ai: !!$("#aiAfter")?.checked,
    };
  }

  async function uploadOne(entry, common) {
    const { blob, ext } = await compressImage(entry.file);
    const id = uuid();
    const path = `${common.slug}/${id}.${ext}`;
    const up = await supabase.storage.from("product-images")
      .upload(path, blob, { contentType: blob.type || "image/webp", upsert: false });
    if (up.error) throw up.error;
    const ins = await supabase.from("items").insert({
      id, category_id: common.categoryId, brand: common.brand,
      attributes: common.attributes, status: common.status,
      image_path: path, original_filename: entry.file.name,
    });
    if (ins.error) throw ins.error;
    // Opt-in: read the photo and fill any still-empty fields. Soft-fails — the
    // photo is already saved, so an AI hiccup never fails the upload.
    if (common.ai) { try { await aiFillItem(id, common); } catch (e) { console.error("ai-fill failed", e); } }
  }

  const barFill = $("#barFill");
  const runStats = $("#runStats");
  const stopBtn = $("#stopBtn");
  function paintRun(p, total, done, failed) {
    if (!barFill?.isConnected) return;
    barFill.style.width = `${total ? Math.round((p / total) * 100) : 0}%`;
    runStats.innerHTML = `${p}/${total} processed · <b>${done}</b> added${failed ? ` · <span style="color:#ffb3b8">${failed} failed</span>` : ""}`;
  }

  async function startUpload(list) {
    const common = gatherCommon();
    if (!common) { alert("Choose a category first."); return; }
    stopFlag = false;
    stopBtn.disabled = false;
    stopBtn.textContent = "Stop";
    setMode("running");
    const total = list.length;
    let done = 0, failed = 0, processed = 0, firstError = "";
    const doneEntries = [];
    paintRun(0, total, 0, 0);

    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* best effort */ }

    let idx = 0;
    const worker = async () => {
      while (!stopFlag) {
        const i = idx++;
        if (i >= list.length) return;
        const entry = list[i];
        try { await uploadOne(entry, common); done++; doneEntries.push(entry); }
        catch (err) {
          failed++;
          if (!firstError) firstError = err?.message || String(err);
          console.error("upload failed", entry.file.name, err);
        }
        processed++;
        paintRun(processed, total, done, failed);
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
    finishUpload(done, failed, firstError);
  }

  function finishUpload(added, failed, firstError) {
    if (!doneArea?.isConnected) return; // user navigated away mid-upload
    setMode("done");
    const remaining = entries.length;
    $("#doneMsg").innerHTML =
      `Added ${added}${failed ? ` · ${failed} failed` : ""}${remaining ? ` · ${remaining} remaining` : ""}.` +
      (firstError ? `<div class="up-err">${esc(firstError)}</div>` : "");
    const acts = [];
    if (remaining > 0) acts.push(`<button class="primary up-go" data-d="retry">Upload remaining ${remaining}</button>`);
    acts.push(`<button class="ghost up-go" data-d="more">Add more photos</button>`);
    acts.push(`<button class="ghost up-go" data-d="review">Review in gallery</button>`);
    $("#doneActions").innerHTML = acts.join("");
    $("#doneActions").querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => {
      if (b.dataset.d === "retry") startUpload(entries.slice());
      else if (b.dataset.d === "more") { setMode("compose"); renderPicked(); renderGrid(); refreshEnabled(); }
      else { entries.forEach((e) => URL.revokeObjectURL(e.url)); onDone?.(); }
    }));
  }

  stopBtn.onclick = () => { stopFlag = true; stopBtn.disabled = true; stopBtn.textContent = "Stopping…"; };
  uploadBtn.addEventListener("click", () => startUpload(entries.slice()));

  setMode("compose");
}
