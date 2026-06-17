import { supabase } from "./db.js";
import { loadRefData, categoryPath, fieldLabel, resolveFields, getSetting } from "./data.js";
import { esc, toast, trapFocus, openBottomSheet, ICON } from "./ui.js";
import { openPricing } from "./pricing.js";
import { logManyItemActivities } from "./activity.js";
import { costFromRetail } from "./lib/price.js";

// ============================================================================
//  Guided pricing — "price like you'd say it".
//
//  Retail pricing is reasoned about as a sentence: a base price plus
//  carve-outs ("Formal shirts are 90k. The linen ones are 120k. Essential
//  brand is 100k."). This surface speaks that grammar in four steps:
//    1. WHAT   — pick a category pile from a tappable tree (photos + counts)
//    2. BASE   — one price for everyone (or "leave others as they are")
//    3. EXCEPT — carve-outs built from the differences that actually exist
//                in the pile; later lines win when an item matches several
//    4. CHECK  — every affected item shown as a photo with its new price tag,
//                grouped by outcome, then ONE undoable write
//
//  The pivot-style tool (pricing.js) stays available behind "Advanced" — same
//  write semantics, different audience. This flow edits retail price only;
//  cost lives in Advanced where it is capability-gated.
// ============================================================================


// Attribute keys that can carry a "size-like" number (band exceptions).
const isNumericish = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v));

