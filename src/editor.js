import { supabase } from "./db.js";
import {
  loadRefData,
  resolveFields,
  categoryPath,
  vocabSuggestions,
  normalizeValue,
} from "./data.js";
import { toast, confirmSheet, openBottomSheet, trapFocus } from "./ui.js";

// The edit sheet: a full-screen panel (mobile-first) whose fields are driven by
// the item's category. Universal columns (name/brand/price/stock) plus the
// resolved category fields (colour, size, fit, … or volume/concentration for a
// fragrance) render automatically. Supports controlled-vocab autocomplete +
// normalisation, per-field confidence, status workflow, admin-only cost, and
// writes through to Supabase (SKU + audit handled by DB triggers).

const CONF_CYCLE = ["", "High", "Medium", "Low"];
// Placeholder strings the AI sometimes returns — treat as "no value" so they
// don't fill fields (which would defeat the only-fill-empty workflow).
const AI_PLACEHOLDER = new Set(["unknown", "n/a", "na", "none", "null", "-", "--", "not visible", "not specified", "unspecified"]);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/**
 * Open the editor for an item.
 * @param {string} itemId
 * @param {string} role     admin | editor | viewer
 * @param {Function} onSaved called after a successful save (to refresh the grid)
 */
export async function openEditor(itemId, caps, onSaved) {
  await loadRefData();
  caps = caps || {};
  const canEdit = !!caps.can_edit;
  const canViewCost = !!caps.can_view_cost;
  const canDelete = !!caps.can_delete;

  // Fetch the item (cost lives in a separate, capability-gated table).
  const { data: item, error } = await supabase
    .from("items")
    .select("*")
    .eq("id", itemId)
    .single();
  if (error || !item) {
    toast("Couldn't load item.");
    return;
  }

  let cost = null;
  if (canViewCost) {
    const { data } = await supabase
      .from("item_costs")
      .select("cost_price")
      .eq("item_id", itemId)
      .maybeSingle();
    cost = data?.cost_price ?? null;
  }

  const [{ data: signed }] = await Promise.all([
    item.image_path
      ? supabase.storage.from("product-images").createSignedUrl(item.image_path, 3600)
      : Promise.resolve({ data: null }),
  ]);
  const imgUrl = signed?.signedUrl || null;

  const fields = resolveFields(item.category_id);
  const conf = { ...(item.confidence || {}) }; // working copy of per-field confidence

  // ---- build the sheet ----
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  // Describe the photo for screen readers / broken-image fallback.
  const imgAlt = esc([item.brand || item.name, categoryPath(item.category_id)].filter(Boolean).join(" — ") || "Product photo");
  sheet.innerHTML = `
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(categoryPath(item.category_id) || "Edit item")}">
      <header class="sheet-head">
        <button class="ghost" id="cancelBtn">Cancel</button>
        <div class="sheet-title">${esc(categoryPath(item.category_id))}</div>
        <button class="primary" id="saveBtn" ${canEdit ? "" : "disabled"}>Save</button>
      </header>
      <div class="sheet-body">
        <div class="ed-offline" id="edOffline" hidden>● Offline — your changes are kept; tap Save once you reconnect.</div>
        ${imgUrl ? `<div class="sheet-img"><img src="${imgUrl}" alt="${imgAlt}"></div>` : ""}

        ${canEdit && imgUrl ? `<button class="ghost aibtn" id="aiBtn">✨ AI suggest fields from photo</button>` : ""}

        <div class="status-row" id="statusRow" role="group" aria-label="Status">
          ${["draft", "needs-review", "approved", "flag"]
            .map(
              (s) =>
                `<button class="status-pill ${item.status === s ? "on" : ""}" data-status="${s}" aria-pressed="${item.status === s}">${s}</button>`
            )
            .join("")}
        </div>
        <button type="button" class="linkbtn legend-btn" id="legendBtn">What do these labels mean?</button>

        <div id="dupWarn" class="dup-warn" style="display:none"></div>

        <div class="frow">
          <label>Category</label>
          <div class="fctl"><span class="readonly-val">${esc(categoryPath(item.category_id))}</span></div>
        </div>
        ${fieldRow({ key: "name", label: "Name", type: "text" }, item.name, conf, false)}
        ${fieldRow({ key: "brand", label: "Brand", type: "text", vocab: "brand" }, item.brand, conf, canEdit)}
        ${fields.map((f) => fieldRow(f, item.attributes?.[f.key], conf, canEdit)).join("")}

        <div class="field-sec">Stock & pricing</div>
        ${fieldRow({ key: "price", label: "Retail price", type: "number" }, item.price, conf, false)}
        ${fieldRow({ key: "stock_quantity", label: "Stock qty", type: "number" }, item.stock_quantity, conf, false)}
        ${fieldRow({ key: "reorder_level", label: "Reorder level", type: "number" }, item.reorder_level, conf, false)}
        ${
          canViewCost
            ? `<div class="field-sec">Cost <span class="adminonly">restricted</span></div>
               ${fieldRow({ key: "cost_price", label: "Cost price", type: "number" }, cost, conf, false)}`
            : ""
        }

        <div class="sku-line">SKU: <span id="skuVal">${esc(item.sku || "—")}</span>
          <span style="color:var(--muted)"> (updates automatically)</span></div>
        ${item.created_at ? `<div class="added-line">Added ${esc(new Date(item.created_at).toLocaleString())}</div>` : ""}

        ${canEdit ? `<button class="ghost histbtn" id="historyBtn">View change history</button>` : ""}
        ${canDelete ? `<button class="danger del-btn" id="deleteBtn">Delete item</button>` : ""}
      </div>
    </div>`;

  // Datalists for vocab-backed fields (brand + any field with a vocab).
  const vocabFields = new Set(["brand", ...fields.filter((f) => f.vocab).map((f) => f.vocab)]);
  const lists = document.createElement("div");
  for (const vf of vocabFields) {
    const dl = document.createElement("datalist");
    dl.id = `dl-${vf}`;
    dl.innerHTML = vocabSuggestions(vf).map((o) => `<option value="${esc(o)}">`).join("");
    lists.appendChild(dl);
  }
  sheet.appendChild(lists);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add("open"));
  const releaseFocus = trapFocus(sheet);
  // Focus the Cancel control first (not a text field) so opening the editor
  // doesn't pop the mobile keyboard before the user has looked at the photo.
  requestAnimationFrame(() => sheet.querySelector("#cancelBtn")?.focus());

  // ---- interactions ----
  let close = () => {
    releaseFocus();
    sheet.classList.remove("open");
    setTimeout(() => sheet.remove(), 200);
  };
  // Are there unsaved edits? (status changed, any highlighted field, or a
  // confidence pill the user touched). Used to guard accidental dismissal.
  let confDirty = false;
  let savedOk = false; // set true after a successful save so close doesn't prompt
  const isDirty = () => !savedOk && canEdit &&
    (status !== item.status || confDirty || !!sheet.querySelector("[data-key].changed"));
  // Cancel / backdrop: confirm before throwing away unsaved work.
  const requestClose = async () => {
    if (isDirty()) {
      const ok = await confirmSheet({
        title: "Discard changes?",
        message: "Your edits to this item haven't been saved.",
        confirmText: "Discard",
        cancelText: "Keep editing",
        danger: true,
      });
      if (!ok) return;
    }
    close();
  };
  sheet.querySelector("#cancelBtn").onclick = requestClose;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) requestClose(); });

  // Offline awareness: surface the state up front (banner + Save button) instead
  // of only failing on tap. Edits stay in the form; the user saves on reconnect.
  const offlineNote = sheet.querySelector("#edOffline");
  const reflectOnline = () => {
    const off = !navigator.onLine;
    offlineNote.hidden = !off;
    const btn = sheet.querySelector("#saveBtn");
    // Don't fight the not-editable disable or an in-flight "Saving…".
    if (btn && canEdit && btn.textContent !== "Saving…") {
      btn.disabled = off;
      btn.textContent = off ? "Offline" : "Save";
    }
  };
  window.addEventListener("online", reflectOnline);
  window.addEventListener("offline", reflectOnline);
  reflectOnline();
  // Tear the listeners down when the sheet closes (wrap the base close once).
  const baseClose = close;
  close = () => {
    window.removeEventListener("online", reflectOnline);
    window.removeEventListener("offline", reflectOnline);
    baseClose();
  };

  // Status pills
  let status = item.status;
  sheet.querySelector("#statusRow").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-status]");
    if (!b || !canEdit) return;
    status = b.dataset.status;
    sheet.querySelectorAll(".status-pill").forEach((p) => {
      const on = p.dataset.status === status;
      p.classList.toggle("on", on);
      p.setAttribute("aria-pressed", on);
    });
  });

  // Legend: explain what the status labels and H/M/L confidence dots mean.
  sheet.querySelector("#legendBtn").onclick = () => {
    openBottomSheet("What the labels mean", `
      <div class="legend">
        <div class="sheet-sec">Status</div>
        <div class="legend-row"><span class="stbadge st-draft">draft</span> Not reviewed yet.</div>
        <div class="legend-row"><span class="stbadge st-review">needs-review</span> Flagged for a closer look.</div>
        <div class="legend-row"><span class="stbadge st-ok">approved</span> Checked and good to go.</div>
        <div class="legend-row"><span class="stbadge st-flag">flag</span> Has a problem to fix.</div>
        <div class="sheet-sec">Confidence</div>
        <div class="legend-row"><span class="conf-pill conf-high">H</span> High — the AI was sure.</div>
        <div class="legend-row"><span class="conf-pill conf-medium">M</span> Medium — likely right; worth a glance.</div>
        <div class="legend-row"><span class="conf-pill conf-low">L</span> Low — please double-check this field.</div>
      </div>`);
  };

  // Confidence pills cycle —/High/Medium/Low
  sheet.querySelectorAll("[data-conf]").forEach((pill) => {
    pill.addEventListener("click", () => {
      if (!canEdit) return;
      const key = pill.dataset.conf;
      const idx = CONF_CYCLE.indexOf(conf[key] || "");
      const next = CONF_CYCLE[(idx + 1) % CONF_CYCLE.length];
      if (next) conf[key] = next;
      else delete conf[key];
      confDirty = true;
      paintConfPill(pill, next);
    });
  });

  // Mark changed inputs (highlight) versus their initial value.
  sheet.querySelectorAll("[data-key]").forEach((el) => {
    const initial = el.type === "checkbox" ? String(el.checked) : el.value;
    el.addEventListener("input", () => {
      const now = el.type === "checkbox" ? String(el.checked) : el.value;
      el.classList.toggle("changed", now !== initial);
    });
  });

  // Apply AI-suggested values into the form (highlighted, not auto-saved).
  function applySuggestions(values, confidence) {
    const vocabByKey = { brand: "brand" };
    for (const f of fields) if (f.vocab) vocabByKey[f.key] = f.vocab;
    let n = 0;
    for (const [key, raw] of Object.entries(values || {})) {
      if (raw === null || raw === undefined || raw === "") continue;
      if (AI_PLACEHOLDER.has(String(raw).trim().toLowerCase())) continue;
      const el = sheet.querySelector(`[data-key="${key}"]`);
      if (!el) continue;
      let val = String(raw);
      if (vocabByKey[key]) val = normalizeValue(vocabByKey[key], val);
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === val)) {
        const o = document.createElement("option");
        o.value = val;
        o.textContent = val;
        el.appendChild(o);
      }
      el.value = val;
      el.classList.add("changed");
      const lvl = confidence?.[key];
      if (lvl) {
        conf[key] = lvl;
        const pill = sheet.querySelector(`[data-conf="${key}"]`);
        if (pill) paintConfPill(pill, lvl);
      }
      n++;
    }
    return n;
  }

  const aiBtn = sheet.querySelector("#aiBtn");
  if (aiBtn) {
    aiBtn.onclick = async () => {
      if (!navigator.onLine) { toast("You're offline — AI needs a connection."); return; }
      const label = aiBtn.textContent;
      aiBtn.disabled = true;
      aiBtn.textContent = "Reading photo…";
      try {
        const defs = [
          { key: "brand", label: "Brand" },
          { key: "name", label: "Product name" },
          ...fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options })),
        ];
        const { data, error } = await supabase.functions.invoke("ai-extract", {
          body: { item_id: itemId, category: categoryPath(item.category_id), fields: defs },
        });
        if (error) {
          // Surface the function's actual error body (FunctionsHttpError hides it).
          let detail = error.message;
          try {
            const b = await error.context.json();
            detail = b.detail ? `${b.error}: ${JSON.stringify(b.detail)}` : (b.error || detail);
          } catch {}
          throw new Error(detail);
        }
        if (data?.error) throw new Error(data.error);
        const n = applySuggestions(data.values, data.confidence);
        toast(n ? `AI filled ${n} field${n === 1 ? "" : "s"} — review & Save` : "AI couldn't read any fields");
      } catch (e) {
        toast("AI failed: " + (e?.message || e));
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = label;
      }
    };
  }

  sheet.querySelector("#saveBtn").onclick = async () => {
    if (!canEdit) return;
    if (!navigator.onLine) { toast("You're offline — reconnect to save your changes."); return; }
    // An approved item must be sellable, so it can't be approved without a price.
    const priceEl = sheet.querySelector('[data-key="price"]');
    if (status === "approved" && (!priceEl || priceEl.value.trim() === "")) {
      toast("Set a price before approving this item.");
      return;
    }
    const btn = sheet.querySelector("#saveBtn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await saveItem(sheet, item, fields, conf, status, canViewCost);
      const newSku = await refreshSkuAndDupCheck(sheet, itemId);
      toast(`Saved · SKU ${newSku}`);
      navigator.vibrate?.([12, 40, 12]); // affirmative "done" buzz
      savedOk = true; // don't prompt "discard changes?" on the post-save close
      onSaved?.();
      close();
    } catch (err) {
      toast(err.message || "Save failed");
      btn.disabled = false;
      btn.textContent = "Save";
    }
  };

  // Per-item change history (audit log; readable by editors).
  const histBtn = sheet.querySelector("#historyBtn");
  if (histBtn) histBtn.onclick = () => openHistory(itemId);

  // Delete (capability-gated): removes the item and its stored image.
  const deleteBtn = sheet.querySelector("#deleteBtn");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (!navigator.onLine) { toast("You're offline — reconnect to delete."); return; }
      const ok = await confirmSheet({
        title: "Delete item?",
        message: "This item and its photo will be permanently deleted. This cannot be undone.",
        confirmText: "Delete",
        danger: true,
      });
      if (!ok) return;
      deleteBtn.disabled = true;
      try {
        const { error: delErr } = await supabase.from("items").delete().eq("id", itemId);
        if (delErr) throw delErr;
        if (item.image_path) {
          await supabase.storage.from("product-images").remove([item.image_path]);
        }
        toast("Item deleted");
        navigator.vibrate?.(20);
        savedOk = true; // it's gone — no discard prompt
        onSaved?.();
        close();
      } catch (err) {
        toast(err.message || "Delete failed");
        deleteBtn.disabled = false;
      }
    };
  }
}

