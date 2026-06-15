# K-LINE MEN Catalog V2 Roadmap

Date: 2026-06-15

Source: `UX_PRODUCT_AUDIT.md`

## V2 Release Promise

V2 turns K-LINE MEN Catalog from a capable inventory gallery into a premium mobile-first inventory operations cockpit.

The core promise:

- A manager opens the app and immediately knows what needs attention.
- Every item explains why it is blocked and what action fixes it.
- AI, pricing, review, approval, and shop sync failures are recoverable.
- Mobile workflows feel fast, focused, and polished.
- The product feels trustworthy enough to manage sellable inventory.

## V2 Product Principles

1. Work first, catalog second.
   - Gallery remains important, but Review becomes the operational center.

2. One dominant next action.
   - Each screen, queue, item, and error state should expose the safest next action.

3. Human labels over system labels.
   - Users should see "Missing price", "Needs review", "Shop issue", and "Ready" instead of raw implementation states.

4. Every failure becomes a task.
   - AI, upload, sync, and approval failures must remain visible until fixed or dismissed.

5. Mobile is the primary product.
   - Desktop can be more spacious, but no workflow should require desktop-style scanning or precision.

6. Premium means fewer decisions.
   - Smart defaults, saved context, scoped actions, and automation should reduce user thinking.

## V2 Success Metrics

These metrics define whether V2 is actually better, not just visually different.

### Operational Metrics

- Median time from upload completion to first review action.
- Percentage of uploaded items that reach "Ready" without manual search/filtering.
- Number of failed AI/sync/upload jobs with no recovery action available.
- Percentage of items approved with all required checks passing.
- Median taps to fix a no-price item.
- Median taps to retry failed AI fill.

### Quality Metrics

- Items approved with missing price: target 0.
- Items approved with blocking missing fields: target 0.
- Items approved with unresolved AI low-confidence required fields: target near 0 unless explicitly confirmed.
- Duplicate SKU warnings unresolved at approval: target near 0.

### Experience Metrics

- Review first meaningful action within 5 seconds on mobile.
- No visible mojibake/corrupted UI copy.
- All primary mobile actions have reachable tap targets.
- All empty, loading, error, and success states have a clear next action.

## V2 Scope Summary

### Must Ship In V2

- Copy, terminology, and visible polish cleanup.
- Review Inbox with prioritized queues and queue-specific actions.
- Per-item readiness/blocking checklist.
- Approval gates for editor and bulk approval.
- Persistent AI/sync/upload failure recovery.
- Mobile editor redesign with sections and sticky action.
- Upload completion handoff into Review.
- Quick pricing from Review/No price.
- Shop issue recovery path.
- More/Settings restructuring.

### Should Ship In V2

- Smart views for common work states.
- Saved view promotion.
- AI consistency audits for sizes, brands, and missing data.
- Better batch templates and last-used defaults.
- Shop health dashboard.

### Could Ship After V2

- Command palette.
- Gesture accelerators.
- Advanced analytics.
- Role-specific home screens.
- Image quality scoring.
- Duplicate-photo detection.

## Release Phases

## Phase 0: Foundation And Trust

Goal: remove launch-level trust issues and create the shared language/model V2 needs.

Expected outcome: the app feels clean, readable, and consistent before deeper workflow changes begin.

### V2-001: Copy And Encoding Cleanup

Problem:

Corrupted strings and decorative symbols can make the product feel unreliable.

Scope:

- Audit visible strings across `src/*.js`, `README.md`, and user-facing docs.
- Replace corrupted ellipses, bullets, arrows, checkmarks, locks, and separators.
- Prefer ASCII text plus existing `ICON` assets for visible UI.
- Add a small copy glossary for statuses, queues, errors, and success messages.

Acceptance criteria:

- No visible mojibake in the app.
- `rg` scan for common corrupted sequences returns no user-facing matches.
- Empty/loading/error/success messages use consistent wording.
- Status labels are human-readable in UI.

Impact: very high. Effort: low-medium. Priority: P0.

### V2-002: Friendly Status And Issue Language

Problem:

The UI exposes raw system states like `draft`, `needs-review`, and `flag`.

Scope:

- Add display-label helpers for item status, issue state, shop state, and AI state.
- Keep database values unchanged.
- Use friendly labels consistently in Gallery, Review, editor, legends, filters, and toasts.

Recommended labels:

