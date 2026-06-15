# K-LINE MEN Catalog UX Product Audit

Date: 2026-06-15

Scope: source-led review of the current PWA experience across Gallery, Add photos, Review, item editor, AI fill, pricing, shop sync, export, settings, user/category admin, and supporting design system. This audit is written for a premium, mobile-first operational product used to prepare retail inventory for review and sale.

## Executive Diagnosis

K-LINE MEN Catalog is already moving in the right direction for a serious mobile operations app. It has a focused bottom navigation, card-based gallery, full-screen mobile sheets, AI-assisted extraction, bulk actions, review queues, guided pricing, shop sync status, role-aware controls, and offline awareness. These are strong product foundations.

The main gap is not raw feature count. The main gap is orchestration. The app has many capable surfaces, but the user must still know where to go, what each status means, what work is blocking approval, and which action fixes the issue. Premium software reduces that thinking. It should feel like a high-quality workbench that says: "Here is what needs attention, here is why, here is the fastest safe action, and here is what is now ready."

The second major gap is polish consistency. Some UI strings and source text show mojibake-style corruption, including broken ellipses, middle dots, arrows, and symbols. If any of this renders to users, it immediately makes the product feel unreliable. Even if it is only a console/display artifact, the codebase should be cleaned and checked because visible copy quality is a launch-level trust signal.

The third gap is mobile information density. The current app correctly uses cards, bottom nav, bottom sheets, and action bars, but several workflows still feel like desktop business software compressed onto a phone: long editor forms, broad filter sheets, multi-purpose overflow menus, and admin/pricing/sync tools competing with daily review actions.

## Product North Star

The app should become an "inventory control cockpit" for phone-first retail work:

- Capture items quickly from a phone.
- Let AI fill what it can, then clearly expose uncertainty.
- Turn messy uploads into clean, priced, approved, sellable inventory.
- Make every issue discoverable and recoverable.
- Keep managers in flow with queues, smart defaults, scoped actions, and undo.
- Make the system feel trustworthy by showing status, provenance, and next action without clutter.

## Immediate Critical Issues

### 1. Fix visible text corruption and copy quality

Observed in source/output: mojibake sequences appear across README and UI strings, including ellipses, bullets, arrows, checkmarks, lock/search emoji, and punctuation. Examples include broken versions of "Search...", "Choose...", middle-dot separators, and status symbols.

Why it matters: corrupted copy is one of the fastest ways to make a product feel cheap or unsafe. It also damages comprehension for critical states such as saving, AI failure, sync status, and approval.

Recommendation:

- Run a copy audit across `src/*.js`, `README.md`, and visible strings.
- Replace decorative symbols with lucide/SVG icons from the existing `ICON` system where possible.
- Keep text ASCII where there is no strong reason for special characters.
- Create a small copy glossary for statuses, queues, errors, and success states.

Impact: very high. Effort: low to medium.

### 2. Create a single Review command center

The Review page now has queues for Needs work, Needs AI fill, No price, AI doubts, Missing details, Flagged, Shop errors, and Ready. That is powerful. However, it still behaves like a filtered gallery rather than a management cockpit.

Recommendation:

- Add a compact "Today" or "Review Inbox" header with counts and priority order.
- Show only the top 3 to 4 queue chips by default on mobile, with "More" opening the full queue list.
- Give each queue a primary action:
  - Needs AI fill -> Run AI fill on this queue.
  - No price -> Set prices for this queue.
  - AI doubts -> Review uncertain fields.
  - Missing details -> Complete required fields.
  - Shop errors -> Retry/open sync details.
  - Ready -> Approve all visible.
- Add a per-item "blocking checklist" in each card or editor: AI, price, required fields, sync, duplicate SKU, confidence.

Impact: very high. Effort: medium.

### 3. Make AI and sync failures recoverable

The app has better error surfacing after the AI fill resilience work, but failures still need a persistent operational model.

Recommendation:

- Add an "Errors" queue that includes AI failures, sync failures, upload failures, and save failures.
- Store failed AI attempts per item or batch with error type, retry count, last tried time, and next suggested action.
- Add "Retry failed only" after batch AI fill and upload.
- Show user-friendly failure categories: "AI service busy", "photo unreadable", "missing image", "network", "permission", "shop rejected".

Impact: very high. Effort: medium.

### 4. Reduce editor overload