// Render one labelled field row with the right control + a confidence pill.
function fieldRow(def, value, conf, showConf) {
  const id = `f-${def.key}`;
  let control;
  const v = value ?? "";
  if (def.type === "boolean") {
    control = `<input type="checkbox" id="${id}" data-key="${def.key}" data-kind="boolean" ${
      v === true || v === "true" ? "checked" : ""
    }>`;
  } else if (def.type === "select" && Array.isArray(def.options) && def.options.length) {
    const opts = def.options.includes(v) || !v ? def.options : [v, ...def.options];
    control = `<select id="${id}" data-key="${def.key}" data-kind="value">
      <option value=""></option>
      ${opts.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}
    </select>`;
  } else {
    const list = def.vocab ? ` list="dl-${def.vocab}"` : "";
    const type = def.type === "number" ? "number" : "text";
    control = `<input id="${id}" type="${type}"${list} data-key="${def.key}" data-kind="value"
      data-vocab="${def.vocab || ""}" value="${esc(v)}">`;
  }

  const confPill = showConf
    ? `<button class="conf-pill ${confClass(conf[def.key])}" data-conf="${def.key}"
         aria-label="Confidence: ${conf[def.key] || "not set"}" title="Confidence (tap to cycle)">${conf[def.key] ? conf[def.key][0] : "·"}</button>`
    : "";

  return `<div class="frow">
    <label for="${id}">${esc(def.label)}</label>
    <div class="fctl">${control}${confPill}</div>
  </div>`;
}