- `draft` -> New
- `needs-review` -> Needs review
- `approved` -> Approved
- `flag` -> Problem
- `pos_dirty` -> Shop update needed
- AI doubts -> Check AI
- No price -> Missing price
- Shop errors -> Shop issue

Acceptance criteria:

- Raw DB workflow labels do not appear in primary UI.
- Legend explains user-facing labels, not implementation values.
- Filters and queues use the same labels as cards and editor.

Impact: high. Effort: low. Priority: P0.

### V2-003: Readiness Model

Problem:

Review can classify issues, but readiness is not yet exposed as a clear reusable checklist.

Scope:

- Create one shared readiness evaluator for:
  - Missing price.
  - Missing required details.
  - Needs AI fill.
  - AI low/medium confidence on important fields.
  - Flagged/problem status.
  - Shop sync issue.
  - Duplicate SKU warning if available.
- Return both machine-readable blockers and user-facing reasons/actions.
- Use this model in Review, editor, approval, and bulk actions.

Acceptance criteria:

- Review cards and editor use the same readiness result.
- Ready queue has no known blockers.
- Bulk approval and editor approval call the same gate.
- Each blocker includes a suggested action.

Impact: very high. Effort: medium. Priority: P0.

## Phase 1: Review Inbox

Goal: make Review the central management cockpit for all inventory problems and final approval.

Expected outcome: a manager can open Review, see priority work, run the right action, and approve clean items without hunting.

### V2-010: Review Inbox Header

Problem:

Review is currently a filtered gallery with queues. It needs to feel like an operational command center.

Scope:

- Add a compact Review header above the grid:
  - Total work count.
  - Critical blockers count.
  - Ready count.
  - Today/uploaded batch count if available.
- Show a recommended next action based on current queue.
- Keep header compact on mobile.

Mobile behavior:

- First viewport should show header, queue row, and at least part of first tile.
- Avoid card-like nesting. Use a simple full-width band or unframed layout.

Acceptance criteria:

- User can identify the highest-priority queue without opening filters.
- Header action changes by queue.
- Header does not push inventory tiles completely below the fold.

Impact: very high. Effort: medium. Priority: P0.

### V2-011: Prioritized Review Queues

Problem:

Too many queues can become a horizontal chip strip that users must inspect.

Scope:

- Prioritize visible queues on mobile:
  1. Errors
  2. Needs AI
  3. Missing price
  4. Check AI
  5. Missing details
  6. Shop issue
  7. Problem
  8. Ready
- Show counts.
- Put overflow queues behind "More" if the row becomes crowded.
- Preserve full queue access on desktop/wide screens.

Acceptance criteria:

- Top-priority non-empty queues are visible without horizontal hunting.
- Empty queues are visually quiet or hidden behind More.
- Ready remains discoverable.

Impact: high. Effort: medium. Priority: P0.

### V2-012: Queue-Specific Primary Actions

Problem:

Different queues need different fixes, but the UI should not make users infer the action.

Scope:

- Needs AI -> AI-fill visible items.
- Errors -> Retry failed only.
- Missing price -> Set prices for visible items.
- Check AI -> Start review of uncertain fields.
- Missing details -> Open first missing-field item.
- Shop issue -> Open shop recovery.
- Ready -> Approve visible.

Acceptance criteria:

- Each queue has exactly one prominent primary action.
- Primary action is disabled with a useful reason when unavailable.
- Actions are scoped to the visible queue/filter context.
- Completion updates the queue without losing context.

Impact: very high. Effort: medium. Priority: P0.

### V2-013: Issue-First Product Cards

Problem:

Cards currently show many useful states, but the main blocker can get lost.

Scope:

- Show one primary blocker or ready state on each card.
- Secondary blockers collapse into a count or checklist inside editor.
- Keep brand/product and image dominant.
- Add "why here" text for Review cards where useful.

Acceptance criteria:

- Card hierarchy is image -> product identity -> primary issue -> price/shop/date.
- No card displays a noisy cluster of competing issue chips.
- Tapping a blocked card opens the editor at the relevant section or action.

Impact: high. Effort: medium. Priority: P1.

### V2-014: Approval Gate And Undo

Problem:

Approval must be safe from every entry point.

Scope:

- Use the readiness model before:
  - Editor approval.
  - Bulk approval.
  - Approve visible.
- Show checklist for blockers.
- Allow explicit override only for non-critical warnings, not missing price.
- Add undo for bulk approval if technically safe.