The item editor is a capable full-screen sheet, but it asks users to process image, AI suggestion, status, confidence, category fields, stock/pricing, cost, SKU, history, duplicate warnings, and delete in one vertical form.

Recommendation:

- Split editor into progressive sections:
  - Verify: image, issue checklist, AI confidence, critical fields.
  - Details: brand, name, category attributes.
  - Selling: retail price, stock, shop status.
  - Admin: cost, history, delete.
- On mobile, keep a sticky footer with primary next action: Save, Save and approve, Retry AI, Set price, Fix sync.
- Collapse low-priority sections by default after the item is complete.

Impact: high. Effort: medium.

### 5. Separate daily work from admin/configuration

The overflow menu mixes daily operations with account/admin tasks: Users, Categories and fields, Shop sync, Settings, Set prices, Calibration check, Export CSV, Appearance, Install, Sign out.

Recommendation:

- Keep daily operations close to bottom nav or Review:
  - Pricing
  - Shop sync
  - Export if regularly used
  - Calibration if part of review workflow
- Move account/admin/configuration into a Settings hub:
  - Users
  - Categories and fields
  - Appearance
  - Currency
  - Install
  - Sign out

Impact: high. Effort: low to medium.

## Current Strengths

- Mobile-first shell with bottom navigation and full-screen sheets.
- Gallery and Review share one underlying browse system, which keeps behavior consistent.
- Review queues are a strong direction for issue management.
- Bulk selection uses familiar phone-gallery patterns.
- AI fill exists both for upload and post-upload batches.
- Guided pricing is conceptually strong because it matches how people think about retail pricing.
- Shop/POS sync status is visible at item and gallery level.
- Role-based permissions are built into the interface.
- Offline awareness exists in the editor.
- Undo appears in pricing workflows, which is important for trust.
- Field definitions are category-driven, which is a strong information architecture foundation.

## 1. Visual Design And Aesthetics

### First Impression

The app reads as an operational inventory tool, not a marketing site. That is appropriate. Cards, bottom nav, sheets, status chips, and photo-first layouts are a strong base for retail catalog work.

The visual quality is functional but not yet premium. The biggest blockers are inconsistent copy/symbol rendering, dense state badges, uneven terminology, and a few generic business-app patterns that dilute the photo-first experience.

### Modernity And Uniqueness

What feels modern:

- Photo-first tile view.
- Bottom sheet interactions.
- AI-assisted metadata extraction.
- Review queues.
- Bulk action bar.
- Guided pricing.
- Shop sync chips.

What feels less modern:

- Long forms with many fields visible at once.
- Status labels shown as implementation values: `draft`, `needs-review`, `approved`, `flag`.
- Overflow menu used as a catch-all.
- Filters and admin tools feel utilitarian rather than designed as a premium workflow.

### Brand Identity

The app has a named retail identity, K-LINE MEN Catalog, but the UI does not yet express a distinct product personality. It feels like a capable internal tool more than a polished branded system.

Recommendations:

- Establish a concise brand header style: K-LINE MEN, Catalog, Review, Shop.
- Use a small set of product voice rules:
  - Prefer verbs over database states: "Needs review" instead of `needs-review`.
  - Prefer action labels over nouns: "Set price", "Retry AI", "Approve".
  - Keep errors plain and recoverable.
- Replace visible raw statuses with human labels:
  - Draft -> New
  - Needs review -> Review
  - Approved -> Approved
  - Flag -> Problem

### Typography

The use of Inter is a good choice. Hierarchy should be tightened:

- Card brand/name should remain dominant.
- Category and status should become secondary, not compete with product identity.
- Issue pills should be visually quieter unless critical.
- Dense rows should use consistent two-line rhythm: identity line, issue/detail line, metadata line.

Recommendation: define 5 reusable text roles:

- Page title
- Section title
- Item title
- Metadata
- Microcopy/error

### Color System And Accessibility

The color token system is a strength. It supports dark and light modes and separates panel, elevated, line, accent, warn, error, and success.

Risks:

- Warning/review colors may appear too similar across AI doubts, missing details, and needs-review.
- Too many chips can create a multi-color noise field.
- Some status color meaning depends on small text and border color only.

Recommendations:

- Assign severity levels:
  - Blocking: error/red
  - Needs action: amber
  - AI/automation: blue or accent
  - Ready/success: green
  - Informational: muted neutral
