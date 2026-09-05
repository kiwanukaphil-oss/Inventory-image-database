/**
 * Railway Catalog Bulk Pricing
 *
 * Responsible for: Building and applying one branch-scoped default pricing plan
 *                  with optional per-size retail and cost exceptions.
 * NOT responsible for: retired-provider pricing or published POS price changes.
 */

import { requestRailwayCatalog } from "./railwayCatalogApi.js";
import { fetchBoundedRailwayCatalog } from "./lib/railway-catalog-pagination.js";
import {
  selectCatalogPricingItems,
  summarizeCatalogPricingItems,
  summarizeCatalogVariantValues,
} from "./lib/catalog-pricing-plan.js";
import { formatPriceInput, parsePrice, stripPriceGrouping } from "./lib/price.js";
import { esc, toast, trapFocus, bindPriceInput, ICON } from "./ui.js";

const PRICING_QUEUE_LIMIT = 2000;

const positiveMoneyFromInput = (input, label) => {
  const raw = stripPriceGrouping(input?.value || "").trim();
  const value = parsePrice(raw);
  if (value === null || value <= 0) throw new Error(`Enter a ${label} greater than zero.`);
  return value;
};

const optionalPositiveMoneyFromInput = (input, label) => {
  const raw = stripPriceGrouping(input?.value || "").trim();
  if (!raw) return null;
  return positiveMoneyFromInput(input, label);
};