function confClass(level) {
  return level ? `conf-${level.toLowerCase()}` : "";
}
function paintConfPill(pill, level) {
  pill.className = `conf-pill ${confClass(level)}`;
  pill.textContent = level ? level[0] : "·";
  pill.setAttribute("aria-label", `Confidence: ${level || "not set"}`);
}

// Collect values, normalise vocab fields, and write to Supabase.
async function saveItem(sheet, item, fields, conf, status, canViewCost) {
  const attributes = { ...(item.attributes || {}) };

  // Resolved category fields -> attributes.
  for (const f of fields) {
    const el = sheet.querySelector(`[data-key="${f.key}"]`);
    if (!el) continue;
    let val;
    if (f.type === "boolean") val = el.checked;
    else {
      val = el.value.trim();
      if (f.vocab) val = normalizeValue(f.vocab, val); // Grey -> Gray
    }
    if (val === "" || val === false || val === null) delete attributes[f.key];
    else attributes[f.key] = f.type === "number" ? Number(val) : val;
  }

  const brandEl = sheet.querySelector('[data-key="brand"]');
  const brand = normalizeValue("brand", brandEl.value.trim()) || null;

  const num = (k) => {
    const el = sheet.querySelector(`[data-key="${k}"]`);
    const t = el?.value.trim();
    return t ? Number(t) : null;
  };

  const update = {
    name: sheet.querySelector('[data-key="name"]').value.trim() || null,
    brand,
    price: num("price"),
    stock_quantity: num("stock_quantity"),
    reorder_level: num("reorder_level"),
    status,
    attributes,
    confidence: conf,
  };

  const { error } = await supabase.from("items").update(update).eq("id", item.id);
  if (error) throw error;

  // Cost -> capability-gated table (upsert).
  if (canViewCost) {
    const cost = num("cost_price");
    const { error: cErr } = await supabase
      .from("item_costs")
      .upsert({ item_id: item.id, cost_price: cost }, { onConflict: "item_id" });
    if (cErr) throw cErr;
  }

  // Persist any brand value the user typed that isn't in the vocab yet.
  if (brand && !vocabSuggestions("brand").includes(brand)) {
    await supabase.from("vocabularies").insert({ field: "brand", canonical: brand }).select();
  }
}

