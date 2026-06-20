import { supabase } from "./db.js";
import { AI_BLIND_FIELDS, loadRefData, normalizeAttributeValue, resolveFields } from "./data.js";
import { missingCoreFields } from "./readiness.js";
import { esc, openBottomSheet } from "./ui.js";


function canonicalBrand(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function displayName(it) {
  return it.brand || it.name || it.sku || it.id.slice(0, 8);
}

function normalizedKey(v) {
  return String(v || "").trim().toLowerCase();
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : String(v ?? "");
}

export async function openConsistencyAudit(_caps, openReviewQueue) {
  const sh = openBottomSheet("Catalog health check", `<div class="muted" style="padding:14px">Checking catalog...</div>`);
  await loadRefData();

  const { data, error } = await supabase
    .from("items")
    .select("id, sku, brand, name, category_id, attributes, confidence, price, status")
    .order("created_at", { ascending: false })
    .limit(1500);
  if (error) {
    sh.body.innerHTML = `<div class="muted" style="padding:14px">Couldn't run audit: ${esc(error.message)}</div>`;
    return;
  }

  const items = data || [];
  const brandGroups = new Map();
  const sizeIssues = [];
  const aiDoubts = [];
  const missingDetails = [];
  const skuGroups = new Map();
  const priceGroups = new Map();

  for (const it of items) {
    const brandKey = canonicalBrand(it.brand);
    if (brandKey) {
      if (!brandGroups.has(brandKey)) brandGroups.set(brandKey, new Map());
      const variants = brandGroups.get(brandKey);
      variants.set(it.brand, (variants.get(it.brand) || 0) + 1);
    }

    const attrs = it.attributes || {};
    for (const f of resolveFields(it.category_id)) {
      if (!["size", "waist", "waist_size", "size_eu"].includes(f.key)) continue;
      const raw = attrs[f.key];
      if (raw === null || raw === undefined || raw === "") continue;
      const normalized = normalizeAttributeValue(it.category_id, f.key, raw);
      if (String(normalized) !== String(raw)) {
        sizeIssues.push({ item: it, field: f.label || f.key, raw, normalized });
      }
    }

    for (const [key, level] of Object.entries(it.confidence || {})) {
      if ((level === "Low" || level === "Medium") && !AI_BLIND_FIELDS.has(key)) {
        aiDoubts.push({ item: it, key, level });
      }
    }

    const missing = missingCoreFields(it).filter((m) => m !== "photo");
    if (missing.length) missingDetails.push({ item: it, missing });

    const skuKey = normalizedKey(it.sku);
    if (skuKey) {
      if (!skuGroups.has(skuKey)) skuGroups.set(skuKey, []);
      skuGroups.get(skuKey).push(it);
    }

    const price = Number(it.price);
    const priceKey = [it.category_id || "", canonicalBrand(it.brand || it.name)].join("|");
    if (Number.isFinite(price) && price > 0 && priceKey !== "|") {
      if (!priceGroups.has(priceKey)) priceGroups.set(priceKey, []);
      priceGroups.get(priceKey).push({ item: it, price });
    }
  }

  const brandIssues = [...brandGroups.entries()]
    .map(([key, variants]) => ({ key, variants: [...variants.entries()] }))
    .filter((g) => g.variants.length > 1)
    .sort((a, b) => b.variants.reduce((s, [, n]) => s + n, 0) - a.variants.reduce((s, [, n]) => s + n, 0));
  const duplicateSkus = [...skuGroups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  const priceOutliers = [];
  for (const [, rows] of priceGroups) {
    if (rows.length < 5) continue;
    const med = median(rows.map((r) => r.price));
    if (!med) continue;
    for (const row of rows) {
      if (row.price < med * 0.4 || row.price > med * 2.5) {
        priceOutliers.push({ ...row, median: med });
      }
    }
  }
  priceOutliers.sort((a, b) => Math.abs(b.price / b.median - 1) - Math.abs(a.price / a.median - 1));

  const row = (label, count, note, action = "") => `
    <div class="audit-row">
      <div><b>${esc(label)}</b><span>${esc(note)}</span></div>
      <strong>${count}</strong>
      ${action}
    </div>`;

  const brandDetail = brandIssues.slice(0, 4).map((g) =>
    `<div class="audit-detail"><b>${esc(g.variants.map(([v]) => v).join(" / "))}</b>
      <span>${g.variants.map(([v, n]) => `${esc(v)} (${n})`).join(", ")}</span></div>`
  ).join("");
  const sizeDetail = sizeIssues.slice(0, 6).map((x) =>
    `<div class="audit-detail"><b>${esc(displayName(x.item))}</b>
      <span>${esc(x.field)}: ${esc(x.raw)} -> ${esc(x.normalized)}</span></div>`
  ).join("");
  const missingDetail = missingDetails.slice(0, 6).map((x) =>
    `<div class="audit-detail"><b>${esc(displayName(x.item))}</b>
      <span>Missing ${esc(x.missing.join(", "))}</span></div>`
  ).join("");
  const skuDetail = duplicateSkus.slice(0, 5).map(([sku, rows]) =>
    `<div class="audit-detail"><b>${esc(sku.toUpperCase())}</b>
      <span>${rows.slice(0, 4).map(displayName).map(esc).join(", ")}${rows.length > 4 ? `, +${rows.length - 4} more` : ""}</span></div>`
  ).join("");
  const priceDetail = priceOutliers.slice(0, 6).map((x) =>
    `<div class="audit-detail"><b>${esc(displayName(x.item))}</b>
      <span>${fmtNumber(x.price)} vs group median ${fmtNumber(x.median)}</span></div>`
  ).join("");
  const clean = !brandIssues.length && !sizeIssues.length && !aiDoubts.length &&
    !missingDetails.length && !duplicateSkus.length && !priceOutliers.length;

  sh.body.innerHTML = `
    <div class="audit-intro">Read-only checks for brand variants, size normalization, missing details, AI checks, duplicate SKUs, and price outliers.</div>
    <div class="audit-summary">
      ${row("Brand variants", brandIssues.length, "Same brand written in different ways.")}
      ${row("Size normalization", sizeIssues.length, "Values that would normalize on the next save.")}
      ${row("Missing details", missingDetails.length, "Items missing identity or required category fields.",
        missingDetails.length ? `<button class="ghost audit-open" data-review="missing">Open</button>` : "")}
      ${row("AI checks", aiDoubts.length, "Low or medium confidence fields still need a human glance.",
        aiDoubts.length ? `<button class="ghost audit-open" data-review="doubt">Open</button>` : "")}
      ${row("Duplicate SKUs", duplicateSkus.length, "Same SKU appears on more than one item.")}
      ${row("Price outliers", priceOutliers.length, "Prices far away from similar items.")}
    </div>
    ${clean ? `<div class="audit-clean">No major consistency issues found in the latest ${items.length.toLocaleString()} items.</div>` : ""}
    ${brandDetail ? `<div class="sheet-sec">Brand variants</div>${brandDetail}` : ""}
    ${sizeDetail ? `<div class="sheet-sec">Size examples</div>${sizeDetail}` : ""}
    ${missingDetail ? `<div class="sheet-sec">Missing detail examples</div>${missingDetail}` : ""}
    ${skuDetail ? `<div class="sheet-sec">Duplicate SKU examples</div>${skuDetail}` : ""}
    ${priceDetail ? `<div class="sheet-sec">Price outlier examples</div>${priceDetail}` : ""}
    <div class="menu-sub" style="margin-top:10px">This audit is read-only. Use Review to fix affected items and Save to apply normalization.</div>`;

  sh.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-review]");
    if (!btn) return;
    sh.close();
    openReviewQueue?.(btn.dataset.review);
  });
}