const optionHtml = (value, label, selected) =>
  `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;

/** Group available pricing work by category without widening the write scope. */
function categoryPricingScopes(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.category_id || "__uncategorized";
    const group = groups.get(key) || {
      id: key,
      label: item.categories?.name || "Uncategorized",
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Open a restart-safe bulk planner. The browser previews a finite list of item
 * IDs, while Railway validates and commits the complete plan atomically.
 */
export async function openRailwayPricing(caps, onClose, opts = {}) {
  const overlay = document.createElement("div");
  overlay.className = "calib pricing railway-pricing";
  overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
    <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
    <span>Bulk price catalog</span><span></span></div>
    <div class="calib-body"><div class="spinner" style="margin:48px auto"></div></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));
  const releaseFocus = trapFocus(overlay);
  let didChangePrices = false;

  const close = () => {
    releaseFocus();
    overlay.classList.remove("open");
    setTimeout(() => {
      overlay.remove();
      if (didChangePrices) onClose?.();
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
      <div class="big">!</div><div>Couldn't load the Railway pricing queue.</div>
      <div class="muted">${esc(error?.message || error)}</div></div>`;
    return;
  }

  const requestedIds = Array.isArray(opts.itemIds) && opts.itemIds.length
    ? opts.itemIds
    : null;
  const queue = selectCatalogPricingItems(catalog.data || [], {
    itemIds: requestedIds,
    includeCosts: !!caps.can_view_cost,
  });
  if (!queue.length) {
    overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
      <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
      <span>Bulk price catalog</span><span></span></div>
      <div class="calib-body"><div class="empty"><div class="big">&#10003;</div>
      <div>${requestedIds
        ? "The selected items are already published or unavailable in this branch."
        : "Every unpublished item in this branch has complete catalog pricing."}</div>
      </div></div></div>`;
    overlay.querySelector("[data-close]").onclick = close;
    return;
  }

  const scopes = categoryPricingScopes(queue);
  let selectedScopeId = "all";
  const priceDraft = {
    basePrice: "",
    baseCostPrice: "",
    sizeOverrides: new Map(),
    overwriteExisting: false,
  };

  const selectedItems = () => selectedScopeId === "all"
    ? queue
    : (scopes.find((scope) => scope.id === selectedScopeId)?.items || []);

  /** Preserve entered values whenever a category switch redraws the plan. */
  const capturePricingDraft = () => {
    const basePriceInput = overlay.querySelector("[data-base-price]");
    const baseCostInput = overlay.querySelector("[data-base-cost]");
    if (basePriceInput) priceDraft.basePrice = basePriceInput.value;
    if (baseCostInput) priceDraft.baseCostPrice = baseCostInput.value;
    priceDraft.overwriteExisting = overlay.querySelector("[data-overwrite-existing]")?.checked
      ?? priceDraft.overwriteExisting;
    overlay.querySelectorAll("[data-size-value]").forEach((row) => {
      priceDraft.sizeOverrides.set(row.dataset.sizeValue, {
        retail: row.querySelector("[data-size-retail]")?.value || "",
        cost: row.querySelector("[data-size-cost]")?.value || "",
      });
    });
  };

  /** Render the one-screen bulk plan, including optional size exceptions. */
  const renderPricingPlan = () => {
    const items = selectedItems();
    const summary = summarizeCatalogPricingItems(items);
    const sizeSummaries = summarizeCatalogVariantValues(items);
    const requiresRetailPrice = items.some((item) => item.pricing_ready !== true);
    const requiresCostPrice = !!caps.can_view_cost && items.some((item) => item.cost_ready !== true);
    const scopePicker = requestedIds
      ? `<div class="rail-price-scope-fixed">Selected catalog items</div>`
      : `<label>Items to price
          <select data-pricing-scope>
            ${optionHtml("all", `All incomplete items (${queue.length})`, selectedScopeId === "all")}
            ${scopes.map((scope) => optionHtml(
              scope.id,
              `${scope.label} (${scope.items.length})`,
              selectedScopeId === scope.id
            )).join("")}
          </select>
        </label>`;
    const sizeRows = sizeSummaries.length
      ? sizeSummaries.map((sizeSummary) => {
        const saved = priceDraft.sizeOverrides.get(sizeSummary.value) || {};
        return `<div class="rail-price-line" data-size-value="${esc(sizeSummary.value)}">
          <div class="rail-price-line-title"><b>${esc(sizeSummary.value)}</b>
            <span>${sizeSummary.itemCount} item${sizeSummary.itemCount === 1 ? "" : "s"} &middot; ${sizeSummary.unitCount} unit${sizeSummary.unitCount === 1 ? "" : "s"}</span></div>
          <label>Retail override
            <input type="text" inputmode="decimal" data-size-retail data-price-input
              placeholder="Use default" value="${esc(saved.retail || "")}">
          </label>
          ${caps.can_view_cost ? `<label>Cost override
            <input type="text" inputmode="decimal" data-size-cost data-price-input
              placeholder="Use default" value="${esc(saved.cost || "")}">
          </label>` : ""}
        </div>`;
      }).join("")
      : `<p class="muted">These items have one default variant each. No size exceptions are needed.</p>`;

    overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
      <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
      <span>Bulk price catalog</span><span>${summary.itemCount} items</span></div>
      <div class="calib-body railway-price-body">
        <section class="rail-price-scope">
          <h3>1. Choose the group</h3>
          ${scopePicker}
          <div class="rail-price-impact"><b>${summary.itemCount} photos</b><span>${summary.variantCount} variants</span><span>${summary.unitCount} units</span></div>
        </section>
        <section class="rail-price-defaults">
          <h3>2. Set shared prices</h3>
          <p>These prices apply to every selected item unless a size override is entered below.</p>
          <label>Default retail price
            <input type="text" inputmode="decimal" data-base-price data-price-input
              placeholder="${requiresRetailPrice ? "Required" : "Leave blank to preserve"}" value="${esc(priceDraft.basePrice)}">
          </label>
          ${caps.can_view_cost ? `<label>Default cost price
            <input type="text" inputmode="decimal" data-base-cost data-price-input
              placeholder="${requiresCostPrice ? "Required for approval" : "Leave blank to preserve"}" value="${esc(priceDraft.baseCostPrice)}">
          </label>` : ""}
          <label class="rail-price-overwrite"><input type="checkbox" data-overwrite-existing${priceDraft.overwriteExisting ? " checked" : ""}>
            Replace prices that are already set</label>
        </section>
        <section class="rail-price-lines"><h3>3. Add size differences</h3>
          <p class="muted">Leave a size blank to use the shared price.</p>${sizeRows}</section>
      </div>
      <div class="calib-foot rail-price-foot">
        <span class="muted">Nothing changes until you review and apply.</span>
        <button class="primary" data-review-prices>Review ${summary.itemCount} items</button>
      </div></div>`;
    overlay.querySelectorAll("[data-price-input]").forEach((input) => bindPriceInput(input));
    overlay.querySelector("[data-close]").onclick = close;
    const scopeSelect = overlay.querySelector("[data-pricing-scope]");
    if (scopeSelect) scopeSelect.onchange = () => {
      capturePricingDraft();
      selectedScopeId = scopeSelect.value;
      renderPricingPlan();
    };
    overlay.querySelector("[data-review-prices]").onclick = reviewPricingPlan;
  };

  /** Validate the draft and show exact impact before the bulk write is enabled. */
  const reviewPricingPlan = () => {
    try {
      capturePricingDraft();
      const items = selectedItems();
      const summary = summarizeCatalogPricingItems(items);
      const requiresRetailPrice = items.some((item) => item.pricing_ready !== true);
      const requiresCostPrice = !!caps.can_view_cost && items.some((item) => item.cost_ready !== true);
      const basePrice = requiresRetailPrice || priceDraft.overwriteExisting
        ? positiveMoneyFromInput(overlay.querySelector("[data-base-price]"), "default retail price")
        : optionalPositiveMoneyFromInput(overlay.querySelector("[data-base-price]"), "default retail price");
      const baseCostPrice = caps.can_view_cost
        ? (requiresCostPrice || priceDraft.overwriteExisting
          ? positiveMoneyFromInput(overlay.querySelector("[data-base-cost]"), "default cost price")
          : optionalPositiveMoneyFromInput(overlay.querySelector("[data-base-cost]"), "default cost price"))
        : null;
      const variantRules = [];
      for (const row of overlay.querySelectorAll("[data-size-value]")) {
        const priceOverride = optionalPositiveMoneyFromInput(
          row.querySelector("[data-size-retail]"),
          `${row.dataset.sizeValue} retail price`
        );
        const costOverride = caps.can_view_cost
          ? optionalPositiveMoneyFromInput(
            row.querySelector("[data-size-cost]"),
            `${row.dataset.sizeValue} cost price`
          )
          : null;
        if (priceOverride !== null || costOverride !== null) {
          variantRules.push({
            attribute: "size",
            values: [row.dataset.sizeValue],
            ...(priceOverride !== null && { price_override: priceOverride }),
            ...(costOverride !== null && { cost_override: costOverride }),
          });
        }
      }
      renderPricingReview({
        items,
        summary,
        basePrice,
        baseCostPrice,
        variantRules,
        overwriteExisting: priceDraft.overwriteExisting,
      });
    } catch (error) {
      toast(error?.message || String(error));
    }
  };

  /** Render the explicit confirmation step for the server-side transaction. */
  const renderPricingReview = ({
    items,
    summary,
    basePrice,
    baseCostPrice,
    variantRules,
    overwriteExisting,
  }) => {
    const overrideRows = variantRules.map((rule) => `<li><b>${esc(rule.values.join(", "))}</b>: ${rule.price_override != null
      ? `${esc(formatPriceInput(rule.price_override))} retail`
      : "shared retail"}${rule.cost_override != null
      ? `, ${esc(formatPriceInput(rule.cost_override))} cost`
      : ""}</li>`).join("");
    overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
      <button class="iconbtn" data-close aria-label="Close">${ICON.x}</button>
      <span>Review bulk pricing</span><span>${summary.itemCount} items</span></div>
      <div class="calib-body railway-price-body">
        <section class="rail-price-review-hero">
          <b>${summary.itemCount} photos</b><span>${summary.variantCount} sellable variants</span><span>${summary.unitCount} physical units</span>
        </section>
        <section class="rail-price-review-card">
          <h3>Shared prices</h3>
          <div><span>Retail</span><b>${basePrice === null ? "Preserve existing" : esc(formatPriceInput(basePrice))}</b></div>
          ${caps.can_view_cost ? `<div><span>Cost</span><b>${baseCostPrice === null ? "Preserve existing" : esc(formatPriceInput(baseCostPrice))}</b></div>` : ""}
          <p class="muted">${overwriteExisting
            ? "Existing catalog prices will be replaced."
            : "Existing catalog prices are protected; only missing values are filled."}</p>
        </section>
        <section class="rail-price-review-card">
          <h3>Size differences</h3>
          ${overrideRows ? `<ul>${overrideRows}</ul>` : `<p class="muted">Every variant will use the shared prices.</p>`}
        </section>
        <div class="rail-price-atomic-note"><b>One atomic Railway update</b><span>If any selected item changed branch or was published, the complete plan rolls back.</span></div>
      </div>
      <div class="calib-foot rail-price-foot">
        <button class="ghost" data-back-prices>Back</button>
        <button class="primary" data-apply-prices>Apply to ${summary.itemCount} items</button>
      </div></div>`;
    overlay.querySelector("[data-close]").onclick = close;
    overlay.querySelector("[data-back-prices]").onclick = renderPricingPlan;
    overlay.querySelector("[data-apply-prices]").onclick = async () => {
      const applyButton = overlay.querySelector("[data-apply-prices]");
      applyButton.disabled = true;
      try {
        const response = await requestRailwayCatalog("/catalog/pricing/bulk", {
          method: "PATCH",
          body: {
            item_ids: items.map((item) => item.id),
            ...(basePrice !== null && { base_price: basePrice }),
            ...(caps.can_view_cost && baseCostPrice !== null && { base_cost_price: baseCostPrice }),
            variant_rules: variantRules,
            overwrite_existing: overwriteExisting,
          },
        });
        didChangePrices = true;
        toast(`Priced ${response.data.item_count} items and ${response.data.variant_count} variants`);
        close();
      } catch (error) {
        toast(error?.message || String(error));
        applyButton.disabled = false;
      }
    };
  };

  renderPricingPlan();
}
