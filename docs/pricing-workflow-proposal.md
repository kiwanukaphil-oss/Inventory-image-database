# Pricing workspace proposal

Status: workflow approved and implemented locally, 2026-09-05. See [implementation and verification](pricing-workflow-implementation.md). The companion interactive concept remains a separate illustration with invented inventory and no API calls.

## What happened

The move to Railway replaced the original pricing experience with a narrower implementation. The historical guided tool (`src/pricing_guided.js`) supports category trees, brand/attribute exceptions, numeric bands, price previews, and Undo. The historical group table (`src/pricing.js`) supports multiple grouping dimensions and include/exclude scopes. Both use the retired database client.

The Railway adapter arrived in commit `a515b70`; commit `40bb9e3` restored bulk variant pricing on September 4. The active `src/railwayPricing.js` offers a category selector, one shared retail/cost default, and size exceptions. It does not expose the original attribute filters, arbitrary groups, or rule builder. This explains the functional regression; the repository does not establish a business decision to remove those capabilities permanently.

The initial read-only inspection also covered the adjacent POS repository's ADR-069, `catalogPricingService.js`, and `CatalogPricing.js`. The approved implementation subsequently added the reviewed plan contract described below.

## Product model

The photo is evidence for a photographed stock lot. It does not determine the number of units or force all sizes to have the same price. Keep the current distinction between photographed lots and sellable variants; do not merge separate lots merely because they share a brand or look alike.

- Product attributes choose the merchandise: category and descendants, brand, material, fit, colour, and other fields supported by that category.
- Variant attributes choose the sellable sizes within that merchandise. A size filter must select lines, not accidentally price every sibling size in a matching photo.
- Retail and cost inherit from separate lot defaults; either can have a per-line exception.
- Quantity multiplies stock value, never the unit price. One XL line with ten units is one price decision.
- Branch stays visible and fixed throughout a plan. Published prices are POS-owned; catalog pricing cannot change them.

## Recommended interaction

Use one workspace named **Price items**, reached from Home's price queue, Catalog's current filters or selection, and an individual photo. Carry the originating scope into the workspace and show it explicitly. Never silently widen selection to the whole catalog.

### 1. Choose merchandise

Start with the current branch and a compact scope bar. Category, brand, material, and fit filters show available values and counts from actual inventory. More filters reveals additional category-specific fields. Multiple values within one filter mean OR; different filters mean AND. Include/exclude and missing-value options make the scope precise. Unknown brands remain explicitly unclassified rather than being guessed.

Offer **Fill missing prices** and **Revise prices** as distinct intents. A fully priced item must remain reachable in Revise mode. Show matched photos, sellable variants, and physical units, plus published exclusions and missing selected IDs. The current 2,000-item ceiling must be visible; never label a partial fetch as the whole branch. Resolve explicitly selected IDs directly rather than hoping they occur in the first 2,000 rows.

### 2. Set prices and exceptions

The normal view is a readable rule: **Formal shirts / all brands: 90,000 each**. Add an exception such as **Material is linen: 120,000**, then a nested size exception **2XL–3XL: 130,000**. Pick actual normalized sizes; numeric waist bands and clothing size bands are different controls.

Each exception shows its match count. A narrower exception can explicitly override its parent. Overlapping sibling exceptions require an explicit priority choice or scope refinement before applying; never let incidental row order silently decide the selling price. A directly edited variant has the highest explicit priority. Preview labels explain the winning rule.

**Group table** is a second view of the same draft, useful for pricing many brands differently. Group by Category + Brand, Material, or chosen fields; edit one price per row, expand sizes underneath. Switching views preserves the same resolved plan. Do not create two independent pricing engines.

Rows represent one photo/lot and expand into size, quantity, current price, proposed price, and reason. All-equal rows show one price. Mixed-price rows show an effective range and how many sizes differ. Fully override-priced items with no default are still correctly shown as priced. Include an explicit **Use shared price** action to remove a size override; blank entry means no change, never deletion or zero.

### 3. Handle existing prices and costs independently

Fill missing mode protects each line's PRE-PLAN effective selling price, including inherited prices. It does not merely protect non-null database columns. New size exceptions can fill unpriced lines, but cannot change already-priced lines in this mode.

Revise mode offers an explicit policy for existing size exceptions: **Keep individual size prices** (recommended initial default) or **Replace prices on all matched sizes**. Every changed line remains visible in review. If only selected sizes are being revised, preserve defaults and nonmatching siblings.

Costs live in a collapsed, permission-gated section. Provide **Leave costs unchanged**, **Fill missing costs**, and **Revise costs** independently of retail intent. Costs are per unit and can vary by lot and size. Missing cost can block publication without blocking a retail-only save. Never force a cost entry just because the operator can view costs.

For authorized users, optional margin-based retail calculation uses verified recorded cost. Do not infer purchase cost from retail. Missing cost means margin unavailable, not zero. Match the configured currency's precision and round server-side consistently. Markup and gross margin are distinct calculations and must be labeled separately if both are added.

### 4. Review and apply

Review exact before/after effective prices per line, with separate totals for changed, protected, unchanged, and excluded variants. Quantities provide context. Explain incomplete stock breakdowns, unpriced remaining sizes, conflicting rules, and below-cost prices where cost access permits. Show projected stock retail value only if quantities and full price coverage are known; do not label it expected revenue or profit.

