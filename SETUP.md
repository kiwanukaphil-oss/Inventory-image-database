# Setup — Phase 1 (deployable skeleton)

This gets the app live with login and an (empty) gallery. Seeding the 242
existing images comes in Phase 2.

## A. Create the Supabase project (you do this — needs your account)

1. Go to <https://supabase.com> → **New project**. Pick a name, a strong
   database password, and the region closest to you. Wait for it to provision.
2. **Run the schema — three scripts, in order**, in the **SQL Editor** (paste
   each, Run, then the next). "Success. No rows returned" is the expected result.
   1. [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
      — `profiles`, `items`, `item_costs`, RLS, the private `product-images` bucket.
   2. [`supabase/migrations/0002_categories.sql`](supabase/migrations/0002_categories.sql)
      — category tree + per-category custom-field engine; converts `items` to
      `category_id` + flexible `attributes`.
   3. [`supabase/migrations/0003_seed_categories.sql`](supabase/migrations/0003_seed_categories.sql)
      — seeds the category tree (Clothing/Footwear/Fragrance/Accessories) and
      each category's fields.
   *(If you already ran only 0001, just run 0002 then 0003 now.)*
3. **Get your API keys:** **Project Settings → API**. Copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **anon / public key** → `VITE_SUPABASE_ANON_KEY`
   (Do **not** copy the `service_role` key into the app — it bypasses security.)
4. **Auth redirect URLs:** **Authentication → URL Configuration**:
   - **Site URL:** `https://kiwanukaphil-oss.github.io/Inventory-image-database/`
   - **Additional Redirect URLs:** add `http://localhost:5173` (for local dev).
5. **Create your first user:** **Authentication → Users → Add user** (email +
   password, mark email confirmed). This becomes your login.
6. **Make yourself admin:** **SQL Editor**, run (using your email):
   ```sql
   update public.profiles set role = 'admin'
   where email = 'kiwanukaphil@gmail.com';
   ```

## B. Run locally

```bash
npm install
cp .env.example .env      # then edit .env with your URL + anon key
npm run dev               # open the printed http://localhost:5173 (also on your phone via the LAN URL)
```

You should be able to sign in and see the empty gallery. Your role chip should
read **admin**.

## C. Deploy to GitHub Pages

1. Push this repo to `github.com/kiwanukaphil-oss/Inventory-image-database`
   (the `main` branch).
2. **Repo → Settings → Secrets and variables → Actions → New repository secret**,
   add both:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. **Repo → Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. The workflow in `.github/workflows/deploy.yml` builds and publishes on every
   push to `main`. The site appears at
   `https://kiwanukaphil-oss.github.io/Inventory-image-database/`.

## Verifying Phase 1
- Live URL loads, you can sign in on phone + desktop.
- Empty gallery renders (no errors).
- A non-admin user cannot read `item_costs` (we'll exercise this once data is
  seeded in Phase 2, but the policy is already in force).

---

# Phase 2 — Seed the 242 existing pants

This loads your real photos + data into the catalogue.

## 1. Run migration 0004 (pant subcategories)
SQL Editor → run [`supabase/migrations/0004_pants_subcategories.sql`](supabase/migrations/0004_pants_subcategories.sql).
Adds Cargo / Khaki / Formal / Linen / Flat-front / Relaxed Drawstring under Pants.

## 2. Add the service-role key to `.env`
The importer needs a trusted key to write data and upload images. In Supabase:
**Project Settings → API keys → `service_role`** (the one marked *secret*).
Copy it into [`.env`](.env) after `SUPABASE_SERVICE_ROLE_KEY=`.
- This key is powerful — it bypasses security. It is only used by the local
  `npm run seed` script, is never bundled into the web app, and `.env` is
  gitignored so it never leaves your machine.

## 3. Run the importer
```bash
npm run seed
```
It reads `pants_products.xlsx` + the photo folders, compresses each image to
WebP, uploads to Storage, and inserts an item per photo (brand → column;
colour/size/style/material → attributes; price/stock → columns; cost → the
admin-only table). Safe to re-run — already-imported photos are skipped.

## Verifying Phase 2
- The importer prints `Imported 242, failed 0`.
- Refresh the app → the gallery shows your pants with thumbnails; tap one to open
  the swipeable lightbox.
- As **admin** you'll later see cost; an **editor**/**viewer** never will.

---

# Phase 5 — AI auto-fill (Anthropic vision)

Lets the edit sheet read a photo's tag/garment and pre-fill fields. The API key
stays server-side in a Supabase Edge Function — never in the browser.

## 1. Get an Anthropic API key
Sign in at <https://console.anthropic.com> → **API Keys** → create a key (add a
little billing credit — usage is ~a fraction of a cent per photo with Haiku).