Acceptance criteria:

- Missing price cannot be approved.
- Critical missing required fields cannot be approved.
- Low-confidence required fields require confirmation or correction.
- Bulk approval presents counts and blockers before write.
- Approval success moves items out of Review immediately.

Impact: very high. Effort: medium. Priority: P0.

## Phase 2: Persistent Recovery And AI Reliability

Goal: make failures operationally manageable instead of transient modal messages.

Expected outcome: failed AI, upload, and shop sync jobs become visible tasks with retry paths.

### V2-020: Automation Job Log

Problem:

AI/sync/upload failures can disappear after a modal closes or appear only as generic errors.

Scope:

- Add a persistent job/error model, likely via Supabase migration.
- Track:
  - Job type: AI fill, upload, shop sync, pricing write if needed.
  - Item ID or batch ID.
  - Status: pending, running, succeeded, failed, dismissed.
  - Error category.
  - Error detail.
  - Attempt count.
  - Last attempt time.
  - Next retry time if applicable.
- Consider a table such as `item_jobs` or `item_issue_events`.

Acceptance criteria:

- Failed AI fill is visible after closing the modal.
- Failed sync is visible in Review/Shop.
- Failed upload batch can show failed items/files where technically possible.
- User can retry failed jobs from the relevant queue.

Impact: very high. Effort: medium-high. Priority: P0.

### V2-021: Retry Failed Only

Problem:

After batch work, users need a safe way to retry only failures.

Scope:

- Add retry-failed action to bulk AI modal.
- Add retry failed to Review Errors queue.
- Add retry failed to Shop sync recovery.
- Preserve success results and avoid rerunning completed work unnecessarily.

Acceptance criteria:

- User can retry only failed AI items.
- Retry count and latest error update.
- Successful retry removes item from failure queue.
- Repeated transient failures show helpful guidance.

Impact: high. Effort: medium. Priority: P0.

### V2-022: User-Friendly Error Taxonomy

Problem:

Raw edge/function/network errors are not enough for operational recovery.

Scope:

- Classify errors:
  - AI service busy.
  - AI could not read photo.
  - Missing image.
  - Network offline.
  - Permission denied.
  - Shop rejected item.
  - Shop service unavailable.
  - Unknown technical error.
- Map each category to a user-facing message and action.

Acceptance criteria:

- Errors show category, short explanation, and next action.
- Technical detail is available but secondary.
- Toasts are short; persistent surfaces carry details.

Impact: high. Effort: medium. Priority: P1.

## Phase 3: Mobile Editor V2

Goal: make item editing issue-first, fast, and safe on a phone.

Expected outcome: users fix one item without scrolling through an undifferentiated form.

### V2-030: Sectioned Editor

Problem:

The editor currently combines all item data into one long sheet.

Scope:

- Split into:
  - Verify: image, readiness checklist, AI confidence, current blocker.
  - Details: brand, name, category fields.
  - Selling: price, stock, shop state.
  - Admin: cost, history, delete.
- Open directly to relevant section based on queue/blocker.
- Collapse completed low-priority sections.

Acceptance criteria:

- Opening from Missing price focuses Selling.
- Opening from Check AI focuses Verify.
- Opening from Missing details focuses Details.
- Admin controls are not competing with review work.

Impact: high. Effort: medium. Priority: P1.

### V2-031: Sticky Editor Action

Problem:

Save, approve, retry AI, and set price should not require scrolling.

Scope:

- Add sticky footer inside editor sheet.
- Action changes by readiness state:
  - Save.
  - Save and approve.
  - Retry AI.
  - Set price.
  - Fix sync.
- Keep Cancel/back in sheet header.

Acceptance criteria:

- Primary action is reachable at all scroll positions.
- Button label reflects current item state.
- Disabled state explains what is missing.

Impact: high. Effort: medium. Priority: P1.

### V2-032: Field-Level Fix Mode

Problem:

Missing/uncertain fields should be fixed without scanning the whole form.

Scope:

- Add a "Fix missing fields" mode that shows only required missing/uncertain fields.
- Add "Next issue" navigation.
- Preserve full details mode for deep editing.

Acceptance criteria:

- User can resolve missing details without seeing unrelated fields.
- Completing the last issue updates readiness state.
- Save and approve becomes available when checks pass.

Impact: medium-high. Effort: medium. Priority: P2.

## Phase 4: Upload-To-Review Flow

