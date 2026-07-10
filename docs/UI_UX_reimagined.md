# K-LINE MEN Catalog UI/UX Redesign Blueprint

Source-verified product/design document for a mobile-first retail operations PWA.

## Source Verification

This blueprint was written after inspecting the current app source, not from the old README status alone. The README still describes an early phased skeleton, but the source now contains the richer V3-era product surface: gallery, upload, burst capture, AI fill, review queues, swipe review, item editor, guided and advanced pricing, shop reports, POS sync center, activity history, calibration, consistency audit, export, users, categories, settings, install support, role/capability gates, hardening migrations, and Supabase Edge Functions.

The prompt requested these docs:

- `docs/V3_upgrade/UX_PRODUCT_AUDIT.md`
- `docs/V3_upgrade/V3_ROADMAP.md`
- `docs/V3_upgrade/V3.1_ASSESSMENT.md`
- relevant hardening docs

They are not present in this checkout under `docs`. The hardening intent was verified instead from `supabase/migrations/0027_security_hardening.sql`, `0028_edge_hardening.sql`, `0029_client_errors.sql`, `0030_active_enforcement.sql`, `supabase/config.toml`, and the Edge Function source.

Confirmed product invariants from source:

- The frontend is Vanilla JS plus Vite, backed by Supabase Auth, Postgres/RLS, Storage, and Edge Functions.
- The PWA is mobile-first and touch-first, with install support, safe-area handling, a static app shell, and bottom navigation.
- One photo equals one physical stock unit. Duplicate SKUs are intentional, and uploaded items default to one unit.
- Cost data is isolated in `item_costs`, protected by `can_view_cost`, RLS, redacted activity events, and admin-only UI paths.
- AI extraction runs through the `ai-extract` Edge Function. The browser never receives the provider API key.
- POS sync is mediated by `pos-push`, `pos-mirror`, and `pos-reconcile`; the POS owns live stock and price after push, while the catalog mirrors shop state.
- The role model is `admin`, `editor`, `viewer`, plus explicit capabilities: upload, edit, delete, view cost, and manage users.
- Sync, pricing, approval, bulk edit, AI fill, and destructive actions already carry recovery patterns such as Undo, confirmations, retry, or explicit blocking.

## 1. Product Diagnosis

K-LINE MEN Catalog is not a generic inventory gallery. It is a shop-floor operating system built around photographic evidence. The real loop is:

1. Photograph each physical unit.
2. Let AI identify what it can from the image.
3. Review and complete the item.
4. Price it.
5. Approve it.
6. Push it to the POS.
7. Monitor live shop health from the POS mirror.

The app serves four user modes:

- Owner/admin: wants control, cost protection, users, categories, pricing policy, POS health, exports, and auditability.
- Floor editor: adds stock, fixes AI reads, prices items, approves clean work, and recovers sync errors.
- Reviewer: clears uncertainty quickly from photos, confidence marks, and readiness queues.
- Viewer: checks catalog/shop state without being able to mutate sensitive workflows.

Core jobs to be done:

- "I have new stock in front of me; get it into the system without losing count."
- "Tell me what needs attention before it can be sold."
- "Help me price a pile consistently without touching every item."
- "Show me what is in the shop, what is low, what is sold out, and what is stuck."
- "Let me fix errors without guessing whether the POS or catalog is the source of truth."
- "Let me trust AI where it is proven and review it where it is uncertain."

Current strengths:

- The app already encodes serious operational rules: one-photo-one-unit, POS ownership after push, cost isolation, capability gates, undoable bulk edits, review queues, and sync recovery.
- The upload flow is unusually strong for a shop workflow: multi-photo batches, share-target import, burst capture, duplicate-frame warnings, upload progress, AI self-identification, and resumable offline handling.
- Pricing is product-aware: a guided sentence-builder for normal users and an advanced group-by tool for power users.
- Review and sync are already built around practical buckets rather than abstract database state.

Current UX problems:

- The app feels assembled from individually good tools rather than one cohesive operating environment.
- The first screen is a gallery, but the primary question for a manager is "what needs action today?"
- Important intelligence is scattered: AI confidence, readiness, POS state, sync freshness, activity, calibration, and consistency checks live in separate surfaces.
- Settings mixes account, tools, admin, export, sync, calibration, users, and categories; the logic is clear in code but not emotionally calm.
- The visual language leans on dark panels, teal accents, and small chips. It works, but it does not yet feel like a premium retail operations product.
- Empty, loading, offline, failed-AI, and failed-sync states exist, but they should become part of a designed operational grammar rather than one-off messages.

