# K-LINE MEN Catalog — V3 Roadmap

**Theme: "Coherence & Craft" — from power tool to premium product.**

**Date:** 2026-06-15
**Predecessor:** V2 `feature/v2-mobile-ops-cockpit` (Shop tab, Sync Center, Consistency, Activity/work-trail, Readiness, Job Log).
**Source of truth for findings:** [UX_PRODUCT_AUDIT.md](UX_PRODUCT_AUDIT.md) (2026-06-15). This roadmap is the prescription for that diagnosis.

> **Status: proposal — pending sign-off.** Work strictly phase-by-phase; verify each phase builds/works, then stop for explicit approval before the next. Nothing here is committed or built yet.

---

## 1. Thesis

V2 added power faster than it added coherence. The product now has **more concepts than its non-technical daily user can hold**, and its highest-frequency workflow (one-photo-per-unit capture) is its slowest. V3 does **not** add feature surfaces. It makes the existing power *feel* premium by doing four things, in order:

1. **Make it instant** — remove the perceived-speed gap.
2. **Make capture effortless** — the one genuinely new workflow worth building.
3. **Make it coherent** — fewer top-level concepts, each deeper.
4. **Make it crafted** — one component system, consistent motion, premium numbers.

If V3 succeeds, a first-time user perceives the app as fast, simple, and trustworthy within the first 30 seconds — and the daily user adds a rack of stock in a fraction of today's taps.

---

## 2. Guiding principles

- **Subtract before you add.** Every phase should leave fewer concepts/components than it found, except Phase 2 (the one sanctioned new workflow).
- **Touch-first, always.** No primary information or action may be hover/keyboard-only.
- **Uniformly forgiving.** Every destructive or bulk action is reversible (Undo) or explicitly confirmed.
- **One job per screen.** Especially on mobile — Uber/Revolut discipline.
- **Respect the invariants** (non-negotiable): cost data stays RLS-isolated to admins; `stock_quantity` pinned to 1 (one photo = one unit); no front-end framework (vanilla JS + Vite); AI only via the Edge Function; secure-context constraints for camera/PWA.
- **Visible polish first.** Per established preference, invisible refactors (e.g. CSS de-duplication) are sequenced late and can be interleaved/optional — but their *token scales* land early so new V3 work builds on them.

## 3. Non-goals for V3

- No new top-level tabs or feature areas.
- No batch-quantity / multi-unit-per-photo features (violates the audit rule).
- No new AI capabilities beyond wiring existing extraction into capture.
- No full offline write-queue (still out of scope, per prior decision).
- No backend/RLS model changes except where a phase explicitly requires one.

---

## 4. Phases at a glance

| Phase | Name | Goal | Impact | Effort | Risk | Depends on |
|------|------|------|--------|--------|------|------------|
| **0** | Quick-win polish pass | Remove visible friction + risk in one low-effort sweep | High | Low | Low | — |
| **1** | Make it feel instant | Kill the perceived-speed gap (C1) | Very High | Med | Med | — |
| **2** | Capture breakthrough | Burst/stocktake capture (C5) | Very High | Med | Med | 0 |
| **3** | Consolidate the IA | Fewer concepts, each deeper | Very High | Med-High | Med | 1 |
| **4** | Unify & smooth workflows | One model/task; no silent overrides; swipe triage | High | Med | Med | 3 |
| **5** | Design-system unification | One component each; spacing/type/radius scales | Med (High long-term) | Med-High | Med | token scales early |
| **6** | Premium finish | The delight layer | Med | Med | Low | 5 |

**Recommended sequence: 0 → 1 → 2 → 3 → 4 → 5 → 6.** Phases 0, 1, 2 are largely independent and could be reordered to taste; 3 should follow 1 (stable gallery render before IA changes); 4 follows 3; 6 follows 5.

---

## 5. Phases in detail

