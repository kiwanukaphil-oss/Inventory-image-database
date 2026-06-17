# DB hardening tests (offline, against a throwaway Postgres)

These SQL tests prove the security/data-integrity behaviour of the hardening
migrations on a **real Postgres**, without touching any Supabase project. They
were used to validate Phase 0 (and are the seed of the T1 test suite).

## What they cover
- `0027_security_hardening.test.sql` — S1 self-escalation block, S3 cost-event
  scrub, S7 constraints (negative price / null category rejected; duplicate SKU
  allowed), S8 audit_log append-only + non-spoofable actor.
- `0029_client_errors.test.sql` — P4 client_errors: caller's `user_id` is forced
  (no spoof), write-only for editors, read-only for managers, no update/delete.
- `_stubs.sql` — minimal Supabase-compatible stubs (`auth`/`storage` schemas,
  `auth.uid()`/`auth.role()` driven by `test.uid`/`test.role`, role grants).

## How to run (Docker)
```bash
# 1. throwaway Postgres
docker rm -f pg_test 2>/dev/null
docker run -d --name pg_test -e POSTGRES_PASSWORD=test postgres:17
sleep 3
docker exec pg_test psql -U postgres -qc "create database app;"

# 2. stubs + all migrations in order (run from the repo root)
docker cp supabase/tests/_stubs.sql pg_test:/tmp/stubs.sql
docker cp supabase/migrations/. pg_test:/tmp/m/
docker exec pg_test psql -U postgres -d app -v ON_ERROR_STOP=1 -f /tmp/stubs.sql
docker exec pg_test bash -c 'for f in /tmp/m/[0-9]*.sql; do \
  psql -U postgres -d app -v ON_ERROR_STOP=1 -q -f "$f" || exit 1; done'

# 3. behavioural assertions (read ERROR lines as PASS where one is expected)
docker cp supabase/tests/0027_security_hardening.test.sql pg_test:/tmp/t27.sql
docker cp supabase/tests/0029_client_errors.test.sql      pg_test:/tmp/t29.sql
docker exec pg_test psql -U postgres -d app -v ON_ERROR_STOP=0 -f /tmp/t27.sql
docker exec pg_test psql -U postgres -d app -v ON_ERROR_STOP=0 -f /tmp/t29.sql

docker rm -f pg_test
```

> Windows/Git Bash: prefix the `docker cp`/`docker exec` lines with
> `MSYS_NO_PATHCONV=1` and use `C:/...` host paths so container paths aren't mangled.

## Note
These run against the Supabase **stubs**, which grant `usage` on the `auth`
schema to `authenticated` (as production Supabase does) so non-SECURITY-DEFINER
triggers can call `auth.uid()`. A future step (T1) wires a one-command runner
and adds JS unit tests for the pure pricing/SKU logic.