Design north star:

K-LINE MEN Catalog should feel like a premium retail floorbook: photo-led, calm, fast, tactile, and decisive. It should make a first-time user understand that every image is stock evidence, every status is a next action, and every POS number has a trustworthy owner.

## 2. Information Architecture

### Primary Navigation

Use five mobile tabs:

- Today
- Catalog
- Add
- Review
- Shop

Add remains centered and camera-forward. Review and Shop keep badges. Catalog becomes the browsing/archive surface. Today becomes the default landing surface and the place where work is prioritized.

Desktop/tablet adaptation:

- Use a left rail with the same five destinations.
- Keep Add as a prominent rail action.
- Show Today and Shop summaries side by side on wide screens.
- Let Catalog and Review use two-pane layouts: list/grid on the left, editor preview on the right.

### Today Surface

Today should answer "what needs action now?" in 10 seconds:

- New photos waiting for review
- Ready to approve
- Missing price
- AI issues
- Sync errors
- POS updates pending
- Running low
- Sold out
- Recent edits by staff

Every module on Today is an action card, not an analytics card. Tapping a number opens the exact filtered queue.

### Command Model

Keep the global command button, but make it a real command sheet:

- Add photos
- Open review queue
- Set prices
- Send to shop now
- Refresh shop numbers
- Run AI consistency audit
- Export CSV
- Users and permissions
- Categories and fields

Commands should be searchable on desktop and grouped on mobile. The command sheet is for actions; Settings is for configuration.

### Settings Structure

Settings should be reorganized into:

- Account: signed-in identity, role/capabilities, sign out.
- Appearance and install: theme, PWA install help, device status.
- Shop settings: currency, POS sync settings, category map, reorder defaults.
- Data tools: export, activity, calibration, consistency audit.
- Admin: users, permissions, categories, fields, vocabularies.
- Diagnostics: client errors, last sync runs, app build/version, Supabase configuration state.

Capability gates should hide unavailable actions where possible and explain denied actions where hiding would cause confusion.

## 3. Visual Design Direction

### Mood

The product should feel like a retail operations floorbook, not a SaaS dashboard. The visual language should be:

- Image-led: product photos are the main texture of the app.
- Calm: the default state is quiet; attention states are precise.
- Premium: surfaces feel deliberate, not stacked.
- Operational: status colors always mean something.
- Tactile: touch feedback is fast, small, and consistent.

### Layout Principles

- Start with photos, then decisions, then metadata.
- Treat every screen as a work surface with one primary question.
- Keep repeated item rows dense but legible.
- Use full-width bands and tool surfaces. Avoid nesting cards inside cards.
- Make bottom sheets task-specific and predictable.
- Use 44px minimum hit targets for all primary controls.
- Preserve one-handed mobile use for Add, Review, and Shop recovery.

### Palette

Move away from a one-note dark teal look. Use a wider but disciplined system:

- Base: warm black or soft graphite for dark mode; porcelain/off-white for light mode.
- Primary: deep petrol for primary actions and navigation.
- Success: leaf green for approved/ready.
- Warning: amber for AI doubt, stale sync, and review attention.
- Danger: cranberry for destructive or failed sync.
- Insight: violet/indigo only for AI-specific affordances.
- Neutral: blue-gray/slate for chrome, dividers, and secondary text.

Do not use color alone. Pair every state with label text, icon, shape, or position.

### Typography

Keep Inter as the practical base. Use:

- Compact 13-15px body text for operational density.
- 16-18px section titles on mobile.
- Larger numeric counters only on Today and Shop, where numbers are the content.
- No negative letter spacing in implementation; use weight, size, and spacing instead.

### Image Treatment

- Product photos should be clean, contained, and inspectable.
- Catalog tiles use squared image areas with soft matte backgrounds.
- Review and editor photos prioritize object-fit contain so tags and labels remain readable.
- Shop rows use cropped thumbnails because the task is recognition, not inspection.
- AI and sync overlays should sit beside images, not over critical product details.

### Motion

Motion should communicate state change:

- Add: shutter flash, captured tile arrival, progress movement.
- Review: card swipe, approval/flag/fix transitions.
- Pricing: step transitions and preview grouping.
- Sync: running states and count refresh.
- Undo: toast action with visible rollback.