export async function openGuidedPricing(caps, onClose, opts = {}) {
  // Show the overlay immediately with a spinner so "Set prices" feels responsive
  // while the catalogue (up to 5000 rows) loads; real content replaces it below.
  const el = document.createElement("div");
  el.className = "calib pricing pgd";
  el.innerHTML = `<div class="calib-panel"><div class="calib-head"><span>Set prices</span></div>
    <div class="calib-body"><div class="spinner" style="margin:48px auto"></div></div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));

  await loadRefData();
  const ref = await loadRefData(); // cached — gives us the raw category tree

  const { data: rows, error } = await supabase
    .from("items")
    .select("id, brand, attributes, category_id, price, image_path, pos_sync_status")
    .limit(5000);
  if (error) {
    // Keep the overlay open with a retry instead of vanishing on a network blip.
    el.querySelector(".calib-body").innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Couldn't load items — check your connection.</div>
      <button class="ghost" id="pgdRetry" style="margin-top:10px">Try again</button></div>`;
    el.querySelector("#pgdRetry").onclick = () => { el.remove(); openGuidedPricing(caps, onClose, opts); };
    return;
  }
  // Once an item is in the POS, the POS owns its price (catalog price changes
  // deliberately do NOT propagate) — so this surface only offers items whose
  // price will actually take effect: never pushed, or errored (the price goes
  // with the retry push). Synced/in-flight items are repriced in the POS.
  const allItems = rows || [];
  const priceable = (it) => !it.pos_sync_status || it.pos_sync_status === "error";
  const items = allItems.filter(priceable);
  // Selection mode: when the caller hands us specific items (a gallery selection
  // or the review price queue), we price exactly those — skipping the category
  // picker — so "Set prices" is one model everywhere. Pivot stays via Advanced.
  const selIds = Array.isArray(opts.itemIds) ? new Set(opts.itemIds) : null;
  const selectionMode = !!(selIds && selIds.size);

  const cur = getSetting("currency", "");
  const fmt = (n) => (cur ? `${cur} ` : "") + Number(n).toLocaleString();

  // ---- category tree helpers ----------------------------------------------
  // ancestorsOf(item.category_id) includes the category itself, so "pile of a
  // node" = every item whose chain contains the node (descendants inclusive).
  const catById = ref.byId;
  const chainCache = new Map();
  const chainOf = (catId) => {
    if (chainCache.has(catId)) return chainCache.get(catId);
    const chain = new Set();
    let cu = catById[catId], depth = 0;
    while (cu && depth++ < 20) { chain.add(cu.id); cu = cu.parent_id ? catById[cu.parent_id] : null; }
    chainCache.set(catId, chain);
    return chain;
  };
  const itemsUnder = (nodeId) => items.filter((it) => it.category_id && chainOf(it.category_id).has(nodeId));
  // How many items under a node are already in the POS (price owned there).
  const inShopUnder = (nodeId) =>
    allItems.filter((it) => !priceable(it) && it.category_id && chainOf(it.category_id).has(nodeId)).length;
  const childrenOf = (nodeId) =>
    ref.categories.filter((c) => (c.parent_id || null) === nodeId).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  // ---- flow state ----------------------------------------------------------
  let step = 1;          // 1 what · 2 base · 3 exceptions · 4 check
  let drillId = null;    // current tree level while choosing (null = roots)
  let pickedId = null;   // the chosen category node
  let pile = [];         // items in the chosen node
  let basePrice = "";    // "" = leave non-matching items unchanged
  // Overwriting an existing price is the destructive case, so protection is ON
  // by default — untick it deliberately to reprice.
  let keepPriced = true;
  // Optional cost price (admins only) applied alongside retail, so a pricing pass
  // also clears the cost approval-blocker. "pct" = a percentage of each item's
  // retail (e.g. 50% margin); "fixed" = one cost for everything priced.
  let costEnabled = false;
  let costMode = "pct";  // "pct" | "fixed"
  let costPct = "50";
  let costFixed = "";
  const exceptions = []; // { key, label, mode:'values'|'band', values?, dir?, threshold?, price }

  // Seed the pile straight from the selection and jump to the base-price step.
  let droppedInShop = 0;
  if (selectionMode) {
    pile = items.filter((it) => selIds.has(it.id));
    droppedInShop = selIds.size - pile.length; // selected items already in the POS (price owned there)
    step = 2;
  }

  // Signed thumbnails for everything, one batch up front — the tree rows, the
  // pile strip and the preview grid all draw from the same pool.
  const signed = {};
  {
    const paths = [...new Set(items.map((it) => it.image_path).filter(Boolean))];
    if (paths.length) {
      const { data: urls } = await supabase.storage.from("product-images").createSignedUrls(paths, 3600);
      (urls || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
    }
  }

  // ---- the rule engine ------------------------------------------------------
  const exceptionMatches = (ex, it) => {
    if (ex.key === "brand") {
      return ex.mode === "values" && ex.values.has((it.brand || "").trim());
    }
    const raw = it.attributes?.[ex.key];
    if (ex.mode === "values") return raw != null && ex.values.has(String(raw).trim());
    const v = Number(raw);
    if (!Number.isFinite(v)) return false;
    return ex.dir === "le" ? v <= Number(ex.threshold) : v > Number(ex.threshold);
  };
  // Final price for an item under the current sentence: base, then each
  // exception in order — the LAST matching line wins. null = untouched.
  const finalPriceOf = (it) => {
    let p = basePrice === "" ? null : Number(basePrice);
    for (const ex of exceptions) if (exceptionMatches(ex, it)) p = Number(ex.price);
    if (p == null) return null;
    if (keepPriced && it.price != null) return null;
    return p;
  };

  // Human sentence for one exception line ("Material is Linen → 120,000").
  // Whether cost-setting is active (admin + a mode chosen) and the cost for a
  // given retail price under the current cost rule (rounded), or null.
  const costOn = () => caps.can_view_cost && costEnabled;
  // Delegates the arithmetic to the shared, unit-tested helper (src/lib/price.js)
  // so the guided and advanced pricing tools compute cost identically.
  const costOf = (retail) => {
    if (!costOn() || retail == null) return null;
    return costFromRetail(retail, { mode: costMode, value: costMode === "fixed" ? costFixed : costPct });
  };

  const exText = (ex) => {
    const what = ex.mode === "band"
      ? `${ex.label} ${ex.dir === "le" ? "up to" : "above"} ${ex.threshold}`
      : `${ex.label} is ${[...ex.values].slice(0, 3).join(", ")}${ex.values.size > 3 ? ` +${ex.values.size - 3}` : ""}`;
    return `${what} → ${fmt(ex.price)}`;
  };
  const exCount = (ex) => pile.filter((it) => exceptionMatches(ex, it)).length;

  // The running sentence shown in the header from step 2 onward.
  const sentence = () => {
    const bits = [];
    if (basePrice !== "") bits.push(fmt(basePrice));
    for (const ex of exceptions) bits.push(exText(ex));
    return bits.join(" · ");
  };

  // ---- overlay shell --------------------------------------------------------
  // el is already created + shown (with a loading spinner) at the top.
  const release = trapFocus(el);
  const close = () => {
    document.removeEventListener("keydown", onKey);
    release();
    el.classList.remove("open");
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  };
  // Esc backs out one step at a time; sheets on top own Esc while open.
  const onKey = (e) => {
    if (e.key !== "Escape" || document.querySelector(".msheet.open")) return;
    back();
  };
  document.addEventListener("keydown", onKey);
  function back() {
    if (step === 1) {
      if (drillId != null) { drillId = catById[drillId]?.parent_id || null; render(); }
      else close();
    } else if (selectionMode && step === 2) {
      close(); // no category step to fall back to in selection mode
    } else { step -= 1; render(); }
  }

  // ---- step renderers -------------------------------------------------------
  const thumbOf = (it) => it.image_path && signed[it.image_path]
    ? `<img loading="lazy" src="${signed[it.image_path]}" alt="">` : `<span class="row-noimg">—</span>`;

  function stepWhat() {
    const kids = childrenOf(drillId).map((c) => ({ c, n: itemsUnder(c.id).length })).filter((x) => x.n > 0);
    const here = drillId ? catById[drillId] : null;
    const hereCount = here ? itemsUnder(here.id).length : 0;
    const crumb = here ? categoryPath(here.id) : "";
    return `
      <div class="pgd-lead">Pick the group you're pricing. You can carve out
        exceptions (brand, fabric, size…) on the next steps.</div>
      ${here ? `<div class="pgd-crumb">${esc(crumb)}</div>
        <button class="pgd-noderow pgd-all" data-pick="${esc(here.id)}">
          <span class="pgd-nodename">Price all ${esc(here.name)}</span>
          <span class="pgd-nodecount">${hereCount}</span>
        </button>` : `<div class="pgd-crumb">Categories</div>`}
      ${kids.map(({ c, n }) => {
        const sample = itemsUnder(c.id).find((it) => it.image_path && signed[it.image_path]);
        const hasKids = childrenOf(c.id).some((k) => itemsUnder(k.id).length);
        return `<button class="pgd-noderow" data-${hasKids ? "drill" : "pick"}="${esc(c.id)}">
          <span class="pgd-nodethumb">${sample ? `<img loading="lazy" src="${signed[sample.image_path]}" alt="">` : ""}</span>
          <span class="pgd-nodename">${esc(c.name)}</span>
          <span class="pgd-nodecount">${n}</span>
          ${hasKids ? `<span class="pgd-chev">›</span>` : ""}
        </button>`;
      }).join("") || `<div class="muted" style="padding:20px">Nothing here has items.</div>`}`;
  }

  function pileStrip() {
    const withImg = pile.filter((it) => it.image_path && signed[it.image_path]).slice(0, 14);
    const inShop = selectionMode ? droppedInShop : inShopUnder(pickedId);
    const head = selectionMode
      ? `${pile.length} selected item${pile.length === 1 ? "" : "s"}`
      : `${pile.length} item${pile.length === 1 ? "" : "s"} · ${esc(categoryPath(pickedId))}`;
    return `<div class="pgd-pile">
      <div class="pgd-pilehead">${head}</div>
      <div class="pgd-strip">${withImg.map((it) => `<span class="pgd-stripthumb">${thumbOf(it)}</span>`).join("")}</div>
      ${inShop ? `<div class="pgd-hint muted">${inShop} more ${inShop === 1 ? "is" : "are"} already in the shop and not shown — once pushed, prices change in the POS, not here.</div>` : ""}
    </div>`;
  }

  // A grounded price anchor from the shop's OWN catalogue (deliberately not an
  // LLM guess of local retail — that's unreliable in the shop's currency): the
  // median + range of already-priced items sharing this pile's category or brand.
  function priceSuggestion() {
    const pileCats = new Set(pile.map((it) => it.category_id).filter(Boolean));
    const pileBrands = new Set(pile.map((it) => (it.brand || "").trim().toLowerCase()).filter(Boolean));
    const pileIds = new Set(pile.map((it) => it.id));
    const ref = allItems
      .filter((it) => it.price != null && !pileIds.has(it.id) &&
        (pileCats.has(it.category_id) || pileBrands.has((it.brand || "").trim().toLowerCase())))
      .map((it) => Number(it.price)).filter(Number.isFinite).sort((a, b) => a - b);
    if (ref.length < 3) return null; // too little signal to anchor on
    return { min: ref[0], max: ref[ref.length - 1], median: ref[Math.floor(ref.length / 2)], n: ref.length };
  }

  function stepBase() {
    const already = pile.filter((it) => it.price != null).length;
    const sug = priceSuggestion();
    return `${pileStrip()}
      <div class="pgd-lead">Everyone pays this — unless an exception says otherwise.</div>
      <div class="pg-input pgd-baseinput">
        ${cur ? `<span class="pg-cur">${esc(cur)}</span>` : ""}
        <input id="pgdBase" type="number" inputmode="decimal" placeholder="Standard price — or leave empty" value="${esc(basePrice)}">
      </div>
      ${sug ? `<button class="ghost pgd-suggest" id="pgdSuggest" type="button">Use ${esc(fmt(sug.median))}<span class="muted"> · similar in your catalogue ${esc(fmt(sug.min))}–${esc(fmt(sug.max))} (${sug.n})</span></button>` : ""}
      <div class="pgd-hint muted">Leave it empty to only price the exceptions you add next
        (everything else stays as it is).</div>
      ${already ? `<label class="pg-toggle pgd-keep"><input type="checkbox" id="pgdKeep"${keepPriced ? " checked" : ""}>
        Don't change the ${already} item${already === 1 ? "" : "s"} that already ${already === 1 ? "has" : "have"} a price</label>` : ""}
      ${caps.can_view_cost ? `
      <div class="pgd-cost">
        <label class="pg-toggle"><input type="checkbox" id="pgdCostOn"${costEnabled ? " checked" : ""}>
          Also set a cost price <span class="muted">(needed before approval)</span></label>
        <div class="pgd-cost-body" id="pgdCostBody"${costEnabled ? "" : " hidden"}>
          <div class="pg-modeseg pgd-costmode">
            <button class="pg-modebtn${costMode !== "fixed" ? " on" : ""}" data-cm="pct" type="button">% of price</button>
            <button class="pg-modebtn${costMode === "fixed" ? " on" : ""}" data-cm="fixed" type="button">Fixed amount</button>
          </div>
          <div class="pg-input pgd-costinput">
            ${costMode === "fixed" && cur ? `<span class="pg-cur">${esc(cur)}</span>` : ""}
            <input id="pgdCostVal" type="number" inputmode="decimal"
              placeholder="${costMode === "fixed" ? "Cost amount" : "e.g. 50"}"
              value="${esc(costMode === "fixed" ? costFixed : costPct)}">
            ${costMode !== "fixed" ? `<span class="pg-cur">%</span>` : ""}
          </div>
          <div class="pgd-hint muted">${costMode === "fixed"
            ? "Every item you price gets this cost."
            : "Each item's cost = this % of its retail price."}</div>
        </div>
      </div>` : ""}`;
  }

  function stepExceptions() {
    const lines = exceptions.map((ex, i) => `
      <div class="pgd-exrow">
        <div class="pgd-extext">${esc(exText(ex))}<span class="pgd-excount">${exCount(ex)} item${exCount(ex) === 1 ? "" : "s"}</span></div>
        <div class="pgd-exbtns">
          ${exceptions.length > 1 ? `<button class="pgd-exmove" data-exup="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="pgd-exmove" data-exdn="${i}" ${i === exceptions.length - 1 ? "disabled" : ""}>↓</button>` : ""}
          <button class="pgd-exdel" data-exdel="${i}" aria-label="Remove">✕</button>
        </div>
      </div>`).join("");
    return `${pileStrip()}
      <div class="pgd-lead">Any exceptions?
        ${basePrice !== "" ? `Everyone else pays <b>${esc(fmt(basePrice))}</b>.` : `Only the exceptions below will be priced.`}</div>
      ${lines || `<div class="pgd-hint muted">No exceptions — every item gets the base price.</div>`}
      ${exceptions.length > 1 ? `<div class="pgd-hint muted">If an item matches several lines, the <b>last</b> matching line wins — use ↑↓ to reorder.</div>` : ""}
      <button class="ghost pgd-addex" id="pgdAddEx">＋ Except…</button>`;
  }

  function stepCheck() {
    // Bucket every pile item by its final price.
    const buckets = new Map(); // price -> items[]
    let unchanged = 0, overwrites = 0, news = 0;
    for (const it of pile) {
      const p = finalPriceOf(it);
      if (p == null) { unchanged++; continue; }
      if (it.price == null) news++;
      else if (it.price !== p) overwrites++;
      else { unchanged++; continue; } // already exactly this price — no write
      if (!buckets.has(p)) buckets.set(p, []);
      buckets.get(p).push(it);
    }
    const total = news + overwrites;
    const sections = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([p, its]) => `
      <div class="pgd-bucket">
        <div class="pgd-buckethead"><b>${esc(fmt(p))}</b><span>${its.length} item${its.length === 1 ? "" : "s"}</span></div>
        <div class="pgd-grid">${its.map((it) => `
          <div class="pgd-cell">
            <div class="pgd-cellimg">${thumbOf(it)}</div>
            <div class="pgd-tag">${esc(fmt(p))}</div>
            ${it.price != null && it.price !== p ? `<div class="pgd-was">was ${esc(fmt(it.price))}</div>` : ""}
          </div>`).join("")}</div>
      </div>`).join("");
    const willCost = costOn() ? pile.filter((it) => { const p = finalPriceOf(it); return p != null && costOf(p) != null; }).length : 0;
    const costLabel = costMode === "fixed" ? esc(fmt(Number(costFixed) || 0)) : `${esc(costPct)}% of each price`;
    return `
      <div class="pgd-lead">${total
        ? `Check the tags — <b>${total}</b> item${total === 1 ? "" : "s"} will be priced (${news} new · ${overwrites} changed${unchanged ? ` · ${unchanged} untouched` : ""}).`
        : willCost
          ? `No retail change, but cost will be set on <b>${willCost}</b> item${willCost === 1 ? "" : "s"}.`
          : `Nothing to write — every item is either untouched or already at this price.`}</div>
      ${costOn() && willCost ? `<div class="pgd-costnote">Cost: ${costLabel} · applied to ${willCost} item${willCost === 1 ? "" : "s"}.</div>` : ""}
      ${sections || ""}`;
  }

  // ---- shell render ---------------------------------------------------------
  const TITLES = { 1: "What are we pricing?", 2: "Base price", 3: "Exceptions", 4: "Check & apply" };
  function footHtml() {
    // While drilled into the tree, the left slot becomes Back (mobile users
    // need a visible way up); Advanced is discoverable at the entry level.
    if (step === 1) return `${drillId
      ? `<button class="ghost" id="pgdBack">‹ Back</button>`
      : `<button class="ghost" id="pgdAdv">Advanced</button>`}<span class="pgd-dots">${dots()}</span><span></span>`;
    const nextLabel = step === 2 ? "Exceptions ›" : step === 3 ? "Preview ›" : "Apply";
    const nextDisabled = step === 4 && !pile.some((it) => {
      const p = finalPriceOf(it);
      if (p == null) return false;
      return it.price !== p || (costOn() && costOf(p) != null); // a retail change OR a cost to write
    });
    return `<button class="ghost" id="pgdBack">‹ Back</button>
      <span class="pgd-dots">${dots()}</span>
      <button class="primary" id="pgdNext"${nextDisabled ? " disabled" : ""}>${nextLabel}</button>`;
  }
  const dots = () => [1, 2, 3, 4].map((s) => `<span class="pgd-dot${s === step ? " on" : ""}"></span>`).join("");

  function render() {
    const body = step === 1 ? stepWhat() : step === 2 ? stepBase() : step === 3 ? stepExceptions() : stepCheck();
    el.innerHTML = `<div class="calib-panel">
      <div class="calib-head">
        <button class="iconbtn" id="pgdX" aria-label="Close">${ICON.x}</button>
        <span>${esc(TITLES[step])}</span>
        <span>${selectionMode ? `<button class="linkbtn" id="pgdAdv">Advanced</button>` : ""}</span>
      </div>
      ${step >= 2 && sentence() ? `<div class="pgd-sentence">${esc(selectionMode ? "Selected" : (categoryPath(pickedId)?.split(" › ").pop() || ""))}: ${esc(sentence())}</div>` : ""}
      <div class="calib-body" id="pgdBody">${body}</div>
      <div class="calib-foot pgd-foot">${footHtml()}</div>
    </div>`;

    el.querySelector("#pgdX").onclick = close;
    el.querySelector("#pgdBack")?.addEventListener("click", back);
    el.querySelector("#pgdAdv")?.addEventListener("click", () => { close(); openPricing(caps, onClose, selectionMode ? { itemIds: [...selIds] } : undefined); });
    el.querySelector("#pgdNext")?.addEventListener("click", next);

    const bodyEl = el.querySelector("#pgdBody");
    if (step === 1) {
      bodyEl.addEventListener("click", async (e) => {
        const drill = e.target.closest("[data-drill]");
        if (drill) { drillId = drill.dataset.drill; render(); return; }
        const pick = e.target.closest("[data-pick]");
        if (pick) {
          pickedId = pick.dataset.pick;
          pile = itemsUnder(pickedId);
          step = 2; render();
        }
      });
    } else if (step === 2) {
      bodyEl.querySelector("#pgdBase").addEventListener("input", (e) => { basePrice = e.target.value.trim(); });
      bodyEl.querySelector("#pgdKeep")?.addEventListener("change", (e) => { keepPriced = e.target.checked; });
      bodyEl.querySelector("#pgdSuggest")?.addEventListener("click", () => {
        const s = priceSuggestion();
        if (!s) return;
        basePrice = String(s.median);
        const input = bodyEl.querySelector("#pgdBase");
        if (input) input.value = basePrice;
      });
      // Cost controls (admins): toggle visibility in place; mode switch re-renders
      // so the input's adornment (% vs currency) and placeholder update.
      bodyEl.querySelector("#pgdCostOn")?.addEventListener("change", (e) => {
        costEnabled = e.target.checked;
        const body = bodyEl.querySelector("#pgdCostBody");
        if (body) body.hidden = !costEnabled;
      });
      bodyEl.querySelector(".pgd-costmode")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-cm]");
        if (btn) { costMode = btn.dataset.cm; render(); }
      });
      bodyEl.querySelector("#pgdCostVal")?.addEventListener("input", (e) => {
        const v = e.target.value.trim();
        if (costMode === "fixed") costFixed = v; else costPct = v;
      });
      requestAnimationFrame(() => bodyEl.querySelector("#pgdBase")?.focus());
    } else if (step === 3) {
      bodyEl.querySelector("#pgdAddEx").onclick = openExceptionSheet;
      bodyEl.addEventListener("click", (e) => {
        const del = e.target.closest("[data-exdel]");
        if (del) { exceptions.splice(Number(del.dataset.exdel), 1); render(); return; }
        const up = e.target.closest("[data-exup]");
        if (up) { const i = Number(up.dataset.exup); [exceptions[i - 1], exceptions[i]] = [exceptions[i], exceptions[i - 1]]; render(); return; }
        const dn = e.target.closest("[data-exdn]");
        if (dn) { const i = Number(dn.dataset.exdn); [exceptions[i + 1], exceptions[i]] = [exceptions[i], exceptions[i + 1]]; render(); }
      });
    }
  }

  function next() {
    if (step === 2) {
      if (basePrice !== "" && (!Number.isFinite(Number(basePrice)) || Number(basePrice) < 0)) {
        toast("Enter a valid base price (or leave it empty)."); return;
      }
      step = 3; render();
    } else if (step === 3) {
      if (basePrice === "" && !exceptions.length) { toast("Set a base price or add at least one exception."); return; }
      step = 4; render();
    } else if (step === 4) {
      apply();
    }
  }

  // ---- the "+ Except…" sheet ------------------------------------------------
  // Offers only differentiators that actually VARY within the pile, with a
  // values checklist or an above/below band for numeric attributes.
  function openExceptionSheet() {
    // Label a key through the PILE's own categories' field definitions — the
    // same key (e.g. "size") carries different labels per category ("Size" on
    // shirts, "Belt size" on belts), and a global lookup once dressed shirts
    // in the belt label.
    const pileCats = [...new Set(pile.map((it) => it.category_id).filter(Boolean))];
    const labelFor = (key) => {
      for (const catId of pileCats) {
        const f = resolveFields(catId).find((x) => x.key === key);
        if (f?.label) return f.label;
      }
      return fieldLabel(key);
    };
    // Internal bookkeeping keys that nobody prices by: the style code is the
    // grouping fingerprint for the POS push, not a merchandise difference.
    const NEVER_EXCEPT = new Set(["style"]);
    // brand + every attribute key with ≥2 distinct values in the pile.
    const diffs = [];
    const brandVals = [...new Set(pile.map((it) => (it.brand || "").trim()).filter(Boolean))].sort();
    if (brandVals.length >= 2) diffs.push({ key: "brand", label: "Brand", values: brandVals, numeric: false });
    const attrKeys = [...new Set(pile.flatMap((it) => Object.keys(it.attributes || {})))].sort();
    for (const k of attrKeys) {
      if (NEVER_EXCEPT.has(k)) continue;
      const vals = [...new Set(pile.map((it) => it.attributes?.[k]).filter((v) => v != null && String(v).trim() !== "").map((v) => String(v).trim()))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (vals.length < 2) continue;
      diffs.push({ key: k, label: labelFor(k), values: vals, numeric: pile.some((it) => isNumericish(it.attributes?.[k])) });
    }
    if (!diffs.length) { toast("These items don't differ by anything to except on."); return; }

    const sh = openBottomSheet("Except…", "");
    // Uniform two-line rows: the dimension on top, a single ellipsized line of
    // sample values below — every row the same shape regardless of content.
    const showDiffs = () => {
      sh.body.innerHTML = `<div class="cm-label">What makes these different?</div>` +
        diffs.map((d) => `<button class="pgd-diffrow" data-diff="${esc(d.key)}">
          <span class="pgd-diffname">${esc(d.label)}<span class="pgd-diffn">${d.values.length}</span></span>
          <span class="pgd-diffvals">${esc(d.values.slice(0, 6).join(" · "))}${d.values.length > 6 ? " …" : ""}</span>
        </button>`).join("");
      sh.body.querySelectorAll("[data-diff]").forEach((b) => {
        b.onclick = () => showPicker(diffs.find((d) => d.key === b.dataset.diff));
      });
    };

    const showPicker = (d) => {
      let mode = "values";       // numeric attrs can switch to "band"
      const sel = new Set();
      let dir = "le", threshold = "", price = "", valQ = "";
      const counts = {};
      for (const it of pile) {
        const v = d.key === "brand" ? (it.brand || "").trim() : String(it.attributes?.[d.key] ?? "").trim();
        if (v) counts[v] = (counts[v] || 0) + 1;
      }
      const bandCount = () => {
        const T = Number(threshold);
        if (!Number.isFinite(T)) return null;
        return pile.filter((it) => {
          const v = Number(it.attributes?.[d.key]);
          return Number.isFinite(v) && (dir === "le" ? v <= T : v > T);
        }).length;
      };
      // The checklist rows for the current search text. Selected values always
      // show (even when the search would hide them) so a choice never vanishes.
      const valListHtml = () => d.values
        .filter((v) => !valQ || v.toLowerCase().includes(valQ) || sel.has(v))
        .map((v) => `<button class="fs-opt${sel.has(v) ? " on" : ""}" data-val="${esc(v)}">
            <span class="fs-check-box${sel.has(v) ? " on" : ""}">${sel.has(v) ? "✓" : ""}</span>
            <span class="fs-opt-label">${esc(v)}</span><span class="fs-opt-n">${counts[v] || 0}</span></button>`)
        .join("") || `<div class="muted" style="padding:12px">No matches.</div>`;
      const draw = () => {
        const bandN = bandCount();
        sh.body.innerHTML = `
          <button class="linkbtn" data-back>‹ Back</button>
          <div class="cm-label">${esc(d.label)}</div>
          ${d.numeric ? `<div class="pg-modeseg">
            <button class="pg-modebtn${mode === "values" ? " on" : ""}" data-m="values">Specific ${esc(d.label.toLowerCase())}s</button>
            <button class="pg-modebtn${mode === "band" ? " on" : ""}" data-m="band">Above / below</button>
          </div>` : ""}
          ${mode === "values" ? `
            ${d.values.length > 8 ? `<input class="facet-filter" id="pgdValQ" type="search" placeholder="Search ${esc(d.label.toLowerCase())}…" value="${esc(valQ)}">` : ""}
            <div class="pg-vallist" id="pgdValList">${valListHtml()}</div>`
          : `<div class="pgd-bandrow">
              <div class="pg-modeseg">
                <button class="pg-modebtn${dir === "le" ? " on" : ""}" data-dir="le">Up to</button>
                <button class="pg-modebtn${dir === "gt" ? " on" : ""}" data-dir="gt">Above</button>
              </div>
              <input type="number" inputmode="decimal" class="pg-thresh" id="pgdT" placeholder="e.g. 40" value="${esc(threshold)}">
            </div>
            <div class="pgd-hint muted" id="pgdBandN">${bandN == null ? "Enter a number." : `${bandN} item${bandN === 1 ? "" : "s"} match.`}</div>`}
          <div class="cm-label" style="margin-top:10px">They pay</div>
          <div class="pg-input">
            ${cur ? `<span class="pg-cur">${esc(cur)}</span>` : ""}
            <input type="number" inputmode="decimal" id="pgdExPrice" placeholder="Price for this exception" value="${esc(price)}">
          </div>
          <button class="primary up-go" data-add>Add exception</button>`;
        sh.body.querySelector("[data-back]").onclick = showDiffs;
        sh.body.querySelectorAll("[data-m]").forEach((b) => { b.onclick = () => { mode = b.dataset.m; draw(); }; });
        sh.body.querySelectorAll("[data-dir]").forEach((b) => {
          b.onclick = () => {
            dir = b.dataset.dir;
            sh.body.querySelectorAll("[data-dir]").forEach((x) => x.classList.toggle("on", x.dataset.dir === dir));
            const n = sh.body.querySelector("#pgdBandN"); const bn = bandCount();
            if (n) n.textContent = bn == null ? "Enter a number." : `${bn} item${bn === 1 ? "" : "s"} match.`;
          };
        });
        sh.body.querySelector("#pgdT")?.addEventListener("input", (e) => {
          threshold = e.target.value.trim();
          const n = sh.body.querySelector("#pgdBandN"); const bn = bandCount();
          if (n) n.textContent = bn == null ? "Enter a number." : `${bn} item${bn === 1 ? "" : "s"} match.`;
        });
        sh.body.querySelector("#pgdExPrice").addEventListener("input", (e) => { price = e.target.value.trim(); });
        // Search filters the list in place (the input lives OUTSIDE the list,
        // so it keeps focus and the sheet's scroll position survives typing).
        sh.body.querySelector("#pgdValQ")?.addEventListener("input", (e) => {
          valQ = e.target.value.trim().toLowerCase();
          const list = sh.body.querySelector("#pgdValList");
          if (list) list.innerHTML = valListHtml();
        });
        // Delegated toggle, so filtered re-renders of the list need no rebinding.
        sh.body.querySelector("#pgdValList")?.addEventListener("click", (e) => {
          const b = e.target.closest("[data-val]");
          if (!b) return;
          const v = b.dataset.val;
          sel.has(v) ? sel.delete(v) : sel.add(v);
          const on = sel.has(v);
          b.classList.toggle("on", on);
          const box = b.querySelector(".fs-check-box");
          box.classList.toggle("on", on); box.textContent = on ? "✓" : "";
        });
        sh.body.querySelector("[data-add]").onclick = () => {
          if (!Number.isFinite(Number(price)) || price === "" || Number(price) < 0) { toast("Enter the exception's price."); return; }
          if (mode === "values" && !sel.size) { toast("Pick at least one value."); return; }
          if (mode === "band" && !Number.isFinite(Number(threshold))) { toast("Enter the threshold number."); return; }
          exceptions.push(mode === "values"
            ? { key: d.key, label: d.label, mode, values: new Set(sel), price: Number(price) }
            : { key: d.key, label: d.label, mode, dir, threshold, price: Number(price) });
          sh.close();
          render();
        };
      };
      draw();
    };

    showDiffs();
  }

  // ---- apply (one undoable write) ------------------------------------------
  let applying = false; // in-flight guard: a double-tap must not write twice (R7)
  async function apply() {
    if (applying) return;
    applying = true;
    try {
    const writes = new Map(); // price -> ids[]
    const prior = [];
    for (const it of pile) {
      const p = finalPriceOf(it);
      if (p == null || it.price === p) continue;
      if (!writes.has(p)) writes.set(p, []);
      writes.get(p).push(it.id);
      prior.push({ id: it.id, value: it.price ?? null });
    }

    // Cost targets: every item with an effective retail under this sentence, when
    // cost-setting is on — so a pricing pass also clears the cost approval-blocker.
    const costTargets = costOn()
      ? pile.map((it) => ({ id: it.id, cost: costOf(finalPriceOf(it)) })).filter((x) => x.cost != null)
      : [];

    if (!prior.length && !costTargets.length) { toast("Nothing to write."); return; }

    // --- retail ---
    for (const [value, ids] of writes) {
      const { error: wErr } = await supabase.from("items").update({ price: value }).in("id", ids);
      if (wErr) { toast("Couldn't set prices: " + wErr.message); return; }
    }
    const priceById = new Map([...writes.entries()].flatMap(([v, ids]) => ids.map((id) => [id, v])));

    // --- cost (admin-gated item_costs upsert), snapshotting prior cost for Undo ---
    let priorCostById = new Map();
    let costApplied = false;
    if (costTargets.length) {
      const ids = costTargets.map((x) => x.id);
      // R5: without a reliable prior-cost snapshot, an Undo could WIPE real cost
      // data — so if the snapshot read fails we don't write cost at all (retail
      // is already applied). Undo then has nothing cost-related to get wrong.
      const { data, error: snapErr } = await supabase.from("item_costs").select("item_id, cost_price").in("item_id", ids);
      if (snapErr) {
        toast("Prices set; cost skipped (couldn't read current cost — retry).");
      } else {
        priorCostById = new Map((data || []).map((r) => [r.item_id, r.cost_price ?? null]));
        for (const id of ids) if (!priorCostById.has(id)) priorCostById.set(id, null);
        const { error: cErr } = await supabase.from("item_costs")
          .upsert(costTargets.map((x) => ({ item_id: x.id, cost_price: x.cost })), { onConflict: "item_id" });
        if (cErr) toast("Prices set, but cost failed: " + cErr.message);
        else costApplied = true;
      }
    }

    if (prior.length) {
      await logManyItemActivities(
        prior.map((p) => p.id), "pricing", "pricing",
        new Map(prior.map((p) => [p.id, [{ field_path: "price", before: p.value, after: priceById.get(p.id) }]])),
        "Applied guided pricing"
      );
    }
    if (costApplied) {
      await logManyItemActivities(
        costTargets.map((x) => x.id), "pricing", "pricing",
        // Value-less by design — the logger redacts cost_price regardless.
        new Map(costTargets.map((x) => [x.id, [{ field_path: "cost_price", before: null, after: null }]])),
        "Set cost via guided pricing"
      );
    }
    for (const it of pile) if (priceById.has(it.id)) it.price = priceById.get(it.id);
    navigator.vibrate?.([12, 40, 12]);

    const costCount = costApplied ? costTargets.length : 0;
    const pricedMsg = prior.length
      ? `Priced ${prior.length} item${prior.length === 1 ? "" : "s"}${costCount ? ` · cost on ${costCount}` : ""}`
      : `Cost set on ${costCount} item${costCount === 1 ? "" : "s"}`;
    toast(pricedMsg, {
      label: "Undo",
      onClick: async () => {
        const byVal = new Map();
        for (const p of prior) { if (!byVal.has(p.value)) byVal.set(p.value, []); byVal.get(p.value).push(p.id); }
        for (const [v, pids] of byVal) {
          const { error: uErr } = await supabase.from("items").update({ price: v }).in("id", pids);
          if (uErr) { toast("Undo failed: " + uErr.message); return; }
        }
        if (priorCostById.size) {
          const rows = [...priorCostById.entries()].map(([item_id, cost_price]) => ({ item_id, cost_price }));
          const { error: cuErr } = await supabase.from("item_costs").upsert(rows, { onConflict: "item_id" });
          if (cuErr) { toast("Undo (cost) failed: " + cuErr.message); return; }
        }
        const priorById = new Map(prior.map((p) => [p.id, p.value]));
        for (const it of items) if (priorById.has(it.id)) it.price = priorById.get(it.id);
        await logManyItemActivities(
          [...new Set([...prior.map((p) => p.id), ...costTargets.map((x) => x.id)])],
          "undo", "undo", new Map(), "Undid guided pricing"
        );
        toast("Pricing change undone");
      },
    });

    // Selection mode is a one-shot on the picked items; category mode resets for
    // the next sentence (scenarios usually come in runs).
    if (selectionMode) { close(); return; }
    step = 1; drillId = null; pickedId = null; pile = [];
    basePrice = ""; keepPriced = false; exceptions.length = 0; costEnabled = false;
    render();
    } finally {
      applying = false;
    }
  }

  render();
}
