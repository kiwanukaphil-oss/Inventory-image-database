import { supabase } from "./db.js";
import { refreshRefData } from "./data.js";
import { esc, toast, confirmSheet, trapFocus, isTopOverlay, ICON } from "./ui.js";

// Category & field manager (for user-managers): create/edit/delete categories
// and their children, and manage the fields each category defines. Writes to
// `categories` and `category_fields` (RLS already gates these to can_manage_users).
// On close, the in-memory reference cache is refreshed so the rest of the app
// picks up the changes.

const FIELD_TYPES = ["text", "number", "select", "boolean", "size"];

function slugify(name) {
  return (name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category";
}

export async function openCategoryManager(caps) {
  if (!caps?.can_manage_users) return;

  const screen = document.createElement("div");
  screen.className = "screen";
  screen.setAttribute("role", "dialog");
  screen.setAttribute("aria-modal", "true");
  screen.setAttribute("aria-label", "Categories & fields");
  screen.innerHTML = `
    <div class="screen-head">
      <button class="iconbtn" id="scBack" aria-label="Back" hidden>${ICON.back}</button>
      <span id="scTitle">Categories &amp; fields</span>
      <button class="iconbtn" id="scClose" aria-label="Close">${ICON.x}</button>
    </div>
    <div class="screen-body" id="scBody"><div class="spinner"></div></div>`;
  document.body.appendChild(screen);
  requestAnimationFrame(() => screen.classList.add("open"));
  const releaseFocus = trapFocus(screen);

  let dirty = false;
  const close = () => {
    releaseFocus();
    document.removeEventListener("keydown", onKey);
    screen.classList.remove("open");
    setTimeout(() => screen.remove(), 200);
    if (dirty) refreshRefData(); // so gallery/editor/find see the changes
  };
  // Esc steps back through the drill-down if possible, otherwise closes.
  // (Ignored while a confirm/prompt dialog is stacked on top.)
  const onKey = (e) => { if (e.key === "Escape" && isTopOverlay(screen)) (backFn ? backFn() : close()); };
  document.addEventListener("keydown", onKey);
  const body = screen.querySelector("#scBody");
  const titleEl = screen.querySelector("#scTitle");
  const backBtn = screen.querySelector("#scBack");
  let backFn = null;
  screen.querySelector("#scClose").onclick = close;
  backBtn.onclick = () => backFn && backFn();
  function setScreen(title, html, onBack) {
    titleEl.textContent = title;
    body.innerHTML = html;
    backFn = onBack;
    backBtn.hidden = !onBack;
  }

  let cats = [];
  let fields = [];
  async function load() {
    const [c, f] = await Promise.all([
      supabase.from("categories").select("*").order("sort"),
      supabase.from("category_fields").select("*").order("sort"),
    ]);
    cats = c.data || [];
    fields = f.data || [];
  }

  const childrenOf = (id) =>
    cats.filter((c) => c.parent_id === id).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  function descendants(id) {
    const out = [];
    for (const c of childrenOf(id)) { out.push(c.id); out.push(...descendants(c.id)); }
    return out;
  }
  function ownFields(catId) {
    return fields.filter((f) => f.category_id === catId).sort((a, b) => (a.sort - b.sort));
  }
  // Fields inherited from ancestors (inherit=true), nearest ancestor first.
  function inheritedFields(cat) {
    const out = [];
    let cur = cat.parent_id ? cats.find((c) => c.id === cat.parent_id) : null;
    let depth = 0;
    while (cur && depth++ < 20) {
      for (const f of fields.filter((f) => f.category_id === cur.id && f.inherit)) out.push(f);
      cur = cur.parent_id ? cats.find((c) => c.id === cur.parent_id) : null;
    }
    return out;
  }

  // ---------- tree ----------
  function renderTree() {
    const rows = [];
    (function walk(parentId, depth) {
      for (const c of childrenOf(parentId)) {
        const fc = ownFields(c.id).length;
        rows.push(`<div class="cat-row" style="margin-left:${depth * 14}px">
          <div class="cat-name">${esc(c.name)} ${c.active === false ? '<span class="muted">(hidden)</span>' : ""}</div>
          <div class="cat-acts">
            <button class="chip" data-act="fields" data-id="${c.id}">Fields${fc ? ` · ${fc}` : ""}</button>
            <button class="chip" data-act="addchild" data-id="${c.id}">+ child</button>
            <button class="chip" data-act="edit" data-id="${c.id}">Edit</button>
            <button class="chip danger" data-act="del" data-id="${c.id}">Delete</button>
          </div>
        </div>`);
        walk(c.id, depth + 1);
      }
    })(null, 0);

    setScreen("Categories & fields",
      `<button class="primary scbtn" id="addTop">+ Add top-level category</button>
       ${rows.join("") || '<div class="empty"><div>No categories yet.</div></div>'}`, null);

    body.querySelector("#addTop").onclick = () => editCategory(null, null);
    body.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = () => {
        const cat = cats.find((x) => x.id === b.dataset.id);
        const act = b.dataset.act;
        if (act === "fields") manageFields(cat);
        else if (act === "addchild") editCategory(null, cat.id);
        else if (act === "edit") editCategory(cat, cat.parent_id);
        else if (act === "del") deleteCategory(cat);
      };
    });
  }

  // ---------- category form ----------
  function editCategory(cat, parentId) {
    const isNew = !cat;
    const exclude = cat ? new Set([cat.id, ...descendants(cat.id)]) : new Set(); // no cycles
    const parentOptions = `<option value="">— Top level —</option>` +
      cats.filter((c) => !exclude.has(c.id))
        .map((c) => `<option value="${c.id}" ${(cat ? cat.parent_id : parentId) === c.id ? "selected" : ""}>${esc(c.name)}</option>`)
        .join("");

    setScreen(isNew ? "New category" : `Edit · ${cat.name}`, `
      <div class="cm-form">
        <div class="cm-label">Name</div>
        <input id="cName" value="${esc(cat?.name || "")}" placeholder="e.g. Sneakers">
        <div class="cm-label">Parent</div>
        <select id="cParent">${parentOptions}</select>
        <div class="cm-label">SKU token <span class="muted">(short code used in SKUs; optional)</span></div>
        <input id="cToken" value="${esc(cat?.sku_token || "")}" placeholder="e.g. SNEAKER">
        <div class="cm-label">Sort order</div>
        <input id="cSort" type="number" value="${cat?.sort ?? 0}">
        <label class="cm-check"><input type="checkbox" id="cActive" ${cat?.active === false ? "" : "checked"}> Visible</label>
        <button class="primary scbtn" id="cSave" style="margin-top:16px">${isNew ? "Create category" : "Save"}</button>
      </div>`, renderTree);

    body.querySelector("#cSave").onclick = async () => {
      const name = body.querySelector("#cName").value.trim();
      if (!name) { toast("Name is required."); return; }
      const row = {
        name,
        parent_id: body.querySelector("#cParent").value || null,
        sku_token: body.querySelector("#cToken").value.trim() || null,
        sort: Number(body.querySelector("#cSort").value) || 0,
        active: body.querySelector("#cActive").checked,
      };
      let res;
      if (isNew) {
        const existing = new Set(cats.map((c) => c.slug));
        let slug = slugify(name), i = 2;
        while (existing.has(slug)) slug = `${slugify(name)}-${i++}`;
        res = await supabase.from("categories").insert({ ...row, slug });
      } else {
        res = await supabase.from("categories").update(row).eq("id", cat.id);
      }
      if (res.error) { toast("Save failed: " + res.error.message); return; }
      dirty = true;
      toast(isNew ? "Category created" : "Category saved");
      await load();
      renderTree();
    };
  }

  async function deleteCategory(cat) {
    if (childrenOf(cat.id).length) { toast("This category has subcategories — delete those first."); return; }
    const { count } = await supabase.from("items").select("id", { count: "exact", head: true }).eq("category_id", cat.id);
    if (count) { toast(`This category has ${count} item(s). Move or delete them first.`); return; }
    const ok = await confirmSheet({
      title: "Delete category?",
      message: `“${cat.name}” and its field definitions will be deleted.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("categories").delete().eq("id", cat.id);
    if (error) { toast("Delete failed: " + error.message); return; }
    dirty = true;
    toast("Category deleted");
    await load();
    renderTree();
  }

  // ---------- fields ----------
  function manageFields(cat) {
    const own = ownFields(cat.id);
    const inh = inheritedFields(cat);
    const ownHtml = own.length
      ? own.map((f) => `<div class="cat-row">
          <div class="cat-name">${esc(f.label)} <span class="muted">${esc(f.key)} · ${esc(f.type)}${f.inherit ? " · inherited↓" : ""}</span></div>
          <div class="cat-acts">
            <button class="chip" data-fedit="${f.id}">Edit</button>
            <button class="chip danger" data-fdel="${f.id}">Delete</button>
          </div>
        </div>`).join("")
      : '<div class="muted" style="padding:4px 2px">No own fields yet.</div>';
    const inhHtml = inh.length
      ? `<div class="cm-label" style="margin-top:14px">Inherited from parents (read-only)</div>` +
        inh.map((f) => `<div class="cat-row" style="opacity:.7">
          <div class="cat-name">${esc(f.label)} <span class="muted">${esc(f.key)} · ${esc(f.type)}</span></div></div>`).join("")
      : "";

    setScreen(`Fields · ${cat.name}`,
      `<button class="primary scbtn" id="addField">+ Add field</button>${ownHtml}${inhHtml}`,
      renderTree);

    body.querySelector("#addField").onclick = () => fieldForm(cat, null);
    body.querySelectorAll("[data-fedit]").forEach((b) =>
      (b.onclick = () => fieldForm(cat, fields.find((f) => f.id === b.dataset.fedit))));
    body.querySelectorAll("[data-fdel]").forEach((b) =>
      (b.onclick = () => deleteField(cat, fields.find((f) => f.id === b.dataset.fdel))));
  }

  function fieldForm(cat, field) {
    const isNew = !field;
    setScreen(isNew ? `New field · ${cat.name}` : `Edit field`, `
      <div class="cm-form">
        <div class="cm-label">Key <span class="muted">(stored on items; lowercase, no spaces)</span></div>
        <input id="fKey" value="${esc(field?.key || "")}" placeholder="e.g. sleeve" ${isNew ? "" : "disabled"}>
        <div class="cm-label">Label</div>
        <input id="fLabel" value="${esc(field?.label || "")}" placeholder="e.g. Sleeve length">
        <div class="cm-label">Type</div>
        <select id="fType">${FIELD_TYPES.map((t) => `<option ${field?.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
        <div class="cm-label">Options <span class="muted">(comma-separated, for type=select)</span></div>
        <input id="fOptions" value="${esc((field?.options || []).join(", "))}" placeholder="e.g. Short, Long">
        <div class="cm-label">Vocabulary name <span class="muted">(controlled list for autocomplete; optional)</span></div>
        <input id="fVocab" value="${esc(field?.vocab || "")}" placeholder="e.g. color">
        <div class="cm-label">Sort order</div>
        <input id="fSort" type="number" value="${field?.sort ?? 0}">
        <label class="cm-check"><input type="checkbox" id="fRequired" ${field?.required ? "checked" : ""}> Required</label>
        <label class="cm-check"><input type="checkbox" id="fInherit" ${field?.inherit ? "checked" : ""}> Inherited by child categories</label>
        <button class="primary scbtn" id="fSave" style="margin-top:16px">${isNew ? "Add field" : "Save"}</button>
      </div>`, () => manageFields(cat));

    body.querySelector("#fSave").onclick = async () => {
      const key = body.querySelector("#fKey").value.trim();
      const label = body.querySelector("#fLabel").value.trim();
      if (!key || !label) { toast("Key and label are required."); return; }
      const optsRaw = body.querySelector("#fOptions").value.trim();
      const row = {
        label,
        type: body.querySelector("#fType").value,
        options: optsRaw ? optsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
        vocab: body.querySelector("#fVocab").value.trim() || null,
        sort: Number(body.querySelector("#fSort").value) || 0,
        required: body.querySelector("#fRequired").checked,
        inherit: body.querySelector("#fInherit").checked,
      };
      let res;
      if (isNew) {
        if (ownFields(cat.id).some((f) => f.key === key)) { toast("A field with that key already exists here."); return; }
        res = await supabase.from("category_fields").insert({ ...row, key, category_id: cat.id });
      } else {
        res = await supabase.from("category_fields").update(row).eq("id", field.id);
      }
      if (res.error) { toast("Save failed: " + res.error.message); return; }
      dirty = true;
      toast(isNew ? "Field added" : "Field saved");
      await load();
      manageFields(cat);
    };
  }

  async function deleteField(cat, field) {
    const ok = await confirmSheet({
      title: "Delete field?",
      message: `“${field.label}” will be removed from this category.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("category_fields").delete().eq("id", field.id);
    if (error) { toast("Delete failed: " + error.message); return; }
    dirty = true;
    toast("Field deleted");
    await load();
    manageFields(cat);
  }

  await load();
  renderTree();
}
