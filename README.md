# K-LINE MEN Catalog

> Repo: `Inventory-image-database` · App/brand name: **K-LINE MEN Catalog** (K-Line, a retail men's clothing shop)

A mobile-first PWA for reviewing a clothing inventory: browse product photos
alongside their data, edit fields fast (incl. bulk edits), upload new photos
from a phone with AI-assisted field pre-fill, group by category/subcategory,
and export the latest state to CSV. The catalog backend, database, private
image storage, authentication, and AI extraction are being consolidated on the
existing Railway POS service under ADR-062 and ADR-065.

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
- **Backend:** the existing POS Express API, PostgreSQL, POS JWT auth, private
  Railway object storage, and server-side OpenAI GPT-5.6 Terra integration. Set
  `VITE_CATALOG_API_URL` at build time to use this boundary.
- **Rollback compatibility:** leaving `VITE_CATALOG_API_URL` unset preserves the
  legacy backend during the approved observation window. It is a removal
  candidate, not the target architecture.
- **Security:** roles `admin` / `editor` / `viewer`; cost data isolated in
  `item_costs` with admin-only RLS (invisible to others even via the API).

## Railway migration status

The Railway slice includes POS login, effective catalog permissions,
branch-scoped catalog/reference-data reads, short-lived private image URLs,
authenticated photographed-unit intake, upload Undo, and AI extraction that
fills only empty fields and records usage, jobs, and item activity. The Home,
Catalog, Review, and permission-gated Add Images destinations are available in
Railway mode. Shop sync and general edit/cost/user-management/publish workflows
remain separately approved slices, so those unrelated controls stay masked.

For local migration-mode development, add this to `.env.local`:

```env
VITE_CATALOG_API_URL=http://localhost:5000/api
```

## Getting started
See [SETUP.md](SETUP.md).

## Source data (for seeding)
The 6 category folders and `pants_products.xlsx` hold the existing 242 photos
and their reviewed fields; `scripts/seed.mjs` (Phase 2) imports them. The
original local review tool (`build_review.py` → `review.html`) remains for
reference.