Respect reduced-motion preferences. Haptics remain short and purposeful.

## 4. Screen-by-Screen Specs

### Login

Goal: feel like a private shop tool, not a public landing page.

Mobile spec:

- Full-screen centered sign-in panel with the brand and one concise value line: "Photograph stock. Review AI. Send ready items to the shop."
- Email and password fields with show/hide password.
- Forgot password remains admin-mediated, but make the guidance shorter and clearer.
- If Supabase is not configured, show a setup diagnostic screen as the current app does.

States:

- Loading session
- Sign-in error
- Offline
- Deactivated account
- Setup missing

### First Run and Empty Catalog

Goal: teach the product loop without a marketing page.

Empty Today:

- "No stock photos yet"
- Primary action: Add photos
- Secondary actions: create categories, invite users, set currency
- Three-step loop: Add photos, review fields, price and send to shop

Empty Catalog:

- Grid placeholder using real product-photo framing, not generic icons.
- Clear call to Add.

Empty Shop:

- Explain that approved/priced items appear after POS sync.
- Offer "Open Sync Center" only to managers/admins.

### Today

Mobile layout:

- Top summary band: "Today" plus sync freshness and signed-in role chip.
- Primary work stack:
  - Needs work
  - Missing price
  - Ready to approve
  - AI issues
  - Shop issues
- Shop pulse:
  - sold today
  - sold this week
  - running low
  - sold out
- Recent activity strip: latest human/AI/sync changes.

Interactions:

- Tapping a work card opens the exact filtered Review or Sync Center.
- Long press on a work card previews the first few items.
- Admins see cost readiness counts; editors see only "cost required" or "cost present" without values.

Desktop:

- Two columns: Work queue left, Shop pulse right.
- Recent activity spans full width below.

### Catalog

Goal: browse and find inventory fast.

Mobile spec:

- Search at top, filter button, density toggle, saved views.
- Default grid is photo-forward.
- Dense list mode is for scanning decisions: thumbnail, brand/name, AI doubts, price, POS state, status.
- Item tile hierarchy:
  - Photo
  - Brand/name
  - Category attributes
  - Price or missing-price marker
  - Status/issue chips
  - POS chip

Filters:

- Smart views first: Missing price, AI doubt, Ready, In shop, Sync error, Recently edited.
- Then category, brand, status, shop state, price, date, custom facets.
- Saved views should be surfaced as "shelves" rather than buried in filter detail.

Bulk actions:

- Enter selection via long press or Select.
- Sticky bottom action bar: Approve, AI fill, Edit, Price, More.
- Every reversible bulk action gets Undo. Hard delete requires explicit confirmation.

Desktop:

- Left filter rail, main grid/list, optional item preview pane.

### Add Photos

Goal: keep count while moving quickly through physical stock.

Mobile spec:

- Primary actions: Take photo, Choose photos, Burst capture.
- Category must be selected before burst because AI self-identification needs context.
- Batch defaults should be visually clear: category, brand/common fields, status, AI fill toggle.
- Uploaded count, failed count, AI issue count, and remaining count remain visible.

Burst capture:

- Full-screen camera.
- Shutter center, Undo left, Done right.
- Filmstrip shows latest captures with states: saving, reading, identified, failed, possible duplicate.
- AI label format: brand plus product name, with a small confidence dot.
- Duplicate warning supports one-photo-one-unit without blocking legitimate identical stock.

Share target:

- Imported photos should open Add with a banner: "Shared photos ready to add."
- After import, clear shared cache as the current code does.

Failure/recovery:

- Offline before upload: keep batch, show reconnect instruction.
- Offline mid-upload: pause and auto-resume.
- AI failure: keep uploaded item, record job failure, route to Review AI issues.
- Oversized photo: explain compression failure and ask for smaller image.

### Item Editor

Goal: verify one item with photo, readiness, selling state, and audit context in one place.

Mobile spec:

- Full-screen sheet with sticky header and footer.
- Header: Cancel, category title, Save.
- Photo stays near top with tap-to-zoom.
- Readiness panel is the first decision surface: Ready, Blocked, Warning.
- "Show only fields to fix" should become a prominent Fix Mode toggle.
- Details section: name, brand, category fields, confidence pills.
- Selling section: retail price, stock receipt, reorder level, POS life line.
- Activity section: source-aware changes.
- Admin section: cost and SKU metadata, visible only where allowed.

Key rule:

