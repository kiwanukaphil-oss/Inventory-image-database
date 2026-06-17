# K-LINE MEN Catalog — Engineering Hardening Roadmap

**Theme: "Make it safe to trust with real money." — from working prototype to production system.**

**Date:** 2026-06-16
**Branch:** `feature/v3-coherence` (create hardening work on `hardening/*` branches off this).
**Diagnosis / source of findings:** [V3_ENGINEERING_AUDIT.md](V3_ENGINEERING_AUDIT.md) (2026-06-16). That doc is *what's wrong*; this doc is *how we fix it and where we are*.

> **Status: NOT STARTED.** This is the working plan and the single source of truth for the *status* of every audit finding. Engineers: update the **Status** column in §3 and the **Progress log** in §11 as you go. Do not mark an item `DONE` until its **acceptance criteria** and **test** (where required) are met.

---

## 1. How to use this document (read first)

This roadmap is written for **current and future engineers** — including people who have never seen this codebase. It assumes you know JavaScript, SQL, and roughly what Supabase (Postgres + RLS + Edge Functions) is, but **not** this app's history.

- **Every issue has a stable ID** (`S1`, `R1`, `P3`, …) that matches the audit and must appear in the commit that fixes it (e.g. `fix(security): block self-promotion via profiles UPDATE (S1)`).
- **Work top-down by phase.** Phases are ordered by risk, not convenience. Phase 0 must land before the app is exposed to anyone outside the core trusted team.
- **Respect the invariants in §2.** They are non-negotiable; several past decisions depend on them.
- **Nothing ships without meeting the Definition of Done (§4).**
- **Per the project's working agreement:** wait for the owner's sign-off between phases; never auto-commit; when two viable approaches exist, present both rather than silently choosing.

### Mental model of the system (for newcomers)
- **Frontend:** a vanilla-JS (no framework) Vite PWA in `src/`, deployed as a static site to `klinemen-catalog.com` (GitHub Pages). It talks directly to Supabase using the **anon key** (safe to ship).
- **The real security boundary is Postgres Row-Level Security (RLS)**, defined in `supabase/migrations/*.sql`. The client UI only *cosmetically* hides things; RLS is what actually enforces them. **If you change who-can-do-what, you change a migration, not just JS.**
- **Privileged server logic** lives in `supabase/functions/*` (Deno/TypeScript Edge Functions): AI extraction, user management, and POS sync. Some are deployed `--no-verify-jwt` and **authenticate themselves**.
- **The money/stock path:** capture photo → AI extract → human review → set price/cost → approve → `pos-push` creates a product + books a stock receipt in the separate POS. Cost is **admin-only** and must never leak to editors/viewers.

---

## 2. Invariants (non-negotiable — do not regress these)

1. **Cost data stays RLS-isolated to cost-viewers.** Never expose `cost_price` (or its before/after history) to a `can_edit && !can_view_cost` user — at the UI, API, *or* row level.
2. **The DB is the enforcement layer.** Any new access rule must be expressed in RLS, not only in the client. Client gating is UX, not security.
3. **`SECURITY DEFINER` functions always pin `set search_path = public`.**
4. **One photo = one unit** — `stock_quantity` is pinned to 1 per photo (a confirm guards >1). Don't reintroduce multi-unit-per-photo.
5. **No frontend framework** — vanilla JS + Vite. No React/Vue/Svelte.
6. **AI runs only through the `ai-extract` Edge Function** — the Anthropic key never reaches the browser.
7. **POS owns live stock/price after push;** the catalog mirrors them read-only. Don't make the catalog a second source of truth for live stock.
8. **Money & stock writes must be idempotent and validated** — no double receipts, no negative/NaN prices.

---

## 3. Master issue register (the source of truth for status)

Severity: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low. **Before prod?** = must be resolved before public/multi-user launch. Status: `TODO` / `IN PROGRESS` / `IN REVIEW` / `DONE` / `WON'T FIX (rationale)`.

