# Staging environment & backups runbook (P1 + P7)

**Purpose:** stand up a second Supabase project as **staging/dev** so local work and migrations never touch production data (audit P1), and establish a verified backup/restore path for prod (audit P7). Companion to [V3_ENGINEERING_HARDENING_ROADMAP.md](V3_ENGINEERING_HARDENING_ROADMAP.md).

> **Golden rule:** the deployed site at `klinemen-catalog.com` reads **prod** (its URL/key come from GitHub repo secrets in `.github/workflows/deploy.yml`). Your **local `.env` reads staging**. Changing `.env` never affects the live site.

---

## Part 1 — Create the staging project (P1)

### 1. Create it
- Supabase dashboard → **New project**.
- **Name:** `klinemen-catalog-staging` (the name is just a label; the project *ref* is what matters).
- **Organization:** same as prod.
- **Region:** **match your prod project's region** (prod → Project Settings → General shows it) so behaviour/latency match.
- **Database password:** generate a strong one and **save it in your password manager** — you'll need it for backups/restores below.
- **Plan:** Free is fine for staging. (Free projects pause after ~1 week idle; just un-pause when you return — staging pausing is harmless.)

### 2. Apply the schema (migrations 0001 → 0028, in order)
Staging must have the **exact same schema** as prod. Two ways:

- **Easy (manual):** SQL Editor → paste each `supabase/migrations/000N_*.sql` **in numeric order**, 0001 through 0028. They're idempotent, so a re-paste is safe. (Ask me for a single concatenated file if you'd rather paste once.)
- **Better (CLI — this is also the P3 direction):**
  ```bash
  npx supabase link --project-ref <STAGING_REF>
  npx supabase db push       # applies all migrations in order
  ```

Migration 0001 also creates the private `product-images` storage bucket, so you don't create it by hand.

### 3. Make yourself an admin on staging
New sign-ups default to `viewer` (the `handle_new_user` trigger). After you create your account (either sign up in the app pointed at staging, or dashboard → Authentication → Add user), promote it in the SQL Editor:
```sql
update public.profiles set
  role='admin', can_upload=true, can_edit=true, can_delete=true,
  can_view_cost=true, can_manage_users=true
where email='kiwanukaphil@gmail.com';
```
> Note: the new S1 self-escalation trigger does **not** block this — the SQL Editor runs as `postgres` (no `auth.uid()`), which is intentionally exempt so initial admin setup still works. Inside the app, no one can self-promote.

### 4. Point local dev at staging
From the staging project → **Project Settings → API**, copy:
- **Project URL** → `VITE_SUPABASE_URL`
- **anon/public key** → `VITE_SUPABASE_ANON_KEY` (public-safe; it's gated by RLS)

Put them in your local `.env` (overwriting the prod values that are there now). Now `npm run dev` and `npm run seed` hit **staging**. The deployed prod site is untouched (it uses GitHub secrets).

### 5. Edge-function secrets on staging — **leave the POS OFF**
Set secrets on the staging project (dashboard → Edge Functions → Manage secrets, or `npx supabase secrets set`). For staging:

| Secret | Set on staging? |
|---|---|
| `ANTHROPIC_API_KEY` | Optional — only if you want to test AI extract. Reusing your prod key is OK now that `ai-extract` is rate-capped (S6); or use a separate key with a spend cap. |
| `ALLOWED_ORIGINS` | `http://localhost:5173` (so the new CORS allows your dev origin). |
| `POS_BASE_URL`, `CATALOG_SYNC_USERNAME/PASSWORD`, `MIRROR_INVOKE_KEY` | **DO NOT SET on staging.** Unset = `pos-push`/`pos-mirror` refuse to run (they throw "POS_BASE_URL not set") so staging can never write to your live POS. |
| POS cron schedules (`pos-push */5`, `pos-mirror */10`, `pos-reconcile nightly`) | **Do NOT schedule on staging.** Only prod runs the sync crons. |

If you ever need to test the POS pipeline against a throwaway POS, stand up a separate test POS and point staging's `POS_BASE_URL` at *that* — never the production one.

### 6. Sanity check
- `npm run dev`, sign in with your staging admin → empty gallery loads.
- Upload a test item, set a price, approve it. Confirm **nothing** appears in the real POS (because staging has no POS creds).

---

## Part 2 — Backups & a verified restore (P7) — on the **PROD** project

Real inventory/cost/accounting data needs a recovery path you've actually tested.

### 1. Check what Supabase gives you
PROD project → **Database → Backups**:
- **Daily backups** (managed) come with the **Pro** plan. **Free projects have no restorable managed backups** — if prod is on Free and holds real business data, **upgrade prod to Pro**.
- **PITR (point-in-time recovery)** is a paid add-on on top of Pro. Worth it once there's real sales history; optional at launch.

### 2. Take your own logical backup (vendor-independent, uses tools you already have)
You have PostgreSQL 17 client tools installed. From prod → Project Settings → Database → **Connection string** (use the **Session/Direct** connection, not the pooler, for `pg_dump`):
```bash
# Full logical dump of prod (read-only; safe to run anytime)
pg_dump "postgresql://postgres:<PASSWORD>@<PROD_HOST>:5432/postgres" \
  --no-owner --no-privileges -Fc -f klinemen_prod_$(date +%F).dump
```
Store the `.dump` somewhere safe (it contains cost data — treat it as sensitive).

### 3. Prove the restore works (this is the actual P7 deliverable)
A backup you've never restored is a hope, not a backup. Restore the dump into a scratch DB and confirm row counts:
```bash
# Option A: restore into a local throwaway Postgres (Docker)
docker run -d --name pg_restore_test -e POSTGRES_PASSWORD=test postgres:17
docker cp klinemen_prod_*.dump pg_restore_test:/tmp/p.dump
docker exec pg_restore_test createdb -U postgres restored
docker exec pg_restore_test pg_restore -U postgres -d restored --no-owner /tmp/p.dump
docker exec pg_restore_test psql -U postgres -d restored -c \
  "select (select count(*) from items) as items, (select count(*) from item_costs) as costs;"
docker rm -f pg_restore_test
```
(`auth`/`storage` schemas won't restore into a plain Postgres — that's expected; you're proving the **public** business data restores. Option B: restore into the **staging** project for a fuller test, but note that copies real cost data into staging.)

### 4. Schedule it
Add a recurring reminder (or a small cron/GitHub Action) to run the `pg_dump` weekly and keep the last few. Document where the dumps live.

---

## What "done" looks like (update the roadmap register when each is true)
- **P1 DONE:** staging project exists with migrations 0001–0028 applied; local `.env` points at it; POS secrets are **absent** on staging; a test approve on staging touches no real POS.
- **P7 DONE:** prod backup capability confirmed (Pro/PITR or your own `pg_dump`), and you have **restored a dump and verified row counts** at least once; a recurring backup is scheduled.

## What to send me to finish wiring P1
Just the two **public-safe** staging values (the anon key is safe to share; **never** paste a service-role key):
- staging **Project URL**
- staging **anon/public key**

I'll update `.env`, point dev at staging, and we verify the app loads against it.