- Add icon shape cues in addition to color.
- Keep only one dominant issue chip per card; move secondary issues into a compact count or checklist.

### Spacing And Balance

Cards are compact and efficient. The risk is that Review cards may become visually overloaded with category, status, issue pills, brand, attributes, price, shop chip, and date.

Recommendation:

- Use a consistent card hierarchy:
  - Image
  - Brand/product
  - Most important variant attributes
  - One issue/ready state
  - Price/shop/date metadata
- Move category into either a small top-left overlay or metadata line, not both category and status competing at the top.

### Iconography And Imagery

The product images are the app's strongest visual asset. The UI should let them lead.

Recommendations:

- Use icons for actions where the meaning is familiar: filter, grid/list, select, AI, price, sync, approve, retry, warning.
- Avoid decorative emoji or special character symbols in visible UI.
- Use image aspect ratio consistently across Gallery and Review.
- Add image quality markers when relevant: blurry, duplicate, no image, dark photo, missing front/back if this becomes part of workflow.

## 2. Mobile-First Experience

### What Works

- Bottom nav is reachable.
- Sheets are mobile-first.
- Tile view matches phone gallery mental models.
- Selection mode and bottom action bar are appropriate.
- Search/filter controls are compact.
- Review now defaults to tiles, matching Gallery.

### Mobile Friction

- The top bar places search, density toggle, filter, and select together. On narrow screens, this is efficient but cognitively heavy.
- Queue chips can overflow horizontally. Horizontal scroll is acceptable but discoverability drops after the first few chips.
- Long editor sheets require repeated scrolling and memory.
- Important work actions are split between count line, selection bar, overflow menu, and editor.
- Filter sheets can become broad and desktop-like when many attributes exist.

### Recommendations

- Add a sticky bottom "next action" per context:
  - Review/Needs AI fill: Run AI fill.
  - Review/No price: Set prices.
  - Review/Ready: Approve visible.
  - Editor with missing price: Set price.
  - Editor with AI doubts: Verify fields.
- Use bottom sheets for focused action flows:
  - Quick price
  - Retry AI
  - Fix missing details
  - Approve checklist
  - Sync error details
- Keep the bottom nav stable except during selection mode.
- Use long-press for selection but also keep the visible select button for discoverability.
- Add pull-to-refresh or visible refresh for shop sync status.
- Consider swipe gestures in Review:
  - Swipe right: approve when complete.
  - Swipe left: flag/problem.
  - Swipe up or tap image: inspect photo.
  - Long press: select.

## 3. User Experience And Interaction Design

### Simplicity And Learnability

The app is learnable for someone who understands the inventory process, but it currently exposes too much system language. A first-time user must learn statuses, confidence pills, shop sync states, price gates, AI behavior, and filter semantics.

Recommendations:

- Add a first-run empty state for each major tab:
  - Gallery: "Add photos or search existing inventory."
  - Add: "Pick photos, choose category, upload."
  - Review: "Fix issues, then approve items for shop."
  - Shop: "Track what reached the POS."
- Add contextual one-line explanations only inside empty states or issue sheets, not persistent instructional text.
- Use "why this item is here" explanations in Review cards and editor checklists.

### Cognitive Load

Current load is highest in:

- Review queue selection.
- Item editor.
- Filter sheet.
- Pricing surfaces.
- Shop sync troubleshooting.

Recommendations:

- Convert "everything visible" into "the next required decision visible".
- Show completion state per item: 4 of 5 checks passed.
- Hide advanced metadata until needed.
- Keep AI confidence visible only where it changes behavior.

### Feedback And Responsiveness

Strengths:

- Skeleton cards.
- Toasts.
- Progress bars for upload and bulk AI.
- Undo in pricing.
- Offline editor feedback.

Gaps:

- AI failures should remain visible after closing the modal.
- Upload failures should produce a retryable failed subset.
- Sync failures should show exact affected items and retry state.
- Save success should update the queue immediately and explain what changed: "Ready to approve" or "Still missing price."

### Error Prevention And Recovery

Current prevention:

- Cannot approve without price in editor.
- Quantity above 1 prompts confirmation.
- Duplicate SKU warning exists.
- POS stock is frozen after sync.

Needed:

- Approval checklist everywhere approval is possible, including bulk approve.
- Prevent approving items with low-confidence blocking fields unless explicitly confirmed.
- Prevent sync if required shop fields are missing.
- Add "Undo approve" for bulk approval if technically safe.
- Add retry-only-failed for AI/upload/sync.

## 4. Workflow Analysis

### Workflow A: Add Photos And AI Fill

Current workflow:

1. Open Add.
2. Take or choose photos.
3. Review preview grid.
4. Choose category.
5. Enter common fields.
6. Choose status.
7. Optionally enable Auto AI-fill.
8. Upload.
9. AI may fill fields after upload.
10. User goes to Review to fix issues.

Friction:

- Category must be chosen before upload can proceed, even though AI/photo context may help suggest it.
- Status selection exposes raw workflow labels.
- AI failure during upload is silent or easy to miss if no persistent queue is created.
- The user must switch mental context from Add to Review.

Better workflow:

1. Pick photos.
2. App shows batch summary and asks for category with smart default from last batch.
3. AI-fill defaults on for editors/admins.
4. Upload runs with visible progress.
5. Completion screen groups results:
   - Ready for review
   - Needs AI retry
   - Missing category/details
   - Upload failed
6. Primary action: "Review this batch".

Tap reduction:

- Current: often 8 to 12 taps before review.
- Target: 5 to 7 taps for normal batch upload.

High-impact improvements:

- Remember last category and brand for a session.
- Add "same as previous batch" shortcut.
- Add "Review uploaded batch" as primary completion action.
- Persist AI errors as item issues.

### Workflow B: Review And Approval

Current workflow:

1. Open Review.
2. Pick queue.
3. Search/filter if needed.
4. Open item or select items.
5. Run AI, set price, edit, approve, or sync depending on issue.
6. Return to Review.

Friction:

- Queues are useful but compete for attention.
- "Needs work" is broad and may hide the most important next action.
- Cards show several states but not always the specific blocker checklist.
- Ready approval exists but should be safer and more explicit.

Better workflow:

1. Review opens to prioritized inbox:
   - AI failed/needs retry
   - Missing price
   - Low-confidence AI
   - Missing required details
   - Shop errors
   - Ready to approve
2. Each queue has one primary action and secondary filter controls.
3. Each card shows one blocking reason and a progress indicator.
4. Opening an item lands on the exact field/action needed.
5. Approval shows a quick checklist and supports undo.

Tap reduction:

- Fix no-price item: current 4 to 8 taps, target 2 to 4.
- Retry AI failures: current 4 to 6 taps, target 1 to 2.
- Approve ready batch: current 2 to 4 taps, target 1 plus undo/safety check.

### Workflow C: Item Editing

Current workflow:

1. Tap item.
2. Full editor sheet opens.
3. User scans image, status, AI, fields, pricing, stock, SKU, history.
4. User edits field and saves.

Friction:

- All fields are presented with similar weight.
- Critical blockers do not dominate the first viewport.
- Status labels are technical.
- AI confidence is useful but could be better tied to action.

Better workflow:

1. Tap item.
2. Editor opens with issue summary at top:
   - "Missing price"
   - "AI unsure about size"
   - "Ready to approve"
3. First viewport contains image and exact required fields.
4. Secondary sections are collapsed.
5. Sticky footer offers context-specific action:
   - Save
   - Save and approve
   - Retry AI
   - Set price

Tap reduction:

- Fix one missing field: current scroll/search/edit/save, target direct field focus from queue.
- Approve after edit: target one final "Save and approve" action.

### Workflow D: Pricing

Current workflow:

Pricing appears in several places: overflow menu "Set prices", Review count-line CTA, selection action bar, guided pricing, and advanced pricing.

Strength:

- Guided pricing is a strong domain-specific idea.
- Pricing by group/category/brand is practical for retail.

Friction:

- Users may not know whether to use guided pricing, advanced pricing, review price queue, or selected-item pricing.
- Pricing is not visually integrated enough with Review blockers.

Better workflow:

1. Review/No price is the primary pricing doorway for operational users.
2. "Set prices" opens a quick pricing sheet for the visible queue first.
3. Advanced pricing remains available inside that sheet.
4. The result returns to Review with priced items moved to Ready or remaining issue queue.

Tap reduction:

- Set price for one group: target queue -> price -> apply -> back to queue.
- Avoid requiring users to re-scope the same set they were already viewing.

