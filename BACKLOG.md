# Backlog — deferred features & future phases

A running list of things intentionally left out so far, so we remember to pick
them up. Grouped by "deferred" (consciously skipped during a phase) and
"planned" (upcoming phases from the project plan).

## Deferred (skipped for now, revisit in a dedicated phase)

- **Cloud-synced saved views** — the Find tab's saved views are currently stored
  per-device (localStorage). Move them to a Supabase table so they sync across
  phone + desktop. Could also add price/date range facets to the finder.

- **Offline write-queue** — _deferred from Phase 4._ The app shell opens
  offline, but edits and uploads currently require a connection. Plan: queue
  changes in IndexedDB and sync on reconnect; on conflict (server row changed),
  mark the item `flag`.
- **Desktop webcam capture** — taking a photo with a laptop/desktop camera
  (via `getUserMedia`). Today "Take photo" uses the device camera on phones;
  on desktop the picker opens files only.
- **In-app category & field editor** — admins currently define categories and
  their fields via the SQL seed config (`0003_seed_categories.sql`). A future
  self-service UI would let admins add/edit categories and fields in the app.
- **Low-confidence triage cues** — an amber dot on cards that have any
  low-confidence field, plus a "needs review" filter (status flag/needs-review
  OR any low-confidence field). Offered, not yet built.
- **Currency setting** — prices show as plain numbers (e.g. `90,000`) with no
  currency symbol. Add a configurable currency prefix (e.g. `UGX`).
- **Audit history view** — the `audit_log` table records every change; surface
  a per-item history view in the UI and a corrections-CSV export.

## Planned (next phases)

- **Phase 5 — AI auto-fill.** _Per-item version done_ — the edit sheet has an
  "✨ AI suggest" button (Anthropic vision via the `ai-extract` Edge Function).
  Follow-ups still open:
  - **Bulk AI fill** — run the model across many selected items / all blanks at
    once (queue + progress), the real time-saver for backfilling 200+ fields.
  - **AI on upload** — auto-run extraction as photos are uploaded so new stock
    arrives pre-filled.
- **Phase 6 — bulk ops, grouping, export, polish.**
  - ✅ Multi-select (long-press / shift-range / slide-sweep) + bulk AI-fill.
  - ✅ User-management screen (capabilities).
  - ✅ Keep-alive cron (`.github/workflows/keepalive.yml`, pings Supabase every 3 days).
  - ✅ CSV export (current catalogue + change log) — Export tab.
  - ✅ Bulk status change + bulk delete on the selection bar.
  - ✅ Two-level grouping (Groups tab: pick two dimensions, collapsible, counts).

**Phase 6 complete.** Remaining work is all in "Deferred" above (AI-on-upload,
offline queue, desktop webcam, in-app field editor, triage dot, currency,
custom date range, audit history view).

_Last updated: 2026-06-06 (after Phase 4)._
