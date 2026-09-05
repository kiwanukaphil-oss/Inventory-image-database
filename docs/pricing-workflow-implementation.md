# Reviewed pricing workspace

Implemented locally on 5 September 2026 following approval of the pricing proposal. Deployment and commits remain a separate review step.

## Staff workflow

1. Open **Quick actions → Price items**, or price the current filtered/selected catalog items.
2. Choose merchandise using category, brand, product attributes, and size. Values within a condition are alternatives; separate conditions must all match. A size filter selects only matching sellable sizes.
3. Choose **Fill missing prices** or **Revise prices**, then enter a shared unit price. Revising preserves individual size prices by default. Costs have their own independent controls.
4. Add product or size exceptions, or use **Group table** to enter prices by attribute combinations. Both views edit the same draft. Conflicting rules require a deliberate choice of precedence.
5. Expand a photo to review its sizes, quantities, current prices, proposed prices, and individual edits. One photo is never mistaken for one unit.
6. Review exact changes, then Apply. The receipt supports safe retry and Undo, including after reopening the workspace. Publication to POS remains separate.

Retail drafts are saved per account, branch, and selection on this device. Cost inputs are never stored in browser drafts. Receipts belong to the creating account and branch. Published catalog items are excluded; their prices are managed in POS.

## Engineering contract

The catalog uses the new reviewed pricing endpoints in the adjacent `inventory-pos-system` backend. Migration 105 adds the private plan ledger. The backend stores the exact proposed result and compares item, size, stock, cost, and publication revisions before applying. Writes are atomic. Replaying the same plan does not repeat the mutation. Undo refuses to overwrite subsequent changes or publication.

Both retail and cost support leave/fill/revise. Fill protects pre-existing effective prices, including inherited values. A partial size selection cannot change the photo's shared default. Explicit individual edits replace only the relevant retail or cost override. Positive prices are validated by the existing money utility.

The workspace loads up to 2,000 photos with a visible limit; explicit selected IDs are fetched directly. The API accepts up to 100 sizes per photo and 10,000 target sizes per plan. Reviews expire after one hour. Applied receipts are durable; Undo additionally depends on the affected inventory remaining unchanged. There is no automatic ongoing repricing of future intake.

## Verification and rollout

Automated coverage includes attribute intersection/exclusion, shared photos, size-only boundaries, rule conflicts, independent costs, effective price ranges, atomic application, concurrent retries, stale edits, expiry, branch/account isolation, redaction, and Undo. See the pricing section of `C:/Projects/inventory-pos-system/REVIEW_BRIEF.md` for final results and browser verification.

For an approved release, deploy the backend with migration 105 before the catalog bundle. Existing pricing contracts remain available for compatibility. The prior Railway pricing screen is explicitly marked as a removal candidate; it has not been deleted. No production migration, inventory edit, commit, or deployment is part of this implementation phase.

For local browser review, run `node scripts/preview-catalog-pricing.js` from the backend and run this catalog with `VITE_CATALOG_API_URL=http://127.0.0.1:5107/api` on port 5188. The preview helper resets only the explicitly guarded local `_test` database and seeds disposable multi-size lots. Do not run the database test suite while that preview server is in use.