- Once an item is synced to POS, price and live stock are not edited here. The editor can show the original catalog price/receipt and direct the user to POS where appropriate.

Approval:

- "Save and approve" is available only when readiness passes.
- AI warnings require confirmation that the user checked them.
- Missing price or missing required fields blocks approval and scrolls to the issue.

Destructive:

- Delete explains that POS products are not removed and stock is not changed there.
- Multi-delete in Catalog still requires typed confirmation.

Desktop:

- Two-pane editor: large photo on the left, fields and readiness on the right.
- Activity can become a side rail.

### Review

Goal: turn uncertainty into decisions.

Queues:

- Needs work
- AI checks
- Missing details
- Missing price
- Sync issues
- Recently edited
- Ready to approve

Mobile spec:

- Review is a filtered catalog surface by default.
- Queue tabs are horizontally scrollable, with counts.
- Count line includes contextual CTA: Set prices, Open first, Swipe review, Approve all.
- Ready queue should feel like a final inspection bench.

Swipe review:

- One card at a time.
- Left: Flag.
- Right: Approve when allowed.
- Up: Fix.
- Buttons mirror gestures for reliability.
- Undo restores last approve/flag.
- Card shows photo, title, category, price/missing price, and primary readiness issue.

### Pricing

Goal: let staff price how they think, while protecting existing prices and POS-owned prices.

Guided pricing:

- Keep as the default path.
- Reframe as "Build a price rule":
  - What group?
  - Standard price
  - Exceptions
  - Check tags
  - Apply
- Show photo strips and affected counts at every step.
- Keep existing prices protected by default for whole-catalog pricing.
- In selection mode, assume overwrite may be intentional but still preview risky changes.
- Admins can set cost alongside retail when allowed.

Advanced pricing:

- Keep for power users.
- Rename to "Group pricing table."
- Make grouping chips, scope, split bands, cost/retail toggle, and selection mode clearer.
- Show "POS-owned items skipped" wherever relevant.

Recovery:

- All pricing writes remain undoable.
- Risky spans across multiple subcategories require preview confirmation.
- Cost Undo must restore prior values without wiping real cost data.

### Shop

Goal: answer floor questions from the POS mirror.

Mobile spec:

- Shop freshness bar at top: as-of time, stale warning, refresh.
- Health strip: In shop, queued, sending, update needed, shop issues.
- Today at shop: sold today, sold this week, products in stock.
- Sections:
  - Running low
  - Sold out
  - Best sellers
  - Sleepers
  - Waiting to go to shop

Rows:

- Thumbnail, title, human SKU caption, price, metric.
- Tapping a represented row opens the editor.
- POS-only rows without catalog representation are visibly read-only.

Desktop:

- Dashboard grid with Shop health, Best sellers, and Running low visible without scrolling.
- Filters remain sticky.

### Sync Center

Goal: make POS recovery understandable without exposing implementation noise.

Structure:

- Health: push, mirror, reconcile.
- Queue: waiting, sending, dirty, errors.
- Problems: item-level errors with Open.
- Drift report: missing receipts, double receipts, oversold stock, retired variants.
- Actions: Send to shop now, Retry shop issues, Refresh shop numbers.

Language:

- Use shop terms: "Send to shop", "Shop numbers", "Drift check."
- Keep technical error detail visible but secondary.

Rules:

- Only managers/admins can run sync.
- Manual sync uses the signed-in JWT; cron uses the invoke key.
- Stale mirror is a visible warning because silence means the floor may be seeing old data.

### Activity and Audit Trail

Goal: build trust in who changed what.

Global activity:

- Date-bucketed feed.
- Row shows item name, source pill, change summary, relative time.
- Cost changes show "Cost updated" without values.
- Tapping opens the item editor.

Item activity:

- Keep the editor preview, with "View full activity."
- Separate human edits, AI fills, pricing, approvals, undo, uploads, shop/system.

Audit export:

- Keep CSV export for current catalog and change log.
- Warn clearly if export caps are hit.

### Calibration and Consistency

Calibration:

- Position as "AI quality check."
- One photo at a time.
- Mark each AI field Correct/Wrong.
- End with confidence accuracy and approval suggestion.
- Keep "High confidence can be trusted" language conditional on enough marked evidence.

Consistency audit:

- Position as "Catalog health check."
- Surface brand variants, size normalization, missing details, AI checks, duplicate SKUs, and price outliers.
- Make actionable rows open Review queues or filtered Catalog.
- Keep it read-only.

