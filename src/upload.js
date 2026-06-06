import { supabase } from "./db.js";
import {
  loadRefData,
  resolveFields,
  categoryPath,
  vocabSuggestions,
  normalizeValue,
} from "./data.js";
import { compressImage } from "./imageCompress.js";

// The Add flow: pick/take multiple photos, choose the target category, set any
// fields common to the whole batch once (e.g. 100 shots all Khaki), then each
// photo is compressed, uploaded, and inserted as a draft item to refine later.

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Leaf categories (no children) are where items actually go.
function leafCategories(cache) {
  const hasChild = new Set(cache.categories.filter((c) => c.parent_id).map((c) => c.parent_id));
  return cache.categories
    .filter((c) => !hasChild.has(c.id))
    .map((c) => ({ id: c.id, path: categoryPath(c.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function renderUpload(view, role, onDone) {
  if (role !== "admin" && role !== "editor") {
    view.innerHTML = `<div class="empty"><div class="big">🔒</div>
      <div>You don't have permission to add items.</div></div>`;
    return;
  }

  const cache = await loadRefData();
  const leaves = leafCategories(cache);
  const state = { files: [] };

  view.innerHTML = `
    <div class="uploader">
      <h2 class="up-h">Add photos</h2>
      <div class="pickrow">
        <label class="pickbtn">
          <input id="camInput" type="file" accept="image/*" capture="environment" hidden>
          <span class="big">📷</span><span>Take photo</span>
        </label>
        <label class="pickbtn">
          <input id="libInput" type="file" accept="image/*" multiple hidden>
          <span class="big">🖼️</span><span>Choose photos</span>
        </label>
      </div>
      <div id="picked" class="picked"></div>

      <div id="batchForm" style="display:none">
        <div class="field-sec">Common to all photos in this batch</div>
        <div class="frow">
          <label for="catSel">Category</label>
          <div class="fctl">
            <select id="catSel">
              <option value="">Choose…</option>
              ${leaves.map((l) => `<option value="${l.id}">${esc(l.path)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div id="commonFields"></div>
        <div class="frow">
          <label for="statusSel">Status</label>
          <div class="fctl">
            <select id="statusSel">
              <option value="draft" selected>draft</option>
              <option value="needs-review">needs-review</option>
            </select>
          </div>
        </div>
        <button class="primary up-go" id="uploadBtn" disabled>Upload</button>
        <div id="progress" class="progress"></div>
      </div>

      <datalist id="dl-brand">${vocabSuggestions("brand").map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
    </div>`;

  const camInput = view.querySelector("#camInput");
  const libInput = view.querySelector("#libInput");
  const picked = view.querySelector("#picked");
  const batchForm = view.querySelector("#batchForm");
  const catSel = view.querySelector("#catSel");
  const commonFields = view.querySelector("#commonFields");
  const uploadBtn = view.querySelector("#uploadBtn");
  const progress = view.querySelector("#progress");

  // Both pickers accumulate into the same batch, so you can take several photos
  // one at a time and/or add some from the library before uploading.
  function addFiles(list) {
    state.files.push(...list);
    renderPicked();
    batchForm.style.display = state.files.length ? "block" : "none";
    refreshUploadEnabled();
  }
  function renderPicked() {
    picked.innerHTML = state.files.length
      ? `${state.files.length} photo${state.files.length === 1 ? "" : "s"} selected ·
         <a href="#" id="clearPick">clear</a>`
      : "";
    const c = view.querySelector("#clearPick");
    if (c) c.onclick = (e) => { e.preventDefault(); state.files = []; renderPicked(); batchForm.style.display = "none"; refreshUploadEnabled(); };
  }
  camInput.addEventListener("change", () => { addFiles([...camInput.files]); camInput.value = ""; });
  libInput.addEventListener("change", () => { addFiles([...libInput.files]); libInput.value = ""; });

  // When a category is chosen, render its (optional) common fields + brand.
  catSel.addEventListener("change", () => {
    const fields = catSel.value ? resolveFields(catSel.value) : [];
    commonFields.innerHTML =
      `<div class="frow"><label for="c-brand">Brand</label>
         <div class="fctl"><input id="c-brand" data-ck="brand" list="dl-brand"></div></div>` +
      fields
        .map((f) => {
          const dl = f.vocab ? ` list="dl-${f.vocab}"` : "";
          if (f.vocab && !view.querySelector(`#dl-${f.vocab}`)) {
            // add a datalist for this vocab field on the fly
            const d = document.createElement("datalist");
            d.id = `dl-${f.vocab}`;
            d.innerHTML = vocabSuggestions(f.vocab).map((o) => `<option value="${esc(o)}">`).join("");
            view.querySelector(".uploader").appendChild(d);
          }
          const type = f.type === "number" ? "number" : "text";
          return `<div class="frow"><label for="c-${f.key}">${esc(f.label)}</label>
            <div class="fctl"><input id="c-${f.key}" type="${type}"${dl}
              data-ck="${f.key}" data-vocab="${f.vocab || ""}" data-type="${f.type}"></div></div>`;
        })
        .join("");
    refreshUploadEnabled();
  });

  function refreshUploadEnabled() {
    uploadBtn.disabled = !(state.files.length && catSel.value);
  }

  uploadBtn.addEventListener("click", async () => {
    uploadBtn.disabled = true;
    const categoryId = catSel.value;
    const slug = cache.byId[categoryId]?.slug || "misc";
    const status = view.querySelector("#statusSel").value;

    // Gather common attributes + brand once for the whole batch.
    const attributes = {};
    let brand = null;
    commonFields.querySelectorAll("[data-ck]").forEach((el) => {
      let val = el.value.trim();
      if (!val) return;
      if (el.dataset.ck === "brand") {
        brand = normalizeValue("brand", val);
        return;
      }
      if (el.dataset.vocab) val = normalizeValue(el.dataset.vocab, val);
      attributes[el.dataset.ck] = el.dataset.type === "number" ? Number(val) : val;
    });

    let ok = 0;
    let failed = 0;
    for (let i = 0; i < state.files.length; i++) {
      const file = state.files[i];
      progress.textContent = `Uploading ${i + 1} of ${state.files.length}…`;
      try {
        const { blob, ext } = await compressImage(file);
        const id = crypto.randomUUID();
        const path = `${slug}/${id}.${ext}`;
        const up = await supabase.storage
          .from("product-images")
          .upload(path, blob, { contentType: blob.type || "image/webp", upsert: false });
        if (up.error) throw up.error;
        const ins = await supabase.from("items").insert({
          id,
          category_id: categoryId,
          brand,
          attributes,
          status,
          image_path: path,
          original_filename: file.name,
        });
        if (ins.error) throw ins.error;
        ok++;
      } catch (err) {
        failed++;
        console.error("upload failed", file.name, err);
      }
    }

    progress.textContent = `Done — ${ok} added${failed ? `, ${failed} failed` : ""}.`;
    setTimeout(() => onDone?.(), 1200); // back to the gallery to review the new drafts
  });
}