### Workflow E: Shop Sync

Current workflow:

Shop status appears as chips in cards and a sync center in the overflow menu. Items can show queued, sending, in shop, dirty, error, or mirror state.

Friction:

- Sync status is operationally important but hidden behind a menu for diagnosis.
- Error chips are visible, but recovery path should be immediate.
- Users need to distinguish item approval from shop availability.

Better workflow:

1. Review has Shop errors queue.
2. Shop tab has dashboard cards:
   - In shop
   - Queued
   - Sync errors
   - Dirty after edits
   - Mirror stale
3. Error item sheet explains:
   - What failed
   - Whether retry is automatic
   - What the user can fix
   - Last attempt time
4. Primary actions:
   - Retry sync
   - Open item
   - Mark resolved if no longer relevant

Tap reduction:

- Diagnose sync issue: current menu -> sync center -> item context, target Review/Shop -> error card -> action.

### Workflow F: Search, Filters, And Saved Views

Current workflow:

Search is always available. Filters include status, issue, price, date, category/attribute facets, saved views, and sorting.

Strength:

- Powerful for management.
- Attribute-driven filtering is valuable.

Friction:

- Filter power may overwhelm mobile users.
- Saved views are useful but likely hidden.
- Users may think in tasks, not fields: "Needs photos", "Unpriced jeans", "AI doubts today", "Ready for shop".

Better workflow:

- Keep search as global item lookup.
- Convert common filters into saved smart views:
  - Uploaded today
  - Unpriced
  - Needs AI
  - Ready
  - Shop errors
  - Low stock
  - Category-specific review
- In filter sheet, show "Smart views" first, then advanced facets.
- Add "Save this view" after a user creates a filter combination.

### Workflow G: Admin, Categories, Users, Settings

Current workflow:

Admin/configuration actions are accessible from the overflow menu.

Friction:

- Daily work and admin work are mixed.
- Category and field management can break data consistency if not guided carefully.

Better workflow:

- Create Settings hub with groups:
  - Team and permissions
  - Catalog structure
  - Shop integration
  - App appearance
  - Data export
- Add guardrails to field/category edits:
  - Preview affected items.
  - Show existing values before renaming/removing fields.
  - Require confirmation for destructive schema changes.

## 5. Information Architecture

### Current Structure

Primary nav:

- Gallery
- Add
- Review
- Shop

Overflow:

- Users
- Categories and fields
- Shop sync
- Settings
- Set prices
- Calibration check
- Export CSV
- Appearance
- Install app
- Sign out

### Assessment

The primary nav is close to right. Gallery, Add, Review, and Shop map to core jobs. The issue is the overflow menu. It has become a mixture of daily workflows, diagnostics, setup, account, and admin.

### Recommended IA

Bottom nav:

- Work
- Add
- Catalog
- Shop
- More

Alternative if keeping current labels:

- Gallery
- Add
- Review
- Shop

But make Review the default management surface for editors/admins after login, not Gallery, when there is outstanding work.

More/Settings hub:

- Pricing
- Reports/export
- Calibration
- Team
- Categories and fields
- Shop integration
- App settings
- Appearance
- Install
- Sign out

Terminology cleanup:

- `draft` -> New
- `needs-review` -> Needs review
- `flag` -> Problem
- `pos_dirty` -> Shop update needed
- `AI doubts` -> Check AI
- `No price` -> Missing price
- `Shop errors` -> Shop issue

## 6. Premium Product Experience

### Does It Feel Enterprise-Grade?

Partially. The underlying capabilities are enterprise-grade: permissions, RLS, audit/history, POS sync, cost isolation, bulk operations, AI, and pricing controls. The interface needs more confidence, hierarchy, and workflow clarity to communicate that quality.

### Does It Feel Premium?

Not yet consistently. Premium feel comes from:

- Clean copy.
- Predictable hierarchy.
- Immediate feedback.
- Helpful empty/error states.
- Fewer visible technical details.
- Smooth recovery from failures.
- Strong defaults.

The app has the machinery, but the polish layer needs attention.

### Elements That Feel Cheap Or Generic

- Corrupted visible strings if rendered.
- Raw status values.
- Dense forms with many fields.
- Catch-all overflow menu.
- Multiple pricing entry points without clear priority.
- Error messages that expose implementation details instead of action categories.
- Too many small chips competing for attention.