## 2. Store the key as a Supabase secret
Supabase dashboard → **Edge Functions → Secrets** (or **Project Settings → Edge
Functions**) → add:
- `ANTHROPIC_API_KEY` = your `sk-ant-...` key

Optional application-side cost controls:
- `AI_RATE_PER_HOUR` = positive request limit per editor per hour. Omit it or set
  it to `0` to allow large intake batches without an application hourly ceiling.
- `AI_RATE_PER_DAY` = global daily request limit. The default is `2000`.

These are K-LINE application limits, not Anthropic account-tier limits. Anthropic
can still return its own rate-limit response; those items remain recoverable from
the Review AI-issues queue.

(You do NOT set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`
— the platform injects those into functions automatically.)

## 3. Deploy the `ai-extract` function — pick one:

**A. Dashboard (no tools needed):** Edge Functions → **Deploy a new function** →
name it exactly `ai-extract` → paste the contents of
[`supabase/functions/ai-extract/index.ts`](supabase/functions/ai-extract/index.ts)
→ Deploy.

**B. Supabase CLI:**
```bash
npm i -g supabase
supabase login
supabase link --project-ref rlqtnmahyryvuitaytah
supabase functions deploy ai-extract
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # if not set in step 2
```

---

# Permissions (capability model)

Run [`supabase/migrations/0008_capabilities.sql`](supabase/migrations/0008_capabilities.sql)
once. It adds per-user capability switches (upload / edit / delete / see-cost /
manage-users), backfills them from existing roles, and rewrites RLS to enforce
them. Your admin account keeps full access.

To manage people: sign in as someone with **Manage users**, tap **Users** in the
top bar, then per person pick a **role preset** (admin / editor / viewer) or
toggle individual capabilities. A "worker who can upload & edit but not delete or
see cost" = the **editor** preset.

New sign-ups start with **no** capabilities until you grant them in that screen.

## Verifying Phase 5
- Open an item with a photo → tap **✨ AI suggest fields from photo**.
- Fields fill in (highlighted) with confidence dots; Low-confidence reads are
  flagged for your check. Review, correct, and **Save**.
- Open the browser Network tab → the request goes to `…/functions/v1/ai-extract`
  and your `ANTHROPIC_API_KEY` never appears anywhere client-side.

---

# Branch-aware POS synchronization

Apply `supabase/migrations/20260711065228_branch_aware_pos_sync.sql` before
deploying the three POS functions. It adds the POS branch directory,
branch/variant stock mirror, item receipt destination, RLS policies, and
explicit Data API grants.

The POS `catalog_sync` account must be assigned to every branch that the catalog
is allowed to use. Re-run `backend/src/scripts/seedCatalogSyncUser.js` in the POS
repository after creating a branch, then run `npm run branch:readiness` there.

The existing POS secrets remain required. Optionally set
`CATALOG_SYNC_BRANCH_IDS` to a comma-separated allowlist of POS branch UUIDs;
when omitted, every active/opening branch assigned to `catalog_sync` is mirrored.

Deploy in this order:

```bash
supabase functions deploy pos-mirror
supabase functions deploy pos-push
supabase functions deploy pos-reconcile
```

Invoke `pos-mirror` once before releasing the frontend. That discovers branches,
backfills legacy catalog items to the POS default branch, and populates the
branch selector used by stock intake and the Shop dashboard.