### Phase 0 — Quick-win polish pass
**Goal:** strip the most visible friction and the riskiest gaps in one low-effort sweep; build momentum and trust before the bigger phases.
**Scope (the §9 batch from the audit):**
- C3 — AI suggest fills empty fields only, or confirms before overwrite ([editor.js:536-551](src/editor.js#L536-L551)).
- C4 — Undo on bulk Edit, bulk Delete, calibration bulk-approve ([gallery.js:1657](src/gallery.js#L1657), [gallery.js:1888](src/gallery.js#L1888), [calibration.js:271-278](src/calibration.js#L271-L278)).
- C6 — surface the cost-missing blocker to non-admins as "Ask an admin to add cost" ([readiness.js:132](src/readiness.js#L132)).
- ≥44px tap targets: status pills, confidence pills, top-bar icon buttons ([styles.css:998](src/styles.css#L998), [styles.css:1013](src/styles.css#L1013), [styles.css:655-658](src/styles.css#L655-L658)).
- `inputmode="decimal"` on editor numeric inputs ([editor.js:836](src/editor.js#L836)).
- Hover/`title`-only info → tap-to-reveal (POS story, confidence reasons — [gallery.js:601](src/gallery.js#L601), [gallery.js:80](src/gallery.js#L80)).
- Loading skeleton for pricing's 5,000-row fetch ([pricing.js:61](src/pricing.js#L61)).
- Remove dead `openHistory` ([editor.js:1030-1052](src/editor.js#L1030-L1052)); `aria-labelledby` on confirm/prompt sheets ([ui.js:262](src/ui.js#L262)); delete the ~80–100 lines of flagged dead CSS.
**Out of scope:** any structural/IA change.
**Done when:** every §9 item shipped; no primary tap target <44px; no destructive/bulk action without Undo; touch users can reach all info.
**Effort:** Low · **Risk:** Low.

### Phase 1 — Make it feel instant
**Goal:** close the #1 perceived-quality gap (C1) so search/filter/scroll feel Linear-fast at full catalog.
**Scope:**
- Replace the full `.map().join("")` grid rebuild ([gallery.js:1013-1015](src/gallery.js#L1013-L1015)) with windowed/incremental rendering; `content-visibility:auto` on offscreen cards.
- Don't re-render the whole grid per keystroke/filter tap — diff or window.
- Optimistic UI on Approve/price (paint instantly, reconcile after).
**Out of scope:** changing what the gallery *shows* (that's Phase 3) — this phase is render-path only.
**Done when:** typing in search and toggling filters stays smooth (no visible reflow stall, ~60fps target) on a mid-range phone at full catalog; approve/price changes paint immediately.
**Effort:** Med · **Risk:** Med (core render path). **Do before Phase 3.**

### Phase 2 — Capture breakthrough (burst / stocktake mode)
**Goal:** collapse the highest-frequency workflow from ~3 taps/unit + an OS-camera round-trip to ~1 tap/unit (C5).
**Scope:**
- In-app full-bleed camera that **stays open**: tap shutter → thumbnail drops into a growing tray → keep shooting.
- Per-photo AI extraction fires in the background; shared category set **once** for the session.
- Reuse the existing compression + concurrent-upload + offline auto-resume pipeline ([upload.js](src/upload.js)).
- Keep the current single-shot/file-picker as a fallback.
**Constraints:** requires secure context (HTTPS / localhost) for `getUserMedia`; preserve the one-photo-one-unit rule (stock = 1).
**Done when:** a user photographs N units in one continuous session without leaving the camera; items land queued with AI running and a clear per-item status.
**Effort:** Med · **Risk:** Med (camera APIs, secure-context).

### Phase 3 — Consolidate the IA
**Goal:** the audit's core fix — fewer top-level concepts, each deeper; no orphan surfaces.
**Scope:**
- Replace the ~12-item ⋮ junk-drawer ([gallery.js:241-285](src/gallery.js#L241-L285)) with a slim account menu (`email · Settings · Sign out`) + a real **Settings screen**: General (Currency, Appearance, Install) / Data tools (Export, Consistency, Calibration) / Admin (Users, Categories).
- Fold **Sync Center into the Shop "Ops home"** as progressive disclosure; compute sync counts in **one** place (kill the [shop.js:50-56](src/shop.js#L50-L56) vs [synccenter.js:67-81](src/synccenter.js#L67-L81) duplication).
- Fold **Consistency into Review** as a "Catalog health" header that links to the existing queues ([consistency.js:154-157](src/consistency.js#L154-L157)).
- Promote the existing Cmd-K command palette ([gallery.js:336](src/gallery.js#L336)) to a **visible mobile affordance**.
- Give **Activity a home** — a global "Recent activity" view (the `item_events` model already supports it: [0023 indexes](supabase/migrations/0023_item_events.sql)).
**Done when:** ⋮ menu ≤3 items; sync counts have a single source; every surface is reachable (no Activity/Readiness orphans); Consistency is not a parallel audit screen.
**Effort:** Med-High · **Risk:** Med. **Depends on Phase 1.**

### Phase 4 — Unify & smooth workflows
**Goal:** one mental model per task; no silent overrides; faster triage.
**Scope:**
- **Pricing:** one default flow (guided sentence wizard); the pivot table becomes an explicit "Advanced" mode reached from inside it ([pricing_guided.js:267](src/pricing_guided.js#L267)); add a cost step so admins don't switch tools ([pricing_guided.js:22](src/pricing_guided.js#L22)). A label must never open two different tools.
- **No silent overrides:** stop AI-on-upload silently promoting `draft → needs-review` ([upload.js:95](src/upload.js#L95), [bulkai.js:211](src/bulkai.js#L211)); make pill-then-Save status changes explicit ([editor.js:485-488](src/editor.js#L485-L488)).
- **Swipe-review stack** for the uncertain pile: full-screen card, swipe right = approve, left = flag, up = fix-mode (data already there: [readiness.js:92-161](src/readiness.js#L92-L161), [editor.js:806-813](src/editor.js#L806-L813)).
**Done when:** pricing has one entry/model; status changes are never silent; reviewing the uncertain pile is a swipe loop.
**Effort:** Med · **Risk:** Med. **Depends on Phase 3.**

### Phase 5 — Design-system unification
**Goal:** one canonical component each; real spacing/type/radius scales; remove drift.
**Scope:**
- Merge the two sheet systems (`.msheet` + `.sheet`); one Chip with semantic modifiers (replace 9+ variants + the `.issue-pill`/`.source-pill` twins); collapse the 4 segmented controls; route all buttons through `.primary/.ghost/.danger/.iconbtn`; merge the two confidence chips; reuse the `.card` shell for shop/pricing/user/cat/audit rows.
- Add `--space-*` and `--text-*` tokens; actually honor `--radius` ([styles.css:297](src/styles.css#L297)).
**Sequencing note:** introduce the **token scales additively early** (cheap, low-risk, so Phases 2–4 build on them); the big de-duplication refactor lands here and may be interleaved or treated as optional per appetite for invisible work.
**Done when:** no duplicate component systems remain; new tokens are used; a visual-regression pass shows no unintended change.
**Effort:** Med-High · **Risk:** Med (broad but mechanical).

### Phase 6 — Premium finish
**Goal:** the delight layer that signals "high-end."
**Scope:**
- Loading states on every async surface; consistent error-state voice (match the good empty-state copy).
- Number/typography polish: tabular figures, currency alignment, "weeks of cover" framing extended from [shop.js:142-147](src/shop.js#L142-L147).
- Micro-interactions: card-select spring/scale, count-up on review-inbox bignums, satisfying swipe-away on approve (building on existing haptics, [editor.js:668](src/editor.js#L668)).
- Enrich the global Activity feed from Phase 3.
**Done when:** every async surface has a loading state; one consistent motion language; numbers read premium.
**Effort:** Med · **Risk:** Low. **Depends on Phase 5.**

---

## 6. Definition of done for V3 (exit criteria)

- **Speed:** search/filter/scroll smooth at full catalog on a mid-range phone; key actions optimistic.
- **Capture:** adding a rack of units is a continuous in-app burst, ~1 tap/unit.
- **Coherence:** ≤3 items in the account menu; a single Settings screen; sync state from one source; no orphan surfaces; one pricing model.
- **Forgiveness:** no destructive/bulk action without Undo or explicit confirm; no silent status changes.
- **Touch:** no primary info/action is hover/keyboard-only; no primary target <44px.
- **Craft:** one component system; spacing/type/radius tokens in use; consistent motion + premium number rendering.

## 7. Success metrics (how we'll know it worked)

| Metric | Today (approx) | V3 target |
|--------|----------------|-----------|
| Taps to add one unit (in a multi-unit session) | ~3 + OS round-trip | ~1 |
| Top-level concepts (tabs + menu items) | 4 tabs + ~12 menu | 4 tabs + ~3 menu + Settings |
| Sources computing sync counts | 2 | 1 |
| Pricing mental models from one entry | 2 | 1 |
| Destructive/bulk actions lacking Undo | 3 | 0 |
| Duplicate component systems (sheets/chips/segmented) | many | 1 each |
| Primary tap targets <44px | several | 0 |

## 8. Risks & constraints

- **Secure context** for camera/PWA (Phase 2) — test on the deployed HTTPS app, not plain-LAN http.
- **Render-path change** (Phase 1) touches the busiest code path — guard with manual perf checks before/after.
- **IA consolidation** (Phase 3) moves discoverable entry points — communicate changes; keep deep-links working.
- **CSS de-dup** (Phase 5) is broad — do behind a visual-regression check; respect the "visible polish first" preference (this phase is the least visible).
- **Invariants** must survive every phase: cost RLS isolation, stock=1, vanilla JS, AI-via-Edge-Function.

---

## 9. Open decisions (for sign-off)

1. **Lock the sequence?** Recommended `0 → 1 → 2 → 3 → 4 → 5 → 6`. Phases 0–2 are reorderable if you'd rather lead with the capture breakthrough (most visible daily value) than the quick-wins.
2. **Phase 5 appetite:** full design-system unification, or token scales only + opportunistic clean-up (defer the big de-dup)?
3. **Branch strategy:** continue on the V2 branch, or open a fresh `feature/v3-coherence` branch off `main` after V2 merges?

---

*This roadmap pairs with [UX_PRODUCT_AUDIT.md](UX_PRODUCT_AUDIT.md). Build one phase at a time; verify; stop for sign-off.*
