import { supabase } from "./db.js";
import {
  loadRefData,
  resolveFields,
  categoryPath,
  vocabSuggestions,
  normalizeValue,
  normalizeAttributeValue,
  AI_BLIND_FIELDS,
} from "./data.js";
import { loadCostPresence } from "./costs.js";
import { clearItemJobFailures, loadLatestFailedJobs, recordItemJobFailure } from "./joblog.js";
import { STATUS_OPTIONS, getItemReadiness, statusLabel } from "./readiness.js";
import { activitySourceClass, activitySourceLabel, diffItemValues, fieldKeyFromPath, loadItemActivity, logItemActivity } from "./activity.js";
import { toast, confirmSheet, openBottomSheet, trapFocus, isTopOverlay, openLightbox, ICON } from "./ui.js";

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

function hasValue(v) {
  return v !== null && v !== undefined && v !== "";
}

function fieldNameForKey(key, fields) {
  if (key === "brand") return "Brand";
  if (key === "name") return "Name";
  if (key === "price") return "Retail price";
  if (key === "cost_price") return "Cost price";
  if (key === "stock_quantity") return "Units";
  if (key === "reorder_level") return "Reorder level";
  return fields.find((f) => f.key === key)?.label || key;
}

function buildEditorFixPlan(item, fields, conf, { canViewCost = false } = {}) {
  const keys = new Set();
  const labels = [];
  const add = (key, label) => {
    if (key) keys.add(key);
    if (label && !labels.includes(label)) labels.push(label);
  };

  if (item.price == null) add("price", "Retail price");
  if (!hasValue(item.name)) add("name", "Name");
  if (canViewCost && item.has_cost_price === false) add("cost_price", "Cost price");

  const attrs = item.attributes || {};
  const required = fields.filter((f) => f.required);
  for (const f of required) {
    if (!hasValue(attrs[f.key])) add(f.key, f.label || f.key);
  }
  if (!required.length && !Object.keys(attrs).some((k) => hasValue(attrs[k]))) {
    for (const f of fields.slice(0, 4)) add(f.key, f.label || f.key);
  }

  for (const [key, level] of Object.entries(conf || {})) {
    if ((level === "Low" || level === "Medium") && !AI_BLIND_FIELDS.has(key)) {
      add(key, `${fieldNameForKey(key, fields)} (${level})`);
    }
  }

  return { keys, labels };
}

/**
 * Open the editor for an item.
 * @param {string} itemId
 * @param {object} caps     capability object
 * @param {Function} onSaved called after a successful save (to refresh the grid)
 * @param {object} opts     { focusIssue } to open near the relevant fix section
 */
// Re-entry guard: a fast double-tap fires two opens before the first sheet
// reaches the DOM (the item fetch is async), which used to stack two editors.
let _editorOpening = false;

