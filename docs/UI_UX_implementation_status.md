# UI/UX Redesign Implementation Status

Tracking file for the roadmap in `docs/UI_UX_reimagined.md`.

## Current Branch

- Branch: `feature/reimagined-ops-ui`
- Goal: implement the redesign blueprint fully, phase by phase, with tests and commits after each phase slice.

## Phase Checklist

- [x] Phase 0: Design-system foundation
  - Status: partially implemented.
  - Done: warmer palette tokens, shared heading letter-spacing cleanup, Today-specific component layer.
  - Outstanding: full component normalization and screenshot comparison across all major surfaces.
- [x] Phase 1: Today and navigation
  - Status: implemented.
  - Done: Today default landing surface, Catalog nav rename, five-tab nav, Today work counts, intake strip, shop pulse, activity bridge.
  - Outstanding: long-press work-card previews and permission-specific cost readiness counts.
- [x] Phase 2: Catalog and Review refresh
  - Status: implemented.
  - Done: visible Catalog smart-view shelves, saved-view shelf promotion, filter-sheet smart-view parity, shelf styling, refreshed tile and dense-row hierarchy, active Review queue brief and contextual actions, desktop preview pane, bulk-selection regression pass.
  - Outstanding: none.
- [x] Phase 3: Add and camera experience
  - Status: implemented.
  - Done: Add workbench intake summary, visible batch/category/AI state, shared-photo import banner, clearer upload progress and recovery actions, burst filmstrip AI-issue state, failed-AI routing into Review.
  - Outstanding: final real-device camera/share-target verification during block review.
- [x] Phase 4: Editor, readiness, and AI evidence
  - Status: implemented.
  - Done: editor Verify/Details/Selling/Activity/Admin structure, prominent Fix Mode treatment, readiness and approval guards, POS-owned field notice, AI evidence panel, persisted AI visible-text transcript, failed-AI evidence state.
  - Outstanding: migration deployment verification and live AI transcript verification during block review.
- [x] Phase 5: Pricing
  - Status: implemented.
  - Done: guided pricing entry points renamed to Build price rule, advanced pricing renamed to Group pricing table, POS-owned items skipped and explained in guided and advanced pricing flows, pricing CTA copy aligned across quick actions, review, approval, count-line shortcuts, and selection actions.
  - Outstanding: final block-review pricing regression around POS-owned skips, undo, preview, and cost mode.
- [x] Phase 6: Shop and Sync
  - Status: implemented.
  - Done: Shop recovery callout for stale/no-mirror/queued/sending/dirty/error/drift states, visible POS-only read-only rows, Today shop-sync bridge includes stale/missing mirror work, Sync Center renamed to Shop recovery, Health/Queue/Problems/Drift/Actions layout, manager-only sync actions, manual drift-check action.
  - Outstanding: final block-review state regression for queued, sending, dirty, error, in-shop, stale mirror, no mirror, and drift findings.
- [x] Phase 7: Admin and data tools
  - Status: implemented.
  - Done: Settings reorganized into Device & app, Shop settings, Data tools, and Admin; AI quality check and Catalog health check language applied; Recent activity source filters added; Users permission matrix safety notes added; Categories/Fields dependency context and delete warnings strengthened; Export CSV caps and scope made visible.
  - Outstanding: final block-review admin workflow checks for create/deactivate/reactivate users, capability edits, category/field edits, reference-data refresh, and export caps.
- [x] Phase 8: Intelligence layer
  - Status: implemented.
  - Done: non-blocking Add photo quality checks, Review AI issue grouping for failed/unread/field-confidence work, AI quality evidence-size reporting, and stock-intake session language reinforced in Add.
  - Outstanding: final block-review checks that AI suggestions do not overwrite protected values and Review remains the approval authority.

## Current Working Todo

- [x] Commit and push blueprint/mockup docs.
- [x] Commit and push Phase 1 implementation.
- [x] Implement Phase 2 Catalog/Review smart-view shelves.
- [x] Validate with unit tests and production build.
- [x] Commit and push Phase 2 slice.
- [x] Implement Phase 2 tile and dense-row hierarchy refresh.
- [x] Validate tile/row refresh with unit tests and production build.
- [x] Commit and push tile/row refresh slice.
- [x] Implement Phase 2 Review queue polish.
- [x] Validate Review queue polish with unit tests and production build.
- [x] Commit and push Review queue polish slice.
- [x] Implement Phase 2 desktop preview pane.
- [x] Validate preview pane and bulk-selection paths with unit tests and production build.
- [x] Commit and push Phase 2 completion slice.
- [x] Implement Phase 3 Add/camera workbench polish.
- [x] Validate Phase 3 slice with unit tests and production build.
- [x] Commit and push Phase 3 slice.
- [x] Implement Phase 4 editor readiness and AI evidence slice.
- [x] Validate Phase 4 slice with unit tests and production build.
- [x] Commit and push Phase 4 slice.
- [x] Implement Phase 5 pricing workflow language and POS-owned skip treatment.
- [x] Validate Phase 5 slice with unit tests and production build.
- [x] Commit and push Phase 5 slice.
- [x] Implement Phase 6 Shop floor report and Sync Center recovery polish.
- [x] Validate Phase 6 slice with unit tests and production build.
- [x] Commit and push Phase 6 slice.
- [x] Implement Phase 7 Settings and admin/data tool polish.
- [x] Validate Phase 7 slice with unit tests and production build.
- [x] Commit and push Phase 7 slice.
- [x] Implement Phase 8 intelligence layer polish.
- [x] Validate Phase 8 slice with unit tests and production build.
- [ ] Commit and push Phase 8 slice.
