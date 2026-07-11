# Production Readiness Review — 2026-07-11

## Executive decision

**Current decision: conditionally ready for a controlled internal production rollout, not yet ready for unattended business-critical operation.**

The codebase has a stronger baseline than a typical prototype: private image storage, capability-aware RLS, append-only audit data, non-negative inventory/money constraints, POS synchronization locks, AI rate limits, durable client-error capture, unit tests, and a gated Pages deployment. This review implemented additional security and release controls. Production database state, Edge Functions, Advisors, and a logical backup have now been verified. The remaining blockers are operational: leaked-password protection is disabled, restore recovery has not been drilled, GitHub Pages cannot supply the desired security headers, and there is no end-to-end or independent uptime/alerting coverage.

Do not call the system fully production-ready until every **P0 release gate** below passes.

## Production remediation update — 2026-07-11 11:25 EAT

The repository and production Supabase project were hardened after the initial review:

- Supabase CLI authentication and project linkage succeeded for `rlqtnmahyryvuitaytah`.
- A verified logical backup was created at `C:\Projects\Inventory-image-database-production-backups\20260711-111020` with schema, data, and role dumps.
- The branch-aware migration was already present remotely. The legacy numbered migrations were deliberately not replayed because their historical ledger entries are absent.
- `20260711072317_explicit_authenticated_read_policies.sql` and `20260711081344_advisor_security_and_policy_hardening.sql` were applied directly and recorded in the remote ledger.
- Production structural invariants passed: app-owned exposed tables have RLS, final policies do not use `auth.role()`, public `SECURITY DEFINER` RPCs are not executable, and app functions have fixed search paths.
- Security Advisor improved from 32 warnings to one: leaked-password protection must be enabled in the Supabase Dashboard. The two remaining INFO findings are intentional service-role-only tables with RLS and no client policies.
- Performance Advisor has zero warnings. Its remaining INFO findings are unused-index observations and the Auth connection allocation setting.
- All five Edge Functions were deployed with the expected JWT posture. Production CORS allows the live site and local development, does not grant an unknown origin, and every unauthenticated POST returns 401.
- Active editors can read items and query cost presence; an inactive identity has `active=false`, `can_edit=false`, and sees zero items. Anonymous identities cannot execute auth helpers or trigger RPCs.
- Anthropic and POS outbound calls now have bounded timeouts.
- A hidden POS push failure was found and fixed: calling `.catch()` on the RPC builder threw inside `finally`, returning HTTP 500 and retaining the single-flight lock after a successful push. The corrected production push returned HTTP 200, recorded `ok=true`, and left zero lock rows.
- Post-deploy production runs passed: mirror `ok=true`, reconcile `ok=true` with zero drift, and push `ok=true` with a clean queue.

The unresolved P0 items are now operational choices rather than unknown code/database state: enable leaked-password protection, select a non-pausing backup plan and image-backup destination, configure independent monitoring, and choose a header-capable frontend host/proxy plus staging environment.

## Review scope and evidence

- Frontend, PWA/service worker, auth/session routing, client telemetry, uploads, review/approval, bulk editing, Shop/POS views.
- All 35 SQL migrations and the final RLS policy state, validated from scratch against Postgres 17 with Supabase-compatible test stubs.
- Five Supabase Edge Functions and their auth/CORS/dependency posture.
- GitHub Actions deploy/keepalive workflows, dependency tree, build output, live response headers, and current worktree state.
- Verification completed locally: 83 unit/static tests, production build, full npm audit, production-only npm audit, migration replay, and RLS invariants.
- Production Advisors and the migration ledger were verified after authenticating and linking the Supabase CLI to project `rlqtnmahyryvuitaytah`.

## Improvements implemented in this review

### Security and data integrity

- Added `20260711072317_explicit_authenticated_read_policies.sql`: final read policies now target `TO authenticated` and retain `auth_is_active()` authorization instead of using deprecated `auth.role()` predicates.
- All Edge Functions now pin `@supabase/supabase-js@2.110.2` rather than floating on major version `@2`.
- All user-callable Edge Functions now reject inactive profiles. `ai-extract` uses the actual `can_edit` capability instead of a role label.
- `manage-users` now reports a profile-state update failure instead of returning success after a partial deactivate/reactivate operation.
- Client telemetry strips query strings and fragments before saving URLs, preventing auth callback material from entering `client_errors`.
- The top-level error recovery screen uses `textContent` for remote error messages, closing an HTML-injection path.
- Added a `no-referrer` browser policy.

