# Database migrations — apply, verify, roll back (P3)

How schema changes reach the databases safely. For current and future engineers.
Companion to [V3_ENGINEERING_HARDENING_ROADMAP.md](V3_ENGINEERING_HARDENING_ROADMAP.md).

## Principles
- **Numbered, ordered, append-only.** Files are `supabase/migrations/NNNN_name.sql`,
  applied in ascending order. Never edit an already-applied migration — add a new one.
- **Idempotent.** Every migration is safe to re-run (`create … if not exists`,
  `drop … if exists` before `create policy/trigger`, guarded `update`s). Re-running
  the whole folder must be a no-op on an up-to-date DB.
- **Rollback documented in the file.** Each migration's header comment carries a
  `ROLLBACK:` block with the exact down-SQL. (See 0027/0028/0029 for the pattern.)
- **Staging first, always.** Apply to `klinemen-catalog-staging`, verify, then prod.
- **One source of truth.** The repo is authoritative; prod must equal the repo.
- **Data migrations are one-shot + guarded (S15).** A migration that *mutates rows*
  (normalisation, placeholder-clearing) must be idempotent AND guarded so a replay
  can't re-mangle hand-corrected data — prefer keeping bulk data fixes out of the
  always-applied schema set. The existing data migrations (`0006` seed vocab,
  `0011` clear placeholders, `0021` normalise waist sizes) are pattern-guarded
  (they only touch rows still matching the original placeholder/format), so a
  replay is safe; future data fixes should follow the same rule.

## Current state (2026-06-16)
- **Prod** (`rlqtnmahyryvuitaytah`): applied through **0026**. Hardening
  migrations **0027, 0028, 0029 are NOT yet on prod** — they ship after review.
- **Staging** (`euvngvbqsikhewtyftxw`): applied through **0029** (incl. the
  hardening set), verified live.

## Apply to STAGING
Option A — Supabase SQL Editor (current manual process): paste each new
`NNNN_*.sql` in order and run.

Option B — Supabase CLI (preferred; also the direction for prod):
```bash
npx supabase link --project-ref euvngvbqsikhewtyftxw
npx supabase db push        # applies pending migrations in order
```

## Verify (before prod, after any apply)
1. **Pre-apply, offline:** run the test harness in `supabase/tests/` against a
   throwaway Postgres (see `supabase/tests/README.md`) — proves the new migration
   applies cleanly on top of all prior ones and behaves correctly.
2. **Post-apply, on the project:** confirm new tables/policies exist. Quick REST
   probe with the project's publishable key (a missing table → `404 PGRST205`; an
   existing-but-RLS-protected table → `200 []` or `401 42501`):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" \
     "https://<ref>.supabase.co/rest/v1/<table>?select=*&limit=1" \
     -H "apikey: <publishable_key>" -H "Authorization: Bearer <publishable_key>"
   ```

## Apply to PROD (the gated step)
1. Staging is applied + verified, and the offline harness passes.
2. Take a backup first (see [STAGING_AND_BACKUPS.md](STAGING_AND_BACKUPS.md) — `pg_dump`).
3. Apply the **same** migrations, in order (SQL Editor or `supabase db push`
   linked to the prod ref). Never apply a migration to prod that hasn't been on
   staging.
4. Re-run the post-apply verification against prod.
5. Record the highest applied number in the progress log + here.

## Roll back
1. Open the migration's header `ROLLBACK:` block.
2. Run that down-SQL **on staging first**; confirm the app still works.
3. Then run it on prod. Restore from the pre-apply backup if a rollback can't
   cleanly reverse a data change.

## Adding a new migration (checklist)
- [ ] Next number, descriptive name.
- [ ] Header comment: what it does, which audit IDs it addresses, `Run AFTER NNNN`,
      idempotent note, and a tested `ROLLBACK:` block.
- [ ] Idempotent statements throughout.
- [ ] If it changes security/data-integrity behaviour, add a test in `supabase/tests/`.
- [ ] Validate offline (harness) → apply to staging → verify → PR/commit →
      apply to prod (gated) → record version.