Goal: close the gap between adding photos and managing the resulting review work.

Expected outcome: after upload, users immediately continue with the right batch review task.

### V2-040: Upload Completion Groups

Problem:

Upload completion should explain outcomes, not just finish.

Scope:

- Group uploaded results:
  - Ready for review.
  - Needs AI retry.
  - Missing details.
  - Missing price.
  - Upload failed.
- Show counts and primary action.

Acceptance criteria:

- Completion screen tells user what happened.
- Failed upload/AI results are recoverable.
- Primary action routes to Review filtered to the uploaded batch.

Impact: high. Effort: medium. Priority: P1.

### V2-041: Review This Batch

Problem:

Users should not need to manually find the batch they just uploaded.

Scope:

- Track current upload batch in client state and optionally database.
- Add "Review this batch" after upload.
- Apply a Review filter for uploaded item IDs or batch ID.
- Keep the filter visible and clearable.

Acceptance criteria:

- User can jump from upload completion to the exact uploaded items.
- Batch filter persists during review until cleared.
- Bulk actions scope to the batch.

Impact: high. Effort: medium. Priority: P1.

### V2-042: Smart Defaults For Upload

Problem:

Repeated upload sessions should not require repeated setup.

Scope:

- Remember last selected category.
- Remember common brand within a session.
- Add "same as previous batch".
- Default Auto AI-fill on for editors/admins if cost is acceptable.

Acceptance criteria:

- Repeat upload flow requires fewer taps.
- Defaults are visible and editable.
- User can clear remembered values.

Impact: medium-high. Effort: low-medium. Priority: P2.

## Phase 5: Pricing V2

Goal: make pricing a direct part of Review rather than a separate tool users must discover.

Expected outcome: missing-price items can be resolved quickly from the Review context.

### V2-050: Quick Pricing From Review

Problem:

Pricing has several entry points and can feel separate from the missing-price queue.

Scope:

- Add quick price sheet scoped to:
  - Current queue.
  - Current filters.
  - Selected items.
- Let user set one price for visible/selected items.
- Offer guided pricing and advanced pricing as secondary actions.

Acceptance criteria:

- Missing price queue primary action opens quick pricing.
- Scope is explicit before write.
- Price write supports preview and undo.
- Items move out of Missing price after success.

Impact: high. Effort: medium. Priority: P1.

### V2-051: Pricing Scope Preview

Problem:

Bulk pricing is risky without a clear preview.

Scope:

- Show count, category mix, brands, current prices, and affected unpriced items.
- Confirm before applying multi-item price changes.

Acceptance criteria:

- User sees what will change before committing.
- Risky broad changes require confirmation.
- Undo is offered after successful change.

Impact: high. Effort: medium. Priority: P1.

## Phase 6: Shop Sync V2

Goal: make shop/POS state understandable and recoverable.

Expected outcome: users can see what reached the shop, what is queued, what failed, and how to recover.

### V2-060: Shop Health Dashboard

Problem:

Shop sync is important but diagnosis is not central enough.

Scope:

- Add compact Shop dashboard:
  - In shop.
  - Queued.
  - Sending.
  - Shop issues.
  - Shop update needed.
  - Mirror stale/failing.
- Link each count to the relevant list.

Acceptance criteria:

- Shop tab explains current operational health.
- Sync failures are visible without opening overflow menu.
- Stale mirror state is clear.

Impact: high. Effort: medium. Priority: P1.

### V2-061: Shop Issue Recovery

Problem:

Shop error chips need a direct recovery path.

Scope:

- Add issue detail sheet:
  - Error category.
  - Last attempt.
  - Affected item.
  - What user can fix.
  - Retry action.
- Link from Review Shop issue queue and Shop dashboard.

Acceptance criteria:

- User can recover or retry shop errors from the issue surface.
- Error detail is understandable without technical context.
- Successful retry updates card/shop status.

Impact: high. Effort: medium. Priority: P1.

## Phase 7: Information Architecture And Settings

Goal: separate daily work from configuration and make advanced features discoverable.

Expected outcome: the app feels calmer and easier to navigate.

### V2-070: More And Settings Restructure

Problem:

The overflow menu mixes admin, daily work, configuration, account, and diagnostics.

Scope:

- Group actions into:
  - Work tools: Pricing, Calibration, Export.
  - Shop: Shop sync, integration settings.
  - Admin: Users, Categories and fields.
  - App: Currency, Appearance, Install.
  - Account: Sign out.