### Supply chain, performance, and release safety

- Replaced vulnerable SheetJS `xlsx` with ExcelJS and forced a patched UUID dependency.
- Upgraded and exactly pinned Vite, Vitest, Sharp, Supabase JS, fonts, and PWA tooling; declared Node `>=22.12.0`.
- Full `npm audit` now reports **0 vulnerabilities** (previously 6, including high/critical development findings).
- Split the previous 514 KB JavaScript bundle into a 289 KB app chunk and a 204 KB independently cacheable Supabase chunk.
- Added Dependabot for npm and GitHub Actions.
- CI now runs unit tests, replays every migration in Docker, verifies RLS invariants, and audits production dependencies before deploy.
- Reduced GitHub Actions permissions: Pages write and OIDC are granted only to the deploy job; jobs have timeouts.

## Findings by production dimension

| Area | Status | Evidence and remaining gap | Required action |
|---|---|---|---|
| Security | **P0 open** | Production Advisors, RLS invariants, Storage policies, function JWT posture, CORS, and active/inactive access were verified. The remaining Advisor warning is disabled leaked-password protection. Live HTML lacks CSP, HSTS, `X-Content-Type-Options`, frame restrictions, and Permissions Policy. | Enable leaked-password protection and review the remaining Auth controls; put the custom domain behind a host/proxy that can set security headers. |
| Performance | **P1 open** | Bundle warning resolved. Gallery and Shop still load broad/full datasets into the browser; large modules render substantial HTML; signed-URL work and full-catalog metadata remain scale-sensitive. | Add server-side pagination/filtering, measure Core Web Vitals on representative phones, set performance budgets, and profile queries using `pg_stat_statements`/Advisor. |
| Reliability | **P0 open** | POS locks, bounded work loops, retryable AI calls, PWA update prompting, sync-run records, and bounded POS/AI network timeouts are in place. Some multi-step operations can still partially succeed; the scheduled keepalive indicates reliance on a pausable tier. | Add idempotency tests and transactional boundaries; upgrade to a non-pausing production plan; define degraded-mode behavior. |
| Scalability | **P1 open** | `pos-mirror` can scan up to ~200k movements per run and several UI paths fetch the full catalogue. This is acceptable at hundreds of items, not at sustained high volume. | Establish volume thresholds; replace full scans with cursor/delta APIs; paginate items/jobs/events; load-test concurrent upload, review, and POS sync. |
| Error handling | **P1 open** | Durable `client_errors`, top-level recovery, job logs, and `pos_sync_runs` exist. Reports have no alert, ownership, resolution workflow, automated retention, release version, or correlation ID. Several `.catch(() => {})` paths intentionally hide failures. | Add release/version and correlation IDs, 90-day retention, alerting on new/high-rate errors and stale sync, and audit swallowed errors for operator impact. |
| Data integrity | **P0 open** | Migration replay, remote migration state, RLS, constraints, audit immutability, sync lock, approval requirements, and branch immutability pass. Bulk item/cost/event writes and storage-upload/database-insert sequences are not transactional, so partial state and orphan files remain possible. | Move multi-table mutations to transactional RPCs and add orphan reconciliation. |
| Usability/accessibility | **P1 open** | Mobile-first UI, explicit PWA update prompt, retry surfaces, and review continuity tests are positive. No browser E2E, keyboard journey, screen-reader, contrast, or real-device regression gate exists. Offline data editing is limited; queued files do not survive a page/process restart. | Add Playwright smoke journeys for admin/editor/viewer, automated axe checks plus manual VoiceOver/TalkBack review, and make offline limits explicit or persist an IndexedDB queue. |
| Deployment | **P0 open** | Tests now gate Pages deploy; permissions/timeouts are improved. Database/function deployment is separate from frontend promotion, there is no staging environment, GitHub Action tags are not SHA-pinned, and no post-deploy authenticated smoke test or automatic rollback exists. | Introduce staging; make migration/function/frontend promotion an ordered release runbook; pin Actions; add cache-busted smoke checks and documented rollback. |
| Monitoring/DR | **P0 open** | In-app error and POS sync tables are useful, but they are not independent of Supabase. No external uptime check, paging, SLO, restore drill, RPO/RTO, or verified PITR/backup was found. | Add external uptime checks for the app and Supabase/function probes; alert on stale/error sync; select backup/PITR; perform and record a restore drill. |
| Maintainability | **P1 open** | Pure logic has useful tests and dependencies are pinned. `gallery.js` is ~152 KB, `styles.css` ~121 KB, several other modules exceed 40 KB, Edge Functions use `@ts-nocheck`, and no lint/typecheck/coverage thresholds exist. | Split by feature boundary, extract shared Edge auth/CORS/POS clients, add ESLint plus Deno type-checking, and introduce risk-based coverage thresholds. |