export async function openEditor(itemId, caps, onSaved, opts = {}) {
  if (_editorOpening || document.querySelector(".sheet")) return;
  _editorOpening = true;
  await loadRefData();
  caps = caps || {};
  opts = opts || {};
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
    _editorOpening = false;
    return;
  }

  let cost = null;
  let hasCostPrice;
  if (canViewCost) {
    const { data } = await supabase
      .from("item_costs")
      .select("cost_price")
      .eq("item_id", itemId)
      .maybeSingle();
    cost = data?.cost_price ?? null;
    hasCostPrice = cost !== null && cost !== undefined;
  } else {
    const costPresence = await loadCostPresence([itemId]);
    if (costPresence.has(itemId)) hasCostPrice = costPresence.get(itemId);
  }
  if (canViewCost) item.cost_price = cost;
  if (hasCostPrice !== undefined) item.has_cost_price = hasCostPrice;

  // Live shop numbers for this item's POS variant (read-only mirror — the POS
  // owns stock/sold/price after push). Null when not pushed or not mirrored yet.
  let shopMirror = null;
  if (item.pos_variant_id) {
    const { data } = await supabase
      .from("pos_stock_mirror")
      .select("stock_quantity, units_sold, units_returned, is_active, mirrored_at")
      .eq("pos_variant_id", item.pos_variant_id)
      .maybeSingle();
    shopMirror = data || null;
  }
  const [recentActivity, failedAiJobs] = await Promise.all([
    canEdit ? loadItemActivity(itemId, 6) : Promise.resolve([]),
    loadLatestFailedJobs([itemId], "ai_fill"),
  ]);
  const latestAiJob = failedAiJobs.get(itemId);
  if (latestAiJob) item.latest_ai_job = latestAiJob;

  // One plain-language line about this item's life in the shop. Wording is for
  // floor staff, not engineers; the gallery chips use the same states.
  function shopLineHtml() {
    const s = item.pos_sync_status;
    const dirtyNote = item.pos_dirty
      ? ` · <span class="warn">✎ recent edits haven't reached the shop yet</span>` : "";
    if (s === "synced") {
      if (!shopMirror) return `<div class="shop-line">● In the shop — live count arrives with the next sync${dirtyNote}</div>`;
      if (shopMirror.is_active === false) return `<div class="shop-line">Retired — no longer sold in the shop${dirtyNote}</div>`;
      const sold = (shopMirror.units_sold || 0) - (shopMirror.units_returned || 0);
      const asOf = shopMirror.mirrored_at
        ? ` (as of ${new Date(shopMirror.mirrored_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : "";
      const left = shopMirror.stock_quantity <= 0
        ? `<span class="warn">sold out</span>` : `${shopMirror.stock_quantity} left`;
      return `<div class="shop-line">● In the shop · ${left} · ${sold} sold${esc(asOf)}${dirtyNote}</div>`;
    }
    if (s === "error") return `<div class="shop-line"><span class="warn">⚠ Couldn't send to the shop</span> — ${esc(item.pos_sync_error || "unknown error")}. It will be retried automatically.</div>`;
    if (s === "awaiting_approval" || s === "pending") return `<div class="shop-line">… Sending to the shop</div>`;
    if (item.status === "approved") return `<div class="shop-line">◌ Approved — goes to the shop on the next sync</div>`;
    return "";
  }

  const [{ data: signed }] = await Promise.all([
    item.image_path
      ? supabase.storage.from("product-images").createSignedUrl(item.image_path, 3600)
      : Promise.resolve({ data: null }),
  ]);
  const imgUrl = signed?.signedUrl || null;

  const fields = resolveFields(item.category_id);
  const conf = { ...(item.confidence || {}) }; // working copy of per-field confidence
  const readiness = getItemReadiness(item, { canViewCost });
  const fixPlan = buildEditorFixPlan(item, fields, conf, { canViewCost });
  const aiSuggestedKeys = new Set();

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
        <section class="ed-section ed-verify" data-ed-section="verify" aria-label="Verify item">
          <div class="ed-section-title">Verify</div>
        <div class="ed-offline" id="edOffline" hidden>● Offline — your changes are kept; tap Save once you reconnect.</div>
        ${imgUrl ? `<div class="sheet-img"><img src="${imgUrl}" alt="${imgAlt}"></div>` : ""}

        ${canEdit && imgUrl ? `<button class="ghost aibtn" id="aiBtn">${ICON.sparkle} AI suggest fields from photo</button>` : ""}

        ${readinessPanelHtml(readiness)}
        ${fixModeHtml(fixPlan)}

        <div class="status-row" id="statusRow" role="group" aria-label="Status">
          ${STATUS_OPTIONS
            .map(
              (s) =>
                `<button class="status-pill ${item.status === s ? "on" : ""}" data-status="${s}" aria-pressed="${item.status === s}">${esc(statusLabel(s))}</button>`
            )
            .join("")}
        </div>
        <button type="button" class="linkbtn legend-btn" id="legendBtn">What do these labels mean?</button>
        </section>

        <section class="ed-section ed-details" data-ed-section="details" aria-label="Item details">
          <div class="ed-section-title">Details</div>

        <div id="dupWarn" class="dup-warn" style="display:none"></div>

        <div class="frow" data-field-row="category">
          <label>Category</label>
          <div class="fctl"><span class="readonly-val">${esc(categoryPath(item.category_id))}</span></div>
        </div>
        ${fieldRow({ key: "name", label: "Name", type: "text" }, item.name, conf, false, canEdit)}
        ${fieldRow({ key: "brand", label: "Brand", type: "text", vocab: "brand" }, item.brand, conf, canEdit, canEdit)}
        ${fields.map((f) => fieldRow(f, item.attributes?.[f.key], conf, canEdit, canEdit)).join("")}
        </section>

        <section class="ed-section ed-selling" data-ed-section="selling" aria-label="Selling">
          <div class="ed-section-title">Selling</div>
        ${shopLineHtml()}
        ${fieldRow({ key: "price", label: item.pos_sync_status === "synced" ? "Initial price (shop price is set in the POS)" : "Retail price", type: "number" }, item.price, conf, false, canEdit)}
        ${fieldRow(
          { key: "stock_quantity", label: item.pos_sync_status === "synced" ? "Units received (live stock lives in the POS)" : "Units in this batch (1 photo = 1 unit)", type: "number", inputmode: "numeric" },
          item.stock_quantity, conf, false,
          // Frozen once pushed: the receipt is booked, the POS ledger owns
          // stock from here. Restocking = photograph the new units.
          canEdit && item.pos_sync_status !== "synced"
        )}
        ${fieldRow({ key: "reorder_level", label: "Reorder level", type: "number", inputmode: "numeric" }, item.reorder_level, conf, false, canEdit)}
        </section>

        <section class="ed-section ed-activity" data-ed-section="activity" aria-label="Activity">
          <div class="ed-section-title">Activity</div>
          ${activitySectionHtml(recentActivity, canEdit, fields)}
        </section>

        <section class="ed-section ed-admin" data-ed-section="admin" aria-label="Admin">
          <div class="ed-section-title">Admin</div>
        ${
          canViewCost
            ? `${fieldRow({ key: "cost_price", label: "Cost price", type: "number" }, cost, conf, false, canEdit)}
               <div class="admin-note">Cost is restricted to admin roles.</div>`
            : ""
        }

        <div class="sku-line">SKU: <span id="skuVal">${esc(item.sku || "—")}</span>
          <span style="color:var(--muted)"> (updates automatically)</span></div>
        ${item.created_at ? `<div class="added-line">Added ${esc(new Date(item.created_at).toLocaleString())}</div>` : ""}

        ${canDelete ? `<button class="danger del-btn" id="deleteBtn">Delete item</button>` : ""}
        </section>
      </div>
      ${canEdit ? `<div class="sheet-foot">
        <button class="ghost" id="saveFootBtn" type="button">Save</button>
        ${item.status === "approved" ? "" : `<button class="primary" id="saveApproveBtn" type="button">Save &amp; approve</button>`}
      </div>` : ""}
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
  _editorOpening = false; // sheet is in the DOM — the .sheet check guards from here
  requestAnimationFrame(() => sheet.classList.add("open"));
  const releaseFocus = trapFocus(sheet);
  // Focus the Cancel control first (not a text field) so opening the editor
  // doesn't pop the mobile keyboard before the user has looked at the photo.
  requestAnimationFrame(() => sheet.querySelector("#cancelBtn")?.focus());
  if (opts.focusIssue) requestAnimationFrame(() => focusEditorIssue(sheet, opts.focusIssue));

  // A SKU can already collide from an earlier save — surface that when the
  // editor opens, not only after the next save (when the sheet is closing).
  if (item.sku) countSkuDups(itemId, item.sku).then((d) => paintDupWarn(sheet, item.sku, d));

  // Tap the photo to zoom — you're checking fields against it, same as the
  // gallery thumbs (imgAlt is already escaped, as the lightbox caption expects).
  const imgWrap = sheet.querySelector(".sheet-img");
  if (imgWrap && imgUrl) imgWrap.onclick = () => openLightbox([{ url: imgUrl, caption: imgAlt }], 0);

  // ---- interactions ----
  let editorHistoryArmed = false;
  let closed = false;
  let onBrowserBack = null;
  let close = ({ fromBrowserBack = false } = {}) => {
    if (closed) return;
    closed = true;
    if (onBrowserBack) window.removeEventListener("popstate", onBrowserBack);
    if (editorHistoryArmed) {
      editorHistoryArmed = false;
      if (!fromBrowserBack) {
        try { window.history.back(); } catch {}
      }
    }
    releaseFocus();
    sheet.classList.remove("open");
    setTimeout(() => sheet.remove(), 200);
  };
  // Are there unsaved edits? (status changed, any highlighted field, or a
  // confidence pill the user touched). Used to guard accidental dismissal.
  let status = item.status;
  let confDirty = false;
  let savedOk = false; // set true after a successful save so close doesn't prompt
  const isDirty = () => !savedOk && canEdit &&
    (status !== item.status || confDirty || !!sheet.querySelector("[data-key].changed"));
  // Cancel / backdrop: confirm before throwing away unsaved work.
  const requestClose = async ({ fromBrowserBack = false } = {}) => {
    if (isDirty()) {
      const ok = await confirmSheet({
        title: "Discard changes?",
        message: "Your edits to this item haven't been saved.",
        confirmText: "Discard",
        cancelText: "Keep editing",
        danger: true,
      });
      if (!ok) return false;
    }
    close({ fromBrowserBack });
    return true;
  };
  const armBrowserBackClose = () => {
    if (editorHistoryArmed || !window.history?.pushState) return;
    try {
      window.history.pushState({ klineOverlay: "editor", itemId }, "", window.location.href);
      editorHistoryArmed = true;
      window.addEventListener("popstate", onBrowserBack);
    } catch {}
  };
  onBrowserBack = async () => {
    if (closed || !document.body.contains(sheet)) return;
    editorHistoryArmed = false; // Chrome has already consumed the temporary entry.
    if (!isTopOverlay(sheet)) {
      armBrowserBackClose();
      return;
    }
    const didClose = await requestClose({ fromBrowserBack: true });
    if (!didClose && document.body.contains(sheet)) armBrowserBackClose();
  };
  armBrowserBackClose();
  sheet.querySelector("#cancelBtn").onclick = () => requestClose();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) requestClose(); });
  // Esc = Cancel (safe — the dirty-guard above still runs), matching every other
  // overlay. Ignored while a sheet/dialog/lightbox sits on top: that layer owns Esc.
  const onEsc = (e) => { if (e.key === "Escape" && isTopOverlay(sheet)) requestClose(); };
  document.addEventListener("keydown", onEsc);

  // Offline awareness: surface the state up front (banner + Save button) instead
  // of only failing on tap. Edits stay in the form; the user saves on reconnect.
  const offlineNote = sheet.querySelector("#edOffline");
  const headerSaveBtn = sheet.querySelector("#saveBtn");
  const footerSaveBtn = sheet.querySelector("#saveFootBtn");
  const saveApproveBtn = sheet.querySelector("#saveApproveBtn");
  const saveControls = [headerSaveBtn, footerSaveBtn].filter(Boolean);
  let saving = false;
  const approvalReadinessFor = () =>
    getItemReadiness(formItemForReadiness(sheet, item, fields, conf, "approved"), { forApproval: true, canViewCost });
  const currentReadinessFor = () => {
    const candidate = formItemForReadiness(sheet, item, fields, conf, status);
    return getItemReadiness(candidate, { forApproval: status === "approved", canViewCost });
  };
  const approvalBlockerText = (readiness) =>
    (readiness.blockers || []).slice(0, 3).map((b) => b.detail || b.label).join(" ");
  const paintCurrentReadiness = () => {
    const panel = sheet.querySelector("#readyPanel");
    if (panel) panel.outerHTML = readinessPanelHtml(currentReadinessFor());
  };
  const paintApprovalAffordance = () => {
    const off = !navigator.onLine;
    const approvalReadiness = approvalReadinessFor();
    const blocked = approvalReadiness.blockers.length > 0;
    const warned = !blocked && approvalReadiness.warnings.length > 0;
    const blockerText = blocked ? approvalBlockerText(approvalReadiness) : "";
    const approvePill = sheet.querySelector('.status-pill[data-status="approved"]');
    if (approvePill && item.status !== "approved") {
      approvePill.disabled = saving || off || !canEdit || blocked;
      approvePill.title = blocked ? `Fix before approval: ${blockerText}` : "";
    }
    if (saveApproveBtn) {
      saveApproveBtn.disabled = saving || off || !canEdit || blocked;
      saveApproveBtn.textContent = saving
        ? "Saving..."
        : off
          ? "Offline"
          : blocked
            ? "Fix issues first"
            : warned
              ? "Review & approve"
              : "Save & approve";
      saveApproveBtn.title = blocked
        ? `Fix before approval: ${blockerText}`
        : warned
          ? "Approval will ask you to confirm AI checks."
          : "";
    }
    paintCurrentReadiness();
  };
  const setSaveBusy = (busy) => {
    saving = busy;
    const off = !navigator.onLine;
    saveControls.forEach((btn) => { btn.disabled = busy || off || !canEdit; });
    if (headerSaveBtn) headerSaveBtn.textContent = busy ? "Saving..." : (off ? "Offline" : "Save");
    if (footerSaveBtn) footerSaveBtn.textContent = busy ? "Saving..." : "Save";
    paintApprovalAffordance();
  };
  const reflectOnline = () => {
    const off = !navigator.onLine;
    offlineNote.hidden = !off;
    if (!saving) setSaveBusy(false);
  };
  window.addEventListener("online", reflectOnline);
  window.addEventListener("offline", reflectOnline);
  reflectOnline();

  const fixModeBtn = sheet.querySelector("#fixModeBtn");
  let fixModeOn = !!fixModeBtn && ["missing", "doubt", "price"].includes(opts.focusIssue);
  const applyFixMode = () => {
    if (!fixModeBtn) return;
    sheet.classList.toggle("fix-mode", fixModeOn);
    fixModeBtn.setAttribute("aria-pressed", fixModeOn);
    fixModeBtn.textContent = fixModeOn
      ? "Show all fields"
      : `Show only ${fixPlan.keys.size} field${fixPlan.keys.size === 1 ? "" : "s"} to fix`;
    sheet.querySelectorAll("[data-field-row]").forEach((row) => {
      const target = fixPlan.keys.has(row.dataset.fieldRow);
      row.classList.toggle("fix-target", target);
      row.classList.toggle("fix-hide", fixModeOn && !target);
    });
    sheet.querySelectorAll("[data-ed-section]").forEach((section) => {
      const hasTarget = [...section.querySelectorAll("[data-field-row]")]
        .some((row) => fixPlan.keys.has(row.dataset.fieldRow));
      section.classList.toggle("fix-section-hide", fixModeOn && section.dataset.edSection !== "verify" && !hasTarget);
    });
  };
  if (fixModeBtn) {
    fixModeBtn.onclick = () => { fixModeOn = !fixModeOn; applyFixMode(); };
    applyFixMode();
  }
  // Tear the listeners down when the sheet closes (wrap the base close once).
  const baseClose = close;
  close = (opts) => {
    window.removeEventListener("online", reflectOnline);
    window.removeEventListener("offline", reflectOnline);
    document.removeEventListener("keydown", onEsc);
    baseClose(opts);
  };

  // Status pills
  const paintStatusPills = () => {
    sheet.querySelectorAll(".status-pill").forEach((p) => {
      const on = p.dataset.status === status;
      p.classList.toggle("on", on);
      p.setAttribute("aria-pressed", on);
    });
  };
  sheet.querySelector("#statusRow").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-status]");
    if (!b || !canEdit) return;
    if (b.dataset.status === "approved") {
      const approvalReadiness = approvalReadinessFor();
      if (approvalReadiness.blockers.length) {
        toast("Can't approve yet: " + approvalBlockerText(approvalReadiness) + ".");
        focusEditorIssue(sheet, focusIssueForBlocker(approvalReadiness.blockers[0]) || approvalReadiness.primary?.issue);
        paintApprovalAffordance();
        return;
      }
    }
    status = b.dataset.status;
    paintStatusPills();
    paintApprovalAffordance();
  });

  // Legend: explain what the status labels and H/M/L confidence dots mean.
  sheet.querySelector("#legendBtn").onclick = () => {
    openBottomSheet("What the labels mean", `
      <div class="legend">
        <div class="sheet-sec">Status</div>
        <div class="legend-row"><span class="stbadge st-draft">${esc(statusLabel("draft"))}</span> Not reviewed yet.</div>
        <div class="legend-row"><span class="stbadge st-review">${esc(statusLabel("needs-review"))}</span> Needs a closer look.</div>
        <div class="legend-row"><span class="stbadge st-ok">${esc(statusLabel("approved"))}</span> Checked and good to go.</div>
        <div class="legend-row"><span class="stbadge st-flag">${esc(statusLabel("flag"))}</span> Has a problem to fix.</div>
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
      paintApprovalAffordance();
    });
  });

  // Mark changed inputs (highlight) versus their initial value.
  sheet.querySelectorAll("[data-key]").forEach((el) => {
    const initial = el.type === "checkbox" ? String(el.checked) : el.value;
    el.addEventListener("input", () => {
      const now = el.type === "checkbox" ? String(el.checked) : el.value;
      el.classList.toggle("changed", now !== initial);
      paintApprovalAffordance();
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
      // Booleans (checkboxes) are left to the user — AI fills text/number/select
      // fields only. A checkbox has no "empty" state, and its saved value is read
      // from .checked (not the .value this loop assigns), so AI-suggesting one
      // would only add a misleading "changed" mark without changing anything.
      if (el.type === "checkbox") continue;
      // Fill empty fields only — never silently overwrite a value already in the
      // form. This matches the upload + bulk-AI paths (only-empty); to re-suggest
      // a field, clear it first then run AI again.
      if (String(el.value).trim() !== "") continue;
      let val = String(raw);
      if (vocabByKey[key]) val = normalizeValue(vocabByKey[key], val);
      val = normalizeAttributeValue(item.category_id, key, val);
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === val)) {
        const o = document.createElement("option");
        o.value = val;
        o.textContent = val;
        el.appendChild(o);
      }
      el.value = val;
      el.classList.add("changed");
      aiSuggestedKeys.add(key);
      const lvl = confidence?.[key];
      if (lvl) {
        conf[key] = lvl;
        const pill = sheet.querySelector(`[data-conf="${key}"]`);
        if (pill) paintConfPill(pill, lvl);
      }
      n++;
    }
    paintApprovalAffordance();
    return n;
  }

  const aiBtn = sheet.querySelector("#aiBtn");
  if (aiBtn) {
    aiBtn.onclick = async () => {
      if (!navigator.onLine) { toast("You're offline — AI needs a connection."); return; }
      const label = aiBtn.innerHTML; // innerHTML — the label carries the sparkle SVG
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
        await clearItemJobFailures(itemId, "ai_fill");
        delete item.latest_ai_job;
        paintApprovalAffordance();
        toast(n ? `AI filled ${n} field${n === 1 ? "" : "s"} — review & Save` : "AI couldn't read any fields");
      } catch (e) {
        await recordItemJobFailure(itemId, "ai_fill", e);
        item.latest_ai_job = { status: "failed", error_message: e?.message || String(e) };
        paintApprovalAffordance();
        toast("AI failed: " + (e?.message || e));
      } finally {
        aiBtn.disabled = false;
        aiBtn.innerHTML = label;
      }
    };
  }

  const guardApproval = async () => {
    const readiness = approvalReadinessFor();
    if (readiness.blockers.length) {
      toast("Can't approve yet: " + approvalBlockerText(readiness) + ".");
      focusEditorIssue(sheet, focusIssueForBlocker(readiness.blockers[0]) || readiness.primary?.issue);
      paintApprovalAffordance();
      return false;
    }
    if (readiness.warnings.length) {
      const ok = await confirmSheet({
        title: "Approve with AI checks?",
        message: readiness.warnings.map((w) => w.detail || w.label).join(" "),
        confirmText: "I checked, approve",
        cancelText: "Review first",
      });
      if (!ok) return false;
    }
    return true;
  };

  const saveCurrent = async ({ targetStatus = status } = {}) => {
    if (!canEdit) return false;
    if (!navigator.onLine) { toast("You're offline — reconnect to save your changes."); return false; }
    if (targetStatus === "approved" && !(await guardApproval())) return false;
    // One photo = one unit: a quantity above 1 is almost certainly a mistake
    // under this shop's workflow (each identical unit gets its own photo as
    // evidence), so make the person saying otherwise mean it.
    const qtyEl = sheet.querySelector('[data-key="stock_quantity"]');
    if (qtyEl && !qtyEl.disabled && Number(qtyEl.value) > 1) {
      const sure = await confirmSheet({
        title: "More than 1 unit on one photo?",
        message: "This shop counts one unit per photo — identical items each get their own photo. Only keep a higher number if this single photo really stands for several units.",
        confirmText: "Keep " + qtyEl.value.trim(),
      });
      if (!sure) return false;
    }
    const btn = headerSaveBtn;
    setSaveBusy(true);
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const changes = await saveItem(sheet, item, fields, conf, targetStatus, canViewCost, cost);
      const approvalChanges = changes.filter((c) => c.field_path === "status" && c.after === "approved");
      const aiChanges = changes.filter((c) =>
        c.field_path !== "status" && aiSuggestedKeys.has(fieldKeyFromPath(c.field_path))
      );
      const manualChanges = changes.filter((c) => !approvalChanges.includes(c) && !aiChanges.includes(c));
      if (aiChanges.length) {
        await logItemActivity(item.id, "ai_fill", "ai", aiChanges, `AI filled ${aiChanges.length} field${aiChanges.length === 1 ? "" : "s"}`);
      }
      if (manualChanges.length) {
        await logItemActivity(item.id, "manual_edit", "manual", manualChanges, `Manually edited ${manualChanges.length} field${manualChanges.length === 1 ? "" : "s"}`);
      }
      if (approvalChanges.length) {
        await logItemActivity(item.id, "approval", "approval", approvalChanges, "Approved from editor");
      }
      const { sku: newSku, dups } = await refreshSkuAndDupCheck(sheet, itemId);
      toast(dups
        ? `Saved · SKU ${newSku} — ⚠ shared with ${dups} other item${dups === 1 ? "" : "s"}`
        : `Saved · SKU ${newSku}`);
      navigator.vibrate?.([12, 40, 12]); // affirmative "done" buzz
      savedOk = true; // don't prompt "discard changes?" on the post-save close
      onSaved?.();
      close();
      return true;
    } catch (err) {
      toast(err.message || "Save failed");
      setSaveBusy(false);
      btn.disabled = false;
      btn.textContent = "Save";
      return false;
    }
  };
  headerSaveBtn.onclick = () => saveCurrent();
  footerSaveBtn?.addEventListener("click", () => saveCurrent());
  saveApproveBtn?.addEventListener("click", async () => {
    await saveCurrent({ targetStatus: "approved" });
  });

  // Per-item change history (audit log; readable by editors).
  const histBtn = sheet.querySelector("#historyBtn");
  if (histBtn) histBtn.onclick = () => openActivity(itemId);

  // Delete (capability-gated): removes the item and its stored image.
  const deleteBtn = sheet.querySelector("#deleteBtn");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (!navigator.onLine) { toast("You're offline — reconnect to delete."); return; }
      // Deletion rule for pushed items: the POS product is NEVER deleted from
      // here — it may carry sales history. Deleting only removes the catalog
      // photo/record (one unit of evidence) and drops this card's link.
      const inShop = !!item.pos_product_id;
      const ok = await confirmSheet({
        title: inShop ? "Delete item that's in the shop?" : "Delete item?",
        message: inShop
          ? "This photo and catalog record will be permanently deleted, but the product STAYS in the POS (it may have sales history) — its stock there is not changed. If a unit physically left, adjust stock in the POS too."
          : "This item and its photo will be permanently deleted. This cannot be undone.",
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

function readinessPanelHtml(readiness) {
  const primary = readiness.primary;
  const title = readiness.isReady
    ? "Ready to approve"
    : primary?.label || "Approved";
  const detail = primary?.detail || (readiness.isReady
    ? "Price and required details are present."
    : "This item has already been approved.");
  const rows = [
    ...readiness.blockers.map((b) => `<li>${esc(b.detail || b.label)}</li>`),
    ...readiness.warnings.map((w) => `<li>${esc(w.detail || w.label)}</li>`),
  ].join("");
  return `<div class="ready-panel ${readiness.isReady ? "is-ready" : readiness.blockers.length ? "is-blocked" : "is-warn"}" id="readyPanel">
    <div class="ready-title">${esc(title)}</div>
    <div class="ready-detail">${esc(detail)}</div>
    ${rows ? `<ul>${rows}</ul>` : ""}
  </div>`;
}

function fixModeHtml(plan) {
  if (!plan?.keys?.size) return "";
  const labels = (plan.labels || []).slice(0, 4).join(", ");
  const extra = plan.labels.length > 4 ? `, plus ${plan.labels.length - 4} more` : "";
  return `<div class="fixmode-strip">
    <button class="ghost fixmode-btn" id="fixModeBtn" type="button" aria-pressed="false">
      Show only ${plan.keys.size} field${plan.keys.size === 1 ? "" : "s"} to fix
    </button>
    ${labels ? `<div class="fixmode-note">Focus: ${esc(labels + extra)}</div>` : ""}
  </div>`;
}

function activityValue(v) {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function activityFieldLabel(path, fields = []) {
  const key = fieldKeyFromPath(path);
  if (!key) return "";
  return fieldNameForKey(key, fields);
}

function activityRowHtml(row, fields = []) {
  const when = row.created_at ? new Date(row.created_at).toLocaleString() : "";
  const label = activitySourceLabel(row.source);
  const field = activityFieldLabel(row.field_path, fields);
  const detail = row.field_path
    ? (fieldKeyFromPath(row.field_path) === "cost_price"
        ? "Cost updated" // admin-only value — never render the numbers
        : `${field}: ${activityValue(row.before_value)} -> ${activityValue(row.after_value)}`)
    : (row.summary || label);
  return `<div class="act-row">
    <span class="source-pill src-${esc(activitySourceClass(row.source))}">${esc(label)}</span>
    <div class="act-copy"><b>${esc(detail)}</b>${when ? `<span>${esc(when)}</span>` : ""}</div>
  </div>`;
}

function activitySectionHtml(rows, canEdit, fields = []) {
  const preview = rows?.length
    ? rows.slice(0, 4).map((r) => activityRowHtml(r, fields)).join("")
    : `<div class="muted">No source-aware activity yet. New saves, AI fills, pricing, and approvals will appear here.</div>`;
  return `<div class="activity-list">${preview}</div>
    ${canEdit ? `<button class="ghost histbtn" id="historyBtn" type="button">View full activity</button>` : ""}`;
}

function sectionForIssue(issue) {
  if (issue === "cost") return "admin";
  if (issue === "price" || issue === "sync") return "selling";
  if (issue === "missing") return "details";
  if (issue === "ai" || issue === "doubt" || issue === "flag") return "verify";
  return "verify";
}

function focusIssueForBlocker(blocker) {
  if (blocker?.label === "Missing cost price") return "cost";
  return blocker?.issue || "verify";
}

function focusEditorIssue(sheet, issue) {
  const body = sheet.querySelector(".sheet-body");
  const section = sheet.querySelector(`[data-ed-section="${sectionForIssue(issue)}"]`);
  if (!body || !section) return;
  section.classList.add("is-focus");
  body.scrollTo({ top: Math.max(0, section.offsetTop - 10), behavior: "smooth" });
  setTimeout(() => section.classList.remove("is-focus"), 1600);
}

// Render one labelled field row with the right control + a confidence pill.
// `canEdit:false` renders the control disabled — read-only users used to get
// editable-looking fields with a dead Save button, a confusing dead end.
function fieldRow(def, value, conf, showConf, canEdit = true) {
  const id = `f-${def.key}`;
  const dis = canEdit ? "" : " disabled";
  let control;
  const v = value ?? "";
  if (def.type === "boolean") {
    control = `<input type="checkbox" id="${id}" data-key="${def.key}" data-kind="boolean" ${
      v === true || v === "true" ? "checked" : ""
    }${dis}>`;
  } else if (def.type === "select" && Array.isArray(def.options) && def.options.length) {
    const opts = def.options.includes(v) || !v ? def.options : [v, ...def.options];
    control = `<select id="${id}" data-key="${def.key}" data-kind="value"${dis}>
      <option value=""></option>
      ${opts.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}
    </select>`;
  } else {
    const list = def.vocab ? ` list="dl-${def.vocab}"` : "";
    const type = def.type === "number" ? "number" : "text";
    // Number fields get a numeric keypad on mobile: decimal for money/measures,
    // "numeric" (integer) for counts. Callers override via def.inputmode.
    const im = def.type === "number" ? ` inputmode="${def.inputmode || "decimal"}"` : "";
    control = `<input id="${id}" type="${type}"${im}${list} data-key="${def.key}" data-kind="value"
      data-vocab="${def.vocab || ""}" value="${esc(v)}"${dis}>`;
  }

  const confPill = showConf
    ? `<button class="conf-pill ${confClass(conf[def.key])}" data-conf="${def.key}"
         aria-label="Confidence: ${conf[def.key] || "not set"}" title="Confidence (tap to cycle)">${conf[def.key] ? conf[def.key][0] : "·"}</button>`
    : "";

  return `<div class="frow" data-field-row="${esc(def.key)}">
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
function formItemForReadiness(sheet, item, fields, conf, status) {
  const attributes = { ...(item.attributes || {}) };
  for (const f of fields) {
    const el = sheet.querySelector(`[data-key="${f.key}"]`);
    if (!el) continue;
    let val;
    if (f.type === "boolean") val = el.checked;
    else {
      val = el.value.trim();
      if (f.vocab) val = normalizeValue(f.vocab, val);
      val = normalizeAttributeValue(item.category_id, f.key, val);
    }
    if (val === "" || val === false || val === null) delete attributes[f.key];
    else attributes[f.key] = f.type === "number" ? Number(val) : val;
  }

  const textVal = (key) => sheet.querySelector(`[data-key="${key}"]`)?.value.trim() || "";
  const numVal = (key) => {
    const v = textVal(key);
    return v ? Number(v) : null;
  };
  const costEl = sheet.querySelector('[data-key="cost_price"]');
  const costPrice = costEl ? numVal("cost_price") : item.cost_price;
  const hasCostPrice = costEl
    ? hasValue(costPrice)
    : item.has_cost_price;

  return {
    ...item,
    status,
    name: textVal("name") || null,
    brand: normalizeValue("brand", textVal("brand")) || null,
    price: numVal("price"),
    stock_quantity: numVal("stock_quantity") ?? 1,
    reorder_level: numVal("reorder_level"),
    cost_price: costPrice,
    has_cost_price: hasCostPrice,
    attributes,
    confidence: conf,
  };
}

async function saveItem(sheet, item, fields, conf, status, canViewCost, currentCost = null) {
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
      val = normalizeAttributeValue(item.category_id, f.key, val);
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
    // One photo = one unit: a blanked field means the default (1), never
    // "unknown" — blank rows once pushed with no stock receipt at all.
    // "No stock on purpose" is an explicit 0.
    stock_quantity: num("stock_quantity") ?? 1,
    reorder_level: num("reorder_level"),
    status,
    attributes,
    confidence: conf,
  };
  const changes = diffItemValues(item, { ...item, ...update });

  const { error } = await supabase.from("items").update(update).eq("id", item.id);
  if (error) throw error;

  // Cost -> capability-gated table (upsert).
  if (canViewCost) {
    const cost = num("cost_price");
    if (JSON.stringify(currentCost ?? null) !== JSON.stringify(cost ?? null)) {
      changes.push({ field_path: "cost_price", before: currentCost ?? null, after: cost ?? null });
    }
    const { error: cErr } = await supabase
      .from("item_costs")
      .upsert({ item_id: item.id, cost_price: cost }, { onConflict: "item_id" });
    if (cErr) throw cErr;
  }

  // Persist any brand value the user typed that isn't in the vocab yet.
  if (brand && !vocabSuggestions("brand").includes(brand)) {
    await supabase.from("vocabularies").insert({ field: "brand", canonical: brand }).select();
  }

  return changes;
}

// How many OTHER items share this SKU (0 = unique). head:true → count only.
async function countSkuDups(itemId, sku) {
  if (!sku || sku === "—") return 0;
  const { count } = await supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("sku", sku)
    .neq("id", itemId);
  return count || 0;
}

// Show (or hide) the in-sheet duplicate-SKU warning strip.
function paintDupWarn(sheet, sku, dups) {
  const warn = sheet.querySelector("#dupWarn");
  if (!warn) return;
  warn.style.display = dups ? "block" : "none";
  if (dups) warn.textContent = `⚠ ${dups} other item${dups === 1 ? "" : "s"} share${dups === 1 ? "s" : ""} this SKU (${sku}).`;
}

// Re-read the (trigger-derived) SKU and report any collision with another item.
// Returns { sku, dups } so the save toast can carry the warning — the sheet
// closes right after saving, so the in-sheet strip alone would never be seen.
async function refreshSkuAndDupCheck(sheet, itemId) {
  const { data } = await supabase.from("items").select("sku").eq("id", itemId).single();
  const sku = data?.sku || "—";
  sheet.querySelector("#skuVal").textContent = sku;
  const dups = await countSkuDups(itemId, sku);
  paintDupWarn(sheet, sku, dups);
  return { sku, dups };
}

async function openActivity(itemId) {
  const [events, audit] = await Promise.all([
    loadItemActivity(itemId, 120),
    supabase
      .from("audit_log")
      .select("created_at, change_type, field, before, after, notes")
      .eq("item_id", itemId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const eventRows = (events || []).map((r) => activityRowHtml(r)).join("");
  const auditRows = (audit.data || []).map((r) => {
    const when = new Date(r.created_at).toLocaleString();
    let desc;
    if (r.change_type === "create") desc = "Created";
    else if (r.change_type === "delete") desc = "Deleted";
    else desc = `${esc(r.field || "")}: ${esc(r.before ?? "empty")} -> ${esc(r.after ?? "empty")}`;
    return `<div class="hist-row"><div class="hist-when">${esc(when)}</div><div>${desc}</div>${
      r.notes ? `<div class="muted">${esc(r.notes)}</div>` : ""
    }</div>`;
  }).join("");

  openBottomSheet("Activity",
    `${eventRows ? `<div class="sheet-sec">Work trail</div><div class="activity-list">${eventRows}</div>` : ""}
     ${auditRows ? `<div class="sheet-sec">Field history</div>${auditRows}` : ""}
     ${audit.error ? `<div class="muted">${esc(audit.error.message)}</div>` : ""}
     ${!eventRows && !auditRows && !audit.error ? '<div class="muted">No history yet.</div>' : ""}`);
}

// (toast now lives in ui.js — imported above.)
