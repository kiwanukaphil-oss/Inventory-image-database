# Backlog — deferred features & future phases

A running list of things intentionally left out so far, so we remember to pick
them up. Grouped by "deferred" (consciously skipped during a phase) and
"planned" (upcoming phases from the project plan).

## Done since this list was written
- ✅ In-app category & field editor (⋮ → Categories & fields).
- ✅ Bulk AI-fill (selection + filtered).
- ✅ Account ⋮ menu; premium gallery toolbar; QoL (back-to-top, scroll-keep,
  skeletons, filter memory, Esc, haptics); large-batch uploader; AI quality
  (Opus, OCR-first, no "unknown" placeholders).

## Remaining (open)

Quick wins:
- **Currency setting** — prices show as plain numbers (e.g. `90,000`); add a
  configurable currency prefix (e.g. `UGX`).
- **Low-confidence triage cues** — an amber dot on cards with any low-confidence
  field + a "needs review" filter (status flag/needs-review OR any low-conf field).
- **Audit history view** — per-item change history (the `audit_log` is already
  populated; change-log CSV export already exists — this is the in-app view).
- **Price / date-range facets** in the Find tab.
- **Desktop webcam capture** — "Take photo" on a laptop via `getUserMedia`
  (today desktop opens the file picker; camera works on phones).

Larger / optional:
- **Cloud-synced saved views** — Find's saved views are per-device (localStorage);
  move to a Supabase table so they sync across phone + desktop.
- **AI auto-fill on upload** — auto-run extraction as photos upload so new stock
  arrives pre-filled (per-photo cost; uses the configured model).
- **Offline write-queue** — edits/uploads while offline, queued in IndexedDB and
  synced on reconnect; on conflict (server row changed) mark the item `flag`.
  (Largest build.)

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

**Phases 1–6 complete.** Remaining work is the "Remaining (open)" list above.

_Last updated: 2026-06-07._
