# K-LINE MEN Catalog

> Repo: `Inventory-image-database` · App/brand name: **K-LINE MEN Catalog** (K-Line, a retail men's clothing shop)

A mobile-first PWA for reviewing a clothing inventory: browse product photos
alongside their data, edit fields fast (incl. bulk edits), upload new photos
from a phone with AI-assisted field pre-fill, group by category/subcategory,
and export the latest state to CSV. Backed by Supabase, deployed on GitHub Pages.

## Status
Built in phases (see [`plans`](#) / `SETUP.md`):

- **Phase 1 — deployable skeleton:** Vite app, email login, role-aware shell,
  empty gallery reading from Supabase, GitHub Pages deploy. ← _current_
- Phase 2 — seed importer + read-only gallery
- Phase 3 — editing, controlled vocab, SKU derivation, audit log, status
- Phase 4 — PWA install + camera upload + image compression + offline queue
- Phase 5 — AI auto-fill (Anthropic, via Supabase Edge Function)
- Phase 6 — bulk ops, two-level grouping, CSV export, user management

## Stack
- **Frontend:** Vite + vanilla JS/ES modules (no framework), dark theme.
- **Backend:** Supabase — Postgres + RLS, Storage (private), Auth, Edge Functions.
- **Security:** roles `admin` / `editor` / `viewer`; cost data isolated in
  `item_costs` with admin-only RLS (invisible to others even via the API).

## Getting started
See [SETUP.md](SETUP.md).

## Source data (for seeding)
The 6 category folders and `pants_products.xlsx` hold the existing 242 photos
and their reviewed fields; `scripts/seed.mjs` (Phase 2) imports them. The
original local review tool (`build_review.py` → `review.html`) remains for
reference.
