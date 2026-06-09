# Backlog — feature history

All originally-planned phases and deferred extras are now built. This file is
kept as a record; add new ideas under "Open ideas" as they come up.

## ✅ Done

Core (Phases 1–6):
- Deployable PWA (Vite + GitHub Pages), Supabase auth/storage/RLS, private bucket.
- Seed importer + gallery (signed-URL thumbs, lightbox).
- Editing: controlled vocab + alias normalization, live SKU trigger, confidence
  badges, status workflow, audit triggers.
- Multi-category model (tree + per-category fields with inheritance).
- Capability-based permissions; cost isolated in `item_costs`; user-management UI.
- Multi-select (long-press / shift / slide-sweep), bulk status/delete, **bulk AI-fill**.
- Two-level grouping, then reworked into the **Find** faceted finder.
- CSV exports (catalogue + change log); keep-alive cron.

AI:
- Per-item "✨ AI suggest" + **bulk AI-fill** + **AI auto-fill on upload** (opt-in).
- Edge Function holds the key; OCR-first prompt; Opus default (model via
  `ANTHROPIC_MODEL`); placeholders ("unknown") stripped; scent-family inferred.

UX / polish:
- Premium gallery toolbar (filters sheet + pills, contextual selection bar,
  Delete in ⋯), account ⋮ menu, in-app **Categories & fields** manager.
- QoL: back-to-top, scroll-preservation, image skeletons, session filter memory,
  Esc, haptics. Large-batch uploader (preview grid, parallel, progress, retry,
  wake-lock, webcam capture).

Backlog close-out (this round):
- ✅ Currency setting (shared `app_settings`).
- ✅ Low-confidence triage dot + "Needs review" filter.
- ✅ Per-item audit history view.
- ✅ Price / date-range filters in Find.
- ✅ Desktop webcam capture.
- ✅ Cloud-synced saved views (`saved_views`, per-user).
- ✅ Offline-aware: offline banner, uploader auto-pause/resume on reconnect,
  edits blocked offline with a clear message. (Pragmatic version — a full
  IndexedDB write-queue with conflict→flag was consciously not built; revisit
  only if real-world offline use demands it.)

Review efficiency (2026-06-09 round):
- ✅ Triage gate fix (approved items no longer re-enter Review; `AI_BLIND_FIELDS`
  like `fit` excluded from the low-confidence signal).
- ✅ Bulk **Approve** as a first-class selection action (green ✓ + Undo toast).
- ✅ Dense **scan/report list** view (density toggle; Review defaults to it),
  Medium/Low fields tinted inline.
- ✅ Manual **calibration tool** (⋮ → Calibration check) → `calibration_marks`;
  accuracy-by-confidence report + one-tap approve of all-correct items.

## Open ideas (not requested)
- **Swipe-review card stack** (deferred from the 2026-06-09 review-efficiency
  round): full-screen, one item at a time, big photo + AI fields — swipe right to
  approve, left to flag, up (or tap a field) to fix inline; progress + Undo last;
  haptics. Targets the "needs a look" pile (Medium/Low-confidence items) as a
  faster alternative to the tap-card→sheet→back loop. Build only if review still
  feels slow after the calibration pass proves out confidence trust.
- Full offline write-queue (IndexedDB + conflict→flag) if offline editing is
  needed in the field.
- Shared (team-wide) saved views in addition to per-user.
- Thumbnail variants to cut image egress.

_Last updated: 2026-06-09._