### Premium Enhancements

- Add a polished Review Inbox with clear counts and actions.
- Add smooth queue transitions and card state changes.
- Use a consistent empty-state pattern with primary action.
- Add inline completion checklists.
- Add command/action palette for power users.
- Add user-friendly error classes and retry actions.
- Add small success animations or tactile feedback for approval, save, and bulk completion.

## 7. High-End App Benchmarking

### Linear

What Linear does well:

- Clear task hierarchy.
- Fast command actions.
- Precise status labels.
- Minimal clutter.

Gap:

- K-LINE needs a stronger issue/task model. Review should feel like a prioritized issue inbox, not only a filtered gallery.

### Notion

What Notion does well:

- Flexible views.
- Simple information architecture over complex data.
- User-created saved contexts.

Gap:

- Saved views should become first-class and easy to recall. Filters should feel like reusable workspaces, not one-off settings.

### Stripe Dashboard

What Stripe does well:

- Trustworthy operational states.
- Excellent error and empty states.
- Auditability and clear object detail pages.

Gap:

- Shop sync, AI, pricing, and approval need stronger provenance: what happened, when, by whom, and what action is next.

### Revolut And Monzo

What they do well:

- Mobile-first action focus.
- Clear money/status states.
- Strong use of bottom sheets and progressive disclosure.

Gap:

- Pricing and inventory status should feel as direct as mobile finance actions: "Set price", "Approve", "Retry", "Send to shop".

### Uber

What Uber does well:

- One dominant next action.
- Live status.
- Low cognitive load in critical flows.

Gap:

- Each K-LINE workflow should expose one dominant next action based on current state, especially in Review and editor.

## 8. Design System Review

### Component Consistency

Strong existing components:

- Cards
- Dense rows
- Bottom nav
- Bottom sheets
- Toasts
- Action bar
- Status badges
- Issue pills
- Filter chips
- Skeleton loaders
- Pricing cards

Needed standardization:

- Button hierarchy: primary, secondary, ghost, danger, icon, link.
- Status naming and color.
- Issue pill shape and severity.
- Empty state layout.
- Error message layout.
- Form row layout.
- Sticky mobile footers.
- Confirmation dialogs.

### Forms

Current forms are functional. They need:

- Required field markers.
- Inline validation.
- Field grouping.
- Better keyboard types.
- Clear disabled/read-only styling.
- Fewer always-visible fields.

### Tables And Lists

The app mostly uses cards/lists instead of tables, which is right for mobile. Dense rows are useful for review but should be visually tuned:

- Fixed thumbnail size.
- One top-line identity.
- One issue summary line.
- One metadata line.
- Avoid wrapping chips into messy second lines.

### Cards

Cards should standardize:

- Image ratio.
- Brand/name placement.
- Variant summary.
- Primary issue state.
- Price/shop/date metadata.
- Selection state.
- Loading state.
- Missing image state.

### Navigation

Bottom nav is good. Overflow should become structured settings/actions rather than a long menu.

### Dialogs And Drawers

Bottom sheets are appropriate. Recommendations:

- Keep bottom sheet titles action-oriented.
- Use sticky footers for destructive/confirm actions.
- Avoid sheets that become long admin pages.
- Use full-screen surfaces for deep tools like pricing and sync.

### Search And Filters

Search is strong. Filters need:

- Smart views first.
- Advanced filters second.
- Clear active filter pills.
- One-tap reset.
- Saved view creation.

### Data Visualization

Current app has counts but limited visual summary. Add simple operational metrics:

- Items needing work.
- Ready to approve.
- Missing price.
- AI failure rate.
- Shop sync health.
- Uploaded today.
- Approved today.

Keep them compact; this is not an analytics dashboard.

## 9. Mobile Workflow Innovation

### Gesture-Based Review

Use optional gestures that do not replace visible controls:

- Swipe right on complete item: approve.
- Swipe left: flag/problem.
- Long press: enter selection.
- Drag across cards: multi-select.
- Pull down: refresh shop/AI status.

### Bottom-Sheet Quick Actions

Add context-sensitive sheets:

- Quick price: set price for selected/visible group.
- Quick AI retry: retry failed or missing AI fields.
- Quick approve: checklist plus approve.
- Quick fix: jump between missing fields.
- Sync issue: error, retry, open item.

### AI-Assisted Workflows