The button reads **Apply prices to N variants**. A successful pricing save returns a receipt and updated readiness, with **Continue review** or **Approve & import to POS** only when authorized and ready. Pricing alone never publishes stock.

Undo is a durable, permission-checked reversal of the specific committed values, allowed only where those values have not since changed or been published. Do not fake batch Undo with browser memory or promise it from the current incomplete event history.

## Technical gaps to fix with the implementation

1. Existing backend `PATCH /catalog/pricing/bulk` accepts one base price plus variant attribute rules for a fixed ID list. It can support restored merchandise filtering for a single shared plan. It cannot express a multi-brand group table with different defaults in one atomic request. Do not simulate an atomic operation with sequential group writes.
2. Add one server-resolved plan contract for heterogeneous item and line edits, with authoritative preview, explicit branch, exact IDs, actor, protected-cost handling, and an expected revision/fingerprint. Apply the reviewed result only if relevant prices, stock, attributes, publication state, and branch have not changed. Serialize concurrent cost/stock writes through the same locking convention.
3. Current protection checks `price_override IS NULL`. An already-priced inherited XL line can receive a new override in fill mode. Protection must use effective values from before the plan. Current overlapping rules also have different practical precedence in fill mode versus overwrite mode; use a deterministic resolved plan instead.
4. The current review summarizes defaults and size rules rather than actual line changes. The returned `updated_variant_count` counts rule updates, potentially double-counting a line, and excludes default-driven changes. Derive distinct effective-change counts from the resolved result.
5. Current pricing events store default changes but insufficient before/after line values for faithful Undo. Add batch identity and protected before/after snapshots. Keep cost values out of ordinary logs, exports, client drafts, and responses for unauthorized users.
6. Current UI forces a base retail price for incomplete coverage even when size-only prices could cover the selection. Overwrite can also force retail and cost together. Validate sparse, independent edits; save incomplete work while retaining publication blockers.
7. Current gallery cards show `item.price`, which can conceal size differences or show missing price despite complete override coverage. Derive price/range and coverage from effective positive-quantity lines across Catalog, detail, Review, filters, and sorting.
8. Store a recoverable draft scoped to account and branch, without unauthorized cost persistence. Revalidate on reopen. Handle double taps and uncertain network responses through an idempotent apply identifier and an authoritative receipt.

## Mobile and desktop

Preserve the existing K-Line typography, teal accent, and light/dark theme support. On desktop, use a compact rule column alongside the preview. On mobile, stack scope, pricing, and preview with a sticky action footer in the actual app. Collapse advanced filters, size exceptions, and costs until needed. Group table rows become expandable group cards rather than a wide spreadsheet. Keep touch controls at least 44px and restore focus when closing sheets.

## Decisions for review

- Recommended: guided rules as the initial view, with Group table for rapid brand-by-brand pricing. Alternative: Group table first for a business that primarily maintains many brand price lists. Both share the same plan and safeguards.
- Recommended initial scope: reviewed one-time plans; optionally save reusable templates that must be previewed on new stock. Alternative: continuously active rules that automatically price future stock, requiring explicit lifecycle, priority, activation, and audit behavior. The historical code implements one-time plans; it does not prove that always-on pricing was intended.

## Acceptance scenarios for implementation

- Filter formal shirts by brand and material; verify every nonmatching product remains unchanged.
- One photo with S/M/L/XL and quantities 1/2/1/10: shared price and XL exception produce four price decisions over fourteen units.
- Filter XL only: S/M/L retain their prior effective values and inheritance.
- Fill missing preserves both explicit and inherited existing prices; an incomplete item still exposes its unpriced sizes.
- Cost-only and retail-only changes work independently with correct permissions.
- Conflicting brand/material rules cannot silently choose a winner; size aliases use canonical values.
- Group and guided views yield identical prices and counts.
- Full variant override coverage without a default is ready and displays a range correctly.
- A branch switch, concurrent price/stock edit, newly published item, or vanished line invalidates a stale preview without a partial save.
- Retry cannot duplicate a pricing batch; Undo does not erase later edits or modify published prices.
- Selections outside the bounded first page set are resolved or clearly reported, never silently omitted.
- Desktop and 360px mobile review expose scope, price reasons, errors, and the final action accessibly.

## Phase boundary

This phase delivers source-backed findings and a working interaction concept. After confirmation, implement the agreed workflow across the catalog and necessary POS API contract, validate pricing invariants and database transactions, and provide a local review. Do not commit or deploy without confirmation.

## Concept verification

Verified in Chrome: default sample shows 5 changed and 4 protected variants; revise mode retains the individual override and shows 8 changed / 1 protected; combined Essential + Linen filters narrow to 1 photo, 3 variants, and 4 units. Editing the group price to 140,000 survives switching views, produces a 150,000 2XL price, and preserves the 125,000 individual XL price. Review and the explicitly labeled demo apply complete without network writes. Invalid text and keyboard-cleared price inputs disable review. Inspected light layouts at 360px and 1,024px and dark layout at 736px; no script errors were recorded during the interaction checks. This validates the concept only, not production pricing or backend contracts.