// Re-read the (trigger-derived) SKU and warn if it collides with another item.
async function refreshSkuAndDupCheck(sheet, itemId) {
  const { data } = await supabase.from("items").select("sku").eq("id", itemId).single();
  const sku = data?.sku || "—";
  sheet.querySelector("#skuVal").textContent = sku;
  if (sku && sku !== "—") {
    const { data: dups } = await supabase
      .from("items")
      .select("id")
      .eq("sku", sku)
      .neq("id", itemId);
    const warn = sheet.querySelector("#dupWarn");
    if (dups && dups.length) {
      warn.style.display = "block";
      warn.textContent = `⚠ ${dups.length} other item(s) share this SKU (${sku}).`;
    }
  }
  return sku;
}

// Per-item change history from the audit log, shown in a bottom sheet.
async function openHistory(itemId) {
  const { data, error } = await supabase
    .from("audit_log")
    .select("created_at, change_type, field, before, after, notes")
    .eq("item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data || []).map((r) => {
    const when = new Date(r.created_at).toLocaleString();
    let desc;
    if (r.change_type === "create") desc = "Created";
    else if (r.change_type === "delete") desc = "Deleted";
    else desc = `${esc(r.field || "")}: ${esc(r.before ?? "∅")} → ${esc(r.after ?? "∅")}`;
    return `<div class="hist-row"><div class="hist-when">${esc(when)}</div><div>${desc}</div>${
      r.notes ? `<div class="muted">${esc(r.notes)}</div>` : ""
    }</div>`;
  }).join("");

  // Reuse the shared sheet so it inherits focus-trap, role=dialog and Esc-to-close.
  openBottomSheet("Change history",
    error ? esc(error.message) : rows || '<div class="muted">No history yet.</div>');
}

// (toast now lives in ui.js — imported above.)