Add AI as an operational assistant, not only a field extractor:

- "Find inconsistent sizes in Jeans."
- "Show items likely missing brand."
- "Suggest price exceptions in this group."
- "Detect duplicate photos or duplicate SKUs."
- "Explain why this item is not ready."
- "Review this batch and group problems."

### Command Palette

For power users, add a command/action palette:

- Search item/SKU.
- Run AI fill on current view.
- Set prices for current view.
- Open shop sync.
- Export current view.
- Save current filters.
- Jump to category.

On mobile, this can be a bottom search/action sheet opened from a floating button or More tab.

### Smart Shortcuts

- Last used category/brand.
- Batch templates.
- "Same as previous item."
- "Apply this value to selected."
- "Approve after saving."
- "Retry only failed."
- "Show only my uploads."

## 10. Required Deliverables

### 10.1 Critical Issues Requiring Immediate Attention

1. Fix encoding/copy corruption in visible UI strings.
2. Make Review a true management cockpit with prioritized queues and actions.
3. Persist and retry AI/sync/upload failures.
4. Add approval checklists for all approve paths.
5. Simplify the overflow menu into daily actions vs settings/admin.
6. Reduce editor overload with progressive sections and sticky next action.

### 10.2 High-Impact UX Improvements

1. Review Inbox header with counts, priority, and primary action.
2. Per-item blocking checklist.
3. Persistent failed-job queue.
4. Quick price sheet for visible/selected items.
5. "Review this batch" after upload.
6. Smart views for common management tasks.
7. Human-readable status labels.
8. Better empty states for each queue.
9. One-tap retry for AI and sync failures.
10. Save and approve from editor.

### 10.3 Mobile-First Redesign Recommendations

1. Keep tile view as Review default.
2. Limit visible queue chips on mobile; use priority plus More.
3. Add sticky context action at bottom of Review and editor.
4. Convert long forms into sections.
5. Use bottom sheets for quick fixes.
6. Make filters task-first, facet-second.
7. Increase thumb-friendly action targets for critical actions.
8. Avoid raw technical labels in mobile UI.
9. Use gestures as accelerators, not required controls.
10. Keep image inspection one tap away everywhere.

### 10.4 Workflow Redesign Recommendations

Upload:

- Default AI on for editors/admins.
- Remember last category.
- Show completion groups.
- Provide "Review this batch".

Review:

- Prioritize queues.
- Give every queue one primary action.
- Show why each item is blocked.
- Support approve visible with checklist and undo.

Editor:

- First viewport should show issue, image, and required fields.
- Add Save and approve.
- Collapse admin sections.

Pricing:

- Route operational pricing through Review/No price.
- Scope pricing to visible/selected items by default.
- Keep guided pricing as primary and advanced pricing as secondary.

Shop:

- Make Shop errors first-class.
- Show retry path and last attempt.
- Clarify approved vs in shop.

Filters:

- Promote smart views.
- Save useful filter combinations.
- Keep advanced facets available but secondary.

### 10.5 Premium Experience Enhancements

1. Copy system and terminology cleanup.
2. High-quality empty/loading/error states.
3. Smooth queue/card transitions.
4. Haptic feedback for save/approve/select.
5. Stronger visual hierarchy in cards.
6. Consistent icon system.
7. Audit/provenance timeline in item details.
8. Compact operational metrics.
9. Command/action palette.
10. AI assistant for issue discovery and consistency checks.

### 10.6 Quick Wins With High ROI

1. Replace raw status labels with friendly labels.
2. Fix corrupted text sequences.
3. Add "Review this batch" after upload.
4. Add "Retry failed only" to AI fill modal.
5. Add queue-specific empty states.
6. Add one-line "why here" to Review cards.
7. Move Settings/Admin into grouped More sheet.
8. Put Set prices as a visible Review action when no-price items exist.
9. Add "Save and approve" in editor.
10. Add smart views: Today, Unpriced, Needs AI, Ready, Shop issues.

### 10.7 Features To Remove Or Simplify

1. Remove or hide raw `draft`/`needs-review` labels from primary UI.
2. Reduce always-visible issue chips to one primary issue.
3. Simplify the overflow menu.
4. Avoid duplicate pricing entry points without clear hierarchy.
5. Hide advanced filters behind an Advanced section.
6. Collapse admin-only cost/history/delete behind Admin section.
7. Remove decorative emoji/symbols from visible text where icons exist.
8. Avoid showing confidence controls where AI confidence does not affect action.

