# K-LINE MEN Catalog — Product & UX Review

**Date:** 2026-06-15
**Branch reviewed:** `feature/v2-mobile-ops-cockpit`
**Scope:** Full end-to-end review of the mobile-first inventory PWA — visual design, mobile ergonomics, interaction design, every major workflow, information architecture, the V2 "ops cockpit" layer, and the CSS design system.
**Method:** Read of all 27 source modules (~9,400 LOC) and `styles.css`. Findings are grounded in code with `file:line` references so each can be acted on directly. Benchmarked against Linear, Notion, Stripe Dashboard, Revolut, Monzo, and Uber.

> This document is a reference/roadmap, not a changelog. Nothing was modified to produce it. Work it phase-by-phase with sign-off between phases.

---

## 0. Executive verdict

**Current tier: a genuinely well-engineered "power tool," not yet a premium product.**

The foundations are better than most internal tools ever get:
- A real elevation ladder and tokenized dual (light/dark) theme — [styles.css:7-68](src/styles.css#L7-L68).
- A disciplined overlay/focus-trap / `:focus-visible` / `prefers-reduced-motion` / safe-area stack — [ui.js:60-108](src/ui.js#L60-L108), [styles.css:129-139](src/styles.css#L129-L139).
- Capability gating mirrored by RLS (not just hidden UI).
- Two standout workflows: the guided-pricing "sentence" wizard with a photo-bucket preview ([pricing_guided.js:229](src/pricing_guided.js#L229)) and the readiness engine that chains issue badges → fix-mode → focus-by-issue into one triage loop ([readiness.js](src/readiness.js), [editor.js:432-455](src/editor.js#L432-L455)).

**The single biggest problem is not visual — it is conceptual sprawl.** The V2 "ops cockpit" added six overlapping systems (Shop, Sync Center, Consistency, Activity/work-trail, Readiness, Job Log). Only **Shop** is a real screen; Sync Center and Consistency are bottom-sheets buried two menus deep; **Activity and Readiness have no entry point at all** — they surface only after you open a specific item. Sync counts are computed two different ways in two places ([shop.js:50-56](src/shop.js#L50-L56) vs [synccenter.js:67-81](src/synccenter.js#L67-L81)), and there are **two pricing tools with different mental models** reached from the same menu ([gallery.js:232](src/gallery.js#L232) opens the guided wizard; [gallery.js:1868](src/gallery.js#L1868) opens the pivot tool).

Linear, Stripe, and Revolut win on **restraint and coherence**, not feature count. Today the product has more concepts than a non-technical shop owner can hold.

**The route to "premium" from here is consolidation + polish + one workflow breakthrough — not more features.** In order: kill the grid re-render jank, fix the capture loop, consolidate the IA, standardize the component layer.

---

## 1. What is already premium (give credit — it's real)

- **Theme & elevation:** documented elevation ladder `--bg < --control < --panel < --elevated`, full light-mode re-tint with a contrast rationale in comments — [styles.css:7-120](src/styles.css#L7-L120).
- **Overlay system:** nested focus-trap stack with restore, top-overlay Esc routing, backdrop/✕/Esc all unified — [ui.js:60-108](src/ui.js#L60-L108), [ui.js:161](src/ui.js#L161).
- **Mobile shell hygiene:** static (non-fixed) bottom nav that "can't move" ([styles.css:229-236](src/styles.css#L229-L236)), `100dvh`, `env(safe-area-inset-*)` applied to topbar/nav/FAB/sheet-feet/toast/lightbox, `overscroll-behavior:contain`.
- **Accessibility care:** low-specificity `:focus-visible` ring via `:where()` ([styles.css:129-131](src/styles.css#L129-L131)), global reduced-motion neutralization, `role`/`aria-live` on toasts and dialogs, login `aria-pressed`/`autocomplete`.
- **Auth robustness:** deadlock-aware auth ([auth.js:12-19](src/auth.js#L12-L19)) and a uid-diff re-render guard so token refresh doesn't reset the view ([main.js:40-44](src/main.js#L40-L44)).
- **Premium workflow moments:** guided-pricing sentence model + per-bucket photo preview before write; readiness-driven fix-mode and focus-by-issue; honest staleness/truncation messaging ("showing the first 1,000 — refine to see all", [gallery.js:941-942](src/gallery.js#L941-L942)); offline auto-resume on upload ([upload.js:499-506](src/upload.js#L499-L506)).
- **Data integrity respected:** one-photo-one-unit rule enforced (stock pinned to 1, >1 confirm); cost isolated to `item_costs` with presence-only RPC for non-admins ([costs.js](src/costs.js)).
- **Voice:** empty/healthy-state copy is genuinely good — "Nothing running low 🎉", "No sleepers — everything has moved" ([shop.js:217-229](src/shop.js#L217-L229)).

---

## 2. Critical issues (immediate attention)

| # | Issue | Evidence | Why it's critical |
|---|-------|----------|-------------------|
| C1 | **Entire grid re-renders on every keystroke and every filter tap** — up to 1,000 cards via `.map().join("")`, no virtualization/pagination | [gallery.js:1013-1015](src/gallery.js#L1013-L1015); cap [gallery.js:415](src/gallery.js#L415); jank acknowledged in-code [gallery.js:1533](src/gallery.js#L1533) | Directly undermines the "fast/premium" feel. A 150ms debounce ([gallery.js:1535](src/gallery.js#L1535)) only masks it; at full catalog it stutters on mid-range phones. #1 perceived-quality gap vs Linear/Stripe. |
| C2 | **Touch is the primary platform, but key info is hover/`title`-only** — POS sync story, confidence reasons | [gallery.js:601](src/gallery.js#L601), [gallery.js:80](src/gallery.js#L80) | On a phone these tooltips are invisible. Information the design deliberately surfaces is unreachable for most users. |
| C3 | **AI suggest overwrites non-empty fields** despite the "only-fill-empty" intent | [editor.js:536-551](src/editor.js#L536-L551) vs comment [editor.js:26](src/editor.js#L26) | Silently destroys user-entered data; erodes AI trust. Upload and bulk paths correctly fill-empty-only — the editor is the outlier. |
| C4 | **Inconsistent reversibility** — Approve and price changes have batched Undo; **bulk Edit, bulk Delete, calibration bulk-approve have none** | Undo: [gallery.js:1816-1837](src/gallery.js#L1816-L1837); no-Undo: [gallery.js:1657](src/gallery.js#L1657), [gallery.js:1888](src/gallery.js#L1888), [calibration.js:271-278](src/calibration.js#L271-L278) | Premium products are uniformly forgiving. A bulk delete with no undo on a mis-tap-prone phone is a data-loss trap. |
| C5 | **The highest-frequency workflow is the slowest.** One photo = one unit, users add many per session, but the camera input is single-shot — re-tap "Take photo" + OS camera round-trip per unit | [upload.js:151](src/upload.js#L151); rule: memory `one-photo-one-unit` | The core job, repeated dozens of times a session, has the highest friction. Biggest single workflow opportunity (§5a). |
| C6 | **A cost-missing approval blocker is invisible to the people it blocks** | blocker [readiness.js:132](src/readiness.js#L132); field gated out [editor.js:251-256](src/editor.js#L251-L256) | Non-admins are told "Fix issues first" with no way to see or fix the issue — a dead-end. |

---

## 3. Core diagnosis — Information Architecture & feature sprawl

The highest-leverage section. The app accreted a powerful V2 layer without an IA to hold it.

### What's wrong now
- **The ⋮ account menu is a junk drawer of ~12 items** spanning tools, admin, settings, and account — [gallery.js:241-285](src/gallery.js#L241-L285): Quick actions, Set prices, Calibration check, AI consistency audit, Export CSV, Shop sync, Users, Categories, Currency, Appearance, Install, Sign out. Five different *kinds* of thing in one list.
- **The richest tools are hardest to find.** Sync Center and Consistency read like premium dashboards but live two menus deep and are role-gated ([gallery.js:248-250](src/gallery.js#L248-L250)); Activity and Readiness have no surface of their own.
- **Concept duplication.** Sync state computed twice ([shop.js:50-56](src/shop.js#L50-L56) vs [synccenter.js:67-81](src/synccenter.js#L67-L81)); "Waiting to go to the shop" exists in both Shop and Sync Center; Consistency's "Missing details"/"AI checks" rows ([consistency.js:154-157](src/consistency.js#L154-L157)) are just a bulk view of readiness queues that already exist in Review.
- **Two pricing mental models** from one entry point (pivot table vs guided sentence) — a user can't predict which opens.

### Recommended IA (proposed — for sign-off, not a silent decision)

Keep the 4-tab bottom nav but make each tab a coherent home, and replace the junk-drawer menu with two real destinations:

```
Bottom nav:  Catalog · Add · Review · Shop
                                        └─ Shop becomes the single "Ops home":
                                           Today's numbers → Health (one sync strip) →
                                           Running low / Sold out / Best / Sleepers →
                                           "Needs sync attention" (drills into recovery)

⋮ menu  →  collapses to just:  [Account email/role] · Settings · Sign out

Settings screen (grouped):  General    (Currency, Appearance, Install)
                            Data tools (Export, Consistency audit, Calibration)
                            Admin      (Users, Categories)   ← gated

Command palette (Quick actions / Cmd-K, already exists at gallery.js:336):
   promote to a visible button so mobile users get it too — your best
   discoverability asset is currently keyboard-only.
```

- **Fold Sync Center into the Shop tab** as progressive disclosure; compute sync counts in exactly one place. Recovery actions become a "Fix sync issues" drill-down, not a separate modal.
- **Fold Consistency into Review** as a "Catalog health" header linking to the same queues it already targets — don't maintain a parallel audit surface.
- **Give Activity a home.** `item_events` already supports a global feed ([0023 indexes](supabase/migrations/0023_item_events.sql)). A lightweight "Recent activity" view turns invisible plumbing into a trust feature.

Benchmark: this is the Stripe/Linear move — fewer top-level concepts, each deep; settings clearly separated from work; a command palette as the power-user escape hatch.

---

## 4. Mobile-first experience

**Strong:** safe-area hygiene and the static bottom nav (see §1).

**Problems:**
- **Sub-44px tap targets in primary spots.** Status pills `5px 10px`/12px font ([styles.css:998](src/styles.css#L998)) yet a primary action; confidence pills 32px ([styles.css:1013](src/styles.css#L1013)); top-bar icon buttons 40px ([styles.css:655-658](src/styles.css#L655-L658)); bottom-nav labels 11px under 20px icons. Apple/Material guidance is 44/48px.
- **Desktop patterns carried to mobile:** shift-click range select ([gallery.js:1091](src/gallery.js#L1091)) and Cmd-K ([gallery.js:336](src/gallery.js#L336)) have no surfaced touch equivalent; the `title` tooltips of C2.
- **Long-press selection is undiscoverable** — 380ms press with no teaching affordance ([gallery.js:1111](src/gallery.js#L1111)).
- **`inputmode="decimal"` missing in the editor** ([editor.js:836](src/editor.js#L836)) — wrong keypad for price/cost — even though *pricing* gets it right ([pricing.js:424](src/pricing.js#L424)).
- **Shop health strip is a 5-column grid with 10.5px ellipsised labels** on a phone ([styles.css:553-558](src/styles.css#L553)) — too dense to read or tap.

---

## 5. Workflow redesigns (with tap counts)

### 5a. Capture — the breakthrough opportunity
**Today (many units):** "Take photo" → OS camera → confirm → back → "Take photo" → … ~3 round-trips per unit ([upload.js:151](src/upload.js#L151)).
**Redesign — in-app burst/stocktake mode:** a full-bleed camera that stays open; tap shutter → thumbnail drops into a growing tray → keep shooting; AI fires per-photo in the background; one "Done (N)" sets the shared category once. This is the Uber/POS-scanner pattern: one job, giant target, zero chrome, no round-trips. Cuts ~3 taps/unit to ~1 and removes all context-switching. This alone changes how the product *feels* to its daily user.

### 5b. Review/triage — swipe stack
The uncertain pile is currently a tap-in-one-at-a-time list. The deferred "swipe-review card stack" (memory `review-efficiency`) is the right call: full-screen card, swipe right = approve, left = flag, up = open fix-mode. The readiness engine already computes the per-item blocker ([readiness.js:92-161](src/readiness.js#L92-L161)) and the focus-by-issue editor jump already exists ([editor.js:806-813](src/editor.js#L806-L813)) — mostly a presentation-layer build.

### 5c. Unify pricing
Pick **one** default mental model (the guided sentence flow is more premium and more on-brand), and make the pivot table an explicit "Advanced" mode reached from inside it — which the wizard already half-does ([pricing_guided.js:267](src/pricing_guided.js#L267)). Never let the same label open two different tools. Also fold cost into the guided flow as a step (today guided edits retail only — [pricing_guided.js:22](src/pricing_guided.js#L22) — forcing admins to switch tools).

### 5d. Stop silently overriding the user
- AI-on-upload silently promotes `draft` → `needs-review` ([upload.js:95](src/upload.js#L95), same in [bulkai.js:211](src/bulkai.js#L211)). Respect the chosen status or make the relationship explicit.
- Tapping a non-approved status pill + Save changes status with no confirmation, while *approval* is heavily guarded ([editor.js:485-488](src/editor.js#L485-L488) vs [editor.js:608-626](src/editor.js#L608-L626)) — asymmetric.

---

## 6. Premium experience enhancements

- **Perceived speed > raw speed.** Optimistic UI on Approve/price (paint result instantly, reconcile after), windowed rendering (C1), `content-visibility:auto` on offscreen cards.
- **Loading states where there are none.** Pricing fetches up to 5,000 rows against a blank screen ([pricing.js:61](src/pricing.js#L61)) — reuse the existing shimmer skeleton ([gallery.js:420-426](src/gallery.js#L420-L426)).
- **Number/typography polish.** Revolut/Monzo feel premium largely through number rendering — tabular figures, currency alignment, "≈2 wk left" framing (Shop already does this well at [shop.js:142-147](src/shop.js#L142-L147)). Extend that voice everywhere.
- **Micro-interactions:** haptics + press-translate already exist ([editor.js:668](src/editor.js#L668)); add spring/scale on card-select, count-up on review-inbox bignums, satisfying swipe-away on approve.
- **Consistent voice for error states.** Calibration/pricing errors are bare toasts ([pricing.js:756](src/pricing.js#L756)); bring them up to the quality of the empty-state copy.

---

## 7. Design-system standardization

Invisible to users today, but it's why future polish will drift.

- **Two parallel bottom-sheet systems** (`.msheet` [styles.css:690](src/styles.css#L690) ≈ `.sheet` [styles.css:947](src/styles.css#L947)) — collapse to one.
- **Two confidence-chip implementations** (`.conf-pill` 32px [styles.css:1013](src/styles.css#L1013) ≈ `.calib-lvl` 22px [styles.css:1089](src/styles.css#L1089), same semantics).
- **9+ chip/pill variants** and **4 hand-rolled segmented controls**; `.issue-pill` ≈ `.source-pill` are siblings ([styles.css:458](src/styles.css#L458)/[466](src/styles.css#L466)); the primary-button look is re-rolled in ~5 places instead of reusing `.primary`.
- **No spacing scale, no type scale, and `--radius:12px` is used exactly once** ([styles.css:297](src/styles.css#L297)) while raw radii 6/8/9/10/14/16/18 appear in the wild; ~15 ad-hoc font sizes incl. fractional `11.5/12.5px`.
- **~80-100 lines of dead CSS** the author already flagged (`.selbar`, `.filterbar*`, the legacy `.find*` block, `.grp*`) — safe to delete (flag-then-remove).

**Target:** one Sheet, one Chip (semantic modifiers), one Segmented control, one Button system; add `--space-*` / `--text-*`; honor `--radius`. Mechanical, low-risk, compounding payoff.

---

## 8. High-end benchmark gaps

| Product | What they nail | This app's gap |
|---|---|---|
| **Linear** | Instant perceived speed; ruthless IA; command palette | C1 re-render; junk-drawer menu; palette exists ([gallery.js:336](src/gallery.js#L336)) but keyboard-only |
| **Stripe Dashboard** | Dense data that stays calm; one clear primary action/screen; great loading states | Card badge density — status + issue + source + POS chip + low-conf dot all on one card ([gallery.js:843-857](src/gallery.js#L843-L857)); missing loading states |
| **Revolut / Monzo** | Bottom-sheet flows; one primary action; gorgeous numbers; progressive disclosure | Shop tab stacks filter + chips + staleness + 5-cell strip + bignums + 4 sections + pipeline before the first useful list ([shop.js:182-237](src/shop.js#L182-L237)) |
| **Uber** | One job per screen, giant targets, no chrome | Capture flow (C5); sub-44px targets |
| **Notion** | Progressive disclosure of power | Power tools (Sync, Consistency, Calibration) buried instead of revealed in context |

---

## 9. Quick wins (high ROI, low effort)

1. Add `inputmode="decimal"` to editor numeric inputs ([editor.js:836](src/editor.js#L836)) — 1 line.
2. Make AI-suggest truly fill-empty-only, or confirm before overwrite (C3).
3. Bump status pills / conf pills / top-bar buttons to ≥44px (CSS only).
4. Move hover/`title` POS + confidence detail to tap-to-reveal (C2).
5. Add Undo to bulk Edit / Delete / calibration approve (C4).
6. Delete the ~80-100 lines of flagged dead CSS (§7).
7. Add a loading skeleton to pricing's 5,000-row fetch.
8. Surface the cost-missing blocker to non-admins as "Ask an admin to add cost" instead of a silent dead-end (C6).
9. Remove dead `openHistory` in [editor.js:1030-1052](src/editor.js#L1030-L1052) (unused; `openActivity` is wired).
10. Add `aria-labelledby` to `confirmSheet`/`promptSheet` so screen readers announce the title ([ui.js:262](src/ui.js#L262)).

---

## 10. Remove / simplify

- **Collapse Sync Center + Consistency into Shop and Review** (no parallel surfaces — §3).
- **Retire one of the two pricing tools** as the default (§5c).
- **Wire or remove Consistency's dead rows** — only 2 of 6 have an action ([consistency.js:154-157](src/consistency.js#L154-L157)); brand/size/SKU/price are dead-ends.
- **Mask the temp-password field** in Users — currently plain `type="text"`, visible on screen ([users.js:53](src/users.js#L53)).
- **Add `.limit()` to ref-data queries** — categories/fields/vocab silently truncate at Supabase's 1,000 default ([data.js:13-19](src/data.js#L13-L19)).

---

## 11. Screens to redesign

1. **Capture** → in-app burst mode (§5a) — highest impact.
2. **Shop tab** → calmer "Ops home" with progressive disclosure; absorb Sync Center.
3. **⋮ menu** → real Settings screen + slim account menu (§3).
4. **Review** → optional swipe stack for the uncertain pile (§5b).
5. **Pricing** → one unified entry/model (§5c).

---

## 12. Components to standardize

One canonical version of each, replacing the duplicates in §7:
- Bottom sheet (merge `.msheet` + `.sheet`).
- Chip/pill (one base + semantic modifiers for status / issue / source / confidence).
- Segmented control (collapse the 4 variants).
- Button system (everything routes through `.primary`/`.ghost`/`.danger`/`.iconbtn`).
- Confidence indicator (merge `.conf-pill` + `.calib-lvl`).
- Card shell (reuse `.card` for shop/pricing/user/cat/audit rows).
- Add design tokens: `--space-*`, `--text-*`, and actually honor `--radius`.

---

## 13. Prioritized roadmap (impact × effort)

| Priority | Item | Impact | Effort |
|---|---|---|---|
| **P0** | C3 AI-overwrite fix; C4 universal Undo; C6 cost dead-end; tap targets; `inputmode`; hover→tap (the §9 quick-wins batch) | High | Low |
| **P0** | C1 windowed/virtualized grid render (kill full re-render) | Very High | Med |
| **P1** | Burst capture mode (§5a) | Very High | Med |
| **P1** | IA consolidation: Settings screen + slim menu; fold Sync Center into Shop; one sync-count source (§3) | Very High | Med-High |
| **P1** | Unify pricing entry/model (§5c); stop silent status overrides (§5d) | High | Med |
| **P2** | Swipe-review stack (§5b) | High | Med |
| **P2** | Design-system unification: one sheet/chip/segmented/button + spacing/type/radius scales; delete dead CSS (§7, §12) | Med (High long-term) | Med-High |
| **P3** | Global Activity feed; calmer Shop "Ops home"; optimistic UI + loading states; micro-interactions | Med | Med |

---

## Bottom line

The app has real bones and two genuinely premium workflows. It is **not** cheap or generic — but it reads as a capable *operator's tool* rather than a *product*, because V2 added power faster than it added coherence. The fastest route to "users immediately recognize this as high-end" is: **kill the re-render jank, fix the capture loop, consolidate the IA, and standardize the component layer** — in that order. Almost no new features required.