- Consider turning overflow into a More tab if needed.

Acceptance criteria:

- Daily review actions are not buried among admin settings.
- Settings are grouped and labeled.
- Role-restricted actions remain hidden when unavailable.

Impact: high. Effort: low-medium. Priority: P1.

### V2-071: Smart Views

Problem:

Users think in work states, not advanced filters.

Scope:

- Add first-class smart views:
  - Uploaded today.
  - Needs AI.
  - Missing price.
  - Check AI.
  - Ready.
  - Shop issues.
  - Low stock if supported.
- Show smart views before advanced filters in filter sheet.

Acceptance criteria:

- User can enter common views in one tap.
- Active smart view is visible and clearable.
- Smart view can be saved if customized.

Impact: medium-high. Effort: medium. Priority: P2.

## Phase 8: Premium Accelerators

Goal: add modern power-user capabilities after core recovery and review workflows are reliable.

### V2-080: AI Consistency Audits

Problem:

AI can produce inconsistent values such as `W32` vs `32`, brand variants, or missing detail patterns.

Scope:

- Add audits for:
  - Size format inconsistencies.
  - Brand spelling variants.
  - Missing required category attributes.
  - Duplicate SKU-like attributes.
  - Unusual prices within a group.
- Surface results in Review as actionable issues.

Acceptance criteria:

- User can run audit by category or current view.
- Findings show affected items and suggested fix.
- Applying fixes uses preview and undo where appropriate.

Impact: high. Effort: medium-high. Priority: P2.

### V2-081: Command And Action Sheet

Problem:

Power users need fast access to actions without hunting through menus.

Scope:

- Mobile bottom action sheet or command palette.
- Actions:
  - Search item/SKU.
  - Run AI fill on current view.
  - Set prices for current view.
  - Open shop sync.
  - Export current view.
  - Save current filters.

Acceptance criteria:

- Accessible from a clear button or shortcut.
- Results/actions are scoped to current view where relevant.
- Does not replace visible primary actions.

Impact: medium-high. Effort: medium. Priority: P3.

### V2-082: Gesture Accelerators

Problem:

Gestures can speed mobile review, but must not hide core functionality.

Scope:

- Optional gestures:
  - Swipe right to approve complete item.
  - Swipe left to flag/problem.
  - Long press to select.
  - Pull to refresh shop/AI status.

Acceptance criteria:

- Gestures are discoverable but not required.
- Destructive/risky gestures require confirmation or undo.
- No conflict with scrolling or image zoom.

Impact: medium. Effort: medium. Priority: P3.

## Design System Workstream

This work should run alongside feature delivery.

### V2-090: Component Standards

Scope:

- Product card.
- Dense review row.
- Issue pill/checklist.
- Status badge.
- Queue chip.
- Empty state.
- Error state.
- Bottom sheet.
- Sticky action footer.
- Confirmation dialog.
- Filter facet group.
- Smart view chip.
- Progress/job status.
- Toast with action.
- Price input and price preview.

Acceptance criteria:

- Components have consistent spacing, type roles, states, and mobile behavior.
- No card-inside-card section layouts.
- Text fits on mobile.
- Buttons use clear hierarchy.

Impact: high. Effort: ongoing. Priority: P1.

### V2-091: Mobile QA Checklist

Scope:

- Test primary flows on narrow mobile viewport.
- Test tile/list Review.
- Test editor long forms.
- Test bottom sheets with keyboard open.
- Test offline editor state.
- Test bulk action bar reachability.
- Test long product names and long category paths.
- Test light and dark modes.

Acceptance criteria:

- No overlapping text or controls.
- Critical actions are thumb-reachable.
- Sheets do not scroll the page beneath.
- Empty/error/loading states have actions.

Impact: high. Effort: low-medium. Priority: P1.

## Suggested Build Order

### Sprint 1: Trust And Language

- V2-001 Copy and encoding cleanup.
- V2-002 Friendly status and issue labels.
- V2-003 Readiness model.
- Start V2-090 component standards for status/issue/card states.

Exit criteria:

- App copy is clean.
- UI labels are human.
- One shared readiness evaluator exists.

### Sprint 2: Review Inbox Core

- V2-010 Review Inbox header.
- V2-011 Prioritized Review queues.
- V2-012 Queue-specific primary actions.
- V2-014 Approval gate.