### Users, Permissions, Categories, Fields

Users:

- Preserve presets: admin, editor, viewer, custom.
- Show capabilities as a matrix.
- Prevent self-lockout clearly.
- Deactivation should explain that DB access is enforced by active-aware RLS.

Categories and fields:

- Treat this as a structured admin screen, not a bottom-sheet utility.
- Use a tree on the left and detail editor on the right for desktop.
- On mobile, keep the drill-in screen pattern.
- Warn before deleting fields/categories and explain dependencies.

Settings:

- Currency belongs under Shop settings.
- Appearance and install are device/app preferences.
- Export, activity, calibration, consistency are Data tools.

### Offline, Permission, and Failure States

Offline:

- Global banner remains.
- Add keeps selected batch.
- Editor disables Save and keeps form state.
- Delete and sync actions are blocked until online.

Permission denied:

- Viewers should see read-only controls, not dead editable fields.
- Hidden admin actions should be discoverable only where helpful: "Ask an admin for access."

Failed upload:

- Show failed count, first error, retry remaining.

Failed AI:

- Item stays saved.
- Job failure is recorded.
- Review AI issues queue opens affected items.

Failed sync:

- Shop badge turns into a problem badge.
- Sync Center shows run state, item errors, and retry.

Destructive actions:

- Reversible actions use Undo.
- Irreversible actions use explicit confirmation.
- Multi-item deletion requires typing DELETE.

## 5. Key Interaction Specs

### Gestures

- Long press: enter selection mode in Catalog and advanced pricing.
- Drag sweep: select multiple groups/items where already supported.
- Swipe card: approve/flag/fix in Review.
- Tap photo: lightbox inspection.
- Tap active tab: scroll to top.
- Pull-to-refresh should be added only where it cannot conflict with app-shell scrolling; a visible refresh button remains required.

### Transitions

- Sheet opens from bottom on mobile, centered modal on larger screens.
- Full-screen tools slide/fade with a stable header/footer.
- Review card exits in the direction of the action.
- Pricing steps progress horizontally or crossfade; do not animate large grids heavily.
- Sync actions show running state inline on the button.

### Undo and Recovery

- Undo toasts remain bottom-centered above nav and stay tappable.
- Undo must be offered for approval, bulk edit, pricing, and reversible status changes.
- Deletion, user deactivation, and category/field deletion require confirmation because they are not safely undoable in the current model.

### Haptics

- Short tap for selection and field verdicts.
- Double pulse for successful batch operations.
- Warning pulse for duplicate burst capture.
- No haptics for passive navigation.

### Camera Flow

- Category first for burst.
- Live capture remains full-screen.
- Filmstrip is the source of truth for saved units.
- Undo must remove the saved row and photo if upload already completed.
- If undo deletion fails, keep the unit visible and explain that it is still saved.

### Review Flow

- The default Review view supports batch work.
- Swipe review is for focused triage, not a replacement for queues.
- Approval never bypasses price/readiness blockers.
- AI warnings require human acknowledgement.

### Pricing Flow

- Guided pricing is the default.
- Advanced pricing is an escape hatch.
- POS-owned synced prices are skipped and explained.
- Risky overwrites require preview.
- All writes are grouped and undoable.

## 6. Component System

### Navigation

- Bottom nav: five destinations, icon plus label, 44px minimum target.
- Badges:
  - Review badge: work count.
  - Shop badge: sync/problem count.
- Desktop rail uses the same labels and icons.

### Buttons

- Primary: one per work surface.
- Ghost: secondary or navigation.
- Danger: destructive.
- Icon buttons: close, back, menu, command, refresh, camera, grid/list, search.
- Loading buttons must keep width stable.

### Chips and Pills

- Status pills: Draft, Needs review, Approved, Flagged.
- Issue pills: AI check, Missing price, Missing detail, Sync issue, Ready.
- POS chips: In shop, Sold out, Retired, Queued, Sync error, Update pending.
- Source pills: Upload, AI, Manual, Bulk, Pricing, Approval, Undo, Shop/System.

### Sheets and Dialogs

- Bottom sheets for short tasks and pickers.
- Full-screen sheets for editor, pricing, calibration, category manager.
- Dialogs for confirmation and prompt.
- Every overlay traps focus and supports Escape/back behavior.

### Item Tiles

Grid tile:

- Stable image box.
- Brand/name line.
- Attribute summary.
- Price/missing price.
- Status/issues/POS chip line.

