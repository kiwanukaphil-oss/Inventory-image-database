# K-LINE MEN Catalog — Engineering & Security Audit

**Date:** 2026-06-16
**Branch reviewed:** `feature/v3-coherence`
**Scope:** Full production-readiness review of the inventory PWA — security, code quality, architecture, data integrity, robustness/reliability, testing, deployment/ops, and UX-flow safety. Covers `src/` (~9.7K LOC vanilla JS), 26 SQL migrations, 5 Supabase Edge Functions, and build/CI/deploy config. The separate `inventory-pos-system` and `inventory-pos-connector` repos are out of scope except where this app calls them.
**Companion doc:** [V3_ENGINEERING_HARDENING_ROADMAP.md](V3_ENGINEERING_HARDENING_ROADMAP.md) — the prescription that resolves every issue below. This audit is the diagnosis; the roadmap is the cure and the single source of truth for *status*.

> This document is a reference, not a changelog. Nothing was modified to produce it. Each finding has a stable ID (e.g. `S1`, `R1`) used throughout the roadmap and in commit messages.

**Method:** Findings were produced by four parallel review passes (DB-layer security, edge-function security, frontend architecture/quality, robustness/ops). The highest-impact claims were then re-verified by hand against the source and are tagged **✓ verified**. One finding raised in review was checked and **withdrawn** (see the honesty note below) — included so the rest can be trusted.

**Honesty note:** an initial pass flagged `supabase/.temp/linked-project.json` as committed to git ("Critical"). Verified with `git ls-files`: it is **not** tracked, and `supabase/.gitignore` covers it. That finding is withdrawn and replaced by the Low item **P6** (root `.gitignore` lacks the same entry as belt-and-suspenders).

---

## 0. Executive verdict

> **Not production-ready** — but close, and well-built underneath.

The **application logic is unusually mature for a fast-built app**: capability-gated cost isolation, idempotent POS receipts, thoughtful Undo, source-aware audit events, disciplined HTML-escaping (no shipped XSS), and only the anon key on the client. But the **security model has three real holes that defeat its own central promise**, and the **production engineering around the code is largely absent.**

- Cost isolation — the headline requirement — is undermined by a **self-promotion vector** (any user-manager can grant themselves admin/cost via a plain `profiles` UPDATE — **S1**) and a **work-trail redaction enforced only in app code** on an editor-readable table (**S3**).
- The money path **accepts negative prices** on its most-used surface with no DB backstop (**R1 / S7**).
- There are **zero tests, no monitoring, a single shared dev/prod database, and manual migrations with no rollback** — so a regression in pricing or a bad migration reaches the live shop with nothing to catch it (**T1, P1–P4**).

The blockers are concentrated and fixable — "harden," not "rewrite." Close the Criticals + the production floor and this moves to **"production-ready with minor fixes"** for a small-team launch; the gallery refactor and pagination are scale-up work that can follow.

---

## 1. What is already strong (give credit — it's real, ✓ verified)