Exit criteria:

- Review clearly tells managers what to do next.
- Bulk/editor approval cannot bypass critical blockers.

### Sprint 3: Recovery And Jobs

- V2-020 Automation job log.
- V2-021 Retry failed only.
- V2-022 User-friendly error taxonomy.

Exit criteria:

- Failed AI/sync work persists.
- Users can retry failed work without rerunning successful work.

### Sprint 4: Editor And Upload

- V2-030 Sectioned editor.
- V2-031 Sticky editor action.
- V2-040 Upload completion groups.
- V2-041 Review this batch.

Exit criteria:

- Opening an item from Review lands on the relevant fix.
- Upload naturally flows into batch review.

### Sprint 5: Pricing And Shop

- V2-050 Quick pricing from Review.
- V2-051 Pricing scope preview.
- V2-060 Shop health dashboard.
- V2-061 Shop issue recovery.

Exit criteria:

- Missing-price and shop-error workflows are direct and recoverable.

### Sprint 6: IA And Premium Layer

- V2-070 More and Settings restructure.
- V2-071 Smart views.
- V2-080 AI consistency audits.
- V2-091 Mobile QA checklist completion.

Exit criteria:

- App navigation is calmer.
- Common management views are one tap away.
- AI helps find inconsistency, not only fill fields.

## V2 Release Criteria

V2 is ready when all of the following are true:

- Review is the default place to manage all problematic and ready items.
- Every review queue has a primary action.
- Every item can explain why it is not ready.
- Approval gates prevent missing price and critical missing details.
- AI/sync failures are persistent and retryable.
- Upload completion routes directly to the uploaded batch in Review.
- Missing-price items can be priced from Review without re-scoping manually.
- Shop errors have a recovery path.
- UI copy is clean and human-readable.
- Mobile QA passes on narrow viewport and touch workflows.

## Key Dependencies

- Readiness model should precede Review Inbox, editor sticky actions, and approval gates.
- Job/error persistence should precede retry-failed workflows.
- Friendly labels should precede broader visual polish.
- Quick pricing should reuse existing pricing write/undo logic.
- Shop recovery should reuse existing POS status and mirror data.
- Smart views should build on existing filter/saved-view infrastructure.

## Risks And Mitigations

### Risk: Review becomes too complex

Mitigation:

- Prioritize queues.
- Show one primary issue per card.
- Move secondary detail to checklist/editor.

### Risk: Persistent jobs add schema complexity

Mitigation:

- Start with a minimal table focused on failed AI/sync jobs.
- Extend only when upload/pricing failure persistence is needed.

### Risk: Approval gates frustrate users

Mitigation:

- Block only critical issues.
- Allow explicit confirmation for softer warnings.
- Explain exactly what is missing.

### Risk: Mobile sheets become too long

Mitigation:

- Use progressive sections.
- Add sticky action.
- Deep-link editor to relevant section.

### Risk: Multiple pricing tools confuse users

Mitigation:

- Make Review/No price the operational entry point.
- Keep guided pricing primary.
- Label advanced pricing as advanced.

## Open Product Decisions

1. Should Review become the default landing tab for editors/admins when there is outstanding work?
2. Should Auto AI-fill default on for uploads, given cost and latency?
3. Which fields are truly required per category for approval?
4. Which AI confidence levels should block approval versus warn?
5. Should failed upload files be persisted client-side for retry, or only failed item records after storage succeeds?
6. Should smart views be global defaults, user-specific, or both?
7. Should managers be able to override approval blockers, and if so which ones?

## First Implementation Slice

The best first slice is small but foundational:

1. Clean corrupted strings and replace raw status labels.
2. Add `getItemReadiness(item)` or equivalent shared evaluator.
3. Render one primary blocker on Review cards.
4. Add approval gate using the readiness evaluator.
5. Add queue primary actions for Needs AI, Missing price, Shop issue, and Ready.

Why this slice first:

- It improves trust immediately.
- It reduces approval risk.
- It gives V2 a shared issue model.
- It makes the current Review page substantially more useful without waiting for larger schema work.

## Final V2 Direction

V2 should not be a cosmetic redesign. It should be a workflow-led upgrade that makes the app feel intelligent, controlled, and fast.

The product should move from:

"Here is the catalog. Filter it to find problems."

to:

"Here is today's inventory work. These items need AI, these need price, these have issues, and these are ready to approve."