## P0 release gates

1. **Authenticate Supabase CLI and prove production state**
   - `npx supabase link --project-ref rlqtnmahyryvuitaytah`
   - `npx supabase migration list --linked`
   - `npx supabase db advisors --linked --type security --level warn`
   - `npx supabase db advisors --linked --type performance --level warn`
   - Resolve all security errors/warnings that expose data or privileged functions; disposition performance warnings with measured evidence.

2. **Back up and apply migrations in order**
   - Confirm the branch-aware POS migration is intended and reviewed with its existing frontend/function changes.
   - Back up production and record restore instructions.
   - Apply `20260711065228_branch_aware_pos_sync.sql`, then `20260711072317_explicit_authenticated_read_policies.sql` if they are not already present.
   - Re-run Advisors and role-based database probes.

3. **Deploy and verify Edge Functions**
   - Deploy `ai-extract`, `manage-users`, `pos-mirror`, `pos-push`, and `pos-reconcile` from the reviewed commit.
   - Verify JWT posture matches `supabase/config.toml`.
   - Test active admin/editor/viewer/custom and inactive accounts. Inactive accounts must receive 403 from every function.
   - Replace cron use of the service-role bearer with a dedicated strong `MIRROR_INVOKE_KEY`; rotate any service-role key that has been copied into an external scheduler.

4. **Prove recovery and independent monitoring**
   - Define initial SLOs (suggested: app availability 99.9%; POS mirror freshness under 20 minutes during business hours).
   - Configure external checks and alerts.
   - Perform a database restore drill and document measured RPO/RTO.

5. **Release through staging and smoke-test production**
   - Run `npm ci`, `npm test`, `npm run test:db`, `npm run audit:prod`, and `npm run build` from a clean checkout.
   - Test login, browse, upload, edit, approve, cost isolation, user deactivation, POS push/mirror/reconcile, error reporting, PWA update, and logout on staging.
   - Promote the exact commit to `main`, watch Pages deployment, then run cache-busted desktop/mobile smoke checks on `https://klinemen-catalog.com/`.

## Recommended next implementation sequence

1. Shared external-call retry policy and POS idempotency tests.
2. Transactional RPCs for bulk price/cost/status updates and upload finalization, plus orphan cleanup.
3. External uptime/error/sync alerting and telemetry retention/versioning.
4. Playwright + axe critical-path suite and staging environment.
5. Pagination/delta sync and measured performance budgets.
6. Module decomposition, shared Edge utilities, lint/typecheck/coverage gates.

## Verification results from this review

- `npm test`: **83 passed** across 12 files.
- `npm run test:db`: **35 migrations applied; RLS, function exposure, search-path, and deprecated-policy invariants passed**.
- `npm audit --audit-level=moderate`: **0 vulnerabilities**.
- `npm run audit:prod`: **0 vulnerabilities**.
- `npm run build`: **passed**; app 289.11 KB / 87.98 KB gzip, Supabase 204.07 KB / 52.30 KB gzip.
- `node --check scripts/seed.mjs`: **passed**.
- Live `https://klinemen-catalog.com/` responded successfully, but its GitHub Pages response did not include the recommended application security headers.

## Change-scope note

The worktree already contained uncommitted branch-aware POS changes before this review. Those files were recovered after an accidental reset and preserved alongside the newer gallery-thumbnail fix. The reviewed production migrations and five Edge Functions were applied/deployed and verified. No commit, push, or Pages promotion was performed.