| ID | Title | Area | Sev | Phase | Before prod? | Status |
|----|-------|------|-----|-------|--------------|--------|
| S1 | Self-promotion via `profiles` UPDATE | Security/RLS | 🔴 | 0 | Yes | IN REVIEW |
| S2 | `manage-users` admin-minting + no password policy | Security/Edge | 🔴 | 0 | Yes | IN REVIEW |
| S3 | Cost redaction app-only (item_events editor-readable) | Security/RLS | 🟠 | 0 | Yes | IN REVIEW |
| R1 | Editor accepts negative/NaN price & cost | Robustness | 🔴 | 0/3 | Yes | DONE (DB CHECK S7 + editor parsePrice guard) |
| S7 | Missing DB CHECK/NOT NULL/uniqueness constraints | Data integrity | 🟠 | 0 | Yes | IN REVIEW |
| S4 | Fragile/non-constant-time secret gate on POS fns | Security/Edge | 🔴 | 0 | Yes | IN REVIEW |
| S5 | Wildcard CORS on admin + paid endpoints | Security/Edge | 🟠 | 0 | Yes | IN REVIEW |
| S6 | No rate/cost cap on paid `ai-extract` | Security/Edge | 🟠 | 0 | Yes | IN REVIEW |
| DI1 | `pos-push` double-receipt race (no run lock) | Data integrity | 🟠 | 0 | Yes | IN REVIEW |
| P1 | No dev/prod environment separation | Ops | 🔴 | 1 | Yes | IN PROGRESS (staging `klinemen-catalog-staging` live; `.env`→staging; migs 0001–0028 applied+verified; pending: admin user + dev boot) |
| T1 | Zero automated tests | Testing | 🔴 | 1 | Yes | IN PROGRESS (Vitest: price + readiness + imagehash, 24 tests; lib/ extraction. POS-SKU JS units deferred — see note) |
| P2 | CI has no test/lint gate before deploy | Ops/CI | 🟠 | 1 | Yes | IN REVIEW (test job gates build+deploy) |
| P3 | Manual migrations, no rollback story | Ops | 🟠 | 1 | Yes | IN REVIEW (docs/V3_upgrade/MIGRATIONS.md + per-migration ROLLBACK blocks) |
| P4 | No error tracking / monitoring | Ops | 🟠 | 1 | Yes | IN REVIEW (0029 client_errors + src/errorlog.js + main.js hook; validated) |
| P7 | Backups/PITR unverified | Ops | 🟠 | 1 | Yes | TODO |
| S8 | Audit log not tamper-resistant; actor spoofable | Security/RLS | 🟠 | 0 | Yes | IN REVIEW (pulled into 0027) |
| S9 | `profiles.active` not enforced in RLS | Security/RLS | 🟠 | 2 | Cond. | IN REVIEW (0030, validated) |
| S10 | `pos-push` unbounded `limit` | Security/Edge | 🟡 | 0 | No | IN REVIEW (clamped in pos-push) |
| S11 | Raw downstream error strings to client | Security/Edge | 🟡 | 2 | No | IN REVIEW (generic errors, detail server-side) |
| S12 | Role-vs-capability dual model | Security/RLS | 🟡 | 2 | No | IN REVIEW (0030: calibration+item_jobs→caps) |
| S13 | Storage has no per-path ownership | Security/RLS | 🟡 | 2 | No | WON'T FIX (accepted: random-UUID keys + no upsert ⇒ no clobber; revisit at upload refactor) |
| S14 | POS-mirror text upserted unsanitized | Security/Edge | 🟡 | 2 | No | IN REVIEW (clampText in pos-mirror) |
| R2 | Bulk attribute edit N+1 aborts mid-batch | Robustness | 🟠 | 3 | No | DONE (per-item failure report) |
| R3 | Burst-undo delete best-effort → orphan | Robustness | 🟠 | 3 | No | DONE (re-surface + retry) |
| R4 | Pricing float/rounding precision | Robustness | 🟡 | 3 | No | DONE (whole-number documented) |
| R5 | Guided-pricing cost-snapshot swallowed weakens Undo | Robustness | 🟡 | 3 | No | DONE (skip cost on snapshot fail) |
| R6 | `imageCompress` silent full-res fallback | Robustness | 🟡 | 3 | No | DONE (oversize reject >10MB) |
| R7 | Inconsistent double-tap guards | Robustness | 🟡 | 3 | No | DONE (in-flight guards both tools) |
| Q2 | `esc()` duplicated 5× (actually 14) | Code quality | 🟠 | 4 | No | DONE (single source in ui.js) |
| Q3 | Swallowed/empty catches | Code quality | 🟡 | 4 | No | DONE (warn on load-bearing failures) |
| Q4 | Dead code `quickPriceItems` | Code quality | 🟢 | 4 | No | DONE (removed) |
| Q5 | Comment/naming nits vs CLAUDE.md | Code quality | 🟢 | 4 | No | WON'T FIX (optional; comment coverage already strong, renames = churn) |
| S15 | Data migrations interleaved with schema DDL | Ops | 🟢 | 4 | No | DONE (documented in MIGRATIONS.md; existing ones guarded) |
| P6 | Root `.gitignore` missing `supabase/.temp/` | Ops | 🟢 | 4 | No | DONE (added `supabase/.temp/` + `.env.*.local`) |
| Q1 | `gallery.js` god-module / full re-render | Architecture | 🟠 | 5 | No | IN PROGRESS (sort→lib/itemsort.js extracted+tested; faceting/selection/bulk = review-gated, see §10 plan) |
| P5 | No pagination; gallery 1000-cap; Shop unbounded | Scalability | 🟠 | 5 | No | DONE for query caps (Shop/export); gallery infinite-scroll folded into Q1 |

