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

## Open ideas (not requested)
- Full offline write-queue (IndexedDB + conflict→flag) if offline editing is
  needed in the field.
- Shared (team-wide) saved views in addition to per-user.
- Thumbnail variants to cut image egress.

_Last updated: 2026-06-07._