- **Only the anon key ships client-side** — [db.js:7](src/db.js#L7); `service_role` appears only in a comment, never in client code. `.env` is gitignored and untracked.
- **Cost is structurally isolated** — no SQL views exist anywhere, and `items` has *no* cost column, so item SELECTs are physically incapable of leaking cost. Cost lives only in `item_costs` behind `auth_can_view_cost()` ([0001_init.sql:96](supabase/migrations/0001_init.sql#L96), [0008_capabilities.sql:76-79](supabase/migrations/0008_capabilities.sql#L76)).
- **All `SECURITY DEFINER` functions pin `search_path = public`** — no search-path privilege escalation ([0001:31,52](supabase/migrations/0001_init.sql#L31), [0008:42-58](supabase/migrations/0008_capabilities.sql#L42), [0025](supabase/migrations/0025_item_cost_presence.sql)).
- **No SSRF in the image path** — both `ai-extract` and `pos-push` build a bucket-scoped `createSignedUrl(item.image_path, …)` rather than fetching a caller-supplied URL.
- **Disciplined output escaping** — a correct `esc()` helper is applied at essentially every DB/LLM/POS text sink; **no exploitable stored-XSS was found.**
- **Real defense-in-depth on POS sync** — receipt idempotency by `reference_id` plus a nightly `pos-reconcile` drift detector.

---

## 2. Security

### 🔴 Critical

#### S1 — Any "user manager" can self-promote to admin / cost-viewer · ✓ verified
[0008_capabilities.sql:119-121](supabase/migrations/0008_capabilities.sql#L119)
- **Problem:** `profiles_manage_write` is `for update using (auth_can_manage_users()) with check (auth_can_manage_users())` — no column restriction, no `id <> auth.uid()` guard. A user with `can_manage_users=true` but `can_view_cost=false` can run `update profiles set can_view_cost=true, role='admin' where id = auth.uid()` from the normal authenticated API.
- **Why it matters:** Defeats the *entire* premise of the capability split — that managing people is separable from seeing cost (the headline requirement). One statement, no service key.
- **Fix:** Add `and id <> auth.uid()` to the `with check`, plus a `BEFORE UPDATE` trigger rejecting any change to `can_*`/`role`/`active` when `NEW.id = auth.uid()`. Reserve granting `can_view_cost`/`admin` to true admins.
- **Before production?** **Yes.**

#### S2 — `manage-users` lets a non-admin manager mint a fresh admin; no password policy
[manage-users/index.ts:50-66](supabase/functions/manage-users/index.ts#L50)
- **Problem:** Gate is "`can_manage_users` OR admin", then `role`/`caps` are accepted verbatim and `password` is only checked truthy. A manager can `create` `{role:"admin", can_manage_users:true}` with a trivially weak password.
- **Why it matters:** Privilege escalation (the API twin of S1) + weak-credential admin accounts.
- **Fix:** Allowlist `role`; forbid non-admins creating/escalating `admin`/`can_manage_users`; never let a manager grant a capability they don't hold; enforce email format + password length server-side.
- **Before production?** **Yes** (escalation guard); password policy close behind.

### 🟠 High

#### S3 — Cost redaction in the work trail is enforced only in app code; the table is editor-readable · ✓ verified
[0023_item_events.sql:74-79](supabase/migrations/0023_item_events.sql#L74), [0026_redact_cost_in_item_events.sql:13-17](supabase/migrations/0026_redact_cost_in_item_events.sql#L13)
- **Problem:** `item_events_read`/`item_events_insert` are both `auth_can_edit()` — every editor reads all events. 0026 is a *one-time* `UPDATE` scrub; there is **no trigger** forcing cost values to null on future inserts. Redaction lives solely in `src/activity.js`. Any code path/bug that writes a cost value, or a direct API insert, exposes admin-only cost to a `can_edit && !can_view_cost` user.
- **Why it matters:** Exactly the leak the cost-isolation requirement forbids — cost at the row/API level, not just hidden UI. The DB does not enforce it.
- **Fix:** `BEFORE INSERT OR UPDATE` trigger on `item_events` that unconditionally nulls `before_value`/`after_value` when `field_path='cost_price'`, regardless of caller.
- **Before production?** **Yes.**

#### S4 — Non-constant-time / fragile secret gate on the `--no-verify-jwt` POS functions
[pos-push/index.ts:299-303](supabase/functions/pos-push/index.ts#L299), [pos-mirror/index.ts:123-127](supabase/functions/pos-mirror/index.ts#L123), [pos-reconcile/index.ts:95-99](supabase/functions/pos-reconcile/index.ts#L95)
- **Problem:** Access gated by `bearer === SERVICE_KEY || bearer === MIRROR_INVOKE_KEY` with plain `===`. These functions are deployed `--no-verify-jwt`, so this compare is the *only* gate on privileged operations (booking receipts, creating POS products, reading the full POS ledger with the service-role key). `verify_jwt` posture isn't version-controlled (no `supabase/config.toml`), so it can drift.
- **Why it matters:** A guessed/leaked invoke key = full unauthenticated invocation; timing side-channel; silent config drift.
- **Fix:** Constant-time compare (hash both sides via `crypto.subtle.digest`); assert each secret present + high-entropy at handler start (fail closed → 500); commit `supabase/config.toml`.
- **Before production?** **Yes.**

#### S5 — Wildcard CORS (`Access-Control-Allow-Origin: *`) on every function, incl. admin + paid-LLM
[ai-extract/index.ts:29-33](supabase/functions/ai-extract/index.ts#L29), [manage-users/index.ts:24-28](supabase/functions/manage-users/index.ts#L24)
- **Problem:** All five functions allow any origin, including user creation and the Anthropic-spending endpoint.
- **Why it matters:** Any web page can drive these from a victim's browser with any token it can obtain.
- **Fix:** Allowlist the known PWA origin(s); reject others.
- **Before production?** **Yes.**

#### S6 — `ai-extract` has no rate limit or spend cap on a paid LLM (defaults to Opus vision)
[ai-extract/index.ts:27](supabase/functions/ai-extract/index.ts#L27), [ai-extract/index.ts:112-141](supabase/functions/ai-extract/index.ts#L112)
- **Problem:** Auth requires editor/admin (good) but no per-user quota, concurrency cap, or daily ceiling, and `fields` length is unbounded (inflates each prompt).
- **Why it matters:** One leaked editor JWT = unbounded vision spend until the bill is noticed.
- **Fix:** Per-user token-bucket (DB counter) + global daily ceiling; cap `fields.length`; consider a cheaper default model.
- **Before production?** **Yes.**

#### S7 — Missing DB integrity constraints permit negative/garbage business data
[0001_init.sql:60-96](supabase/migrations/0001_init.sql#L60)
- **Problem:** No `CHECK (price >= 0)`, no non-negative check on `stock_quantity`/`reorder_level`/`cost_price`; `category_id` nullable; no uniqueness on the natural product key. With the client gap (R1), negative prices reach the POS as sellable variants.
- **Why it matters:** Negative/garbage prices, costless/categoryless items, silent duplicates — accounting corruption with no backstop.
- **Fix:** Non-negative `CHECK`s on price/stock/cost; `NOT NULL`/default on `category_id`; decide SKU-uniqueness or document the intentional duplicate-SKU model.
- **Before production?** **Yes** (at least the non-negative checks).

#### S8 — Audit trail is not tamper-resistant and is unattributable for automated writes · ✓ verified (actor-spoof)
[0005_editing.sql:153-156](supabase/migrations/0005_editing.sql#L153), [0023_item_events.sql:54-69](supabase/migrations/0023_item_events.sql#L54)
- **Problem:** `audit_log` is written by a `SECURITY DEFINER` trigger but has no immutability (no `revoke update, delete`, no block-trigger). Connector/service-role writes record `actor = null`. `item_events.actor` is only filled when null, so an editor can **forge** the actor on inserted events.
- **Why it matters:** An audit log you can edit/truncate/spoof isn't an audit log; with S1, an escalated user can erase evidence.
- **Fix:** `revoke update, delete on audit_log from authenticated, anon` + reject-trigger; always overwrite `actor := auth.uid()` (not only when null); record a sentinel actor for service-role writes.
- **Before production?** Recommended yes.

#### S9 — `profiles.active` (deactivation) is not enforced in RLS
[0014_profile_active.sql](supabase/migrations/0014_profile_active.sql), [0001_init.sql:120-121](supabase/migrations/0001_init.sql#L120)
- **Problem:** Reads use `auth.role() = 'authenticated'`; `active` is consulted nowhere in RLS. A deactivated user with a still-valid JWT keeps full read access until the token expires.
- **Why it matters:** "Disabled account" isn't enforced in depth at the DB.
- **Fix:** Add an `active` check (via a SECURITY DEFINER helper) to sensitive read policies, or confirm short JWT TTL + auth-layer ban is acceptable and document it.
- **Before production?** No if short TTL + ban verified; otherwise yes.

### 🟡 Medium
- **S10 — `pos-push` accepts unbounded `limit`/`dirtyLimit`** ([pos-push:316-318](supabase/functions/pos-push/index.ts#L316)) — clamp to ≤50; the 20/run cap exists to stay under edge timeouts + the POS image rate limit.
- **S11 — Raw downstream error strings returned to clients** (every catch returns `String(err.message)`; [ai-extract:235-246](supabase/functions/ai-extract/index.ts#L235) forwards the Anthropic error body) — return a generic error + correlation id; log detail server-side.
- **S12 — Role-vs-capability dual model** — `calibration_marks`/`item_jobs` still gate on `current_user_role()` while everything else uses capability helpers; inconsistent enforcement + a second writable source of truth (`role`). Migrate them to `auth_can_*` as 0024 did.
- **S13 — Storage has no per-path ownership** ([0008:82-88](supabase/migrations/0008_capabilities.sql#L82)) — any uploader can write any key in the bucket; constrain inserts to a path prefix.
- **S14 — POS-returned text upserted into the mirror unsanitized** ([pos-mirror:165-196](supabase/functions/pos-mirror/index.ts#L165)) — length/type-check before storing.

### 🟢 Low
- **S15 — Data-mutating migrations (0006/0011/0021) interleaved with schema DDL** — replay risk on a populated DB; separate one-shot data migrations.

---

## 3. Code Quality

### 🟠 High
- **Q1 — `gallery.js` is a 2096-line god-module with a ~1530-line `renderGallery`** ([gallery.js:549](src/gallery.js#L549)) — faceting, selection, drag, filter sheet, bulk ops, saved views as nested closures over shared mutable locals. Every editor save calls `refresh()` → full re-fetch + rebuild ([gallery.js:783](src/gallery.js#L783)), defeating the incremental reconciler added for performance. **#1 refactor target.**
- **Q2 — `esc()` duplicated 5×** (ui.js:14, [gallery.js:429](src/gallery.js#L429), editor.js:29, users.js:22, …) — the escaping function is a security primitive; copies diverge. Import the one in `ui.js`.

### 🟡 Medium / 🟢 Low
- **Q3 — Swallowed/empty catches hide failures** ([editor.js:596](src/editor.js#L596), [costs.js:23](src/costs.js#L23), [gallery.js:566](src/gallery.js#L566)) — keep graceful degradation but `console.warn` (CLAUDE.md flags silent swallow).
- **Q4 — Confirmed dead code:** `quickPriceItems` self-labeled "REMOVAL CANDIDATE" ([gallery.js:1813](src/gallery.js#L1813)) — confirm unreferenced, remove.
- **Q5 — Style nits:** a few functions >10 lines lack the leading comment CLAUDE.md requires; a few generic local names (`draw`/`apply`/`go`). Minor; naming is otherwise strong.

---

## 4. Architecture
- **Generally sound:** clean layering (`db.js` client → `data.js`/`costs.js` data layer → feature modules → shared `ui.js` primitives); security correctly pushed into RLS, not the client.
- **Weak points:** the `gallery.js` god-module (Q1); a **role/capability dual authority** in the DB (S12); **no `config.toml`** (S4); client trusts an env-var function URL (acceptable — functions self-authorize).
- **Scaling ceiling:** fetch-all-then-filter on the client caps at 1000/2000 rows (P5).

---

## 5. Data Integrity
- Missing `CHECK`/`NOT NULL`/uniqueness (S7); audit tamper + actor spoofing (S8); cost-redaction not DB-enforced (S3).
- **DI1 — `pos-push` receipt idempotency is a non-atomic check-then-act with no run lock** ([pos-push:454](supabase/functions/pos-push/index.ts#L454)) — cron-every-5-min + manual "Sync now" can overlap and **double-book a receipt** (double-counted stock). Add a Postgres advisory lock / atomic claim row, and a unique constraint on `reference_id`+`movement_type` at the POS.

---

## 6. Robustness & Reliability

### 🔴 Critical
#### R1 — Editor write path accepts negative/NaN prices and costs · ✓ verified
[editor.js:894](src/editor.js#L894), [editor.js:907](src/editor.js#L907), [editor.js:941](src/editor.js#L941), [editor.js:947](src/editor.js#L947)
- **Problem:** `numVal`/`num` are bare `Number(v)` — no negative/NaN guard. `pricing.js`/`pricing_guided.js` *do* validate negatives, so the guarantee is illusory: the most-used surface (the editor) does not, and there is no DB `CHECK` (S7). A `-50` cost/price flows into the POS as a sellable variant.
- **Fix:** Central `parsePrice(raw)` (reject NaN/negative/non-finite) used in editor + both pricing surfaces; add the DB `CHECK` as backstop.
- **Before production?** **Yes.**

### 🟠 High
- **R2 — Bulk attribute edit is an N+1 sequential write that aborts mid-batch** ([gallery.js:1765](src/gallery.js#L1765)) — item 30/100 fails → 1–29 written, rest not, and the all-or-nothing Undo doesn't match the partial write. Report "updated X of Y" (the upload flow already does); scope Undo to written IDs.
- **R3 — Burst-capture undo delete is best-effort and swallowed** (`upload.js` `undoLast`) — a failed server delete drops the tile from the UI but leaves an orphan item/photo that can enter Review and be pushed to the POS. Surface a "retry" state.

### 🟡 Medium
- **R4 — Pricing uses float `Number` + `Math.round`** ([pricing_guided.js:162](src/pricing_guided.js#L162)) — safe for whole-number UGX, but float drift/off-by-one if a decimal currency is ever set (currency is free-text). Decide precision; integer-cents if decimals possible.
- **R5 — Guided-pricing cost-snapshot read is swallowed** ([pricing_guided.js](src/pricing_guided.js)) → a partial Undo can restore wrong cost values (admin-sensitive). Disable cost Undo if the snapshot read failed.
- **R6 — `imageCompress.js` silently uploads the original full-res photo on failure** (HEIC/old Safari) — no size cap; bloats storage + the later POS image transfer. Add a max-bytes cap + notice.
- **R7 — Double-tap guards inconsistent** — editor Save has an in-flight flag; pricing **Set**/guided **Apply** do not. Disable while writing.

---

## 7. Testing

### 🔴 Critical
#### T1 — Zero automated tests · ✓ verified
No `*.test.*`/`*.spec.*`/vitest/jest outside `node_modules`; no `test` script. Money math, cost-isolation, SKU/group derivation, POS push idempotency, and bulk ops are entirely unverified, yet they deploy straight to a live shop. (Plan in the roadmap §Testing.)

---

## 8. Production Readiness

### 🔴 Critical
#### P1 — No environment separation: one Supabase project is dev *and* prod
`npm run dev`, the deployed site, and the destructive `seed.mjs` (service_role) all hit the same DB. A bad migration or stray seed/bulk-delete during development corrupts production directly.

### 🟠 High
- **P2 — CI deploys on "did Vite build"** — [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs `npm ci && build && publish` with no test/lint/typecheck gate. Any compiling push to `main` ships to `klinemen-catalog.com`.
- **P3 — Migrations applied by hand in the SQL Editor** (SETUP.md), no rollback/down-migrations, nothing verifies prod schema = repo, order matters (seed warns "run 0004 first"). Adopt `supabase db push` in a gated job or document exact order + tested rollback.
- **P4 — No error tracking / monitoring** — no `window.onerror`/`unhandledrejection`, no Sentry. Field failures leave no record. Add a browser error reporter wired to the global handlers and the `renderError` path.
- **P5 — Gallery fetches up to 1000 rows + signs all thumbnails; Shop query is unbounded** ([gallery.js:468](src/gallery.js#L468)) — works at ~242 items, but items past the cap are invisible and the payload is heavy on mobile data. Range pagination + server-side filtering; cap the Shop query.

### 🟢 Low
- **P6 — Root `.gitignore` doesn't list `supabase/.temp/`** (only `supabase/.gitignore` does). Add it to root as belt-and-suspenders. *(Replaces the withdrawn "committed secret" finding — nothing is tracked.)*
- **P7 — Backups unverified** — confirm Supabase managed backups + PITR are enabled and that a restore actually works.

---

## 9. Top 10 highest-risk issues (ranked)

| # | ID | Title | Severity |
|---|----|-------|----------|
| 1 | S1 | Self-promotion to admin/cost via `profiles` UPDATE | Critical ✓ |
| 2 | R1 / S7 | Editor accepts negative/NaN price & cost; no DB CHECK | Critical ✓ |
| 3 | S3 | Cost redaction in `item_events` is app-only; editor-readable | Critical/High ✓ |
| 4 | T1 + P1 | Zero tests **and** one shared dev/prod DB | Critical pair |
| 5 | S2 | `manage-users` lets a non-admin mint an admin; no password policy | Critical |
| 6 | S4 | Fragile / non-constant-time secret gate on `--no-verify-jwt` POS fns | Critical |
| 7 | S6 | No rate/cost cap on paid `ai-extract` (Opus vision) | High |
| 8 | DI1 | `pos-push` double-receipt race (no run lock) | High |
| 9 | S5 | Wildcard CORS on admin + paid endpoints | High |
| 10 | P3/P4 | Manual migrations w/ no rollback + no error monitoring | High |

---

## 10. Final verdict

**Not production-ready** — the architecture and product logic are genuinely good; the gaps are concentrated and fixable. The blockers are "harden," not "rewrite": ~7 security fixes (S1–S6, S8), one client validation fix + DB constraint (R1/S7), a concurrency lock (DI1), and the operational floor (a staging DB, a test suite around the money/RLS paths, a CI gate, error monitoring). Close those and this is **production-ready with minor fixes** for a small-team launch; the gallery refactor and pagination are scale-up work that can follow.

See [V3_ENGINEERING_HARDENING_ROADMAP.md](V3_ENGINEERING_HARDENING_ROADMAP.md) for the sequenced resolution plan and live status of every issue.
