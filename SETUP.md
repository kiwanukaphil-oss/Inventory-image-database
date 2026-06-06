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
   where email = 'kiwanukapkn@gmail.com';
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