Dense row:

- 56px thumbnail.
- Title and category summary.
- AI doubt highlights.
- Price/POS/status at right.

### Forms

- Labels always visible.
- Numeric inputs use numeric/decimal keyboards.
- Confidence controls are buttons with explicit aria labels.
- Disabled fields explain why where the reason is not obvious.

### Readiness Indicators

- Use a readiness panel, not just chips.
- States:
  - Ready to approve
  - Blocked
  - Warning
  - Already approved
- Each state includes the next action.

### Confidence Indicators

- High/Medium/Low indicators use color plus letter/label.
- AI-blind fields should not create distracting confidence warnings.
- Tapping a confidence mark in editor cycles level only for editors.

### Sync Indicators

- Global Shop badge for errors/dirty updates.
- Freshness line where mirror data is shown.
- Sync Center health rows for loops.
- Item-level POS chip for each card.

### Skeletons, Empty, Error, Retry

Every async surface must define:

- Loading skeleton or spinner
- Empty state
- Error message
- Retry action
- Permission-denied state
- Offline state where applicable

## 7. AI-Forward Enhancements

AI should feel intelligent, but never authoritative over human review or POS truth.

Must remain true:

- AI calls only through the Edge Function.
- Provider secrets never reach the browser.
- AI only suggests fields.
- Existing values are not overwritten in safe AI fill modes.
- AI-filled drafts are promoted into review.
- Confidence and calibration remain visible.

AI moments to improve:

- Add "AI read from photo" evidence panel in editor showing filled fields, confidence, and visible text when available.
- In burst capture, show a compact "recognized as" label for each unit.
- In Review, group AI issues by kind: low confidence, failed AI, missing AI, conflict/outlier.
- In Catalog, make AI doubts visually scannable without overwhelming the card.
- In Calibration, show whether current High-confidence accuracy supports faster approval.
- In Consistency Audit, make "Fix now" actions route to exact queues.

Where AI must stay subordinate:

- Price setting: AI can suggest anchors from catalog history, not invent retail prices.
- Approval: AI confidence can reduce friction only when calibration supports it.
- POS sync: AI has no role in live stock or POS price truth.
- Cost: AI must not expose or infer cost values for non-admins.

## 8. New Capability Ideas

### Must Have

- Today operations landing surface.
- Reorganized navigation: Today, Catalog, Add, Review, Shop.
- Unified state language for readiness, AI confidence, and POS sync.
- Redesigned settings/admin structure.
- Screen-level empty/error/offline/retry states.
- Editor Fix Mode promoted as a primary workflow.
- Better Shop/Sync bridge from Today and Shop badges.
- Source-verification documentation kept current as features ship.

### High Leverage

- Smart shelves: saved views promoted into named operational shelves.
- Batch "fix assistant" that walks through only missing or doubtful fields.
- Photo quality gate before upload: blur, crop, glare, duplicate, tag unreadable.
- AI visible-text transcript stored with job metadata for auditing.
- Stock intake sessions: a named batch with count, category, uploader, and review progress.
- POS drift resolution workflow with guided actions for missing receipt, double receipt, oversold, retired.
- Reorder planning from Running low plus sell-rate.
- Markdown candidates from sleepers and price outliers.
- Staff task assignments for review/pricing/sync recovery.

### Future Bets

- Demand forecasting from POS mirror history.
- Purchase-order/restock suggestions.
- In-app label/price-tag print preparation after approval.
- Computer vision duplicate/SKU matching before creating new items.
- Natural-language command search over catalog and shop state.
- Guided onboarding mode for new staff with restricted workflow steps.
- Multi-store POS mirror if K-LINE expands.

## 9. Accessibility and Performance Requirements

Accessibility:

- All primary touch targets are at least 44px.
- No hover-only information.
- Keyboard users can reach every control.
- Focus stays trapped in overlays and returns sensibly on close.
- Color contrast meets WCAG AA for text and controls.
- Status never depends on color alone.
- Reduced-motion preferences are respected.
- Form labels are persistent.
- Toasts with actions remain reachable long enough to use.
- Lightbox images have useful alt/caption text.

Performance:

- Keep signed URL batching and thumbnail caching.
- Keep content-visibility for large grids and add virtualization if catalog size grows beyond smooth scrolling.
- Avoid re-rendering entire grids when one item can be patched.
- Keep app shell scroll architecture to prevent mobile viewport jump.
- Continue compressing images before upload.
- Cap exports and reports with visible truncation warnings.
- Keep Edge Function calls concurrency-limited.
- Cache reference data and refresh only after admin changes.