---

## 4. Definition of Done (applies to every issue)

An issue is `DONE` only when **all** of these hold:
1. **The fix matches the acceptance criteria** in its phase section below.
2. **It is enforced at the right layer** — security/data-integrity fixes live in a migration or edge function, not only in client JS (invariant #2).
3. **A test exists** for any logic with a correctness contract (money math, RLS isolation, idempotency, validation). UI-only/cosmetic fixes are exempt but must be manually verified.
4. **No regression of the §2 invariants.**
5. **Migrations are idempotent** (`if not exists` / `drop … if exists` / guarded updates) and have a documented rollback (down-SQL) in the migration's header comment.
6. **The commit references the issue ID.**
7. **The register (§3) and progress log (§11) are updated.**

---

## 5. Phase 0 — Emergency security & data-integrity hotfixes

> **Goal:** close every Critical and the load-bearing Highs. **Nothing widens access to this app until Phase 0 is `DONE`.** All items are small, surgical changes. Est. 1–2 focused days.

### 5.1 New migration `0027_security_hardening.sql` covers S1, S3, S7, S8(partial)
Group the RLS/constraint fixes into one reviewable migration.

**S1 — Block self-promotion**
- *Task:* Recreate `profiles_manage_write` with `with check (auth_can_manage_users() and id <> auth.uid())`. Add a `BEFORE UPDATE` trigger `profiles_block_self_escalation` that raises if `NEW.id = auth.uid()` and any of `can_upload/can_edit/can_delete/can_view_cost/can_manage_users/role/active` changed. (The trigger covers the gap where an admin who is also their own row edits caps — decide with the owner whether true admins may edit their own non-privilege fields; default: managers/admins cannot change *their own* privilege columns at all — only another privileged user can.)
- *Acceptance:* A `can_manage_users` user **cannot** raise their own `can_view_cost`/`role` via the API; can still manage *other* users. Verified by a Tier-2 test using a manager JWT.

**S3 — DB-enforce cost redaction**
- *Task:* Add `scrub_cost_event()` + `BEFORE INSERT OR UPDATE` trigger on `item_events` nulling `before_value`/`after_value` when `field_path = 'cost_price'`, regardless of caller. Re-run the 0026 scrub for safety.
- *Acceptance:* Inserting an `item_events` row with `field_path='cost_price'` and a value (via raw API, editor JWT) stores `null` values. Tier-2 test asserts this.

**S7 — Integrity constraints**
- *Task:* `CHECK (price is null or price >= 0)`, same for `stock_quantity`, `reorder_level`; `CHECK (cost_price >= 0)` on `item_costs`. Decide `category_id` `NOT NULL` (default to keeping nullable only if a real "uncategorized" state exists — confirm with owner) and the SKU-uniqueness stance (document the *intentional* duplicate-SKU model from the POS integration, OR add a partial unique index — **owner decision required**, do not silently pick).
- *Acceptance:* `update items set price = -1` is rejected by the DB. Tier-2 test asserts rejection.

**S8 (partial) — Audit immutability + attribution**
- *Task:* `revoke update, delete on public.audit_log from authenticated, anon;` + a reject-trigger on UPDATE/DELETE. Change `item_events_actor_default` (and the audit trigger) to **always** set `actor := auth.uid()` (drop the "only when null" branch); set a sentinel actor for service-role writes (`auth.uid()` is null there).
- *Acceptance:* An editor cannot forge `actor`; an editor cannot UPDATE/DELETE an `audit_log` row. Tier-2 tests assert both.

> **Rollback:** each block in the migration header lists its reversal (e.g. `drop trigger …; recreate prior policy`). Test the down-path on a local DB before applying to prod.

### 5.2 Edge-function fixes
**S4 — Constant-time secret gate + fail-closed + commit `config.toml`**
- *Files:* `pos-push`, `pos-mirror`, `pos-reconcile`. Add a shared `timingSafeEqual(a, b)` (hash both via `crypto.subtle.digest('SHA-256', …)`, compare digests). At handler start, assert `SERVICE_KEY` and `MIRROR_INVOKE_KEY` are present and ≥ 32 chars; return 500 otherwise. Add `supabase/config.toml` pinning `verify_jwt = false` for the three POS functions (and `true`/default for `ai-extract`, `manage-users`).
- *Acceptance:* Empty/short invoke key → function refuses to start the privileged path; secret comparison is constant-time; `config.toml` is committed.

**S2 — Lock down `manage-users`**
- *Task:* Allowlist `role ∈ {admin,editor,viewer,custom}`; **non-admin** managers may not set `role='admin'` or `can_manage_users=true`, and may not grant a capability they themselves lack; validate email format; enforce password policy (length ≥ 12, not in a small common-password set). Return clean 4xx, not 500, on validation failure.
- *Acceptance:* A `can_manage_users && !admin` JWT cannot create an admin or a manager; weak/no password is rejected. Tier-2 test.

**S5 — CORS allowlist**
- *Task:* Replace `Access-Control-Allow-Origin: *` in all five functions with an allowlist (the PWA origin(s) from an env var, e.g. `ALLOWED_ORIGINS`). Reflect only matched origins; reject others.
- *Acceptance:* A request with a foreign `Origin` is not granted CORS on `manage-users`/`ai-extract`.

**S6 — Rate/cost cap on `ai-extract`**
- *Task:* Per-user token bucket backed by a small `ai_usage` table (or a counter row) — e.g. N calls / rolling hour and a global daily ceiling; cap `fields.length`. Return 429 when exceeded.
- *Acceptance:* The (N+1)th call within the window from one user returns 429; global ceiling halts further spend. Test against a local function with a low limit.

**DI1 — `pos-push` run lock + clamp (also resolves S10)**
- *Task:* Take a Postgres advisory lock (`pg_try_advisory_lock`) or an atomic "claim" row in `pos_sync_runs` at the start of `pos-push`; bail if a push is already in flight. Clamp `limit`/`dirtyLimit` to ≤ 50. Coordinate with the POS team to add a unique constraint on `(reference_id, movement_type)` for true idempotency.
- *Acceptance:* Two concurrent `pos-push` invocations cannot both book a receipt for the same item; a stress test (fire two runs) yields exactly one receipt per item.

### Phase 0 exit criteria
All Phase-0 register rows are `DONE`; the Tier-2 RLS/security tests (built in Phase 1, but **the Phase-0 fixes must be re-verified once those tests land** — track as a checkbox) pass; owner sign-off recorded in §11.

---

## 6. Phase 1 — Production floor (make releases safe & observable)

> **Goal:** you can change money/stock logic and *know* you didn't break it, on a DB that isn't also your scratchpad. Est. 2–4 days.

**P1 — Environment separation**
- *Task:* Stand up a second Supabase project = **staging/dev**. Local `.env` and `npm run dev` point at staging; GitHub Pages prod build uses prod secrets. **Gate `scripts/seed.mjs`** behind an explicit `--prod-confirm` flag + an env check so it cannot run against prod by accident.
- *Acceptance:* `npm run dev` cannot read/write prod data; running `seed` without the flag against a prod URL aborts.

**T1 — Test suite (Vitest)** — the keystone
- *Task:* Add Vitest + `@vitest/coverage`. Add an `npm test` script. Build three tiers (see §9). Phase 1 must at minimum cover: the pricing engine, the new `parsePrice` (R1), `readiness.js` blockers, the POS mapping fns (`getGroupKey`, `resolveProductName`, `buildVariantAttributes`, `normalizeGender`), and **the Phase-0 RLS/security contracts** (S1, S3, S7, S8, S2).
- *Acceptance:* `npm test` runs green locally and in CI; the Phase-0 security fixes each have a failing-without-the-fix test.

**P2 — CI gate**
- *Task:* In `.github/workflows/deploy.yml`, add a `test` job (`npm ci && npm test`, plus optional `eslint`); make `deploy` depend on it (`needs: [test]`). No green tests → no deploy.
- *Acceptance:* A PR with a failing test cannot deploy to `klinemen-catalog.com`.

**P3 — Migration process & rollback**
- *Task:* Move to `supabase db push` (or a documented, ordered apply) driven from CI/CLI against staging first, then prod. Record applied versions. Every migration header gains a tested down-SQL. Document the exact prod apply runbook in `SETUP.md`.
- *Acceptance:* Prod schema is reproducible from the repo; a migration can be rolled back using its documented down-SQL on staging.

**P4 — Error tracking / monitoring**
- *Task:* Add a lightweight reporter (Sentry browser SDK, or a Supabase `client_errors` table sink) wired to `window.addEventListener('error'|'unhandledrejection')` and the `renderError` path in `main.js`. Capture Edge Function failures to a durable store (they partly exist in `pos_sync_runs`; extend to `ai-extract`/`manage-users`).
- *Acceptance:* A thrown error in the field produces a server-side record with enough context to debug.

**P7 — Backups**
- *Task:* Confirm Supabase managed backups + PITR are enabled on the **prod** project; perform one **test restore** to staging and document it.
- *Acceptance:* A documented, exercised restore procedure exists.

### Phase 1 exit criteria
`npm test` gates deploys; staging exists; prod has verified backups + monitoring; all Phase-1 rows `DONE`; owner sign-off.

---

## 7. Phase 2 — Complete the security hardening

> **Goal:** finish the defense-in-depth items that aren't strict launch-blockers but should land before broad use. Est. 1–2 days.

- **S9** — Enforce `profiles.active` in RLS (SECURITY DEFINER `auth_is_active()` added to sensitive read policies) **or** formally accept short-JWT-TTL + auth-layer ban and document it. *(Owner decision: enforce-in-RLS vs documented-acceptance.)*
- **S11** — Replace raw `String(err.message)` responses with a generic message + correlation id; log full detail server-side (ties into P4). Stop forwarding the Anthropic error body in `ai-extract`.
- **S12** — Migrate `calibration_marks` and `item_jobs` RLS from `current_user_role()` to capability helpers (`auth_can_edit()` etc.), matching 0024. Decide the long-term fate of the `role` text column (keep as label only).
- **S13** — Constrain storage `images_insert`/`images_delete` to a path convention (e.g. `name like auth.uid() || '/%'` or an item-id prefix) so uploaders can't clobber others' keys.
- **S14** — Length/type-check POS-returned text fields before upserting into `pos_stock_mirror`.

### Phase 2 exit criteria
All Phase-2 rows `DONE` or `WON'T FIX (rationale)`; owner sign-off.

---

## 8. Phase 3 — Reliability & robustness

> **Goal:** the everyday flows fail safely. Est. 2–3 days.

- **R1 (client half)** — `parsePrice(raw)` helper rejecting NaN/negative/non-finite; use in `editor.js` save + `pricing.js` + `pricing_guided.js` (single source of truth; the DB CHECK from S7 is the backstop). *(The DB half is Phase 0.)*
- **R2** — Make bulk attribute edit report "updated X of Y; Z failed" and scope Undo to the IDs actually written (mirror the upload flow's partial-success pattern). Prefer a single RPC for the attribute merge if feasible.
- **R3** — On burst-undo delete failure, keep the tile in a "undo failed — retry" state and toast; never silently drop a row that still exists server-side.
- **R4** — Decide currency precision explicitly. If decimals are ever possible, switch pricing math to integer-cents; otherwise document the whole-number rounding as intentional.
- **R5** — If the guided-pricing cost-snapshot read fails, disable cost Undo (don't offer an Undo that restores wrong values). Make retail+cost a single transactional intent or clearly state cost wasn't applied.
- **R6** — `imageCompress.js`: enforce a max-bytes cap; if compression fails on a large file, warn/reject rather than silently uploading full-res.
- **R7** — Add in-flight guards (disable button) to pricing **Set** and guided **Apply**, matching the editor's Save guard.

### Phase 3 exit criteria
Each robustness fix has a test or a documented manual-verification; all Phase-3 rows `DONE`; owner sign-off.

---

## 9. Phase 4 — Code quality & hygiene

> **Goal:** lower the cost of every future change. Est. 1–2 days.

- **Q2** — Delete the 4 duplicate `esc()` copies; import the one in `ui.js` everywhere. Move `fmtPrice`/`fmtDate` to a shared `format.js`.
- **Q3** — Replace empty catches with `console.warn` + graceful degradation (keep the degradation; add the diagnostic). Surface persistent failures to the user where the data is load-bearing (e.g. ref-data load in `data.js`).
- **Q4** — Confirm `quickPriceItems` is unreferenced; remove it (flagged "REMOVAL CANDIDATE" already).
- **Q5** — Add leading comments to functions >10 lines per CLAUDE.md; rename a few generic local helpers (`draw`/`apply`/`go`).
- **S15** — Separate one-shot data migrations from schema DDL going forward (and guard existing 0006/0011/0021 against destructive replay).
- **P6** — Add `supabase/.temp/` to the **root** `.gitignore`.

### Phase 4 exit criteria
All Phase-4 rows `DONE`; build still green; owner sign-off.

---

## 10. Phase 5 — Scale & architecture (post-launch)

> **Goal:** remove the ceilings that don't bite at ~242 items but will at thousands. Defer until after a successful launch unless catalogue growth forces it earlier. Est. 3–6 days.

- **P5 — Pagination & query caps.** Range-based pagination / infinite scroll for the gallery; move filtering server-side (Supabase `.range()` + indexed filters) instead of fetch-all-then-filter; add a hard `.limit()` to the Shop query; warn (don't silently truncate) when export hits its cap.
- **Q1 — Decompose `gallery.js`.** Extract `facets.js`, `selection.js`, `filterSheet.js`, `bulkActions.js` from the 2096-line module; hold item state in one object; add a render-token/sequence guard to kill the stale-render race; make `refresh()` patch only changed rows instead of re-fetching the world after each edit. **This is the single biggest refactor; do it incrementally behind tests, one extracted module at a time.**

### Q1 decomposition — execution plan (review-gated, one PR per step)
Status so far: **P5 query caps done**; **sort extracted** to `src/lib/itemsort.js` (tested). The rest of `renderGallery` is a ~1530-line closure whose helpers (`valueOf`, `facets`, `matches`, the filter sheet, selection, bulk actions) close over mutable render state (`q`, `active`, `sortBy`, `priceMin`, `posMirror`, …), so they can't be lifted blindly. Recommended order, each its own commit + tests + manual verify, lowest-risk first:

1. **`lib/facets.js` (pure).** Extract `valueOf(it, key, ctx)` + facet-list building + `matchesFilters(it, criteria)` as PURE functions that take the render state as an explicit `ctx`/`criteria` argument (resolvers for category/shop/issue passed in, like readiness-core). gallery keeps thin wrappers binding the closure state. Unit-test the matcher (search, AND-across/OR-within facets, price/date/no-price). Highest value (the hardest logic) + safest (pure).
2. **`lib/itemsort.js`** — ✅ done.
3. **`selection.js`** — the multi-select model (selected set, range, select-all, selection-bar wiring) as a small controller with explicit callbacks. DOM-coupled → behind a manual verify.
4. **`filterSheet.js`** — the filter/sort bottom-sheet builder (takes facets + current criteria, returns the sheet + change events).
5. **`bulkActions.js`** — approve/AI-fill/status/delete/bulk-edit handlers as a module taking the selection + a refresh callback.
6. **Render token + targeted refresh.** Add a monotonic render id so a stale async `renderGallery` bails (kills the stale-render race), and make `refresh()` patch the in-memory `byId` from returned changes instead of cold-reloading items+mirror+jobs+activity on every edit.
7. **Gallery pagination** (P5 remainder) — once filtering is server-expressible, switch to `.range()` paging / infinite scroll; until then the honest 1,000 cap note stays.

Also in scope: **POS-SKU lib reconcile** — lift the grouping logic (`getGroupKey`/`resolveProductName`/`buildVariantAttributes`/`normalizeGender`) from `pos-push` into a shared `_shared/sku.ts` imported by both the edge function and a Vitest suite (removes the connector/edge duplication; the SQL `derive_item_sku` stays harness-tested).

### Phase 5 exit criteria
Gallery filtering is server-paged; `renderGallery` no longer reloads the full dataset per edit; the god-module is split into the modules above with tests around the extracted pure logic; POS-SKU logic deduped + unit-tested; owner sign-off.

---

## 11. Testing strategy (build in Phase 1, extend forever)

**Stack:** Vitest (+ coverage) for units/integration; a local Supabase (`supabase start`) for RLS/integration; Playwright for a small E2E smoke suite. `npm test` gates the deploy (P2).

- **Tier 1 — pure units (no DB), fast, run on every commit:** pricing engine (`finalPriceOf`, bands/thresholds, `costOf` %/fixed + rounding), `parsePrice` (R1), `readiness.js` blockers, POS mapping fns (`getGroupKey`, `resolveProductName`, `buildVariantAttributes`, `normalizeGender`). *(These cover money + SKU/group correctness — the highest-consequence logic.)*
- **Tier 2 — integration vs local Supabase, run in CI:** assert the security contracts directly — a viewer/editor JWT reads **0 rows** from `item_costs`; **S1** self-promotion is blocked; **S3** cost values are scrubbed in `item_events`; **S7** negative price is rejected; **S8** audit rows can't be forged/deleted; **S2** a non-admin manager can't mint an admin; bulk-edit partial-failure behavior (R2).
- **Tier 3 — Playwright smoke, run pre-release:** irreversible flows (bulk delete confirm, pricing apply on cross-category fans, upload happy path) + POS-push idempotency against a **mock POS** asserting no double receipt (DI1).

**Coverage targets (guidance, not dogma):** 90%+ on Tier-1 pure-logic files; every Phase-0 security fix has a test that fails without the fix.

---

## 12. Conventions for keeping this doc accurate

- **Update the register (§3) Status in the same PR that changes the code.** A `DONE` row whose code isn't merged is a lie.
- **Add a dated line to the Progress log (§13)** for each meaningful change, mirroring the style of `V3_ROADMAP.md`.
- **New findings** get the next free ID in their family (`S16`, `R8`, …), a register row, and a short write-up in the audit doc.
- **`WON'T FIX`** is allowed but must carry a one-line rationale and owner acknowledgement.
- **Decisions flagged "owner decision required"** (SKU uniqueness in S7; `category_id` nullability; S9 enforce-vs-accept) must be resolved with the owner *before* the relevant item is `DONE` — record the decision here.

---

## 13. Progress log

> Append newest entries at the top. Mirror the changelog style of `V3_ROADMAP.md` §10.

- **2026-06-17 — Phase 5 started.** P5 query caps done: explicit cap + truncation note on the Shop report (was silently relying on PostgREST's 1000 default) and on CSV exports (`1d7407b`). Q1 began with the safe slice — pure sort lifted to `src/lib/itemsort.js` + 6 tests (`740d2af`, 30 tests total). The remainder of Q1 (faceting/selection/filter-sheet/bulk + render-token + gallery pagination + POS-SKU dedup) is closure-bound and **review-gated** — a per-step execution plan is in §10. Recommended as a dedicated effort, ideally after the prod rollout of Phases 0–4.
- **2026-06-17 — Phase 4 (code-quality hygiene) complete.** Q4 removed dead `quickPriceItems` (`fceaaae`); Q2 collapsed 14 byte-identical `esc()` copies to the single `ui.js` export (`138a010`); Q3 added warnings on load-bearing silent failures in `data.js`/`costs.js` (`85e1dec`); S15 documented the data-vs-schema migration rule in MIGRATIONS.md (existing data migrations are replay-guarded); Q5 accepted as WON'T FIX (optional nit, strong existing coverage). Build + 24 tests green. **Only Phase 5 (scale: P5 pagination, Q1 gallery decomposition, POS-SKU lib) remains — a dedicated effort.**
- **2026-06-17 — Phase 2 closed; Phase 3 (robustness) complete.** S13 accepted (won't-fix, documented). Phase 3 all committed: R1 editor parsePrice guard (`feecb0c`); R6 oversize-upload reject + R3 honest burst-undo (`9fcdcaf`); R2 bulk-edit partial-failure reporting (`da70aa1`); R7 double-tap guards + R5 safe cost-undo + R4 whole-number precision note (`1fb713c`). Build + 24 tests green throughout. Next: Phase 4 (code-quality: Q2 esc dedup, Q3 catches, Q4 dead code, Q5 nits, S15) then Phase 5 (scale).
- **2026-06-17 — Phase 1 closed; Phase 2 nearly done.** Owner cleared P1 (staging admin works — upload persisted, confirming the promote-SQL) and P7 (prod managed backups present; a one-off test-restore still recommended). Phase 2: `0030_active_enforcement.sql` — S9 (`auth_is_active()` + `active` baked into all capability helpers + added to broad read policies) and S12 (calibration/item_jobs → capability helpers); Docker-validated (inactive account reads 0 + denied write; 0027 suite still green; commit `5ce9158`). Edge: S11 (generic error responses, detail kept in run row + logs) + S14 (clampText sanitizes POS-mirror text); commit `9440d66`. **S13 (storage per-path ownership) left as an OWNER DECISION** — current keys are random UUIDs with no upsert (clobber risk ≈ nil), so per-user-folder scoping needs an upload-path convention change for marginal gain; decide before closing Phase 2.
- **2026-06-16 — Phase 1 underway (commit-per-item).** P4 committed (`c37ed20`). T1: Vitest added (`npm test`, gated in CI); pure logic extracted to `src/lib/price.js` (parsePrice/costFromRetail/marginPercent — the suite caught a `Number(null)===0` bug) and `src/lib/readiness-core.js` (dependency-injected; `readiness.js` now a thin wrapper preserving every export). 24 tests green; build green; commits `a83a4a9`, `c12723c`. P2: deploy.yml gains a `test` job that blocks build+deploy (`78…`→pending commit). **POS-SKU JS unit tests deferred with rationale:** the grouping logic lives in the Deno `pos-push` function (and is duplicated in the connector); SKU derivation is already covered by the SQL harness (`derive_item_sku`), and extracting a third shared copy is best done when pos-push/connector are reconciled (folded into Phase 5). Remaining Phase 1 solo: P3 runbook. Owner: P1 staging admin + dev boot; P7 backups.
- **2026-06-16 — Staging stood up; hardening migrations verified on REAL Supabase (P1 nearly done).** Created `klinemen-catalog-staging` (ref `euvngvbqsikhewtyftxw`, distinct from prod `rlqtnmahyryvuitaytah`). Local `.env` now points at staging; prod values backed up to gitignored `.env.prod.local`. Probed staging via REST with the publishable key: `items`/`categories`/`item_events` → `200 []` (RLS denying anon, correct); `ai_usage`/`pos_sync_locks` → `401 42501 permission denied` (exist + service-role-only REVOKE active) vs a control missing table → `404 PGRST205`. So **all migrations incl. 0027/0028 are applied to staging and the hardening behaves correctly on real Supabase**, not just the Docker stub. P6 also closed (`.gitignore` += `supabase/.temp/`, `.env.*.local`). NOTE: 0027/0028 were applied to staging from the working tree before commit — must still be committed; confirm they are NOT yet applied to prod (prod waits for review). Remaining P1: create a staging admin (sign-up + promote SQL) and confirm `npm run dev` boots against staging.
- **2026-06-16 — Phase 0 code complete (IN REVIEW), all SQL behaviorally validated.** Two migrations + edge-function hardening, branch `hardening/production-readiness`:
  - **`0027_security_hardening.sql`** — S1 (self-escalation trigger), S3 (cost-event scrub trigger), S7 (non-neg price/stock/cost CHECKs, `category_id` NOT NULL guarded, non-unique `items_sku_idx`), S8 (audit_log append-only via REVOKE + reject-trigger; non-spoofable `item_events.actor`).
  - **`0028_edge_hardening.sql`** — S6 (`ai_usage` ledger, service-role only) + DI1 (`pos_sync_locks` + atomic `try_acquire_sync_lock`/`release_sync_lock`).
  - **Validation:** spun up Postgres 17 in Docker with Supabase-compatible stubs, applied all 28 migrations clean, then ran behavioral assertions — ALL PASS (self-escalation blocked; manager-edits-others allowed; cost values nulled in events; actor spoof prevented; audit_log UPDATE/DELETE blocked for editor *and* service_role; negative price + null category rejected; duplicate SKU allowed; lock is single-flight + steals stale; `ai_usage`/locks denied to clients, allowed to service_role). Harness saved under `supabase/tests/` (seed of T1).
  - **Edge functions** — new `supabase/functions/_shared/{http,auth}.ts`: S5 (origin-allowlisted CORS, `ALLOWED_ORIGINS`) across all 5; S4 (constant-time secret compare + fail-closed) in the POS trio; S2 (`manage-users` role allowlist + privilege-amplification guard + email/password validation); S6 (rate cap + fields cap in `ai-extract`, stop forwarding upstream error body); S10 + DI1 (`pos-push` limit clamp + single-flight lock). Plus `supabase/config.toml` pinning per-function `verify_jwt` (S4).
  - **NOT yet applied/deployed to any Supabase project** (no staging exists yet — that's P1). Deno not installed locally, so functions are review-verified, not type-checked; Supabase's deploy bundler will catch syntax. **Awaiting:** owner review → commit → (Phase 1) staging apply + deploy.
- **2026-06-16 — Owner decisions recorded; Phase 0 started.** Branch `hardening/production-readiness`. Decisions: (a) **S7 SKU** — keep intentional duplicate SKUs (one photo = one unit), no unique constraint; add a non-unique index + documenting comment. (b) **S7 category_id** — make `NOT NULL` (backfill any nulls first). (c) **S9** — enforce `profiles.active` in RLS via an `auth_is_active()` helper. (d) **P4** — capture errors in a Supabase `client_errors` table (no external vendor).
- **2026-06-16 — Roadmap created.** Companion to [V3_ENGINEERING_AUDIT.md](V3_ENGINEERING_AUDIT.md). All items `TODO`. Phase 0 is the gate before any wider exposure. Awaiting sign-off to begin Phase 0.
