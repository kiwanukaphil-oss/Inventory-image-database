/**
 * Railway Catalog Pricing
 *
 * Responsible for: a guided one-item-at-a-time default/per-variant pricing
 *                  workflow backed only by authenticated Railway endpoints.
 * NOT responsible for: legacy Supabase pricing or POS price changes.
 */

import { requestRailwayCatalog } from "./railwayCatalogApi.js";
import { fetchBoundedRailwayCatalog } from "./lib/railway-catalog-pagination.js";
import { catalogStockDistributionSummary } from "./lib/stock-distribution.js";
import { formatPriceInput, parsePrice, stripPriceGrouping } from "./lib/price.js";
import { esc, toast, trapFocus, bindPriceInput, ICON } from "./ui.js";

const PRICING_QUEUE_LIMIT = 2000;

const nullableMoneyFromInput = (input, label) => {
  const raw = stripPriceGrouping(input?.value || "").trim();
  if (!raw) return null;
  const value = parsePrice(raw);
  if (value === null) throw new Error(`Enter a valid ${label}.`);
  return value;
};

const variantLabel = (line) => {
  const entries = Object.entries(line.variant_attributes || {});
  return entries.length
    ? entries.map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`).join(" · ")
    : "Single variant";
};

/**
 * Open a restart-safe Railway price queue. Each save is one atomic item patch;
 * the user can leave and resume because committed values are server-owned.
 */
export async function openRailwayPricing(caps, onClose, opts = {}) {
  const overlay = document.createElement("div");
  overlay.className = "calib pricing railway-pricing";
  overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
    <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
    <span>Price catalog variants</span><span></span></div>
    <div class="calib-body"><div class="spinner" style="margin:48px auto"></div></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));
  const releaseFocus = trapFocus(overlay);
  const changedItemIds = new Set();

  const close = () => {
    releaseFocus();
    overlay.classList.remove("open");
    setTimeout(() => {
      overlay.remove();
      if (changedItemIds.size) onClose?.([...changedItemIds]);
    }, 180);
  };
  overlay.querySelector("[data-close]").onclick = close;

  let catalog;
  try {
    catalog = await fetchBoundedRailwayCatalog({
      requestPage: (page, limit) => requestRailwayCatalog(
        `/catalog/items?page=${page}&limit=${limit}`
      ),
      pageSize: 200,
      itemLimit: PRICING_QUEUE_LIMIT,
    });
  } catch (error) {
    overlay.querySelector(".calib-body").innerHTML = `<div class="empty">
      <div class="big">⚠️</div><div>Couldn't load the Railway pricing queue.</div>
      <div class="muted">${esc(error?.message || error)}</div></div>`;
    return;
  }

  const requestedIds = Array.isArray(opts.itemIds) ? new Set(opts.itemIds) : null;
  const queue = (catalog.data || [])
    .filter((item) => !item.is_published && item.pos_sync_status !== "synced")
    .filter((item) => !requestedIds || requestedIds.has(item.id))
    .sort((left, right) => Number(left.pricing_ready) - Number(right.pricing_ready));
  if (!queue.length) {
    overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
      <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
      <span>Price catalog variants</span><span></span></div>
      <div class="calib-body"><div class="empty"><div class="big">✓</div>
      <div>Nothing in this queue needs catalog pricing.</div></div></div></div>`;
    overlay.querySelector("[data-close]").onclick = close;
    return;
  }

  let queueIndex = 0;
  const pricingCache = new Map();
  let saving = false;

  const loadPricing = async (item) => {
    if (!pricingCache.has(item.id)) {
      pricingCache.set(item.id, requestRailwayCatalog(`/catalog/items/${item.id}/pricing`)
        .then((payload) => payload.data));
    }
    return pricingCache.get(item.id);
  };

  /** Render the current evidence item with inherited defaults and line overrides. */
  const renderCurrentItem = async () => {
    const item = queue[queueIndex];
    overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
      <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
      <span>Price catalog variants</span><span>${queueIndex + 1} / ${queue.length}</span></div>
      <div class="calib-body"><div class="spinner" style="margin:48px auto"></div></div></div>`;
    overlay.querySelector("[data-close]").onclick = close;

    let pricing;
    try {
      pricing = await loadPricing(item);
    } catch (error) {
      overlay.querySelector(".calib-body").innerHTML = `<div class="empty">
        <div>Couldn't load this item's pricing.</div><div class="muted">${esc(error?.message || error)}</div>
        <button class="ghost" data-retry>Try again</button></div>`;
      overlay.querySelector("[data-retry]").onclick = () => {
        pricingCache.delete(item.id);
        renderCurrentItem();
      };
      return;
    }

    const unitTotal = pricing.variant_lines.reduce(
      (total, line) => total + Number(line.quantity || 0),
      0
    );
    const lineRows = pricing.variant_lines.map((line) => `
      <div class="rail-price-line" data-line-id="${esc(line.id)}">
        <div class="rail-price-line-title"><b>${esc(variantLabel(line))}</b><span>${line.quantity} unit${Number(line.quantity) === 1 ? "" : "s"}</span></div>
        <label>Retail override
          <input type="text" inputmode="decimal" data-price-override data-price-input
            placeholder="Inherit default" value="${line.price_override == null ? "" : esc(formatPriceInput(line.price_override))}">
        </label>
        ${caps.can_view_cost ? `<label>Cost override
          <input type="text" inputmode="decimal" data-cost-override data-price-input
            placeholder="Inherit default" value="${line.cost_override == null ? "" : esc(formatPriceInput(line.cost_override))}">
        </label>` : ""}
      </div>`).join("");

    overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
      <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
      <span>Price catalog variants</span><span>${queueIndex + 1} / ${queue.length}</span></div>
      <div class="calib-body railway-price-body">
        <div class="rail-price-evidence">
          ${item.image_url ? `<img src="${esc(item.image_url)}" alt="">` : ""}
          <div><b>${esc(pricing.name || pricing.brand || "Unnamed item")}</b>
            <span>1 photo · ${pricing.variant_lines.length} variant${pricing.variant_lines.length === 1 ? "" : "s"} · ${unitTotal} unit${unitTotal === 1 ? "" : "s"}</span>
            <small>${esc(catalogStockDistributionSummary(pricing.variant_lines))}</small></div>
        </div>
        <section class="rail-price-defaults">
          <h3>Default prices</h3>
          <p>Every size inherits these unless its row has an override.</p>
          <label>Default retail price
            <input type="text" inputmode="decimal" data-base-price data-price-input
              placeholder="Required unless every line overrides" value="${pricing.base_price == null ? "" : esc(formatPriceInput(pricing.base_price))}">
          </label>
          ${caps.can_view_cost ? `<label>Default cost price
            <input type="text" inputmode="decimal" data-base-cost data-price-input
              placeholder="Required unless every line overrides" value="${pricing.base_cost_price == null ? "" : esc(formatPriceInput(pricing.base_cost_price))}">
          </label>` : ""}
        </section>
        <section class="rail-price-lines"><h3>Size / variant differences</h3>${lineRows}</section>
      </div>
      <div class="calib-foot rail-price-foot">
        <button class="ghost" data-prev${queueIndex === 0 ? " disabled" : ""}>‹ Previous</button>
        <button class="primary" data-save>${queueIndex + 1 < queue.length ? "Save & next" : "Save & finish"}</button>
      </div></div>`;
    overlay.querySelectorAll("[data-price-input]").forEach((input) => bindPriceInput(input));
    overlay.querySelector("[data-close]").onclick = close;
    overlay.querySelector("[data-prev]").onclick = () => {
      if (queueIndex > 0) {
        queueIndex -= 1;
        renderCurrentItem();
      }
    };
    // Save the entire item-level inheritance graph in one request, then advance
    // only after the server has returned the canonical persisted projection.
    overlay.querySelector("[data-save]").onclick = async () => {
      if (saving) return;
      saving = true;
      const saveButton = overlay.querySelector("[data-save]");
      saveButton.disabled = true;
      try {
        const payload = {
          base_price: nullableMoneyFromInput(
            overlay.querySelector("[data-base-price]"),
            "default retail price"
          ),
          lines: [...overlay.querySelectorAll("[data-line-id]")].map((row) => ({
            id: row.dataset.lineId,
            price_override: nullableMoneyFromInput(
              row.querySelector("[data-price-override]"),
              "variant retail price"
            ),
            ...(caps.can_view_cost && {
              cost_override: nullableMoneyFromInput(
                row.querySelector("[data-cost-override]"),
                "variant cost price"
              ),
            }),
          })),
          ...(caps.can_view_cost && {
            base_cost_price: nullableMoneyFromInput(
              overlay.querySelector("[data-base-cost]"),
              "default cost price"
            ),
          }),
        };
        const response = await requestRailwayCatalog(
          `/catalog/items/${item.id}/pricing`,
          { method: "PATCH", body: payload }
        );
        pricingCache.set(item.id, Promise.resolve(response.data));
        changedItemIds.add(item.id);
        toast(`Saved ${response.data.variant_lines.length} variant price${response.data.variant_lines.length === 1 ? "" : "s"}`);
        if (queueIndex + 1 < queue.length) {
          queueIndex += 1;
          await renderCurrentItem();
        } else {
          close();
        }
      } catch (error) {
        toast(error?.message || String(error));
        saveButton.disabled = false;
      } finally {
        saving = false;
      }
    };
  };

  await renderCurrentItem();
}
