# Railway Catalog Setup

The catalog PWA has one runtime backend: the existing Railway POS API. Database,
object-storage, AI-provider, and signing credentials stay in the backend service
and must never be added to this browser repository.

## Local development

1. Start the POS backend and confirm `GET /api/health` succeeds.
2. Copy `.env.example` to `.env`.
3. Set `VITE_CATALOG_API_URL` to the POS API root, including `/api`.
4. Install and run the PWA:

```bash
npm ci
npm run dev
```

For the default local backend, use:

```env
VITE_CATALOG_API_URL=http://localhost:5000/api
```

Sign in with a POS account that has catalog permissions and a branch assignment.
The application should expose Home, Catalog, Review, and permission-gated Add.

## Railway backend configuration

The POS backend owns the PostgreSQL connection and the shared private Railway
bucket. Configure these in the Railway backend service:

- `DATABASE_URL` or the documented `DB_*` variables
- `JWT_SECRET`
- `CATALOG_BUCKET`
- `CATALOG_BUCKET_ENDPOINT`
- `CATALOG_BUCKET_ACCESS_KEY_ID`
- `CATALOG_BUCKET_SECRET_ACCESS_KEY`
- optional `CATALOG_BUCKET_REGION`, `CATALOG_BUCKET_URL_STYLE`, and
  `CATALOG_IMAGE_URL_TTL_SECONDS`
- the server-side OpenAI variables documented by the POS backend
- `CORS_ORIGINS`, including the deployed catalog origin

Both catalog and POS product images use this bucket with separate
`catalog-items/` and `pos-products/` namespaces. Clients receive only short-lived
signed image URLs.

## GitHub Pages deployment

1. In repository Settings → Secrets and variables → Actions, create the single
   browser build secret `VITE_CATALOG_API_URL` with the production Railway API
   root.
2. In Settings → Pages, select GitHub Actions as the source.
3. Push to `main` only after the local test, build, and Railway-only checks pass.

The workflow runs tests, historical migration invariants, a dependency audit,
the production build, and `npm run verify:railway-only` before publishing.

## Verification

Run:

```bash
npm test
npm run test:db
npm run build
npm run verify:railway-only
npm audit --omit=dev --audit-level=high
```

Then verify in a browser:

- POS username/password login succeeds.
- Branch selection matches the signed-in account.
- Home, Catalog, Add, and Review load from the Railway API.
- Browser requests contain no legacy provider hostname.
- Uploaded and catalog images are returned as short-lived signed URLs; bucket
  credentials never appear in the browser.

## Retirement boundary

Historical migration sources are retained temporarily for reconciliation and
rollback evidence. They are not part of the browser import graph. Remove those
files, their SDK dependency, obsolete repository secrets, and the disabled
keepalive workflow only after the production image migration and post-deploy
zero-legacy-network check are explicitly approved.
