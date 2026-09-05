# K-LINE MEN Catalog

> Repo: `Inventory-image-database` · App/brand name: **K-LINE MEN Catalog** (K-Line, a retail men's clothing shop)

A mobile-first PWA for reviewing a clothing inventory: browse product photos
alongside their data, edit fields fast (incl. bulk edits), upload new photos
from a phone with AI-assisted field pre-fill, group by category/subcategory,
and export the latest state to CSV. The catalog backend, database, private image
storage, authentication, and AI extraction run through the Railway POS service.

## Status
The Railway PWA supports POS username/password authentication, branch-scoped
Home/Catalog/Review views, restart-safe photo intake, AI fill, stock-lot review,
variant pricing, and idempotent POS publication. Unsupported legacy controls are
not exposed.

## Stack
- **Frontend:** Vite + vanilla JS/ES modules (no framework), dark theme.
- **Backend:** the existing POS Express API, PostgreSQL, POS JWT auth, private
  Railway object storage, and server-side OpenAI GPT-5.6 Terra integration. Set
  `VITE_CATALOG_API_URL` at build time to use this boundary.
- **Security:** POS JWT authentication, branch-scoped permissions, private
  server-only bucket credentials, and short-lived image URLs.

## Railway migration status

The Railway service includes POS login, effective catalog permissions,
branch-scoped catalog/reference-data reads, short-lived private image URLs,
authenticated photographed-unit intake, upload Undo, AI extraction that
fills only empty fields and records usage, jobs, and item activity. The Home,
Catalog, Review, and permission-gated Add Images destinations are available in
Railway mode, stock breakdown confirmation, pricing, and publication.

For local development, add this to `.env`:

```env
VITE_CATALOG_API_URL=http://localhost:5000/api
```

## Getting started
See [SETUP.md](SETUP.md).

## Historical source data

The category folders, `pants_products.xlsx`, migration scripts, and original
local review tool remain only as reconciliation/rollback evidence. They are not
part of the deployed browser import graph and are cleanup candidates after the
production retirement gate in ADR-070 is complete.