### 10.8 Screens That Should Be Redesigned

1. Review page: turn into Review Inbox and issue command center.
2. Item editor: progressive, issue-first editor with sticky action.
3. Upload completion: grouped outcome screen and batch review handoff.
4. Pricing: quick pricing flow for Review/No price, advanced still available.
5. Shop tab/sync center: operational health dashboard plus item-level recovery.
6. Overflow/More menu: grouped settings/action hub.
7. Filter sheet: smart views first, advanced facets second.
8. Admin category/field screens: safer schema-change workflow.

### 10.9 Components To Standardize

1. Product card.
2. Dense review row.
3. Issue pill/checklist.
4. Status badge.
5. Queue chip.
6. Empty state.
7. Error state.
8. Bottom sheet.
9. Sticky action footer.
10. Confirmation dialog.
11. Filter facet group.
12. Smart view chip.
13. Progress bar/job status.
14. Toast with action.
15. Price input/price preview.

## Prioritized Roadmap

### P0: Launch Polish And Trust

| Initiative | Impact | Effort | Notes |
| --- | --- | --- | --- |
| Fix corrupted copy/symbol strings | Very high | Low-medium | Required for premium perception |
| Humanize status labels | High | Low | Map DB values to UI labels |
| Add approval checklist to bulk/editor approve | Very high | Medium | Prevent bad inventory reaching shop |
| Persist AI/sync failures with retry | Very high | Medium | Turns failures into manageable work |
| Add queue-specific empty/error states | High | Low | Improves confidence immediately |
| Simplify overflow menu grouping | High | Low-medium | Reduces IA clutter |

### P1: Review And Workflow Excellence

| Initiative | Impact | Effort | Notes |
| --- | --- | --- | --- |
| Redesign Review as Inbox | Very high | Medium-high | Biggest product quality upgrade |
| Add per-item blocking checklist | Very high | Medium | Makes readiness obvious |
| Add Review sticky next action | High | Medium | Speeds mobile workflows |
| Add upload completion groups and Review this batch | High | Medium | Closes Add -> Review loop |
| Add quick price sheet scoped to visible/selected items | High | Medium | Reduces pricing friction |
| Redesign editor into sections | High | Medium | Reduces mobile overload |

### P2: Premium Power Features

| Initiative | Impact | Effort | Notes |
| --- | --- | --- | --- |
| Smart views and saved view promotion | High | Medium | Adds Notion-like flexibility without clutter |
| Command/action palette | Medium-high | Medium | Excellent for power users |
| Gesture accelerators for Review | Medium | Medium | Use as optional speed layer |
| AI consistency audits | High | Medium-high | Finds size/brand/category inconsistency |
| Shop health dashboard | High | Medium | Makes POS integration trustworthy |
| Design system documentation | Medium | Medium | Prevents UI drift |

### P3: Advanced Intelligence And Scale

| Initiative | Impact | Effort | Notes |
| --- | --- | --- | --- |
| Duplicate photo/SKU detection | High | Medium-high | Reduces catalog errors |
| Image quality checks | Medium-high | Medium-high | Prevents unusable product images |
| Batch templates | Medium | Medium | Speeds repeated upload sessions |
| Manager analytics | Medium | Medium | Useful after core workflows are polished |
| Role-specific home screen | Medium-high | Medium-high | Different defaults for admin/editor/viewer |

## Recommended First Build Sequence

1. Copy and terminology cleanup.
2. Review queue polish: priority header, friendly labels, one primary action per queue.
3. Approval checklist and persistent AI/sync error handling.
4. Editor sectioning with sticky action.
5. Upload completion handoff to Review.
6. Quick pricing from Review.
7. More/Settings restructuring.
8. Smart views and command palette.

## Final Assessment

The product has strong foundations and a clear opportunity to become a premium mobile-first inventory operations app. The most important next step is to stop treating Review as a filtered catalog and make it the central work management surface. If the app consistently answers "what needs attention, why, and what should I do next?", it will feel dramatically more polished, intelligent, and trustworthy.

The highest-return path is not a visual reskin. It is a workflow-led redesign: cleaner language, issue-first cards, persistent recovery queues, mobile sticky actions, and fewer places where the user has to infer system state.