Security and data integrity:

- Preserve RLS as the source of truth.
- Preserve cost isolation and cost redaction.
- Preserve active-account enforcement.
- Preserve append-only audit guarantees.
- Preserve POS sync single-flight lock and receipt idempotency.
- Never allow browser-side AI provider keys.

## 10. Phased Implementation Plan

### Phase 0: Design-System Foundation

Scope:

- Define tokens for color, spacing, type, radius, elevation, status, and motion.
- Normalize component shapes across buttons, chips, cards, sheets, lists, and dialogs.
- Keep current behavior intact.

Risk:

- Visual churn could regress dense workflows.

Validation:

- Compare mobile screenshots for Login, Catalog, Add, Review, Editor, Shop, Sync Center.
- Run existing unit tests.
- Manual touch check on phone viewport.

### Phase 1: Today and Navigation

Scope:

- Add Today as the default surface.
- Change bottom nav to Today, Catalog, Add, Review, Shop.
- Move current gallery route to Catalog.
- Surface work counts from readiness and sync state.

Risk:

- Badge/count disagreements if Today uses different predicates.

Validation:

- Today counts must match Review, Shop, and Sync Center counts.
- Test empty, populated, and permission-limited accounts.

### Phase 2: Catalog and Review Refresh

Scope:

- Redesign item tiles and dense rows.
- Refine filter sheet into smart views plus facets.
- Promote saved views as shelves.
- Refresh Review queues and count-line CTAs.

Risk:

- Selection and bulk actions are high-value and easy to disrupt.

Validation:

- Long press, drag select, bulk edit, bulk approve, bulk AI, delete, undo.
- Verify AI doubt and POS chips remain accurate.

### Phase 3: Add and Camera Experience

Scope:

- Refine Add layout, batch defaults, import banner, and progress states.
- Improve burst capture filmstrip language and AI label states.
- Add clearer failed-AI routing.

Risk:

- Camera/browser API differences on mobile.

Validation:

- Android Chrome, iOS Safari fallback, desktop file upload, share target, offline pause/resume.

### Phase 4: Editor, Readiness, and AI Evidence

Scope:

- Redesign editor around Verify, Details, Selling, Activity, Admin.
- Promote Fix Mode.
- Add AI evidence panel where job metadata supports it.
- Clarify POS-owned fields.

Risk:

- Approval and cost gates are sensitive.

Validation:

- Viewer read-only, editor no-cost, admin cost-visible.
- Missing price, missing required fields, AI warnings, synced POS item, failed AI job.

### Phase 5: Pricing

Scope:

- Re-skin guided pricing as a price-rule builder.
- Improve advanced pricing table clarity.
- Make skipped POS-owned items and overwrite protection more visible.

Risk:

- Pricing touches money and many records.

Validation:

- Selection pricing, category pricing, exceptions, cost mode, undo, risky preview, POS-owned skip.

### Phase 6: Shop and Sync

Scope:

- Redesign Shop as a floor report.
- Strengthen Sync Center recovery paths.
- Add Today bridge to sync/drift findings.

Risk:

- POS mirror freshness and sync counts must remain truthful.

Validation:

- Queued, pending, dirty, error, in-shop, stale mirror, no mirror, drift findings.

### Phase 7: Admin and Data Tools

Scope:

- Reorganize Settings.
- Improve Users, Categories/Fields, Export, Activity, Calibration, Consistency.
- Add diagnostics surface for client errors and sync runs.

Risk:

- Admin changes affect reference data app-wide.

Validation:

- Create/deactivate/reactivate users, edit capabilities, manage categories/fields, refresh ref data, export caps.

### Phase 8: Intelligence Layer

Scope:

- Add photo quality checks, smarter AI issue grouping, better calibration reporting, and stock intake sessions.

Risk:

- Intelligence features must not imply false certainty.

Validation:

- AI suggestions never overwrite protected values without explicit action.
- Calibration claims require enough evidence.
- Review queues remain the final authority before approval.

## Closing Product Principle

The redesign should not make K-LINE MEN Catalog look more decorative. It should make the app feel inevitable for the work: a camera-first, photo-led, AI-assisted, POS-aware retail operations tool where the next action is always obvious and the risky actions are always protected.
