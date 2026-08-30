import { supabase } from "./db.js";
import { signOut } from "./auth.js";
import { openEditor } from "./editor.js";
import { renderUpload } from "./upload.js";
import { loadRefData, refreshRefData, resolveFields, categoryPath, fieldLabel, getSetting, normalizeValue, normalizeAttributeValue, vocabSuggestions, AI_BLIND_FIELDS, loadPosMirror } from "./data.js";
import {
  ISSUE_META,
  REVIEW_QUEUE,
  STATUS_OPTIONS,
  approvalSummary,
  aiDoubtFields,
  getItemReadiness,
  hasAiSignal,
  hasAiDoubt,
  issueState,
  missingCoreFields,
  needsReviewItem,
  queueMatches,
  readyItem,
  statusLabel,
} from "./readiness.js";
import { openCalibration } from "./calibration.js";
import { openGuidedPricing } from "./pricing_guided.js";
import { openActivityFeed } from "./activityfeed.js";
import { openSwipeReview } from "./swipereview.js";
import { loadSyncCounts } from "./syncstate.js";
import { openBulkAi } from "./bulkai.js";
import { openUsers } from "./users.js";
import { renderExport } from "./exportcsv.js";
import { renderShop } from "./shop.js";
import { openSyncCenter } from "./synccenter.js";
import { openCategoryManager } from "./categories_admin.js";
import { loadCostPresence } from "./costs.js";
import { loadLatestFailedJobs } from "./joblog.js";
import { openConsistencyAudit } from "./consistency.js";
import { approvalReasonText, confirmApprovalSummaryWarnings } from "./approval.js";
import { activitySourceClass, activitySourceLabel, diffItemValues, loadItemActivitySummaries, logManyItemActivities } from "./activity.js";
import { esc, toast, openBottomSheet, confirmSheet, promptSheet, trapFocus, anyOverlayOpen, openLightbox, bindPriceInput, ICON } from "./ui.js";
import { sortItems } from "./lib/itemsort.js";
import { shopState as libShopState, facetValue, buildFacets, searchText, matchesItem } from "./lib/facets.js";
import { mirrorForItem } from "./posbranches.js";
import { parsePrice, stripPriceGrouping } from "./lib/price.js";
import { classifyVerificationRisk, verificationRiskRank } from "./lib/review-risk.js";
import { fetchBoundedRailwayCatalog } from "./lib/railway-catalog-pagination.js";
import {
  DEFAULT_GALLERY_RENDER_BATCH_SIZE,
  initialGalleryRenderLimit,
  nextGalleryRenderLimit,
} from "./lib/gallery-render-window.js";
import {
  APP_VIEWS,
  REVIEW_FILTERS,
  REVIEW_STAGES,
  buildAppUrl,
  defaultFilterForStage,
  parseAppRoute,
  reviewStageForFilter,
} from "./lib/navigation-state.js";
import { installAvailable, canPromptInstall, promptInstall, isIOS } from "./install.js";
import { getThemePref, setThemePref } from "./theme.js";
import { requestRailwayCatalog } from "./railwayCatalogApi.js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";
import { extractCatalogItemWithAi } from "./catalogAi.js";

// Build the at-a-glance summary line for a card from its category's own field
// definitions, so each category shows the fields that matter to it (a pant shows
// colour/size/fit/style; a fragrance shows volume/concentration/gender/…).
function summarizeItem(it) {
  const attrs = it.attributes || {};
  const parts = [];
  for (const f of resolveFields(it.category_id)) {
    const v = attrs[f.key];
    if (v === null || v === undefined || v === "") continue;
    if (f.type === "boolean") {
      if (v === true || v === "true") parts.push(f.label);
    } else {
      // Append a unit when the field label carries one in parentheses
      // (e.g. "Volume (ml)" -> "100 ml", "Size (EU)" -> "42 EU"). Plain-worded
      // values (Dark Blue, Slim, EDP) stay as-is.
      const unit = (f.label.match(/\(([^)]+)\)/) || [])[1];
      parts.push(unit ? `${v} ${unit}` : String(v));
    }
  }
  return parts.join(" · ");
}

// Like summarizeItem, but returns HTML and tints the fields the AI was unsure
// about (Medium/Low, excluding AI-blind fields it can never read), so on the
// dense scan list a reviewer's eye lands straight on what to verify. Each part
// is escaped individually, so the joined string is safe to inject as HTML.
function summarizeItemRich(it) {
  const attrs = it.attributes || {};
  const conf = it.confidence || {};
  const parts = [];
  for (const f of resolveFields(it.category_id)) {
    const v = attrs[f.key];
    if (v === null || v === undefined || v === "") continue;
    let text;
    if (f.type === "boolean") {
      if (v === true || v === "true") text = f.label; else continue;
    } else {
      const unit = (f.label.match(/\(([^)]+)\)/) || [])[1];
      text = unit ? `${v} ${unit}` : String(v);
    }
    const lvl = conf[f.key];
    const doubt = (lvl === "Low" || lvl === "Medium") && !AI_BLIND_FIELDS.has(f.key);
    // Touch has no hover, so mirror the title into data-tip — the gallery tap
    // handler reveals [data-tip] text in a toast (matches the POS/source chips).
    if (doubt) {
      const tip = `${esc(f.label)}: ${lvl} confidence — verify`;
      parts.push(`<span class="lc lc-${lvl.toLowerCase()}" title="${tip}" data-tip="${tip}">${esc(text)}</span>`);
    } else {
      parts.push(esc(text));
    }
  }
  return parts.join(" · ");
}

// The authenticated app shell: top bar, bottom nav, and the gallery view with
// search + status filtering. Tapping a card opens the category-driven editor;
// tapping its photo opens the lightbox. Upload, grouping, and bulk ops land
// in later phases.

// `ico` is a key into the shared ICON set (ui.js). Keeps one consistent
// line-icon vocabulary.
// Export moved into the ⋮ menu (admin-ish, rarely daily) to make room for
// Shop — the floor-facing reports surface (Phase 3 of the POS integration).
const NAV = [
  { id: "today", label: "Today", ico: "navToday" },
  { id: "catalog", label: "Catalog", ico: "navGallery" },
  { id: "add", label: "Add", ico: "navAdd" },
  { id: "review", label: "Review", ico: "navReview", badge: true },
  { id: "shop", label: "Shop", ico: "navShop", badge: true },
];

const REVIEW_STAGE_META = {
  fix: { label: "Fix", detail: "Clear the blockers that stop items from moving forward." },
  verify: { label: "Verify", detail: "Check AI uncertainty and recently changed items." },
  approve: { label: "Approve", detail: "Give ready items their final inspection." },
};

// Update a bottom-nav count badge. `animate` count-ups give the Review badge a
// premium "numbers move" feel; the Shop attention badge stays steady.
function setNavBadge(id, count, animate = false) {
  const b = document.getElementById(id);
  if (!b) return;
  b.hidden = !count;
  if (count > 99) { b.textContent = "99+"; return; }
  const from = parseInt(b.textContent, 10) || 0;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduce || from === count) { b.textContent = String(count); return; }
  const steps = Math.min(12, Math.abs(count - from));
  let i = 0;
  const tick = () => {
    i++;
    b.textContent = String(Math.round(from + (count - from) * (i / steps)));
    if (i < steps) requestAnimationFrame(tick); else b.textContent = String(count);
  };
  requestAnimationFrame(tick);
}
// Review badge = items needing attention; Shop badge = sync problems surfaced on
// every screen so a manager knows without opening the Shop tab.
const setReviewBadge = (count) => setNavBadge("reviewBadge", count, true);
const setShopBadge = (count) => setNavBadge("shopBadge", count, false);
let renderTodaySeq = 0;

/**
 * Render the full app shell for a signed-in user.
 * @param {HTMLElement} mount  root element
 * @param {object} profile     { id, email, role }
 * @param {Function} onSignOut callback to re-render the login screen
 */
export function renderApp(mount, profile, onSignOut) {
  // `caps` (the profile object) is the source of truth for what the UI exposes;
  // the database independently enforces the same via RLS.
  const caps = profile || {};
  const role = caps.role || "viewer";
  restoreAppSession(caps);
  mount.innerHTML = `
    <div class="shell">
      <div class="topwrap">
        <header class="topbar">
          <h1>K-LINE MEN <span style="color:var(--muted);font-weight:400">Catalog</span></h1>
          <span class="rolechip ${role}">${role}</span>
          <span class="spacer"></span>
          <button class="iconbtn" id="cmdBtn" aria-label="Quick actions">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>
          </button>
          <button class="iconbtn" id="menuBtn" aria-label="Menu">${ICON.kebab}</button>
        </header>
        <div class="offline-banner" id="offlineBanner" hidden>● Offline — changes need a connection</div>
      </div>
      <main class="content" id="view"></main>
      <button class="fab-top" id="fabTop" hidden aria-label="Back to top">${ICON.up}</button>
      <nav class="bottomnav" id="nav"></nav>
    </div>`;

  const view = mount.querySelector("#view");
  const nav = mount.querySelector("#nav");

  // Build bottom nav buttons.
  const availableNav = isRailwayCatalogMode
    ? NAV.filter((navItem) => ["catalog", "review"].includes(navItem.id))
    : NAV;
  nav.innerHTML = availableNav.map(
    (n) => `<button data-view="${n.id}"><span class="ico">${ICON[n.ico] || ""}</span>${n.label}${
      n.badge ? `<span class="navbadge${n.id === "shop" ? " alert" : ""}" id="${n.id}Badge" hidden></span>` : ""
    }</button>`
  ).join("");

  const initialViewFallback = isRailwayCatalogMode ? "catalog" : "today";
  let currentViewId = availableNav.some((navItem) => navItem.id === appSession.view)
    ? appSession.view
    : initialViewFallback;
  const refreshCurrent = () => setView(currentViewId, { historyMode: "replace", restoreScroll: true });
  function openReviewQueue(issueKey = "work", ids = []) {
    const next = REVIEW_FILTERS.includes(issueKey) ? issueKey : "work";
    browseState.review.itemIds = Array.isArray(ids) ? ids : [];
    browseState.review.issue = next;
    browseState.review.stage = reviewStageForFilter(next);
    persistAppSession("review");
    setView("review", {
      historyMode: currentViewId === "review" ? "replace" : "push",
      restoreScroll: false,
    });
  }

  function syncRoute(historyMode = "replace") {
    if (historyMode === "none") return;
    const nextUrl = buildAppUrl(window.location.href, {
      view: currentViewId,
      reviewFilter: browseState.review.issue,
    });
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;
    const routeState = { klineView: currentViewId, reviewFilter: browseState.review.issue };
    if (historyMode === "push") window.history.pushState(routeState, "", nextUrl);
    else window.history.replaceState(routeState, "", nextUrl);
  }

  async function setView(id, { historyMode = "push", restoreScroll = true } = {}) {
    if (!availableNav.some((navItem) => navItem.id === id)) id = initialViewFallback;
    if (currentViewId && view.childElementCount && document.body.contains(view)) {
      appSession.scroll[currentViewId] = view.scrollTop;
    }
    currentViewId = id;
    appSession.view = id;
    persistAppSession(id);
    renderGallerySeq++;
    renderTodaySeq++;
    const targetScroll = restoreScroll ? Number(appSession.scroll[id] || 0) : 0;
    view.scrollTo(0, 0); // .content is the app's only scroller (app-shell layout)
    nav.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === id)
    );
    syncRoute(historyMode);
    if (id === "today") await renderToday(view, caps, { setView, openReviewQueue, refreshCurrent });
    else if (id === "catalog") await renderGallery(view, caps);
    else if (id === "add")
      await renderUpload(view, caps, (result = {}) => {
        if (result.view === "review" && result.itemIds?.length) {
          openReviewQueue(result.issue, result.itemIds);
        } else {
          browseState.gallery.itemIds = [];
          setView("catalog", { restoreScroll: false });
        }
      });
    else if (id === "export") renderExport(view, caps); // routed from the ⋮ menu
    else if (id === "shop") await renderShop(view, caps, refreshCurrent);
    else if (id === "review") await renderReview(view, caps);
    else renderComingSoon(view, id);
    if (currentViewId !== id) return;
    requestAnimationFrame(() => {
      if (currentViewId !== id) return;
      view.scrollTo(0, targetScroll);
      appSession.scroll[id] = view.scrollTop;
      persistAppSession(id);
    });
  }

  // Currency editor (the one shop-wide setting), opened from Settings → Shop.
  function openCurrencyEditor() {
    const cur = getSetting("currency", "");
    const sh = openBottomSheet("Currency", `
      <div class="cm-label">Prefix shown before prices (e.g. UGX, $, KSh)</div>
      <input id="setCurrency" value="${esc(cur)}" placeholder="e.g. UGX">
      <button class="primary up-go" id="setSave">Save</button>`);
    sh.body.querySelector("#setSave").onclick = async () => {
      const v = sh.body.querySelector("#setCurrency").value.trim();
      const { error } = await supabase.from("app_settings").upsert({ key: "currency", value: v });
      if (error) { toast("Save failed: " + error.message); return; }
      sh.close();
      toast("Currency saved");
      refreshRefData();
      await loadRefData();
      setView(currentViewId); // re-render so prices show the new prefix
    };
  }

  // Settings — the single home for configuration, data tools, and admin, grouped
  // and gated by capability. Replaces the old ~12-item account grab-bag; day-to-
  // day actions live in Quick actions (the command palette) instead.
  function openSettings() {
    const install = installAvailable() ? `<button class="menu-item" data-s="install">Install app</button>` : "";
    const currencyRow = caps.can_manage_users
      ? `<button class="menu-item settings-row" data-s="currency"><span><b>Currency</b><small>Prefix shown before shop prices</small></span><span class="menu-val">${esc(getSetting("currency", "") || "not set")}</span></button>`
      : "";
    const dataTools = [
      `<button class="menu-item settings-row" data-s="activity"><span><b>Recent activity</b><small>Human, AI, pricing, approval, undo, and shop events</small></span></button>`,
      `<button class="menu-item settings-row" data-s="export"><span><b>Export CSV</b><small>Catalog snapshot and audit log downloads</small></span></button>`,
      caps.can_edit ? `<button class="menu-item settings-row" data-s="calib"><span><b>AI quality check</b><small>Mark AI fields correct or wrong from photos</small></span></button>` : "",
      caps.can_edit ? `<button class="menu-item settings-row" data-s="audit"><span><b>Catalog health check</b><small>Find variants, missing details, duplicates, and outliers</small></span></button>` : "",
    ].filter(Boolean).join("");
    const adminTools = caps.can_manage_users
      ? `<button class="menu-item settings-row" data-s="users"><span><b>Users & permissions</b><small>Roles, capability matrix, active accounts</small></span></button>
         <button class="menu-item settings-row" data-s="cats"><span><b>Categories & fields</b><small>Reference data that drives forms, AI, and SKUs</small></span></button>
         <button class="menu-item settings-row" data-s="sync"><span><b>Shop recovery</b><small>Send to shop, refresh numbers, and check drift</small></span></button>`
      : "";
    const sh = openBottomSheet("Settings", `
      <div class="sheet-sec">Device & app</div>
      <button class="menu-item" data-s="theme">Appearance<span class="menu-val">${esc(themeLabel())}</span></button>
      ${install}
      ${currencyRow ? `<div class="sheet-sec">Shop settings</div>${currencyRow}` : ""}
      ${dataTools ? `<div class="sheet-sec">Data tools</div>${dataTools}` : ""}
      ${adminTools ? `<div class="sheet-sec">Admin</div>${adminTools}` : ""}`);
    sh.body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-s]");
      if (!b) return;
      const s = b.dataset.s;
      if (s === "theme") { sh.close(); openAppearance(); }
      else if (s === "currency") { sh.close(); openCurrencyEditor(); }
      else if (s === "install") { sh.close(); installApp(); }
      else if (s === "export") { sh.close(); setView("export"); }
      else if (s === "activity") { sh.close(); openActivityFeed(caps); }
      else if (s === "calib") { sh.close(); openCalibration(caps, () => setView(currentViewId)); }
      else if (s === "audit") { sh.close(); openConsistencyAudit(caps, openReviewQueue); }
      else if (s === "users") { sh.close(); openUsers(caps); }
      else if (s === "cats") { sh.close(); openCategoryManager(caps); }
      else if (s === "sync") { sh.close(); openSyncCenter(caps, refreshCurrent); }
    });
  }

  function openQuickActions() {
    const actions = [
      { id: "today", label: "Today", sub: "Open the operations overview", icon: ICON.navToday, show: true },
      { id: "add", label: "Add photos", sub: "Capture or upload a new batch", icon: ICON.navAdd, show: !!caps.can_upload },
      { id: "review-work", label: "Review needs work", sub: "Open all blocked items", icon: ICON.navReview, show: true },
      { id: "review-edited", label: "Recently edited", sub: "Return to items you touched", icon: ICON.pencil, show: true },
      { id: "review-ai", label: "Needs AI fill", sub: "Find photos that need AI fill or retry", icon: ICON.sparkle, show: true },
      { id: "review-price", label: "Missing price", sub: "Price items blocking approval", icon: ICON.navShop, show: true },
      { id: "review-ready", label: "Ready to approve", sub: "Final review queue", icon: ICON.tick, show: true },
      { id: "pricing", label: "Price items", sub: "Set prices in bulk", icon: ICON.pencil, show: !!caps.can_edit },
      { id: "audit", label: "Catalog health check", sub: "Check sizes, brands, missing data, and outliers", icon: ICON.check, show: !!caps.can_edit },
      { id: "sync", label: "Shop sync", sub: "Recover shop errors and pending updates", icon: ICON.refresh, show: !!caps.can_manage_users },
      { id: "shop", label: "Shop floor", sub: "View stock, queued items, and shop health", icon: ICON.navShop, show: true },
      { id: "activity", label: "Recent activity", sub: "Who changed what, lately", icon: ICON.refresh, show: true },
      { id: "export", label: "Export CSV", sub: "Download catalog data", icon: ICON.navExport, show: true },
    ].filter((a) => a.show);
    const sh = openBottomSheet("Quick actions", `
      <div class="cmd-list">
        ${actions.map((a) => `<button class="menu-item cmd-row" data-cmd="${esc(a.id)}">
          <span class="cmd-ico">${a.icon || ""}</span>
          <span class="cmd-copy"><b>${esc(a.label)}</b><span>${esc(a.sub)}</span></span>
        </button>`).join("")}
      </div>
      <div class="menu-sub">Tip: Ctrl or Cmd K opens this sheet.</div>`);
    sh.body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cmd]");
      if (!b) return;
      sh.close();
      const cmd = b.dataset.cmd;
      if (cmd === "today") setView("today");
      else if (cmd === "add") setView("add");
      else if (cmd === "review-work") openReviewQueue("work");
      else if (cmd === "review-edited") openReviewQueue("edited");
      else if (cmd === "review-ai") openReviewQueue("ai");
      else if (cmd === "review-price") openReviewQueue("price");
      else if (cmd === "review-ready") openReviewQueue("ready");
      else if (cmd === "pricing") openGuidedPricing(caps, refreshCurrent);
      else if (cmd === "audit") openConsistencyAudit(caps, openReviewQueue);
      else if (cmd === "sync") openSyncCenter(caps, refreshCurrent);
      else if (cmd === "shop") setView("shop");
      else if (cmd === "activity") openActivityFeed(caps);
      else if (cmd === "export") setView("export");
    });
  }

  // Visible command palette: the bolt button in the top bar opens Quick actions
  // on every screen (Ctrl/Cmd-K still works too) — the power-user escape hatch.
  mount.querySelector("#cmdBtn").onclick = openQuickActions;

  // Account menu (⋮) — deliberately slim: Quick actions, Settings, Sign out.
  // Everything that used to crowd here now lives in Quick actions (work) or
  // Settings (config / data tools / admin).
  mount.querySelector("#menuBtn").onclick = () => {
    const sh = openBottomSheet(caps.email || "Account",
      `<div class="menu-sub">Signed in as ${esc(role)}</div>
       <button class="menu-item" data-m="quick">Quick actions</button>
       <button class="menu-item" data-m="settings">Settings</button>
       <div class="sheet-sec">Account</div>
       <button class="menu-item danger" data-m="signout">Sign out</button>`);
    sh.body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-m]");
      if (!b) return;
      sh.close();
      if (b.dataset.m === "quick") openQuickActions();
      else if (b.dataset.m === "settings") openSettings();
      else if (b.dataset.m === "signout") { await signOut(); onSignOut(); }
    });
  };

  // Appearance picker — light / dark / follow-the-device. Applies instantly on
  // tap (no Save button) so the user sees the theme change behind the sheet,
  // which is the whole point. The active row carries a check.
  function openAppearance() {
    const render = () => {
      const cur = getThemePref();
      return THEME_OPTIONS.map(
        (o) => `<button class="menu-item theme-opt${o.v === cur ? " on" : ""}" data-t="${o.v}">
          <span class="ico">${ICON[o.ico] || ""}</span>
          <span class="theme-opt-txt"><span class="theme-opt-name">${o.label}</span>
            <span class="menu-sub">${o.sub}</span></span>
          <span class="theme-check">${o.v === cur ? ICON.check : ""}</span>
        </button>`
      ).join("");
    };
    const sh = openBottomSheet("Appearance", render());
    sh.body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-t]");
      if (!b) return;
      setThemePref(b.dataset.t);
      sh.body.innerHTML = render(); // refresh the checkmark in place
    });
  }

  // Install to home screen: use the native prompt where available, otherwise
  // (iOS Safari) show the manual Share-sheet instructions.
  async function installApp() {
    if (canPromptInstall()) {
      const accepted = await promptInstall();
      if (accepted) toast("Installing K-LINE MEN…");
    } else if (isIOS()) {
      await confirmSheet({
        title: "Add to Home Screen",
        message: "In Safari, tap the Share button, then choose “Add to Home Screen” to install K-LINE MEN.",
        confirmText: "Got it",
        cancelText: "Close",
      });
    }
  }

  nav.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    // Tapping the already-active tab scrolls back to top (mobile convention).
    if (btn.dataset.view === currentViewId) {
      view.scrollTo({ top: 0, behavior: "smooth" });
      appSession.scroll[currentViewId] = 0;
      persistAppSession(currentViewId);
    }
    else setView(btn.dataset.view);
  });

  if (_appCmdKey) document.removeEventListener("keydown", _appCmdKey);
  _appCmdKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || String(e.key || "").toLowerCase() !== "k") return;
    if (anyOverlayOpen()) return;
    e.preventDefault();
    openQuickActions();
  };
  document.addEventListener("keydown", _appCmdKey);

  // Offline banner — toggled by the browser's connectivity events.
  const banner = mount.querySelector("#offlineBanner");
  const setOnline = () => { banner.hidden = navigator.onLine; };
  window.addEventListener("online", setOnline);
  window.addEventListener("offline", setOnline);
  setOnline();

  // Back-to-top: appears once you've scrolled down a bit. Watches the content
  // scroller (the document never scrolls in the app-shell layout).
  const fab = mount.querySelector("#fabTop");
  let scrollSaveTimer;
  const onScroll = () => {
    fab.hidden = view.scrollTop < 500;
    appSession.scroll[currentViewId] = view.scrollTop;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => persistAppSession(currentViewId), 120);
  };
  view.addEventListener("scroll", onScroll, { passive: true });
  fab.onclick = () => view.scrollTo({ top: 0, behavior: "smooth" });
  onScroll();

  // Restore the exact working surface after a reload/update. PWA shortcuts and
  // share-target links still override the saved session on their first paint.
  const initialRoute = parseAppRoute(location.search, {
    view: appSession.view,
    reviewFilter: browseState.review.issue,
  });
  if (initialRoute.shared) initialRoute.view = isRailwayCatalogMode ? "catalog" : "add";
  if (!availableNav.some((navItem) => navItem.id === initialRoute.view)) {
    initialRoute.view = initialViewFallback;
  }
  browseState.review.issue = initialRoute.reviewFilter;
  browseState.review.stage = reviewStageForFilter(initialRoute.reviewFilter);

  if (_appPopState) window.removeEventListener("popstate", _appPopState);
  _appPopState = () => {
    const route = parseAppRoute(location.search, {
      view: currentViewId,
      reviewFilter: browseState.review.issue,
    });
    const sameView = route.view === currentViewId;
    const sameQueue = route.view !== "review" || route.reviewFilter === browseState.review.issue;
    if (sameView && sameQueue) return;
    browseState.review.issue = route.reviewFilter;
    browseState.review.stage = reviewStageForFilter(route.reviewFilter);
    setView(route.view, { historyMode: "none", restoreScroll: true });
  };
  window.addEventListener("popstate", _appPopState);
  setView(initialRoute.view, { historyMode: "replace", restoreScroll: true }).then(() => {
    if (!initialRoute.itemId) return;
    openCatalogItem(initialRoute.itemId, caps, refreshCurrent).catch((error) => {
      toast(`Couldn't restore item: ${error.message || error}`);
    });
  });
}

// Appearance options shown in the account menu's "Appearance" picker. "system"
// follows the device; light/dark pin it. Order matches the menu top-to-bottom.
const THEME_OPTIONS = [
  { v: "light",  label: "Light",  sub: "Bright, daytime palette", ico: "sun" },
  { v: "dark",   label: "Dark",   sub: "Dim, low-light palette",  ico: "moon" },
  { v: "system", label: "System", sub: "Match this device",       ico: "auto" },
];
// Short label for the current preference, shown on the menu row's right edge.
function themeLabel() {
  return (THEME_OPTIONS.find((o) => o.v === getThemePref()) || THEME_OPTIONS[2]).label;
}

// Escape user-provided text before injecting into innerHTML (brands/colours can
// contain &, <, quotes — e.g. "Jery & Sluo").

// Format a price with thousands separators + the shop's currency prefix (if set).
function fmtPrice(v) {
  const n = parsePrice(v);
  const s = Number.isFinite(n) ? n.toLocaleString() : esc(v);
  const cur = getSetting("currency", "");
  return cur ? `${esc(cur)} ${s}` : s;
}

// Short date for display (upload/added date = created_at).
function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d) ? "" : d.toLocaleDateString();
}

// Date-filter presets → earliest allowed date (null = no limit).
const DATE_FILTERS = [
  { v: "all", label: "Any date" },
  { v: "today", label: "Today" },
  { v: "7d", label: "Last 7 days" },
  { v: "30d", label: "Last 30 days" },
];
function dateCutoff(v) {
  if (v === "all" || !v) return null;
  const d = new Date();
  if (v === "today") d.setHours(0, 0, 0, 0);
  else if (v === "7d") d.setDate(d.getDate() - 7);
  else if (v === "30d") d.setDate(d.getDate() - 30);
  return d;
}

// Hard cap on how many rows the browse surface loads at once. The UI warns when
// a result set is truncated rather than silently hiding items. True server-side
// pagination is a deliberate NON-GOAL: the facet counts are computed client-side
// over the whole set (the product's value), so paging the fetch would break them
// — that would mean rebuilding faceting in Postgres. Instead we cap generously
// (raised 1000→2000 for headroom as the catalogue grows) and stay honest about
// truncation. The render window below keeps the complete result set available
// for exact facets and bulk actions while adding card DOM in small batches.
const GALLERY_LIMIT = 2000;
const GALLERY_CACHE_TTL_MS = 60 * 1000;
const SIGNED_URL_TTL_SECONDS = 3600;
const SIGNED_URL_REFRESH_MS = (SIGNED_URL_TTL_SECONDS - 300) * 1000;
const GALLERY_ITEM_SELECT = "id, name, brand, sku, price, stock_quantity, status, image_path, attributes, confidence, category_id, created_at, pos_sync_status, pos_sync_error, pos_variant_id, pos_branch_id, pos_dirty, categories(name)";

let galleryPayloadCache = null;
let galleryPayloadPromise = null;
const fullImageUrlCache = new Map(); // shared by thumbnails and the full-size viewer (see signThumb)

const galleryCacheKey = (caps = {}) => `${caps.id || caps.email || "user"}:${caps.can_view_cost ? "cost" : "nocost"}`;

function cachedSignedUrl(cache, path, signer) {
  if (!path) return Promise.resolve(null);
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && hit.expiresAt > now) return hit.promise;
  const promise = signer()
    .then(({ data }) => data?.signedUrl || null)
    .catch(() => {
      cache.delete(path);
      return null;
    });
  cache.set(path, { promise, expiresAt: now + SIGNED_URL_REFRESH_MS });
  return promise;
}

// Thumbnails reuse the untransformed original: uploads are already client-side
// compressed to ≤1280px WebP (imageCompress.js), and Supabase image transforms
// are metered at 100 origin images/month on Pro — the catalog alone exceeds
// that. Sharing signFullImage's URL also lets the full-size viewer open from
// browser cache after the grid has loaded the image.
function signThumb(path) {
  return signFullImage(path);
}

function signFullImage(path) {
  if (isRailwayCatalogMode) {
    const cachedImage = fullImageUrlCache.get(path);
    return cachedImage?.promise || Promise.resolve(null);
  }
  return cachedSignedUrl(fullImageUrlCache, path, () =>
    supabase.storage.from("product-images").createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  );
}

/** Cache server-signed image URLs as each Railway page completes. */
function cacheRailwayImageUrls(items) {
  for (const item of items) {
    if (!item.image_path || !item.image_url) continue;
    const signedExpiry = new Date(item.image_url_expires_at || 0).getTime();
    const refreshAt = Number.isFinite(signedExpiry)
      ? Math.max(Date.now() + 30000, signedExpiry - 300000)
      : Date.now() + SIGNED_URL_REFRESH_MS;
    fullImageUrlCache.set(item.image_path, {
      promise: Promise.resolve(item.image_url),
      expiresAt: refreshAt,
    });
  }
}

/**
 * Load reference data alongside page one, then fan out the remaining bounded
 * Railway pages. This preserves whole-catalog facets without serializing every
 * network round trip.
 */
async function fetchRailwayGalleryPayload(caps) {
  const pageSize = 200;
  const [catalog, posMirror] = await Promise.all([
    fetchBoundedRailwayCatalog({
      requestPage: (page, limit) => requestRailwayCatalog(
        `/catalog/items?page=${page}&limit=${limit}`
      ),
      pageSize,
      itemLimit: GALLERY_LIMIT,
      onPageItems: cacheRailwayImageUrls,
    }),
    loadPosMirror().catch(() => ({ byVariant: new Map(), lastMirror: null })),
    loadRefData(),
  ]);

  return {
    key: galleryCacheKey(caps),
    loadedAt: Date.now(),
    data: catalog.data,
    total: catalog.total,
    posMirror,
    syncCounts: { errors: 0, dirty: 0 },
    savedViews: [],
  };
}

function applyGalleryMeta(rows, failedAiJobs, activitySummaries, costPresence) {
  for (const it of rows || []) {
    const job = failedAiJobs.get(it.id);
    if (job) it.latest_ai_job = job;
    const activity = activitySummaries.get(it.id);
    if (activity) it.activity = activity;
    if (costPresence.has(it.id)) it.has_cost_price = costPresence.get(it.id);
  }
}

async function fetchGalleryPayload(caps) {
  if (isRailwayCatalogMode) return fetchRailwayGalleryPayload(caps);
  const [{ data, error }, posMirror] = await Promise.all([
    supabase
      .from("items")
      .select(GALLERY_ITEM_SELECT)
      .order("created_at", { ascending: false })
      .limit(GALLERY_LIMIT),
    loadPosMirror().catch(() => ({ byVariant: new Map(), lastMirror: null })),
    loadRefData(), // category tree + field definitions drive the card summary
  ]);
  if (error) throw error;

  const rows = data || [];
  const itemIdsForMeta = rows.map((it) => it.id);
  const [failedAiJobs, activitySummaries, costPresence, syncCounts, savedViewsRes] = await Promise.all([
    loadLatestFailedJobs(itemIdsForMeta, "ai_fill"),
    loadItemActivitySummaries(itemIdsForMeta),
    loadCostPresence(itemIdsForMeta, { canViewCost: !!caps.can_view_cost }),
    loadSyncCounts(["errors", "dirty"]).catch(() => ({ errors: 0, dirty: 0 })),
    (async () => {
      try {
        return await supabase.from("saved_views").select("id, name, payload").order("created_at");
      } catch {
        return { data: [] };
      }
    })(),
  ]);
  applyGalleryMeta(rows, failedAiJobs, activitySummaries, costPresence);

  return {
    key: galleryCacheKey(caps),
    loadedAt: Date.now(),
    data: rows,
    posMirror,
    syncCounts,
    savedViews: savedViewsRes?.data || [],
  };
}

async function loadGalleryPayload(caps, { force = false } = {}) {
  const key = galleryCacheKey(caps);
  const fresh = galleryPayloadCache
    && galleryPayloadCache.key === key
    && Date.now() - galleryPayloadCache.loadedAt < GALLERY_CACHE_TTL_MS;
  if (!force && fresh) return galleryPayloadCache;
  if (!force && galleryPayloadPromise?.key === key) return galleryPayloadPromise.promise;

  const promise = fetchGalleryPayload(caps).then((payload) => {
    galleryPayloadCache = payload;
    return payload;
  });
  galleryPayloadPromise = { key, promise };
  try {
    return await promise;
  } finally {
    if (galleryPayloadPromise?.promise === promise) galleryPayloadPromise = null;
  }
}

/**
 * Open the canonical editor on rollback builds and a Railway evidence sheet.
 * ADR-065 adds the narrowly-scoped AI fill action here while general editing
 * remains masked until its own write contract is implemented.
 */
async function openCatalogItem(id, caps, onSave, editorOptions = {}) {
  if (!isRailwayCatalogMode) {
    return openEditor(id, caps, onSave, editorOptions);
  }

  const payload = await loadGalleryPayload(caps);
  const item = payload.data?.find((candidate) => candidate.id === id);
  if (!item) throw new Error("Catalog item not found.");

  const imageUrl = item.image_url || (await signFullImage(item.image_path));
  const attributeRows = Object.entries(item.attributes || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `<div class="kv"><span>${esc(fieldLabel(key))}</span><b>${esc(String(value))}</b></div>`
    )
    .join("");
  const sheet = openBottomSheet(todayItemTitle(item), `
    <div class="readonly-catalog-item">
      ${imageUrl ? `<img src="${esc(imageUrl)}" alt="${esc(todayItemTitle(item))}" style="width:100%;max-height:52vh;object-fit:contain;border-radius:10px;background:var(--surface)">` : ""}
      <div class="kv"><span>SKU</span><b>${esc(item.sku || "Not assigned")}</b></div>
      <div class="kv"><span>Category</span><b>${esc(item.categories?.name || "Uncategorized")}</b></div>
      <div class="kv"><span>Status</span><b>${esc(statusLabel(item.status))}</b></div>
      <div class="kv"><span>Retail price</span><b>${item.price == null ? "Not priced" : esc(fmtPrice(item.price))}</b></div>
      ${attributeRows}
      ${caps.can_ai_extract ? `<button class="primary" type="button" data-railway-ai style="width:100%;margin-top:14px">${ICON.sparkle} AI-fill empty fields</button>` : ""}
      <p class="muted" style="margin-top:14px">General editing remains read-only; AI fills only fields that are still blank.</p>
    </div>`);
  const aiButton = sheet.body.querySelector("[data-railway-ai]");
  if (aiButton) {
    // Run the only currently approved Railway mutation, then close stale sheet
    // state and force the branch gallery to re-read the server-applied values.
    aiButton.onclick = async () => {
      if (!navigator.onLine) {
        toast("You're offline â€” AI needs a connection.");
        return;
      }
      const originalLabel = aiButton.innerHTML;
      aiButton.disabled = true;
      aiButton.textContent = "Reading photoâ€¦";
      try {
        const result = await extractCatalogItemWithAi({ itemId: id });
        const filled = result.applied_fields?.length || 0;
        galleryPayloadCache = null;
        sheet.close();
        await onSave?.();
        toast(
          filled
            ? `AI filled ${filled} field${filled === 1 ? "" : "s"} â€” review the item`
            : "AI couldn't find any empty fields to fill"
        );
      } catch (error) {
        toast("AI failed: " + (error?.message || error));
        aiButton.disabled = false;
        aiButton.innerHTML = originalLabel;
      }
    };
  }
  return sheet;
}

// A grid of shimmering placeholder cards shown while data loads, so the screen
// shows the eventual layout immediately instead of a lone centered spinner.
function skeletonGrid(n = 8) {
  const card = `<div class="card sk-card" aria-hidden="true">
      <div class="thumb"></div>
      <div class="body"><div class="sk-line w70"></div><div class="sk-line w45"></div></div>
    </div>`;
  return `<div class="grid">${card.repeat(n)}</div>`;
}

// Sort options for the unified browse surface.
const SORTS = [
  { v: "new", label: "Newest first" },
  { v: "old", label: "Oldest first" },
  { v: "price-desc", label: "Price: high → low" },
  { v: "price-asc", label: "Price: low → high" },
  { v: "stock-asc", label: "Stock: low → high" },
  { v: "stock-desc", label: "Stock: high → low" },
  { v: "brand", label: "Brand A–Z" },
];

// Session-remembered view state, kept separate per surface so the Gallery and
// Review tabs don't clobber each other's search/filters/sort. `active` holds
// facet selections serialised as arrays (rehydrated to Sets on render).
// `density` is the card-grid vs scan-list view mode. Both surfaces default to
// tile/grid; reviewers can still switch to the dense list when skimming.
const defaultBrowseState = () => ({
  gallery: { q: "", needsReview: false, sortBy: "new", priceMin: "", priceMax: "", noPrice: false, datePreset: "all", active: {}, density: "grid", itemIds: [], previewId: "" },
  review:  { q: "", needsReview: true,  sortBy: "new", priceMin: "", priceMax: "", noPrice: false, datePreset: "all", active: {}, density: "grid", stage: "fix", issue: "work", itemIds: [], previewId: "" },
});
let browseState = defaultBrowseState();
let appSession = { view: "today", scroll: {} };
let appSessionKey = "kline.ops.session.v2";

function restoreAppSession(caps = {}) {
  appSessionKey = `kline.ops.session.v2:${caps.id || caps.email || "user"}`;
  let stored = {};
  try { stored = JSON.parse(sessionStorage.getItem(appSessionKey) || "{}"); } catch {}
  const defaults = defaultBrowseState();
  browseState = {
    gallery: { ...defaults.gallery, ...(stored.browse?.gallery || {}) },
    review: { ...defaults.review, ...(stored.browse?.review || {}) },
  };
  if (!REVIEW_FILTERS.includes(browseState.review.issue)) browseState.review.issue = "work";
  browseState.review.stage = reviewStageForFilter(browseState.review.issue);
  appSession = {
    view: APP_VIEWS.includes(stored.view) ? stored.view : "today",
    scroll: stored.scroll && typeof stored.scroll === "object" ? stored.scroll : {},
  };
}

function persistAppSession(view = appSession.view) {
  appSession.view = APP_VIEWS.includes(view) ? view : "today";
  try {
    sessionStorage.setItem(appSessionKey, JSON.stringify({
      view: appSession.view,
      scroll: appSession.scroll,
      browse: browseState,
    }));
  } catch {}
}

function issueBadgesHtml(it, { compact = false } = {}) {
  const readiness = getItemReadiness(it);
  const st = readiness.issue;
  if (!st) return "";
  if (st === "doubt") {
    const risk = classifyVerificationRisk(aiDoubtFields(it));
    const label = risk.level === "critical"
      ? (compact ? "Critical" : `Critical check · ${risk.count} field${risk.count === 1 ? "" : "s"}`)
      : (compact ? "Quick" : `Quick check · ${risk.count} field${risk.count === 1 ? "" : "s"}`);
    const detail = risk.level === "critical"
      ? "Contains a Low-confidence field or several uncertain fields. Review individually."
      : "One or two Medium-confidence fields. Eligible for scan-and-batch verification.";
    return `<span class="issue-pill iss-${risk.level}" title="${esc(detail)}">${esc(label)}</span>`;
  }
  const meta = ISSUE_META[st] || ISSUE_META.work;
  const title = readiness.primary?.detail || meta.label;
  const label = compact ? meta.short : meta.label;
  return `<span class="issue-pill ${meta.cls}" title="${esc(title)}">${esc(label)}</span>`;
}

function activityBadgesHtml(it, { compact = false } = {}) {
  const a = it.activity;
  if (!a) return "";
  const hasAi = a.sources?.has?.("ai");
  const hasHuman = ["manual", "bulk", "pricing", "approval", "undo"].some((s) => a.sources?.has?.(s));
  let label = activitySourceLabel(a.latest_source);
  let cls = activitySourceClass(a.latest_source);
  if (hasAi && hasHuman) { label = "Mixed"; cls = "mixed"; }
  else if (hasAi) { label = compact ? "AI" : "AI filled"; cls = "ai"; }
  else if (hasHuman && !["pricing", "approval", "bulk", "undo"].includes(a.latest_source)) { label = compact ? "Manual" : "Manual edit"; cls = "manual"; }
  const when = a.latest_at ? new Date(a.latest_at).toLocaleString() : "";
  // data-tip mirrors title so touch users (no hover) can tap to read the detail.
  const tip = esc([label, a.latest_summary, when].filter(Boolean).join(" · "));
  return `<span class="source-pill src-${esc(cls)}" title="${tip}" data-tip="${tip}">${esc(compact ? label.replace(" edit", "") : label)}</span>`;
}
let _galEsc = null; // current Esc handler, so we don't stack listeners on re-render
let _appCmdKey = null; // current Ctrl/Cmd+K handler for the signed-in shell
let _appPopState = null; // current browser-history listener for the signed-in shell

// Fade each thumbnail in over its shimmer once the image has loaded, so the
// grid layout never jumps as photos arrive.
function fadeInImages(container) {
  container.querySelectorAll(".thumb").forEach((thumb) => {
    const img = thumb.querySelector("img");
    if (!img) { thumb.classList.add("loaded"); return; }
    // Lazy thumbs have no src yet (set later by observeThumbs) — `complete` is true
    // for a src-less img, so also require an actual currentSrc before fading in.
    if (img.complete && img.currentSrc) thumb.classList.add("loaded");
    else img.addEventListener("load", () => thumb.classList.add("loaded"), { once: true });
  });
}

// (ICON — the shared inline-SVG icon set — now lives in ui.js; imported above.)

// A reusable bottom sheet (filters, status picker, more-actions menu).
// (openBottomSheet now lives in ui.js — imported above.)

// Premium gallery: clean top bar (search · filters · select), active-filter
// pills, and a contextual selection action bar (replaces the app nav while
// selecting). Tapping a card opens the editor; tapping its photo the lightbox.
// Monotonic render token: each renderGallery call claims the next number. If a
// newer call starts while this one is still awaiting data, the stale one bails
// before touching the DOM — kills the interleaved-render race (Q1 step 6).
let renderGallerySeq = 0;
async function renderGallery(view, caps, opts = {}) {
  const mySeq = ++renderGallerySeq;
  const review = !!opts.review; // Review tab = this surface pre-filtered to triage
  const state = review ? browseState.review : browseState.gallery;
  const canEdit = !!caps.can_edit;
  const canDelete = !!caps.can_delete;
  const appNav = document.querySelector(".bottomnav");
  if (appNav) appNav.style.display = ""; // restore if a prior selection hid it
  view.innerHTML = skeletonGrid();
  let galleryPayload;
  try {
    galleryPayload = await loadGalleryPayload(caps, { force: !!opts.force });
  } catch (error) {
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Couldn't load items.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message || error)}</div></div>`;
    return;
  }
  const { data, posMirror, syncCounts } = galleryPayload;
  setReviewBadge((data || []).filter((it) => needsReviewItem(it) || readyItem(it) || queueMatches(it, "edited")).length);
  setShopBadge((syncCounts.errors || 0) + (syncCounts.dirty || 0));

  if (mySeq !== renderGallerySeq) return; // a newer render superseded this one — don't clobber it

  if (!data || data.length === 0) {
    // First-run: a coached empty state showing the whole value loop at a glance,
    // instead of a dead-end emoji. (Review's empty state stays terse.)
    if (!review && caps.can_upload) {
      view.innerHTML = `<div class="empty onboard">
        <div class="big">📸</div>
        <div class="onboard-title">Add your first unit</div>
        <div class="onboard-steps">
          <div class="onboard-step"><span class="onboard-num">1</span><span>Snap each item — the camera stays open for a whole rack</span></div>
          <div class="onboard-step"><span class="onboard-num">2</span><span>AI reads the photo and fills the brand, name &amp; details</span></div>
          <div class="onboard-step"><span class="onboard-num">3</span><span>Price it and push it to your shop</span></div>
        </div>
        <button class="primary" id="emptyAdd">Add your first photos</button></div>`;
      // Route through the real nav button so the tab highlight + render stay in sync.
      view.querySelector("#emptyAdd").onclick = () => document.querySelector('.bottomnav button[data-view="add"]')?.click();
      return;
    }
    view.innerHTML = `<div class="empty"><div class="big">${review ? "✓" : "📭"}</div>
      <div>${review ? "Nothing to review." : "No items yet."}</div>
      <div style="color:var(--muted);font-size:13px">${review ? "New uploads needing attention will appear here." : "Items appear here once added."}</div></div>`;
    return;
  }

  // This user's saved views (cloud-synced; empty if the table isn't there yet).
  let savedViews = galleryPayload.savedViews || [];

  if (mySeq !== renderGallerySeq) return; // last await done — bail if superseded before the DOM build

  // ---- POS shop state (chips + the "Shop" facet) ----
  // One mutually-exclusive state per item, derived from the sync link columns
  // plus the live mirror. Used verbatim as the facet value, so chip and filter
  // can never disagree.
  const mirrorOf = (it) => mirrorForItem(posMirror, it);
  // Pure logic in src/lib/facets.js (tested); bind the live mirror lookup here.
  const shopState = (it) => libShopState(it, mirrorOf);
  // The small ambient chip on every card. Short on the card, full story in the
  // title (long-press / hover). Items the integration hasn't touched get none.
  function posChipHtml(it) {
    const st = shopState(it);
    if (st === "Not pushed") return "";
    const m = mirrorOf(it);
    const branch = posMirror.branches?.find((b) => b.pos_branch_id === (it.pos_branch_id || posMirror.defaultBranchId));
    const branchNote = branch ? ` at ${branch.code}` : "";
    const left = m ? `${m.stock_quantity} left` : "";
    const C = {
      "In shop":        ["ps-in",     m ? `● ${left}` : "● In shop", m ? `In the shop — ${left}` : "In the shop (live count arrives with the next sync)"],
      "Low stock":      ["ps-low",    `● ${left}`,       `Running low — ${left} (reorder at ${m?.reorder_level})`],
      "Sold out":       ["ps-out",    "Sold out",        "In the shop but sold out"],
      "Retired":        ["ps-ret",    "Retired",         "No longer sold in the shop"],
      "Queued":         ["ps-queued", "◌ Queued",        "Approved — goes to the shop on the next sync"],
      "Sending":        ["ps-queued", "… Sending",       "Waiting for the POS to accept this item"],
      "Sync error":     ["ps-err",    "⚠ Error",         `Couldn't reach the shop: ${it.pos_sync_error || "unknown error"}`],
      "Update pending": ["ps-dirty",  "✎ Edited",        "Edited since it went to the shop — the update hasn't reached the POS yet"],
    }[st];
    const visible = branch ? `${C[1]} · ${branch.code}` : C[1];
    return `<span class="poschip ${C[0]}" title="${esc(C[2] + branchNote)}" data-tip="${esc(C[2] + branchNote)}">${esc(visible)}</span>`;
  }
  // The freshness line: when the mirror last spoke to the POS. Stale or failing
  // data is SHOWN as such — never silently presented as live.
  function freshnessNote() {
    const lr = posMirror.lastMirror;
    if (!lr?.finished_at) return "";
    const t = new Date(lr.finished_at);
    const hhmm = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (lr.ok === false) return ` · <span class="freshness stale" title="${esc(lr.error || "")}">⚠ shop sync failing (last try ${hhmm})</span>`;
    const stale = (Date.now() - t.getTime()) / 60000 > 30;
    return ` · <span class="freshness${stale ? " stale" : ""}">shop data ${stale ? "may be stale — " : ""}as of ${hhmm}</span>`;
  }

  // ---- faceting engine (pure logic in src/lib/facets.js; bind resolvers here) ----
  const facetResolvers = {
    statusLabel,
    issueLabel: (it) => ISSUE_META[issueState(it)]?.label || "Clean",
    issueShort: (it) => ISSUE_META[issueState(it)]?.short || "",
    shopStateOf: shopState,
    categoryPathOf: categoryPath,
  };
  const valueOf = (it, key) => facetValue(it, key, facetResolvers);
  const attrKeys = [...new Set(data.flatMap((it) => Object.keys(it.attributes || {})))];
  const facets = buildFacets(data, { attrKeys, fieldLabel, resolvers: facetResolvers });
  const facetByKey = Object.fromEntries(facets.map((f) => [f.key, f]));

  // ---- view state (restored from the session, per surface) ----
  let q = state.q;
  let needsReview = review ? true : state.needsReview; // Review tab forces it on
  let issue = review
    ? (REVIEW_FILTERS.includes(state.issue) ? state.issue : "work")
    : null;
  let reviewStage = review ? reviewStageForFilter(issue) : null;
  let density = state.density === "list" ? "list" : "grid";
  let sortBy = state.sortBy;
  let priceMin = state.priceMin, priceMax = state.priceMax, datePreset = state.datePreset;
  let noPrice = !!state.noPrice; // "only items without a price" — the pricing to-do filter
  const active = {}; // facetKey -> Set(values); AND across keys, OR within a key
  for (const k in (state.active || {})) if (facetByKey[k]) active[k] = new Set(state.active[k]);
  let itemIds = new Set(state.itemIds || []);
  const facetFilter = {}; // facetKey -> typed text to narrow that facet's value list
  let filtered = []; // current filtered+sorted rows, for bulk actions
  let smartShelvesEl = null;
  let reviewBriefEl = null;
  let previewEl = null;
  let previewSelectedId = state.previewId || "";

  function reviewQueueGuide(key) {
    return ({
      work: { title: "Fix blockers", detail: REVIEW_STAGE_META.fix.detail },
      verify: { title: "Verify changes", detail: REVIEW_STAGE_META.verify.detail },
      edited: { title: "Recently edited", detail: "Recheck changed items before they disappear into the approved catalog." },
      ai: { title: "Needs AI fill", detail: "Run AI fill or retry failed jobs before manual review takes over." },
      price: { title: "Missing price", detail: "Price these items before approval or shop sync can be trusted." },
      doubt: { title: "AI checks", detail: "Verify the exact fields the model marked as uncertain." },
      missing: { title: "Missing details", detail: "Complete required catalog facts that block approval." },
      flag: { title: "Problem items", detail: "Resolve flagged records or leave them clearly marked for follow-up." },
      sync: { title: "Shop issues", detail: "Repair sync errors and pending shop updates before stock goes live." },
      ready: { title: "Ready to approve", detail: "Final inspection bench for priced items with no blockers." },
    })[key] || { title: "Review", detail: "Turn uncertainty into decisions." };
  }

  function reviewStageMatches(it, stage) {
    const state = issueState(it);
    if (stage === "approve") return state === "ready";
    if (stage === "verify") {
      const recentlyEdited = queueMatches(it, "edited");
      return state === "doubt" || (recentlyEdited && (!state || state === "doubt"));
    }
    return !!state && state !== "ready" && state !== "doubt";
  }

  function reviewFilterMatches(it) {
    if (issue === "work") return reviewStageMatches(it, "fix");
    if (issue === "verify") return reviewStageMatches(it, "verify");
    return queueMatches(it, issue);
  }

  const verificationRiskOf = (it) => classifyVerificationRisk(aiDoubtFields(it), {
    recentlyEdited: queueMatches(it, "edited"),
  });

  function smartViewDefs() {
    const todayCut = dateCutoff("today");
    const issueCount = (key) => data.filter((it) => queueMatches(it, key)).length;
    const issueOn = (key) => review
      ? issue === key
      : !!active.issue?.has(ISSUE_META[key]?.label);
    if (review) return [
      { id: "ai", label: "Needs AI fill", count: issueCount("ai"), on: issueOn("ai"), tone: "ai" },
      { id: "price", label: "Missing price", count: issueCount("price"), on: issueOn("price"), tone: "price" },
      { id: "missing", label: "Missing details", count: issueCount("missing"), on: issueOn("missing"), tone: "price" },
      { id: "flag", label: "Problem items", count: issueCount("flag"), on: issueOn("flag"), tone: "sync" },
      { id: "sync", label: "Shop issues", count: issueCount("sync"), on: issueOn("sync"), tone: "sync" },
      { id: "doubt", label: "Check AI", count: issueCount("doubt"), on: issueOn("doubt"), tone: "ai" },
      { id: "edited", label: "Recently edited", count: issueCount("edited"), on: issueOn("edited"), tone: "edited" },
      { id: "ready", label: "Ready to approve", count: issueCount("ready"), on: issueOn("ready"), tone: "ready" },
    ];
    return [
      { id: "price", label: "Missing price", count: data.filter((it) => it.price == null).length, on: noPrice, tone: "price" },
      { id: "doubt", label: "AI doubt", count: issueCount("doubt"), on: issueOn("doubt"), tone: "ai" },
      { id: "ready", label: "Ready", count: issueCount("ready"), on: issueOn("ready"), tone: "ready" },
      { id: "in-shop", label: "In shop", count: data.filter((it) => shopState(it) === "In shop").length, on: !!active.shop?.has("In shop"), tone: "shop" },
      { id: "sync", label: "Sync error", count: issueCount("sync"), on: issueOn("sync"), tone: "sync" },
      { id: "edited", label: "Recently edited", count: issueCount("edited"), on: issueOn("edited"), tone: "edited" },
      { id: "today", label: "New today", count: data.filter((it) => it.created_at && new Date(it.created_at) >= todayCut).length, on: datePreset === "today", tone: "today" },
    ];
  }

  function resetSmartBase() {
    q = ""; if (qEl) qEl.value = "";
    for (const k in active) delete active[k];
    for (const k in facetFilter) delete facetFilter[k];
    priceMin = ""; priceMax = ""; noPrice = false; datePreset = "all"; itemIds = new Set();
    if (!review) needsReview = false;
  }

  function applySmartView(id) {
    resetSmartBase();
    if (review && REVIEW_QUEUE.includes(id)) {
      if (id === issue) draw();
      else setReviewIssue(id);
      pills();
      return;
    }
    if (id === "today") datePreset = "today";
    else if (id === "price") noPrice = true;
    else if (id === "in-shop") active.shop = new Set(["In shop"]);
    else if (ISSUE_META[id]) {
      active.issue = new Set([ISSUE_META[id].label]);
    }
    draw();
    pills();
  }

  function applySavedView(v, { announce = true } = {}) {
    if (!v) return;
    const p = v.payload || {};
    for (const k in active) delete active[k];
    for (const k in (p.active || {})) if (facetByKey[k]) active[k] = new Set(p.active[k]);
    q = p.q || ""; if (qEl) qEl.value = q;
    sortBy = p.sortBy && SORTS.some((s) => s.v === p.sortBy) ? p.sortBy : "new";
    priceMin = p.priceMin || ""; priceMax = p.priceMax || ""; noPrice = !!p.noPrice; datePreset = p.datePreset || "all";
    itemIds = new Set();
    draw();
    pills();
    if (announce) toast(`Applied "${v.name}"`);
  }

  function renderSmartShelves() {
    if (!smartShelvesEl) return;
    const smartRow = !review ? `<div class="shelf-row">
      <div class="shelf-label">Smart views</div>
      <div class="shelf-track">${smartViewDefs().map((v) => `<button class="shelf-chip ${esc(v.tone)}${v.on ? " on" : ""}" data-smart-shelf="${esc(v.id)}">
        <span>${esc(v.label)}</span><b>${esc(Number(v.count || 0).toLocaleString())}</b>
      </button>`).join("")}</div>
    </div>` : "";
    const savedRow = savedViews.length ? `<div class="shelf-row saved">
      <div class="shelf-label">Saved shelves</div>
      <div class="shelf-track">${savedViews.slice(0, 8).map((v) => `<button class="shelf-chip saved" data-saved-shelf="${esc(v.id)}">
        <span>${esc(v.name)}</span>
      </button>`).join("")}</div>
    </div>` : "";
    smartShelvesEl.hidden = !(smartRow || savedRow);
    smartShelvesEl.innerHTML = smartRow + savedRow;
  }

  view.innerHTML = `
    <div class="galtop">
      <div class="ghdr" id="hdrNormal">
        <input id="q" class="fb-search" type="search" aria-label="Search inventory" placeholder="Search…" value="${esc(q)}">
        <button class="iconbtn" id="densityBtn" aria-label="${density === "list" ? "Switch to grid view" : "Switch to list view"}">${density === "list" ? ICON.grid : ICON.rows}</button>
        <button class="iconbtn" id="filterBtn" aria-label="Filters &amp; sort">${ICON.filter}<span class="fcount" id="fcount" hidden></span></button>
        ${canEdit ? `<button class="iconbtn" id="selectBtn" aria-label="Select">${ICON.check}</button>` : ""}
      </div>
      <div class="ghdr ghdr-sel" id="hdrSelect" hidden>
        <button class="iconbtn" id="selExit" aria-label="Cancel">${ICON.x}</button>
        <span class="selcount" id="selCount" aria-live="polite">0 selected</span>
        <span class="spacer"></span>
        <button class="linkbtn" id="selAll">Select all</button>
      </div>
      ${review ? `<div class="seg-row review-queues review-stages" id="segRow" aria-label="Review stages">
        ${REVIEW_STAGES.map((stage) => `<button class="seg${reviewStage === stage ? " on" : ""}" data-stage="${stage}">
          ${esc(REVIEW_STAGE_META[stage].label)}<span class="seg-n" id="stageN-${stage}"></span></button>`).join("")}
      </div>` : ""}
      ${review ? `<div class="review-brief" id="reviewBrief"></div>` : ""}
      <div class="smart-shelves" id="smartShelves"></div>
      <div class="active-pills" id="pills"></div>
      <div class="count" id="count"></div>
    </div>
    <div class="browse-layout" id="browseLayout">
      <div class="results" id="grid"></div>
      <aside class="item-preview" id="itemPreview" aria-label="${review ? "Review item preview" : "Catalog item preview"}"></aside>
    </div>
    ${canEdit ? `<div class="actionbar" id="actionbar" hidden>
      <button class="ab-btn ${review && reviewStage === "verify" ? "ab-verify" : "ab-approve"}" id="abApprove"><span class="ab-ico">${ICON.tick}</span>${review && reviewStage === "verify" ? "Verify" : "Approve"}</button>
      <button class="ab-btn" id="abAi"><span class="ab-ico">${ICON.sparkle}</span>AI-fill</button>
      <button class="ab-btn" id="abEdit"><span class="ab-ico">${ICON.pencil}</span>Edit</button>
      <button class="ab-btn" id="abMore"><span class="ab-ico">${ICON.more}</span>More</button>
      <button class="ab-btn" id="abDone"><span class="ab-ico">${ICON.x}</span>Done</button>
    </div>` : ""}`;

  const grid = view.querySelector("#grid");
  const countEl = view.querySelector("#count");
  const pillsEl = view.querySelector("#pills");
  const qEl = view.querySelector("#q");
  const hdrNormal = view.querySelector("#hdrNormal");
  const hdrSelect = view.querySelector("#hdrSelect");
  const actionbar = view.querySelector("#actionbar");
  smartShelvesEl = view.querySelector("#smartShelves");
  reviewBriefEl = view.querySelector("#reviewBrief");
  previewEl = view.querySelector("#itemPreview");

  // Persist the current view state for this surface (so tab switches keep place).
  const saveState = () => {
    state.q = q; state.needsReview = needsReview; state.sortBy = sortBy;
    state.priceMin = priceMin; state.priceMax = priceMax; state.noPrice = noPrice;
    state.datePreset = datePreset; state.density = density;
    state.itemIds = [...itemIds];
    state.previewId = previewSelectedId;
    if (review) { state.issue = issue; state.stage = reviewStage; }
    state.active = {};
    for (const k in active) if (active[k]?.size) state.active[k] = [...active[k]];
    persistAppSession(appSession.view);
  };

  // Re-render after an edit/bulk action without losing the user's scroll place.
  // Pass changedIds to patch ONLY those rows in place (Q1 step 6b) instead of
  // cold-reloading the whole catalogue; no args = full reload (bulk/delete).
  const refresh = (changedIds) => {
    const y = view.scrollTop;
    if (isRailwayCatalogMode) {
      galleryPayloadCache = null;
      return renderGallery(view, caps, { ...opts, force: true }).then(() => view.scrollTo(0, y));
    }
    if (Array.isArray(changedIds) && changedIds.length) {
      return patchItems(changedIds).then(() => view.scrollTo(0, y));
    }
    return renderGallery(view, caps, { ...opts, force: true }).then(() => view.scrollTo(0, y));
  };

  // Targeted refresh: re-fetch only the changed rows + their meta and patch the
  // in-memory model (byId/data), then redraw — the reconciler updates just
  // the affected cards and draw() recomputes the segment counts. Re-fetching the
  // authoritative rows avoids local drift; any error falls back to a full reload.
  async function patchItems(ids) {
    const { data: fresh, error } = await supabase
      .from("items")
      .select(GALLERY_ITEM_SELECT)
      .in("id", ids);
    if (error) return renderGallery(view, caps, { ...opts, force: true });
    const [jobs, acts, costs] = await Promise.all([
      loadLatestFailedJobs(ids, "ai_fill"),
      loadItemActivitySummaries(ids),
      loadCostPresence(ids, { canViewCost: !!caps.can_view_cost }),
    ]);
    const returned = new Set();
    for (const row of fresh || []) {
      returned.add(row.id);
      const job = jobs.get(row.id); if (job) row.latest_ai_job = job;
      const activity = acts.get(row.id); if (activity) row.activity = activity;
      if (costs.has(row.id)) row.has_cost_price = costs.get(row.id);
      const idx = data.findIndex((d) => d.id === row.id);
      if (idx >= 0) data[idx] = row; else data.unshift(row);
      byId[row.id] = row;
    }
    for (const id of ids) { // requested but not returned = deleted
      if (returned.has(id)) continue;
      delete byId[id];
      const idx = data.findIndex((d) => d.id === id);
      if (idx >= 0) data.splice(idx, 1);
    }
    draw();
    // draw() keeps the in-surface seg counts live; the two nav badges are set
    // once per full render, so refresh them here too.
    setReviewBadge((data || []).filter((it) => needsReviewItem(it) || readyItem(it) || queueMatches(it, "edited")).length);
    loadSyncCounts(["errors", "dirty"]).then((sc) => setShopBadge((sc.errors || 0) + (sc.dirty || 0))).catch(() => {});
  }

  // ---- selection mode (phone-gallery style multi-select) ----
  const byId = Object.fromEntries(data.map((d) => [d.id, d]));
  const selected = new Set();
  let selectionMode = false;

  function updateSelBar() {
    const n = selected.size;
    const c = hdrSelect.querySelector("#selCount");
    if (c) c.textContent = `${n} selected`;
    ["abApprove", "abAi", "abEdit", "abMore"].forEach((id) => {
      const el = view.querySelector("#" + id);
      if (el) el.disabled = n === 0;
    });
  }
  function enterSelection() {
    if (!canEdit) return;
    selectionMode = true;
    navigator.vibrate?.(15); // subtle "grab" feedback on mobile
    grid.classList.add("selecting");
    hdrNormal.hidden = true;
    hdrSelect.hidden = false;
    pillsEl.hidden = true;
    countEl.hidden = true;
    const sr = view.querySelector("#segRow"); if (sr) sr.hidden = true;
    if (actionbar) actionbar.hidden = false;
    if (appNav) appNav.style.display = "none"; // one bottom bar at a time
    updateSelBar();
  }
  function exitSelection() {
    selectionMode = false;
    selected.clear();
    grid.classList.remove("selecting");
    grid.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    hdrSelect.hidden = true;
    hdrNormal.hidden = false;
    pillsEl.hidden = false;
    countEl.hidden = false;
    const sr = view.querySelector("#segRow"); if (sr) sr.hidden = false;
    if (actionbar) actionbar.hidden = true;
    if (appNav) appNav.style.display = "";
  }
  function clearSel() {
    selected.clear();
    grid.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    updateSelBar();
  }
  function toggleSelect(id, cardEl) {
    if (selected.has(id)) { selected.delete(id); cardEl?.classList.remove("selected"); }
    else { selected.add(id); cardEl?.classList.add("selected"); }
    navigator.vibrate?.(8);
    updateSelBar();
  }

  // Status badge colour per workflow state.
  const stClass = { draft: "st-draft", "needs-review": "st-review", approved: "st-ok", flag: "st-flag" };

  // Filtering is pure in src/lib/facets.js; bind the live criteria + stateful
  // resolvers (search haystack, facet value, review-queue predicate) here. The
  // review queue partitions Ready vs Needs-work (no overlap, no gaps).
  const passesQueue = (it) =>
    review ? reviewFilterMatches(it) : (!needsReview || needsReviewItem(it));
  const matchCtx = {
    textOf: (it) => searchText(it, facetResolvers),
    valueOf,
    passesQueue,
  };
  // excludeKey lets a facet's own counts ignore its own selection (faceted counting).
  const matches = (it, excludeKey) => matchesItem(it, {
    q, itemIds, noPrice, priceMin, priceMax,
    cutoff: dateCutoff(datePreset), active,
  }, matchCtx, excludeKey);

  // Sort comparators that always push blank (null) numbers to the end.
  // Pure sort lives in src/lib/itemsort.js (tested); this thin wrapper binds the
  // current sortBy so existing call sites are unchanged. (Q1)
  const applySort = (rows) => {
    const sorted = sortItems(rows, sortBy);
    if (!review || sortBy !== "new") return sorted;
    if (reviewStage === "verify") {
      return sorted.sort((a, b) => verificationRiskRank(verificationRiskOf(a)) - verificationRiskRank(verificationRiskOf(b)));
    }
    if (reviewStage === "fix" && issue === "missing") {
      const manualRank = (it) => (it.image_path && it.category_id ? 1 : 0);
      return sorted.sort((a, b) => manualRank(a) - manualRank(b));
    }
    return sorted;
  };

  function verificationDetailsHtml(it) {
    if (!review || reviewStage !== "verify") return "";
    const doubts = aiDoubtFields(it);
    if (!doubts.length) return "";
    return `<div class="verify-fields">${doubts.slice(0, 4).map(({ key, level }) => {
      const value = it[key] ?? it.attributes?.[key] ?? "not set";
      return `<span class="${level === "Low" ? "low" : "medium"}"><b>${esc(fieldLabel(key))}</b>${esc(String(value))}</span>`;
    }).join("")}${doubts.length > 4 ? `<span>+${doubts.length - 4} more</span>` : ""}</div>`;
  }

  function missingDetailsHtml(it) {
    if (!review || reviewStage !== "fix" || issueState(it) !== "missing") return "";
    const missing = missingCoreFields(it);
    if (!missing.length) return "";
    return `<div class="verify-fields missing-fields">${missing.slice(0, 5).map((field) =>
      `<span><b>Missing</b>${esc(field)}</span>`
    ).join("")}${missing.length > 5 ? `<span>+${missing.length - 5} more</span>` : ""}</div>`;
  }

  // One product card.
  function cardHtml(it) {
    const hasImg = !!it.image_path;
    const cat = it.categories?.name || "";
    const variant = summarizeItem(it); // category-driven summary line
    const brand = it.brand || it.name || "—";
    // Thumbnail src is set lazily by observeThumbs (same original image the
    // lightbox uses). data-img marks an image-bearing thumb; the
    // lightbox builds its slide list from the current filtered rows on click, so
    // the cached card HTML never holds a stale positional slide index.
    const inner = hasImg
      ? `<img class="cardthumb" data-thumb="${esc(it.image_path)}" alt="${esc(brand)}">`
      : `<span style="color:var(--muted);font-size:12px">no image</span>`;
    const thumb = `<div class="thumb"${hasImg ? " data-img" : ""}>
      ${inner}<span class="selcheck">✓</span>${hasAiDoubt(it) ? '<span class="lowdot" title="Has an AI field to check" data-tip="Has an AI field to check"></span>' : ""}</div>`;
    return `<div class="card" data-id="${it.id}">
      ${thumb}
      <div class="body">
        <div class="card-head">
          <div class="card-titleblock">
            <div class="cbrand">${esc(brand)}</div>
            ${cat ? `<div class="ccat">${esc(cat)}</div>` : ""}
          </div>
          <span class="stbadge ${stClass[it.status] || ""}">${esc(statusLabel(it.status))}</span>
        </div>
        ${variant ? `<div class="cattr">${esc(variant)}</div>` : ""}
        <div class="issue-line">${issueBadgesHtml(it)}${activityBadgesHtml(it)}${posChipHtml(it)}</div>
        ${verificationDetailsHtml(it)}
        ${missingDetailsHtml(it)}
        <div class="cmeta">
          ${it.price != null ? `<span class="cprice">${fmtPrice(it.price)}</span>` : `<span class="noprice">Missing price</span>`}
          <span class="cdate">${fmtDate(it.created_at)}</span>
        </div>
      </div>
    </div>`;
  }

  // One dense scan-list row: small thumb + brand/status on top, then the
  // category-driven summary with AI-doubt fields tinted, then price/date. Built
  // for skimming many uploads to judge AI quality without opening each one. It
  // reuses the `.card[data-id]` contract so all the selection/tap/lightbox
  // interactions below work unchanged.
  function rowHtml(it) {
    const hasImg = !!it.image_path;
    const cat = it.categories?.name || "";
    const brand = it.brand || it.name || "—";
    const variant = summarizeItemRich(it);
    const inner = hasImg
      ? `<img class="cardthumb" data-thumb="${esc(it.image_path)}" alt="${esc(brand)}">`
      : `<span class="row-noimg">—</span>`;
    const thumb = `<div class="thumb"${hasImg ? " data-img" : ""}>
      ${inner}<span class="selcheck">✓</span>${hasAiDoubt(it) ? '<span class="lowdot" title="Has an AI field to check" data-tip="Has an AI field to check"></span>' : ""}</div>`;
    return `<div class="card card-row" data-id="${it.id}">
      ${thumb}
      <div class="row-main">
        <div class="row-top">
          <span class="row-title"><span class="row-brand">${esc(brand)}</span>${cat ? `<span class="row-cat">${esc(cat)}</span>` : ""}</span>
          ${it.price != null ? `<span class="cprice">${fmtPrice(it.price)}</span>` : `<span class="noprice">Missing price</span>`}
        </div>
        ${variant ? `<div class="row-sub"><span class="row-attr">${variant}</span></div>` : ""}
        ${verificationDetailsHtml(it)}
        ${missingDetailsHtml(it)}
        <div class="row-meta">
          <span class="row-badges">${issueBadgesHtml(it, { compact: true })}${activityBadgesHtml(it, { compact: true })}<span class="stbadge ${stClass[it.status] || ""}">${esc(statusLabel(it.status))}</span>${posChipHtml(it)}</span>
          <span class="cdate">${fmtDate(it.created_at)}</span>
        </div>
      </div>
    </div>`;
  }

  // ---- lazy, transform-signed thumbnails ----------------------------------
  // Cards load a ~500px WebP, signed ON DEMAND as they scroll into view — not the
  // full ~1280px image. This cuts gallery transfer sharply (full ~200KB → ~100KB
  // crisp thumb) AND only fetches what's actually visible. The full image is still
  // used by the lightbox (tap to zoom), so quality on zoom is unchanged.
  const loadThumb = (img) => { const p = img.dataset.thumb; if (p) signThumb(p).then((u) => { if (u) img.src = u; }); };
  // IntersectionObserver = the lazy mechanism (tighter than native loading=lazy,
  // which was eagerly loading far more than one screen). 300px margin = start just
  // before a card scrolls in. No-IO fallback: load thumbs immediately.
  const thumbObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, obs) => {
        for (const e of entries) if (e.isIntersecting) { obs.unobserve(e.target); loadThumb(e.target); }
      }, { rootMargin: "300px" })
    : null;
  function observeThumbs(container) {
    container.querySelectorAll("img[data-thumb]:not([src])")
      .forEach((img) => (thumbObserver ? thumbObserver.observe(img) : loadThumb(img)));
  }

  // ---- incremental grid render (C1) -------------------------------------
  // The gallery used to rebuild grid.innerHTML — a full string build + reparse
  // of up to 1,000 cards — on every keystroke/filter/sort. We now keep a cache
  // of card nodes keyed by id and reconcile: build only new/changed cards,
  // reorder existing nodes in place, and drop removed ones. Selection state is
  // applied to the node AFTER placement (not baked into the cached HTML), so a
  // sweep or shift-range never invalidates the cache. content-visibility already
  // defers off-screen layout, so typing now stays smooth at full catalogue.
  let gridInner = null;        // the live .grid / .scanlist container
  let cacheDensity = null;     // density the current nodes were built for
  const cardCache = new Map(); // id -> { el, html }
  let renderedItemLimit = 0;
  let renderCriteriaKey = "";
  const progressiveRenderObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          revealNextResultBatch();
        }
      }, { rootMargin: "600px" })
    : null;

  function elFromHtml(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function reconcileGrid(rows) {
    // A density switch (grid <-> scan-list) or first paint needs a fresh
    // container — the card markup itself differs between the two layouts.
    if (!gridInner || cacheDensity !== density || gridInner.parentNode !== grid) {
      cardCache.clear();
      grid.innerHTML = density === "list" ? `<div class="scanlist"></div>` : `<div class="grid"></div>`;
      gridInner = grid.firstElementChild;
      cacheDensity = density;
    }
    const seen = new Set();
    let prev = null;
    for (const it of rows) {
      const html = density === "list" ? rowHtml(it) : cardHtml(it);
      let entry = cardCache.get(it.id);
      if (!entry || entry.html !== html) {           // new card, or its content changed
        const el = elFromHtml(html);
        if (entry && entry.el.parentNode) entry.el.remove();
        entry = { el, html };
        cardCache.set(it.id, entry);
      }
      const el = entry.el;
      const target = prev ? prev.nextSibling : gridInner.firstChild;
      if (el !== target) gridInner.insertBefore(el, target); // move into the right slot (no-op if already there)
      el.classList.toggle("selected", selected.has(it.id));
      prev = el;
      seen.add(it.id);
    }
    for (const child of [...gridInner.children]) {    // drop cards no longer in the filtered set
      if (!seen.has(child.dataset.id)) { cardCache.delete(child.dataset.id); child.remove(); }
    }
    fadeInImages(gridInner);
    observeThumbs(gridInner);
  }

  // Keep an accessible manual control as the fallback, then let the same control
  // act as a scroll sentinel when IntersectionObserver is available.
  function renderProgressiveLoadControl(rows) {
    const existingControl = grid.querySelector(".gallery-more");
    if (existingControl) {
      progressiveRenderObserver?.unobserve(existingControl);
      existingControl.remove();
    }
    if (renderedItemLimit >= rows.length) return;
    const remainingItems = rows.length - renderedItemLimit;
    const nextBatchSize = Math.min(DEFAULT_GALLERY_RENDER_BATCH_SIZE, remainingItems);
    const control = document.createElement("div");
    control.className = "gallery-more";
    control.innerHTML = `<span>${renderedItemLimit.toLocaleString()} of ${rows.length.toLocaleString()} shown</span>
      <button type="button" class="ghost">Show ${nextBatchSize.toLocaleString()} more</button>`;
    control.querySelector("button").onclick = () => revealNextResultBatch();
    grid.appendChild(control);
    progressiveRenderObserver?.observe(control);
  }

  // Extend only the visible DOM window. `filtered` remains the full result set,
  // so counts, previews, lightbox order, and bulk actions retain exact behavior.
  function revealNextResultBatch() {
    renderedItemLimit = nextGalleryRenderLimit(renderedItemLimit, filtered.length);
    reconcileGrid(filtered.slice(0, renderedItemLimit));
    renderProgressiveLoadControl(filtered);
  }

  function renderReviewBrief(rows, failedAiShown = 0) {
    if (!reviewBriefEl) return;
    if (!review) { reviewBriefEl.hidden = true; return; }
    const guide = reviewQueueGuide(issue);
    const actions = [];
    if (issue === "price" && canEdit && rows.length) actions.push(["setprices", "Price items"]);
    else if (issue === "ai" && canEdit && rows.length) actions.push([failedAiShown ? "retryai" : "aifill", failedAiShown ? `Retry ${failedAiShown}` : "AI-fill"]);
    else if (issue === "missing" && canEdit && rows.length) {
      const recoverable = rows.filter((it) => it.image_path && it.category_id).length;
      if (recoverable) actions.push(["fillmissing", `AI-fill ${recoverable}`]);
      actions.push(["selectmissing", "Bulk edit by category"]);
    }
    else if (issue === "sync" && canEdit && rows.length) actions.push(["sync", "Open sync"]);
    else if (issue === "ready" && canEdit && rows.length) actions.push(["approveall", `Approve ${rows.length}`]);
    if (reviewStage === "verify" && canEdit) {
      const quickCount = rows.filter((it) => verificationRiskOf(it).bulkEligible).length;
      if (quickCount) actions.push(["selectquick", `Select ${quickCount} quick checks`]);
    }
    if (canEdit && reviewStage === "approve" && rows.length > 1) actions.push(["swipe", `Focus mode ${rows.length}`]);
    const defaultFilter = defaultFilterForStage(reviewStage);
    if (issue !== defaultFilter) actions.push(["allstage", `All ${REVIEW_STAGE_META[reviewStage].label.toLowerCase()}`]);
    const breakdown = reviewStageBreakdown(rows);
    reviewBriefEl.hidden = false;
    reviewBriefEl.innerHTML = `
      <div class="review-brief-copy">
        <div class="review-brief-kicker">${esc(REVIEW_STAGE_META[reviewStage].label)} stage</div>
        <div class="review-brief-title">
          <b>${esc(guide.title)}</b>
          <span>${esc(Number(rows.length || 0).toLocaleString())}</span>
        </div>
        <p>${esc(guide.detail)}</p>
        ${breakdown}
      </div>
      <div class="review-brief-actions">
        ${actions.map(([cta, label], i) => `<button class="${i === 0 ? "primary" : "ghost"}" data-cta="${esc(cta)}">${esc(label)}</button>`).join("")}
      </div>`;
  }

  function reviewStageBreakdown(rows) {
    if (!rows.length) return "";
    if (reviewStage === "fix") {
      if (issue === "missing") {
        const recoverable = rows.filter((it) => it.image_path && it.category_id).length;
        const manual = rows.length - recoverable;
        const parts = [
          recoverable ? `${recoverable} AI-recoverable` : "",
          manual ? `${manual} need photo or category` : "",
        ].filter(Boolean);
        return parts.length ? `<div class="review-ai-breakdown">${parts.map((part) => `<span>${esc(part)}</span>`).join("")}</div>` : "";
      }
      const labels = { ai: "AI fill", price: "price", missing: "details", flag: "problem", sync: "shop" };
      const counts = {};
      rows.forEach((it) => { const key = issueState(it); if (labels[key]) counts[key] = (counts[key] || 0) + 1; });
      const parts = Object.entries(counts).map(([key, count]) => `${count} ${labels[key]}`);
      return parts.length ? `<div class="review-ai-breakdown">${Object.entries(counts).map(([key, count]) =>
        `<button type="button" class="review-break-chip" data-cta="filterissue" data-issue="${esc(key)}">${esc(`${count} ${labels[key]}`)}</button>`
      ).join("")}</div>` : "";
    }
    if (reviewStage === "verify") {
      const risks = rows.map(verificationRiskOf);
      const critical = risks.filter((risk) => risk.level === "critical").length;
      const quick = risks.filter((risk) => risk.level === "quick").length;
      const recent = risks.filter((risk) => risk.level === "recent").length;
      const parts = [
        critical ? `${critical} critical` : "",
        quick ? `${quick} quick checks` : "",
        recent ? `${recent} recent edits` : "",
      ].filter(Boolean);
      return parts.length ? `<div class="review-ai-breakdown">${parts.map((part) => `<span>${esc(part)}</span>`).join("")}</div>` : "";
    }
    return `<div class="review-ai-breakdown"><span>${rows.length} ready for final inspection</span></div>`;
  }

  function isPreviewPaneActive() {
    if (!previewEl || previewEl.hidden) return false;
    return window.matchMedia
      ? window.matchMedia("(min-width: 980px)").matches
      : (window.innerWidth || 0) >= 980;
  }

  function cardElFor(id) {
    return [...grid.querySelectorAll(".card[data-id]")].find((c) => c.dataset.id === id) || null;
  }

  function markPreviewCard() {
    grid.querySelectorAll(".card.previewing").forEach((c) => c.classList.remove("previewing"));
    const card = cardElFor(previewSelectedId);
    if (card) card.classList.add("previewing");
  }

  function openPhotoLightbox(id) {
    const imgRows = filtered.filter((it) => it.image_path);
    const slides = imgRows.map((it) => {
      const brand = it.brand || it.name || "-";
      const sub = density === "list" ? (it.categories?.name || "") : summarizeItem(it);
      return { getUrl: () => signFullImage(it.image_path), caption: esc([brand, sub].filter(Boolean).join(" - ")) };
    });
    openLightbox(slides, Math.max(0, imgRows.findIndex((it) => it.id === id)));
  }

  function setPreviewItem(id) {
    if (!id || !filtered.some((it) => it.id === id)) return;
    previewSelectedId = id;
    state.previewId = id;
    renderPreviewPane(filtered);
  }

  function previewIssueList(readiness) {
    const issues = [...readiness.blockers, ...readiness.warnings].slice(0, 4);
    if (!issues.length) return `<li>Ready for approval when the photo and selling details look right.</li>`;
    return issues.map((x) => `<li><b>${esc(x.label)}</b>${x.detail ? ` <span>${esc(x.detail)}</span>` : ""}</li>`).join("");
  }

  function previewAiDoubts(it) {
    const doubts = aiDoubtFields(it).slice(0, 5);
    if (!doubts.length) return "";
    return `<div class="preview-section">
      <div class="preview-section-title">AI checks</div>
      <div class="preview-chipline">
        ${doubts.map((d) => `<span class="issue-pill iss-doubt">${esc(fieldLabel(d.key))}: ${esc(d.level)}</span>`).join("")}
      </div>
    </div>`;
  }

  function renderPreviewPane(rows) {
    if (!previewEl) return;
    if (!rows.length) {
      previewSelectedId = "";
      state.previewId = "";
      previewEl.hidden = true;
      previewEl.innerHTML = "";
      return;
    }
    if (!previewSelectedId || !rows.some((it) => it.id === previewSelectedId)) previewSelectedId = rows[0].id;
    const it = rows.find((row) => row.id === previewSelectedId) || rows[0];
    previewSelectedId = it.id;
    state.previewId = it.id;
    markPreviewCard();

    const brand = it.brand || it.name || "-";
    const cat = it.categories?.name || "";
    const variant = summarizeItem(it);
    const readiness = getItemReadiness(it, { canViewCost: !!caps.can_view_cost });
    const tone = readiness.blockers.length ? "blocked" : readiness.warnings.length ? "warn" : "ready";
    const title = readiness.blockers.length
      ? "Blocked"
      : readiness.warnings.length
        ? "Check before approval"
        : it.status === "approved"
          ? "Approved"
          : "Ready to approve";
    const img = it.image_path
      ? `<button class="thumb preview-photo" data-preview-photo data-img aria-label="Inspect photo">
          <img class="cardthumb" data-thumb="${esc(it.image_path)}" alt="${esc(brand)}">
        </button>`
      : `<div class="preview-photo preview-noimage">No image</div>`;
    previewEl.hidden = false;
    previewEl.innerHTML = `
      ${img}
      <div class="preview-body">
        <div class="preview-kicker">${esc(review ? "Review preview" : "Catalog preview")}</div>
        <h3>${esc(brand)}</h3>
        ${cat ? `<div class="preview-sub">${esc(cat)}</div>` : ""}
        ${variant ? `<div class="preview-attrs">${esc(variant)}</div>` : ""}
        <div class="preview-chipline">
          <span class="stbadge ${stClass[it.status] || ""}">${esc(statusLabel(it.status))}</span>
          ${issueBadgesHtml(it)}
          ${activityBadgesHtml(it)}
          ${posChipHtml(it)}
        </div>
        <div class="preview-price">${it.price != null ? fmtPrice(it.price) : "Missing price"}</div>
        <div class="preview-readiness ${tone}">
          <div><b>${esc(title)}</b><span>${esc(readiness.primary?.action || "Review item")}</span></div>
          <ul>${previewIssueList(readiness)}</ul>
        </div>
        ${previewAiDoubts(it)}
        <div class="preview-actions">
          <button class="primary" data-preview-open>Open editor</button>
          ${it.image_path ? `<button class="ghost" data-preview-photo>Inspect photo</button>` : ""}
          ${canEdit ? `<button class="ghost" data-preview-select>Select item</button>` : ""}
        </div>
      </div>`;
    observeThumbs(previewEl);
    fadeInImages(previewEl);
  }

  function draw() {
    const rows = applySort(data.filter((it) => matches(it, null)));
    filtered = rows;          // expose current filtered+sorted set for bulk actions
    const nextRenderCriteriaKey = JSON.stringify([
      q, needsReview, issue, reviewStage, density, sortBy, priceMin, priceMax,
      datePreset, noPrice, [...itemIds], Object.entries(active).map(([key, values]) => [key, [...values]]),
    ]);
    if (nextRenderCriteriaKey !== renderCriteriaKey || renderedItemLimit === 0) {
      renderedItemLimit = initialGalleryRenderLimit(rows.length);
      renderCriteriaKey = nextRenderCriteriaKey;
    } else {
      renderedItemLimit = Math.min(rows.length, Math.max(renderedItemLimit, initialGalleryRenderLimit(rows.length)));
    }
    saveState();
    renderSmartShelves();
    const failedAiShown = rows.filter((it) => it.latest_ai_job?.status === "failed").length;
    renderReviewBrief(rows, failedAiShown);

    // Pricing is the gate to approval, so the count line doubles as its
    // doorway: a tap on "N without a price" applies the no-price filter, and
    // once you're looking at the unpriced, "Price items" is right there.
    const unpricedShown = rows.filter((it) => it.price == null).length;
    const priceCta = review ? "" : noPrice
      ? (canEdit ? ` · <button class="count-cta" data-cta="setprices">Price items ›</button>` : "")
      : unpricedShown
        ? ` · <button class="count-cta" data-cta="noprice">${unpricedShown} without a price</button>`
        : "";
    // Review actions live in the stage brief above. Keep the count line quiet so
    // mobile users see the inventory sooner and never meet duplicate CTAs.
    const approveCta = "";
    const swipeCta = "";
    const openFirstCta = "";
    const issueCta = "";
    // Keep the segment counts live (they partition `data`, not the filtered rows).
    if (review) {
      for (const stage of REVIEW_STAGES) {
        const n = data.filter((it) => reviewStageMatches(it, stage)).length;
        const el = view.querySelector(`#stageN-${stage}`);
        if (el) el.textContent = n ? n : "";
      }
    }

    // Note when the load hit the row cap so a truncated set never looks complete.
    const capped = data.length >= GALLERY_LIMIT;
    const countNote = capped ? ` · <span class="cap-note">showing the first ${GALLERY_LIMIT.toLocaleString()} — refine to see all</span>` : "";

    // On Review, "N of <whole catalogue>" read as if N were a fraction of the
    // review queue — say what it is instead.
    const reviewCountText = (n) => {
      if (issue === "work") return `${n} need${n === 1 ? "s" : ""} work`;
      if (issue === "verify") return `${n} to verify`;
      if (issue === "edited") return `${n} recently edited`;
      if (issue === "ai") return `${n} need${n === 1 ? "s" : ""} AI fill`;
      if (issue === "price") return `${n} without a price`;
      if (issue === "doubt") return `${n} to check with AI`;
      if (issue === "missing") return `${n} missing details`;
      if (issue === "flag") return `${n} problem item${n === 1 ? "" : "s"}`;
      if (issue === "sync") return `${n} shop issue${n === 1 ? "" : "s"}`;
      if (issue === "ready") return `${n} ready to approve`;
      return `${n} review item${n === 1 ? "" : "s"}`;
    };
    const countText = (n) => review
      ? reviewCountText(n)
      : `${n} of ${data.length} item${data.length === 1 ? "" : "s"}`;


    if (rows.length === 0) {
      countEl.innerHTML = `${countText(0)}${countNote}${freshnessNote()}`;
      grid.innerHTML = `<div class="empty"><div class="big">${review ? "✓" : "🔍"}</div>
        <div>${review
          ? (reviewStage === "approve"
            ? "Nothing is ready to approve yet — items land here once they're priced and the AI has no doubts."
            : `No ${ISSUE_META[issue]?.empty || "review"} items right now.`)
          : "No items match your search or filters."}</div>
        ${(q || filterCount()) ? `<button class="ghost" id="clearFiltersBtn" style="margin-top:10px">Clear filters</button>` : ""}</div>`;
      renderPreviewPane([]);
      progressiveRenderObserver?.disconnect();
      gridInner = null; cardCache.clear();   // next non-empty draw rebuilds the container
      const cf = grid.querySelector("#clearFiltersBtn");
      if (cf) cf.onclick = clearAllFilters;
      return;
    }

    reconcileGrid(rows.slice(0, renderedItemLimit));
    renderProgressiveLoadControl(rows);
    renderPreviewPane(rows);
    countEl.innerHTML = `${countText(rows.length)}${countNote}${priceCta}${issueCta}${openFirstCta}${approveCta}${swipeCta}${freshnessNote()}`;
  }

  // ---- selection interactions: tap, shift-click range, drag/slide sweep ----
  const cardIndex = (card) => [...grid.querySelectorAll(".card[data-id]")].indexOf(card);
  let anchorIndex = null;      // last single-selected card, for shift-range
  let suppressClick = false;   // swallow the click that ends a long-press / drag
  let drag = null;             // { action:'add'|'remove', processed:Set }
  let lpTimer = null;
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  const reviewFocusIssue = (it) => {
    const st = issueState(it);
    if (st === "price" && it?.price != null && it?.has_cost_price === false) return "cost";
    return st;
  };
  const openItemEditor = (id, focusIssue) => {
    const currentIndex = filtered.findIndex((it) => it.id === id);
    const nextId = review && currentIndex >= 0 ? filtered[currentIndex + 1]?.id : "";
    let saved = false;
    return openCatalogItem(
      id,
      caps,
      async () => {
        saved = true;
        await refresh([id]);
      },
      review ? {
        focusIssue: focusIssue || reviewFocusIssue(byId[id]),
        saveNext: !!nextId,
        onClose: () => {
          if (saved && nextId && byId[nextId]) openItemEditor(nextId, reviewFocusIssue(byId[nextId]));
        },
      } : {}
    );
  };

  function setSelected(card, on) {
    const id = card.dataset.id;
    if (on) { selected.add(id); card.classList.add("selected"); }
    else { selected.delete(id); card.classList.remove("selected"); }
  }
  function rangeSelect(toIndex) {
    const cards = [...grid.querySelectorAll(".card[data-id]")];
    let [a, b] = [anchorIndex ?? toIndex, toIndex].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) cards[i] && setSelected(cards[i], true);
    updateSelBar();
  }
  const preventScroll = (e) => { if (drag) e.preventDefault(); };
  function applyDrag(card) {
    const id = card.dataset.id;
    if (drag.processed.has(id)) return;
    drag.processed.add(id);
    setSelected(card, drag.action === "add");
    updateSelBar();
  }
  function docMove(e) {
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const card = el && el.closest && el.closest(".card[data-id]");
    if (card) applyDrag(card);
  }
  function startDrag(card) {
    if (!selectionMode) enterSelection();
    const willSelect = !selected.has(card.dataset.id);
    drag = { action: willSelect ? "add" : "remove", processed: new Set() };
    anchorIndex = cardIndex(card);
    applyDrag(card);
    // Document-scoped so a sweep keeps working past the grid edge, and these are
    // removed on drag end (no per-render listener buildup).
    document.addEventListener("touchmove", preventScroll, { passive: false });
    document.addEventListener("pointermove", docMove);
    document.addEventListener("pointerup", endDrag);
  }
  function endDrag() {
    if (!drag) return;
    drag = null;
    document.removeEventListener("touchmove", preventScroll, { passive: false });
    document.removeEventListener("pointermove", docMove);
    document.removeEventListener("pointerup", endDrag);
    suppressClick = true;
  }

  grid.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const card = e.target.closest(".card[data-id]");
    if (selectionMode) {
      if (!card) return;
      if (e.shiftKey && anchorIndex !== null) rangeSelect(cardIndex(card));
      else { toggleSelect(card.dataset.id, card); anchorIndex = cardIndex(card); }
      return;
    }
    // Touch has no hover: a tap on an info chip/dot (POS state, AI-doubt, source)
    // reveals its detail in a toast instead of opening the editor/lightbox.
    const tip = e.target.closest("[data-tip]");
    if (tip) { toast(tip.dataset.tip); return; }
    const thumb = e.target.closest(".thumb[data-img]");
    if (thumb) {
      const id = thumb.closest(".card[data-id]")?.dataset.id;
      openPhotoLightbox(id);
      return;
    }
    if (card) {
      if (isPreviewPaneActive()) { setPreviewItem(card.dataset.id); return; }
      openItemEditor(card.dataset.id);
    }
  });

  grid.addEventListener("dblclick", (e) => {
    if (selectionMode || !isPreviewPaneActive()) return;
    const card = e.target.closest(".card[data-id]");
    if (card && !e.target.closest(".thumb")) openItemEditor(card.dataset.id);
  });

  if (previewEl) previewEl.addEventListener("click", (e) => {
    const tip = e.target.closest("[data-tip]");
    if (tip) { toast(tip.dataset.tip); return; }
    if (!previewSelectedId) return;
    if (e.target.closest("[data-preview-open]")) openItemEditor(previewSelectedId);
    else if (e.target.closest("[data-preview-photo]")) openPhotoLightbox(previewSelectedId);
    else if (e.target.closest("[data-preview-select]") && canEdit) {
      enterSelection();
      const card = cardElFor(previewSelectedId);
      if (card) setSelected(card, true);
      else selected.add(previewSelectedId);
      updateSelBar();
    }
  });

  let lpStart = null;
  grid.addEventListener("pointerdown", (e) => {
    if (!canEdit) return;
    const card = e.target.closest(".card[data-id]");
    if (!card) return;
    if (e.pointerType === "mouse") {
      // Mouse in selection mode: shift = range (let click handle it); else drag.
      if (selectionMode && !e.shiftKey) { e.preventDefault(); startDrag(card); }
    } else {
      // Touch/pen: long-press to begin selection + sweep (so scrolling still works).
      lpStart = { x: e.clientX, y: e.clientY };
      lpTimer = setTimeout(() => { lpTimer = null; startDrag(card); }, 380);
    }
  });
  // Cancel the long-press only on real movement (tolerate finger jitter); a held
  // finger that barely moves still triggers selection.
  grid.addEventListener("pointermove", (e) => {
    if (drag || !lpTimer || !lpStart) return;
    if (Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 12) cancelLp();
  });
  grid.addEventListener("pointerup", cancelLp);
  grid.addEventListener("pointercancel", () => { cancelLp(); endDrag(); });
  // Suppress the browser long-press context menu inside the grid.
  grid.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- active filters: pill strip + the "Filters & sort" sheet ----
  // How many narrowing filters are active (drives the Filters-button badge).
  function filterCount() {
    let n = 0;
    for (const k in active) if (active[k]?.size) n += active[k].size;
    if (priceMin || priceMax) n++;
    if (noPrice) n++;
    if (datePreset !== "all") n++;
    if (needsReview && !review) n++;
    if (itemIds.size) n++;
    return n;
  }
  // Reset filters (not sort/group, which are view options). Review keeps triage.
  function clearAllFilters() {
    q = ""; if (qEl) qEl.value = "";
    for (const k in active) delete active[k];
    for (const k in facetFilter) delete facetFilter[k];
    priceMin = ""; priceMax = ""; noPrice = false; datePreset = "all";
    itemIds = new Set();
    if (!review) needsReview = false;
    draw(); pills();
  }

  // The horizontal strip of removable chips below the search box.
  function pills() {
    const out = [];
    if (sortBy !== "new") out.push(`<button class="apill view" data-clear="sort">Sorted: ${esc(SORTS.find((s) => s.v === sortBy)?.label || sortBy)} ✕</button>`);
    for (const k in active) for (const v of active[k]) {
      out.push(`<button class="apill" data-facet="${esc(k)}" data-val="${esc(v)}">${esc(facetByKey[k]?.label || k)}: ${esc(v)} ✕</button>`);
    }
    if (noPrice) out.push(`<button class="apill" data-clear="noprice">Missing price ✕</button>`);
    if (priceMin || priceMax) out.push(`<button class="apill" data-clear="price">Price: ${esc(priceMin ? fmtPrice(priceMin) : "0")}–${esc(priceMax ? fmtPrice(priceMax) : "∞")} ✕</button>`);
    if (datePreset !== "all") out.push(`<button class="apill" data-clear="dt">${esc(DATE_FILTERS.find((d) => d.v === datePreset)?.label || datePreset)} ✕</button>`);
    if (itemIds.size) out.unshift(`<button class="apill" data-clear="batch">Uploaded batch: ${itemIds.size} x</button>`);
    pillsEl.innerHTML = out.join("");
    const badge = view.querySelector("#fcount");
    if (badge) { const n = filterCount(); badge.textContent = n; badge.hidden = !n; }
  }
  // Count-line shortcuts (countEl is created fresh each renderGallery, so one
  // listener per render — no accumulation).
  function selectMissingGroup(items) {
    if (!items.length) return;
    enterSelection();
    items.forEach((it) => {
      selected.add(it.id);
      cardElFor(it.id)?.classList.add("selected");
    });
    updateSelBar();
    toast(`${items.length} item${items.length === 1 ? "" : "s"} selected. Tap Edit to apply shared missing values.`);
  }

  function chooseMissingBulkGroup() {
    const groups = new Map();
    filtered.forEach((it) => {
      const key = it.category_id || "__none__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    });
    if (groups.size <= 1) { selectMissingGroup(filtered); return; }
    const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const sh = openBottomSheet("Bulk edit missing details", `
      <div class="menu-sub">Choose one category so the bulk editor can show its shared fields.</div>
      ${rows.map(([key, items]) => `<button class="menu-item settings-row" data-missing-category="${esc(key)}">
        <span><b>${esc(key === "__none__" ? "No category" : categoryPath(key))}</b><small>${items.length} item${items.length === 1 ? "" : "s"}</small></span>
      </button>`).join("")}`);
    sh.body.addEventListener("click", (event) => {
      const button = event.target.closest("[data-missing-category]");
      if (!button) return;
      const items = groups.get(button.dataset.missingCategory) || [];
      sh.close();
      selectMissingGroup(items);
    });
  }

  function handleCtaClick(e) {
    const cta = e.target.closest("[data-cta]");
    if (!cta) return;
    if (cta.dataset.cta === "noprice") { noPrice = true; priceMin = ""; priceMax = ""; draw(); pills(); }
    else if (cta.dataset.cta === "setprices") {
      // One model everywhere: guided pricing. In Review it opens scoped to the
      // items on screen (selection mode); elsewhere it starts at the category
      // picker. The table tool stays reachable inside guided.
      if (review) openGuidedPricing(caps, refresh, { itemIds: filtered.map((it) => it.id) });
      else openGuidedPricing(caps, refresh);
    }
    else if (cta.dataset.cta === "swipe") openSwipeReview(filtered, caps, { onChanged: refresh });
    else if (cta.dataset.cta === "retryai") {
      const failed = filtered.filter((it) => it.latest_ai_job?.status === "failed");
      if (failed.length) openBulkAi(failed, caps, refresh);
      else toast("No failed AI jobs in this view.");
    }
    else if (cta.dataset.cta === "aifill") openBulkAi(filtered, caps, refresh);
    else if (cta.dataset.cta === "fillmissing") {
      const recoverable = filtered.filter((it) => it.image_path && it.category_id);
      if (recoverable.length) openBulkAi(recoverable, caps, refresh);
      else toast("These items need a photo or category before AI can fill details.");
    }
    else if (cta.dataset.cta === "selectmissing") chooseMissingBulkGroup();
    else if (cta.dataset.cta === "sync") openSyncCenter(caps, refresh, { focus: "errors" });
    else if (cta.dataset.cta === "approveall") approveItems(filtered.map((it) => it.id));
    else if (cta.dataset.cta === "openfirst" && filtered[0]) openItemEditor(filtered[0].id, reviewFocusIssue(filtered[0]));
    else if (cta.dataset.cta === "allstage") setReviewIssue(defaultFilterForStage(reviewStage));
    else if (cta.dataset.cta === "filterissue" && cta.dataset.issue) setReviewIssue(cta.dataset.issue);
    else if (cta.dataset.cta === "selectquick") {
      const quick = filtered.filter((it) => verificationRiskOf(it).bulkEligible);
      if (!quick.length) { toast("No quick checks in this view."); return; }
      enterSelection();
      quick.forEach((it) => {
        selected.add(it.id);
        cardElFor(it.id)?.classList.add("selected");
      });
      updateSelBar();
      toast(`${quick.length} quick checks selected. Scan them, then tap Verify.`);
    }
  }
  countEl.addEventListener("click", handleCtaClick);
  if (reviewBriefEl) reviewBriefEl.addEventListener("click", handleCtaClick);

  // Review-tab segment switch (Needs work ⇄ Ready to approve).
  const segRow = view.querySelector("#segRow");
  function setReviewIssue(next, announce = false) {
    if (!REVIEW_FILTERS.includes(next) || next === issue) return;
    issue = next;
    reviewStage = reviewStageForFilter(issue);
    if (segRow) {
      segRow.querySelectorAll(".seg").forEach((s) => s.classList.toggle("on", s.dataset.stage === reviewStage));
    }
    state.issue = issue;
    state.stage = reviewStage;
    persistAppSession("review");
    window.history.replaceState(
      { klineView: "review", reviewFilter: issue },
      "",
      buildAppUrl(window.location.href, { view: "review", reviewFilter: issue })
    );
    draw();
    if (announce) {
      toast(ISSUE_META[issue]?.label || REVIEW_STAGE_META[reviewStage].label);
      navigator.vibrate?.(8);
    }
  }
  if (segRow) segRow.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-stage]");
    if (!btn || btn.dataset.stage === reviewStage) return;
    setReviewIssue(defaultFilterForStage(btn.dataset.stage));
  });
  function bindReviewSwipe(el) {
    if (!review || !el) return;
    let start = null;
    el.addEventListener("pointerdown", (e) => {
      if (selectionMode || e.pointerType === "mouse") return;
      if (e.target.closest("button, a, input, select, textarea")) return;
      start = { x: e.clientX, y: e.clientY };
    }, { passive: true });
    el.addEventListener("pointerup", (e) => {
      if (!start || selectionMode) { start = null; return; }
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.45) return;
      const i = REVIEW_STAGES.indexOf(reviewStage);
      const nextStage = REVIEW_STAGES[Math.max(0, Math.min(REVIEW_STAGES.length - 1, i + (dx < 0 ? 1 : -1)))];
      setReviewIssue(defaultFilterForStage(nextStage), true);
    }, { passive: true });
    el.addEventListener("pointercancel", () => { start = null; }, { passive: true });
  }
  bindReviewSwipe(countEl);

  pillsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear], [data-facet]");
    if (!b) return;
    if (b.dataset.facet) active[b.dataset.facet]?.delete(b.dataset.val);
    else if (b.dataset.clear === "price") { priceMin = ""; priceMax = ""; }
    else if (b.dataset.clear === "noprice") noPrice = false;
    else if (b.dataset.clear === "batch") itemIds = new Set();
    else if (b.dataset.clear === "dt") datePreset = "all";
    else if (b.dataset.clear === "sort") sortBy = "new";
    draw(); pills();
  });

  // The "Filters & sort" sheet — a clean drill-down (master list → focused
  // picker), designed for non-technical mobile users: one consistent row idiom,
  // one decision per screen, current value shown on each row. Live-applies to
  // the grid behind it; the footer shows the live result count.
  if (smartShelvesEl) smartShelvesEl.addEventListener("click", (e) => {
    const smart = e.target.closest("[data-smart-shelf]");
    if (smart) { applySmartView(smart.dataset.smartShelf); return; }
    const saved = e.target.closest("[data-saved-shelf]");
    if (saved) applySavedView(savedViews.find((v) => v.id === saved.dataset.savedShelf));
  });

  function openFilters() {
    const matchCount = () => data.filter((it) => matches(it, null)).length;
    const PRIMARY = ["issue", "shop", "category", "brand"]; // shown directly; the rest go under "More"
    const moreFacets = facets.filter((f) => !PRIMARY.includes(f.key));
    const priceLabel = () => noPrice ? "Missing price"
      : (priceMin || priceMax)
        ? `${fmtPrice(priceMin || 0)}–${priceMax ? fmtPrice(priceMax) : "∞"}` : "Any";
    const dateLabel = () => DATE_FILTERS.find((d) => d.v === datePreset)?.label || "Any date";
    const facetSummary = (f) => {
      const sel = active[f.key];
      return sel?.size ? `${[...sel].slice(0, 2).join(", ")}${sel.size > 2 ? ` +${sel.size - 2}` : ""}` : "Any";
    };
    const moreSummary = () => {
      const n = moreFacets.reduce((s, f) => s + (active[f.key]?.size || 0), 0);
      return n ? `${n} selected` : "Any";
    };

    // ---- sheet shell with a master/detail head ----
    const el = document.createElement("div");
    el.className = "msheet filter-sheet";
    el.innerHTML = `<div class="msheet-panel" role="dialog" aria-modal="true" aria-label="Filters and sort">
        <div class="msheet-head">
          <button class="iconbtn" id="fsBack" aria-label="Back" hidden>${ICON.back}</button>
          <span id="fsTitle">Filters &amp; sort</span>
          <button class="iconbtn" id="fsX" aria-label="Close">${ICON.x}</button>
        </div>
        <div class="msheet-body" id="fsBody"></div>
        <div class="fs-foot">
          <button class="ghost" id="fsClear">Clear all</button>
          <button class="primary" id="fsShow"></button>
        </div>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    const release = trapFocus(el);
    const bodyEl = el.querySelector("#fsBody");
    const titleEl = el.querySelector("#fsTitle");
    const backBtn = el.querySelector("#fsBack");
    const showBtn = el.querySelector("#fsShow");
    const setFilterBody = (html) => {
      bodyEl.innerHTML = html;
      requestAnimationFrame(() => { bodyEl.scrollTop = 0; });
    };

    const close = () => { document.removeEventListener("keydown", onKey); release(); el.classList.remove("open"); setTimeout(() => el.remove(), 200); };
    let currentBack = null; // where the head back-button goes (null = at master)
    const onKey = (e) => { if (e.key === "Escape" && isTopOverlay(el)) (currentBack ? currentBack() : close()); };
    document.addEventListener("keydown", onKey);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
    el.querySelector("#fsX").onclick = close;
    el.querySelector("#fsClear").onclick = () => { clearAllFilters(); showMaster(); };
    showBtn.onclick = close;

    const refreshShow = () => { const n = matchCount(); showBtn.textContent = `Show ${n} result${n === 1 ? "" : "s"}`; };
    // Apply changes to the grid behind the sheet, then refresh the footer count.
    const apply = () => { draw(); pills(); refreshShow(); };

    // Navigate into a detail view (sets the head back-target).
    function go(renderFn, backFn) { currentBack = backFn; backBtn.hidden = false; renderFn(); }
    backBtn.onclick = () => (currentBack ? currentBack() : showMaster());

    const rowLink = (id, label, val) =>
      `<button class="fs-link" data-go="${esc(id)}"><span class="fs-label">${esc(label)}</span><span class="fs-val">${esc(val)} ›</span></button>`;
    const optRow = (attrs, label, on, n) =>
      `<button class="fs-opt${on ? " on" : ""}" ${attrs}>${
        n === undefined
          ? `<span class="fs-opt-label">${esc(label)}</span>${on ? '<span class="fs-check">✓</span>' : ""}`
          : `<span class="fs-check-box${on ? " on" : ""}">${on ? "✓" : ""}</span><span class="fs-opt-label">${esc(label)}</span><span class="fs-opt-n">${n}</span>`
      }</button>`;

    const smartViews = () => smartViewDefs();

    function applySheetSmartView(id) {
      applySmartView(id);
      refreshShow();
      showMaster();
    }

    // ---- MASTER list ----
    function showMaster() {
      currentBack = null; backBtn.hidden = true; titleEl.textContent = "Filters & sort";
      let html = `<div class="sheet-sec">Smart views</div><div class="fs-list">${smartViews().map((v) =>
        `<button class="fs-opt${v.on ? " on" : ""}" data-smart="${esc(v.id)}"><span class="fs-opt-label">${esc(v.label)}</span><span class="fs-opt-n">${esc(Number(v.count || 0).toLocaleString())}</span></button>`).join("")}</div>`;
      html += `<div class="fs-list">${rowLink("sort", "Sort", SORTS.find((s) => s.v === sortBy)?.label || "Newest")}</div>`;
      html += `<div class="fs-list">`;
      for (const k of PRIMARY) if (facetByKey[k]) html += rowLink("facet:" + k, facetByKey[k].label, facetSummary(facetByKey[k]));
      html += rowLink("price", "Price", priceLabel());
      html += rowLink("date", "Added", dateLabel());
      html += `</div>`;
      if (moreFacets.length) html += `<div class="fs-list">${rowLink("more", "More filters", moreSummary())}</div>`;
      if (!isRailwayCatalogMode) {
        html += `<div class="fs-list">${rowLink("saved", "Saved views", savedViews.length ? `${savedViews.length}` : "None")}</div>`;
      }
      setFilterBody(html);
      refreshShow();
    }

    // ---- SORT detail (single choice) ----
    function showSort() {
      titleEl.textContent = "Sort";
      setFilterBody(`<div class="fs-list">${SORTS.map((s) =>
        optRow(`data-sort="${s.v}"`, s.label, sortBy === s.v)).join("")}</div>`);
    }

    // ---- PRICE detail ----
    // "No price yet" is the pricing to-do filter (pricing gates approval, so
    // finding the unpriced is a first-class job). It's mutually exclusive with
    // a range — a range can only match priced items — so the inputs disable.
    function showPrice() {
      titleEl.textContent = "Price";
      setFilterBody(`<div class="fs-detail">
        <div class="fs-list" style="margin-bottom:10px">${optRow("data-noprice", "Only items without a price", noPrice)}</div>
        <label class="cm-label" for="fsMin">Minimum price</label>
        <input id="fsMin" class="rng" type="text" inputmode="numeric" data-price-input autocomplete="off" placeholder="No minimum" value="${esc(priceMin)}"${noPrice ? " disabled" : ""}>
        <label class="cm-label" for="fsMax">Maximum price</label>
        <input id="fsMax" class="rng" type="text" inputmode="numeric" data-price-input autocomplete="off" placeholder="No maximum" value="${esc(priceMax)}"${noPrice ? " disabled" : ""}>
      </div>`);
      bodyEl.querySelectorAll("[data-price-input]").forEach((input) => bindPriceInput(input));
      if (!noPrice) requestAnimationFrame(() => bodyEl.querySelector("#fsMin")?.focus());
    }

    // ---- ADDED (date) detail (single choice) ----
    function showDate() {
      titleEl.textContent = "Added";
      setFilterBody(`<div class="fs-list">${DATE_FILTERS.map((d) =>
        optRow(`data-dt="${d.v}"`, d.label, datePreset === d.v)).join("")}</div>`);
    }

    // ---- MORE filters: list of the remaining facets ----
    function showMore() {
      titleEl.textContent = "More filters";
      setFilterBody(`<div class="fs-list">${moreFacets.map((f) =>
        rowLink("facet:" + f.key, f.label, facetSummary(f))).join("")}</div>`);
    }

    // ---- FACET detail (multi-select checklist with live counts) ----
    let curFacet = null;
    function renderFacet() {
      const f = curFacet;
      const sel = active[f.key];
      const ff = facetFilter[f.key] || "";
      const base = data.filter((it) => matches(it, f.key));
      const counts = {};
      for (const it of base) { const v = valueOf(it, f.key); if (v) counts[v] = (counts[v] || 0) + 1; }
      const rows = f.values.map((v) => {
        const on = sel?.has(v); const n = counts[v] || 0;
        if (n === 0 && !on) return "";
        if (ff && !v.toLowerCase().includes(ff)) return "";
        return optRow(`data-facet="${esc(f.key)}" data-val="${esc(v)}"`, v, on, n);
      }).join("");
      const search = f.values.length > 8
        ? `<input class="facet-filter" type="search" placeholder="Search ${esc(f.label.toLowerCase())}…" value="${esc(ff)}">`
        : "";
      setFilterBody(`<div class="fs-detail">${search}<div class="fs-list">${rows || `<div class="muted" style="padding:14px">No matches.</div>`}</div></div>`);
    }
    function showFacet(f, backFn) { curFacet = f; titleEl.textContent = f.label; go(renderFacet, backFn); }

    // ---- SAVED VIEWS detail ----
    function showSaved() {
      titleEl.textContent = "Saved views";
      const list = savedViews.length
        ? savedViews.map((v) => `<div class="fs-opt sv-row" data-apply="${v.id}">
            <span class="fs-opt-label">${esc(v.name)}</span>
            <button class="sx" data-del="${v.id}" aria-label="Delete view">${ICON.x}</button></div>`).join("")
        : `<div class="muted" style="padding:14px">No saved views yet.</div>`;
      setFilterBody(`<div class="fs-detail">
        <div class="fs-list">${list}</div>
        <button class="ghost" id="fsSaveView" style="margin-top:12px">★ Save current view</button>
      </div>`);
    }

    // ---- one delegated click handler for the whole sheet body ----
    bodyEl.addEventListener("click", async (e) => {
      const nav = e.target.closest("[data-go]");
      const smart = e.target.closest("[data-smart]");
      if (smart) { applySheetSmartView(smart.dataset.smart); return; }
      if (nav) {
        const id = nav.dataset.go;
        if (id === "sort") go(showSort, showMaster);
        else if (id === "price") go(showPrice, showMaster);
        else if (id === "date") go(showDate, showMaster);
        else if (id === "more") go(showMore, showMaster);
        else if (id === "saved") go(showSaved, showMaster);
        else if (id.startsWith("facet:")) {
          const f = facetByKey[id.slice(6)];
          if (f) showFacet(f, PRIMARY.includes(f.key) ? showMaster : showMore);
        }
        return;
      }
      const sort = e.target.closest("[data-sort]");
      if (sort) { sortBy = sort.dataset.sort; apply(); showMaster(); return; }
      const np = e.target.closest("[data-noprice]");
      if (np) {
        noPrice = !noPrice;
        if (noPrice) { priceMin = ""; priceMax = ""; } // a range can't match unpriced items
        apply(); showPrice();
        return;
      }
      const dt = e.target.closest("[data-dt]");
      if (dt) { datePreset = dt.dataset.dt; apply(); showMaster(); return; }
      const chip = e.target.closest("[data-facet][data-val]");
      if (chip) {
        const k = chip.dataset.facet, v = chip.dataset.val;
        (active[k] = active[k] || new Set()).has(v) ? active[k].delete(v) : active[k].add(v);
        if (!active[k].size) delete active[k];
        // Update the tapped row in place — this list's counts ignore the
        // facet's own selection (excludeKey), so nothing else changes, and a
        // full renderFacet() would reset the list's scroll position.
        const on = !!active[k]?.has(v);
        chip.classList.toggle("on", on);
        const box = chip.querySelector(".fs-check-box");
        box.classList.toggle("on", on);
        box.textContent = on ? "✓" : "";
        apply();
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        const v = savedViews.find((x) => x.id === del.dataset.del);
        const ok = await confirmSheet({ title: "Delete saved view?", message: v ? `“${v.name}” will be removed from all your devices.` : "", confirmText: "Delete", danger: true });
        if (!ok) return;
        const { error } = await supabase.from("saved_views").delete().eq("id", del.dataset.del);
        if (error) { toast("Couldn't delete view: " + error.message); return; }
        savedViews = savedViews.filter((x) => x.id !== del.dataset.del);
        galleryPayload.savedViews = savedViews;
        renderSmartShelves();
        showSaved(); toast("View deleted");
        return;
      }
      const applyV = e.target.closest("[data-apply]");
      if (applyV) {
        const v = savedViews.find((x) => x.id === applyV.dataset.apply);
        if (!v) return;
        const p = v.payload || {};
        for (const k in active) delete active[k];
        for (const k in (p.active || {})) if (facetByKey[k]) active[k] = new Set(p.active[k]);
        q = p.q || ""; if (qEl) qEl.value = q;
        sortBy = p.sortBy && SORTS.some((s) => s.v === p.sortBy) ? p.sortBy : "new";
        priceMin = p.priceMin || ""; priceMax = p.priceMax || ""; noPrice = !!p.noPrice; datePreset = p.datePreset || "all";
        apply(); showMaster(); toast(`Applied “${v.name}”`);
        return;
      }
      if (e.target.closest("#fsSaveView")) {
        const name = await promptSheet({ title: "Save this view", label: "View name", placeholder: "e.g. Low stock, New arrivals", confirmText: "Save view" });
        if (!name) return;
        const serial = {};
        for (const k in active) if (active[k]?.size) serial[k] = [...active[k]];
        const payload = { active: serial, q, sortBy, priceMin, priceMax, noPrice, datePreset };
        const { data: created, error } = await supabase.from("saved_views").insert({ name, payload }).select("id, name, payload").single();
        if (error) { toast("Couldn't save view: " + error.message); return; }
        savedViews.push(created);
        galleryPayload.savedViews = savedViews;
        renderSmartShelves();
        showSaved(); toast("View saved");
      }
    });

    // price + facet-search inputs (delegated). The price fields live-apply, but
    // debounced — typing "1500" shouldn't redraw the grid four times.
    let priceTimer;
    const applyDebounced = () => { clearTimeout(priceTimer); priceTimer = setTimeout(apply, 200); };
    bodyEl.addEventListener("input", (e) => {
      if (e.target.id === "fsMin") { priceMin = stripPriceGrouping(e.target.value); applyDebounced(); }
      else if (e.target.id === "fsMax") { priceMax = stripPriceGrouping(e.target.value); applyDebounced(); }
      else if (e.target.classList.contains("facet-filter") && curFacet) {
        facetFilter[curFacet.key] = e.target.value.trim().toLowerCase();
        renderFacet();
        const again = bodyEl.querySelector(".facet-filter");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      }
    });

    showMaster();
  }

  // ---- wiring: top bar ----
  // Debounced lightly: the incremental reconciler (reconcileGrid) makes a redraw
  // cheap now, so a short 80ms debounce just coalesces fast keystrokes without a
  // perceptible lag — search feels near-instant.
  let qTimer;
  qEl.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { q = qEl.value.trim().toLowerCase(); draw(); }, 80);
  });
  view.querySelector("#filterBtn").onclick = openFilters;
  const selectBtn = view.querySelector("#selectBtn");
  if (selectBtn) selectBtn.onclick = enterSelection;

  // Toggle the card-grid vs scan-list density. Updates the button's own icon +
  // label in place, then redraws the results in the new layout.
  const densityBtn = view.querySelector("#densityBtn");
  if (densityBtn) densityBtn.onclick = () => {
    density = density === "list" ? "grid" : "list";
    densityBtn.innerHTML = density === "list" ? ICON.grid : ICON.rows;
    densityBtn.setAttribute("aria-label", density === "list" ? "Switch to grid view" : "Switch to list view");
    draw();
  };

  // Bulk-edit common fields across the selection. Only the fields you fill are
  // applied; category-specific fields appear when the whole selection is one
  // category. Cost is gated by can_view_cost.
  function openBulkEdit() {
    if (!selected.size) return;
    const ids = [...selected];
    const items = ids.map((id) => byId[id]).filter(Boolean);
    const cats = new Set(items.map((it) => it.category_id));
    const sameCat = cats.size === 1 ? [...cats][0] : null;
    const catFields = sameCat ? resolveFields(sameCat) : [];
    const canCost = !!caps.can_view_cost;
    const UNCH = "— unchanged —";

    let body = `
      <div class="be-note muted">Only the fields you fill are applied to the ${ids.length} selected item${ids.length === 1 ? "" : "s"}.</div>
      <div class="cm-label">Status</div>
      <select id="be-status"><option value="">${UNCH}</option>${STATUS_OPTIONS.filter((s) => s !== "approved").map((s) => `<option value="${s}">${esc(statusLabel(s))}</option>`).join("")}</select>
      <div class="cm-label">Brand</div>
      <input id="be-brand" list="dl-brand" placeholder="${UNCH}">
      <datalist id="dl-brand">${vocabSuggestions("brand").map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
      <div class="cm-label">Retail price</div>
      <input id="be-price" type="text" inputmode="decimal" data-price-input autocomplete="off" placeholder="${UNCH}">
      ${canCost ? `<div class="cm-label">Cost price</div><input id="be-cost" type="text" inputmode="decimal" data-price-input autocomplete="off" placeholder="${UNCH}">` : ""}
      <div class="cm-label">Stock quantity</div>
      <input id="be-stock" type="number" inputmode="numeric" placeholder="${UNCH}">
      <div class="cm-label">Reorder level</div>
      <input id="be-reorder" type="number" inputmode="numeric" placeholder="${UNCH}">`;

    if (sameCat && catFields.length) {
      body += `<div class="sheet-sec">${esc(categoryPath(sameCat))} fields</div>`;
      for (const f of catFields) {
        body += `<div class="cm-label">${esc(f.label)}</div>`;
        if (f.type === "select" && Array.isArray(f.options) && f.options.length) {
          body += `<select class="be-attr" data-key="${esc(f.key)}" data-type="${esc(f.type)}" data-vocab="${esc(f.vocab || "")}"><option value="">${UNCH}</option>${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;
        } else {
          const t = f.type === "number" ? "number" : "text";
          const dl = f.vocab ? ` list="be-dl-${esc(f.vocab)}"` : "";
          body += `<input class="be-attr" data-key="${esc(f.key)}" data-type="${esc(f.type)}" data-vocab="${esc(f.vocab || "")}" type="${t}"${dl} placeholder="${UNCH}">`;
          if (f.vocab) body += `<datalist id="be-dl-${esc(f.vocab)}">${vocabSuggestions(f.vocab).map((o) => `<option value="${esc(o)}">`).join("")}</datalist>`;
        }
      }
    } else if (cats.size > 1) {
      body += `<div class="be-note muted">Category-specific fields are hidden because the selection spans multiple categories.</div>`;
    }
    body += `<button class="primary up-go" id="be-apply">Apply to ${ids.length} item${ids.length === 1 ? "" : "s"}</button>`;

    const sh = openBottomSheet("Edit selected", body);
    sh.body.querySelectorAll("[data-price-input]").forEach((input) => bindPriceInput(input));
    sh.body.querySelector("#be-apply").onclick = async () => {
      const col = {};
      const st = sh.body.querySelector("#be-status").value;
      if (st) col.status = st;
      const brand = sh.body.querySelector("#be-brand").value.trim();
      if (brand) col.brand = normalizeValue("brand", brand);
      const priceRaw = sh.body.querySelector("#be-price").value.trim();
      const price = parsePrice(priceRaw);
      if (priceRaw !== "" && price === null) { toast("Enter a valid retail price."); return; }
      if (price !== null) col.price = price;
      const stock = sh.body.querySelector("#be-stock").value.trim();
      if (stock !== "") col.stock_quantity = Number(stock);
      const reorder = sh.body.querySelector("#be-reorder").value.trim();
      if (reorder !== "") col.reorder_level = Number(reorder);
      const costEl = sh.body.querySelector("#be-cost");
      const costRaw = costEl?.value.trim() || "";
      const costParsed = parsePrice(costRaw);
      if (costRaw !== "" && costParsed === null) { toast("Enter a valid cost price."); return; }
      const costVal = costRaw !== "" ? costParsed : undefined;

      const attrChanges = {};
      sh.body.querySelectorAll(".be-attr").forEach((el) => {
        let v = el.value.trim();
        if (v === "") return;
        if (el.dataset.vocab) v = normalizeValue(el.dataset.vocab, v);
        v = normalizeAttributeValue(sameCat, el.dataset.key, v);
        attrChanges[el.dataset.key] = el.dataset.type === "number" ? Number(v) : v;
      });

      if (!Object.keys(col).length && costVal === undefined && !Object.keys(attrChanges).length) {
        toast("Enter at least one field to apply."); return;
      }
      const changesByItem = new Map();
      for (const it of items) {
        const after = { ...it, ...col };
        if (Object.keys(attrChanges).length) {
          after.attributes = { ...(it.attributes || {}), ...attrChanges };
        }
        const changes = diffItemValues(it, after);
        if (costVal !== undefined) changes.push({ field_path: "cost_price", before: null, after: costVal });
        if (changes.length) changesByItem.set(it.id, changes);
      }

      // Snapshot prior state so the edit is reversible (Undo). We capture the
      // exact prior column values + attributes object per item, plus prior cost
      // rows (read before the upsert), so Undo restores cleanly.
      const priorCost = new Map();
      if (costVal !== undefined) {
        const { data: pc } = await supabase.from("item_costs").select("item_id, cost_price").in("item_id", ids);
        for (const r of pc || []) priorCost.set(r.item_id, r.cost_price);
      }
      const colKeys = Object.keys(col);
      const attrKeys = Object.keys(attrChanges);
      const editUndoSnapshot = items.map((it) => ({
        id: it.id,
        col: Object.fromEntries(colKeys.map((k) => [k, it[k] ?? null])),
        attributes: it.attributes ? { ...it.attributes } : {},
        cost: priorCost.has(it.id) ? priorCost.get(it.id) : undefined,
      }));
      sh.close();
      try {
        if (Object.keys(col).length) {
          const { error } = await supabase.from("items").update(col).in("id", ids);
          if (error) throw error;
        }
        if (costVal !== undefined) {
          const { error } = await supabase.from("item_costs")
            .upsert(ids.map((id) => ({ item_id: id, cost_price: costVal })), { onConflict: "item_id" });
          if (error) throw error;
        }
        // jsonb attributes merge per item, so they can't be one atomic update
        // like the columns. Collect per-item failures instead of aborting
        // mid-batch (R2) — a blip on item N would otherwise leave a silent
        // partial write the all-or-nothing Undo can't honestly describe.
        const attrFailed = [];
        if (Object.keys(attrChanges).length) {
          for (const it of items) {
            const merged = { ...(it.attributes || {}), ...attrChanges };
            const { error } = await supabase.from("items").update({ attributes: merged }).eq("id", it.id);
            if (error) { console.error("bulk attr update failed", it.id, error); attrFailed.push(it.id); }
          }
        }
        await logManyItemActivities(ids, "bulk_edit", "bulk", changesByItem, "Bulk edited selected items");
        navigator.vibrate?.([12, 40, 12]);
        const okCount = ids.length - attrFailed.length;
        const doneMsg = attrFailed.length
          ? `Updated ${okCount} of ${ids.length} — ${attrFailed.length} attribute update${attrFailed.length === 1 ? "" : "s"} failed, retry`
          : `Updated ${ids.length} item${ids.length === 1 ? "" : "s"}`;
        toast(doneMsg, {
          label: "Undo",
          onClick: async () => {
            try {
              // Restore prior columns + (if attributes changed) the exact prior
              // attributes object per item, cleanly removing any added keys.
              for (const s of editUndoSnapshot) {
                const upd = { ...s.col };
                if (attrKeys.length) upd.attributes = s.attributes;
                if (Object.keys(upd).length) {
                  const { error: uErr } = await supabase.from("items").update(upd).eq("id", s.id);
                  if (uErr) throw uErr;
                }
              }
              if (costVal !== undefined) {
                const noPrior = editUndoSnapshot.filter((s) => s.cost == null).map((s) => s.id);
                const hadPrior = editUndoSnapshot.filter((s) => s.cost != null);
                if (noPrior.length) await supabase.from("item_costs").delete().in("item_id", noPrior);
                if (hadPrior.length) await supabase.from("item_costs")
                  .upsert(hadPrior.map((s) => ({ item_id: s.id, cost_price: s.cost })), { onConflict: "item_id" });
              }
              const undoChanges = new Map([...changesByItem].map(([id, arr]) =>
                [id, arr.map((c) => ({ field_path: c.field_path, before: c.after, after: c.before }))]));
              await logManyItemActivities(ids, "undo", "undo", undoChanges, "Undid bulk edit");
              toast("Bulk edit undone");
              refresh();
            } catch (e) {
              toast("Undo failed: " + (e.message || e));
            }
          },
        });
      } catch (e) {
        toast("Bulk edit failed: " + (e.message || e));
      }
      refresh();
    };
  }

  // One-tap bulk approve for the current selection. Approving is fully
  // reversible, so instead of a confirm-tap on every batch we apply immediately
  // and offer a 5-second Undo that restores each item's prior status (items may
  // have been needs-review, draft, or flag, so we snapshot per item).
  async function approveSelected() {
    if (!selected.size) return;
    await approveItems([...selected]);
  }

  async function writeConfidenceRows(rows, valueKey) {
    let cursor = 0;
    const successful = [];
    const failed = [];
    const workers = Array.from({ length: Math.min(6, rows.length) }, async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        const { error } = await supabase.from("items").update({ confidence: row[valueKey] }).eq("id", row.id);
        if (error) failed.push({ row, error });
        else successful.push(row);
      }
    });
    await Promise.all(workers);
    return { successful, failed };
  }

  async function verifySelected() {
    if (!selected.size) return;
    const chosen = [...selected].map((id) => byId[id]).filter(Boolean);
    const eligible = chosen.filter((it) => verificationRiskOf(it).bulkEligible);
    const skipped = chosen.length - eligible.length;
    if (!eligible.length) {
      toast("No selected items are quick checks. Critical and recent-edit items need an individual decision.");
      return;
    }
    const ok = await confirmSheet({
      title: `Verify ${eligible.length} quick check${eligible.length === 1 ? "" : "s"}?`,
      message: `Use this after scanning the photos and highlighted values. Only items with one or two Medium-confidence fields will move forward.${skipped ? ` ${skipped} critical or recent-edit item${skipped === 1 ? " is" : "s are"} excluded.` : ""} This does not approve anything.`,
      confirmText: `Verify ${eligible.length}`,
      cancelText: "Keep reviewing",
    });
    if (!ok) return;

    const rows = eligible.map((it) => {
      const before = { ...(it.confidence || {}) };
      const after = { ...before };
      aiDoubtFields(it).forEach(({ key }) => { after[key] = "High"; });
      return { id: it.id, before, after };
    });
    const { successful, failed } = await writeConfidenceRows(rows, "after");
    if (!successful.length) {
      toast(`Bulk verify failed: ${failed[0]?.error?.message || "check connection"}`);
      return;
    }

    const changes = new Map();
    successful.forEach((row) => {
      if (byId[row.id]) byId[row.id].confidence = row.after;
      changes.set(row.id, Object.keys(row.after)
        .filter((key) => row.before[key] !== row.after[key])
        .map((key) => ({ field_path: `confidence.${key}`, before: row.before[key] || null, after: row.after[key] })));
    });
    await logManyItemActivities(
      successful.map((row) => row.id),
      "verification",
      "manual",
      changes,
      "Bulk verified Medium-confidence fields"
    );
    if (selectionMode) exitSelection();
    draw();
    navigator.vibrate?.([12, 40, 12]);
    const failureNote = failed.length ? `; ${failed.length} failed` : "";
    toast(`Verified ${successful.length} quick check${successful.length === 1 ? "" : "s"}${failureNote}`, {
      label: "Undo",
      onClick: async () => {
        const undo = await writeConfidenceRows(successful, "before");
        undo.successful.forEach((row) => { if (byId[row.id]) byId[row.id].confidence = row.before; });
        await logManyItemActivities(
          undo.successful.map((row) => row.id),
          "undo",
          "undo",
          new Map(),
          "Undid bulk verification"
        );
        draw();
        toast(undo.failed.length ? `Undo restored ${undo.successful.length}; ${undo.failed.length} failed` : "Bulk verification undone");
      },
    });
  }
  // The shared approve core — used by the selection bar AND the Ready
  // segment's "Approve all" (identical guard/Undo semantics either way).
  async function approveItems(ids) {
    if (!ids.length) return;
    // No price ⇒ not sellable ⇒ can't be approved. Approve the priced ones and
    // report how many were skipped, rather than blocking the whole batch.
    const items = ids.map((id) => byId[id]).filter(Boolean);
    const summary = approvalSummary(items, { canViewCost: !!caps.can_view_cost });
    const approveIds = summary.approvable.map(({ item }) => item.id);
    const blockedN = summary.blocked.length;
    if (!approveIds.length) {
      const reasons = approvalReasonText(summary.blocked) || "not ready";
      const hasPriceBlocker = summary.blocked.some(({ readiness }) =>
        readiness.blockers.some((b) => b.issue === "price")
      );
      const action = hasPriceBlocker
        ? { label: "Price items", onClick: () => { if (selectionMode) exitSelection(); openGuidedPricing(caps, refresh, { itemIds: ids }); } }
        : null;
      toast(`Can't approve: ${reasons}.`, action);
      return;
    }
    if (blockedN) {
      const reasons = approvalReasonText(summary.blocked) || "not ready";
      const ok = await confirmSheet({
        title: "Approve ready items?",
        message: `${approveIds.length} item${approveIds.length === 1 ? "" : "s"} can be approved. ${blockedN} will stay in Review: ${reasons}.`,
        confirmText: `Approve ${approveIds.length}`,
        cancelText: "Cancel",
      });
      if (!ok) return;
    }

    if (!(await confirmApprovalSummaryWarnings(summary))) return;

    const prior = approveIds.map((id) => ({ id, status: byId[id]?.status }));
    const { error } = await supabase.from("items").update({ status: "approved" }).in("id", approveIds);
    if (error) { toast("Approve failed: " + error.message); return; }
    // Optimistic: the write already succeeded, so reflect it locally and redraw
    // at once (no full network re-fetch). The activity log is fire-and-forget so
    // it never sits on the critical path between the tap and the UI updating.
    for (const id of approveIds) if (byId[id]) byId[id].status = "approved";
    navigator.vibrate?.([12, 40, 12]);
    if (selectionMode) exitSelection();
    draw();
    logManyItemActivities(
      approveIds,
      "approval",
      "approval",
      new Map(prior.map((p) => [p.id, [{ field_path: "status", before: p.status, after: "approved" }]])),
      "Approved from Review"
    ).catch(() => {});
    const msg = blockedN
      ? `Approved ${approveIds.length}; ${blockedN} left in Review`
      : `Approved ${approveIds.length} item${approveIds.length === 1 ? "" : "s"}`;
    toast(msg, {
      label: "Undo",
      onClick: async () => {
        // One write per distinct prior status (not per item) — undoing a big
        // batch used to fire a request per item, painfully slow on shop Wi-Fi.
        const byStatus = {};
        for (const p of prior) if (p.status) (byStatus[p.status] ||= []).push(p.id);
        for (const [st, sids] of Object.entries(byStatus)) {
          const { error: uErr } = await supabase.from("items").update({ status: st }).in("id", sids);
          if (uErr) { toast("Undo failed: " + uErr.message); return; }
        }
        for (const p of prior) if (byId[p.id]) byId[p.id].status = p.status;
        draw();
        logManyItemActivities(
          approveIds,
          "undo",
          "undo",
          new Map(prior.map((p) => [p.id, [{ field_path: "status", before: "approved", after: p.status }]])),
          "Undid approval"
        ).catch(() => {});
        toast("Approval undone");
      },
    });
  }

  // ---- wiring: selection header + action bar ----
  if (canEdit) {
    view.querySelector("#selExit").onclick = exitSelection;
    view.querySelector("#abDone").onclick = exitSelection; // exit from the bottom too
    view.querySelector("#selAll").onclick = () => {
      for (const it of filtered) selected.add(it.id);
      grid.querySelectorAll(".card[data-id]").forEach((c) => c.classList.add("selected"));
      updateSelBar();
    };
    view.querySelector("#abApprove").onclick = review && reviewStage === "verify" ? verifySelected : approveSelected;
    view.querySelector("#abAi").onclick = () => {
      if (!selected.size) return;
      const items = [...selected].map((id) => byId[id]).filter(Boolean);
      openBulkAi(items, caps, refresh);
    };
    view.querySelector("#abEdit").onclick = openBulkEdit;
    view.querySelector("#abMore").onclick = () => {
      if (!selected.size) return;
      const body = `
        <button class="menu-item" data-pricesel>Price ${selected.size} selected item${selected.size === 1 ? "" : "s"}…</button>
        <button class="menu-item" data-clearsel>Clear selection</button>
        ${canDelete ? `<button class="menu-item danger" data-del>Delete ${selected.size} item(s)</button>` : ""}`;
      const sh = openBottomSheet("More actions", body);
      sh.body.addEventListener("click", async (e) => {
        if (e.target.closest("[data-pricesel]")) {
          const ids = [...selected];
          sh.close();
          exitSelection();
          openGuidedPricing(caps, refresh, { itemIds: ids });
          return;
        }
        if (e.target.closest("[data-clearsel]")) { sh.close(); clearSel(); return; }
        if (e.target.closest("[data-del]")) {
          const ids = [...selected];
          // Deletion rule: pushed items' POS products are never deleted from
          // here (sales history) — only the catalog records/photos go.
          const inShop = ids.filter((id) => byId[id]?.pos_sync_status === "synced").length;
          const warn = inShop
            ? `The selected items and their photos will be permanently deleted. ${inShop} of them ${inShop === 1 ? "is" : "are"} in the shop — the POS products and their stock are NOT touched; adjust stock in the POS if units physically left.`
            : "The selected items and their photos will be permanently deleted. This cannot be undone.";
          // Deleting is irreversible. For a single item a red confirm is enough;
          // for 2+ items require the word DELETE to be typed so a stray tap can't
          // wipe a whole batch (there is no Undo for a hard delete).
          if (ids.length >= 2) {
            const typed = await promptSheet({
              title: `Delete ${ids.length} items?`,
              message: warn,
              label: "Type DELETE to confirm",
              placeholder: "DELETE",
              confirmText: "Delete permanently",
            });
            if (typed === null) return;
            if (typed.trim().toUpperCase() !== "DELETE") { toast("Not deleted — you didn't type DELETE."); return; }
          } else {
            const ok = await confirmSheet({
              title: "Delete 1 item?",
              message: warn,
              confirmText: "Delete",
              danger: true,
            });
            if (!ok) return;
          }
          sh.close();
          const paths = ids.map((id) => byId[id]?.image_path).filter(Boolean);
          const { error } = await supabase.from("items").delete().in("id", ids);
          if (error) { toast("Delete failed: " + error.message); return; }
          if (paths.length) await supabase.storage.from("product-images").remove(paths);
          toast(`Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}`);
          refresh();
        }
      });
    };
  }

  // Esc exits selection mode (the lightbox handles its own Esc). Replace any
  // prior handler so listeners don't accumulate across re-renders.
  if (_galEsc) document.removeEventListener("keydown", _galEsc);
  // Esc exits selection — but not while a sheet/dialog is open (it owns Esc then).
  _galEsc = (e) => { if (e.key === "Escape" && selectionMode && !anyOverlayOpen()) exitSelection(); };
  document.addEventListener("keydown", _galEsc);

  draw();
  pills();
}

async function renderToday(view, caps, actions = {}) {
  const mySeq = ++renderTodaySeq;
  const appNav = document.querySelector(".bottomnav");
  if (appNav) appNav.style.display = "";
  view.innerHTML = `
    <div class="today-wrap">
      <section class="today-hero">
        <div>
          <div class="today-kicker">Operations</div>
          <h2>Today</h2>
          <p>Intake, review, pricing, and shop sync in one working surface.</p>
        </div>
        <div class="today-loading" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
      </section>
      <div class="today-grid">
        <div class="today-skel"></div><div class="today-skel"></div>
        <div class="today-skel"></div><div class="today-skel"></div>
      </div>
    </div>`;

  let galleryPayload;
  try {
    galleryPayload = await loadGalleryPayload(caps);
  } catch (error) {
    if (mySeq !== renderTodaySeq) return;
    view.innerHTML = `<div class="empty"><div class="big">!</div>
      <div>Couldn't load today's overview.</div>
      <div style="color:var(--muted);font-size:13px">${esc(error.message || error)}</div></div>`;
    return;
  }
  if (mySeq !== renderTodaySeq) return;

  const rows = galleryPayload.data || [];
  const syncCounts = galleryPayload.syncCounts || {};
  const posMirror = galleryPayload.posMirror || {};
  const byVariant = posMirror.byVariant instanceof Map ? posMirror.byVariant : new Map();
  const reviewCount = rows.filter((it) => needsReviewItem(it) || readyItem(it) || queueMatches(it, "edited")).length;
  const freshness = todayFreshness(posMirror.lastMirror);
  const freshnessNeedsWork = freshness.cls === "warn" || freshness.cls === "bad";
  const shopIssueCount = (syncCounts.errors || 0) + (syncCounts.dirty || 0) + (freshnessNeedsWork ? 1 : 0);
  let issueCounts = {};
  setReviewBadge(reviewCount);
  setShopBadge(shopIssueCount);

  if (!rows.length) {
    view.innerHTML = `
      <div class="today-wrap">
        <section class="today-hero">
          <div>
            <div class="today-kicker">Operations</div>
            <h2>Today</h2>
            <p>No inventory is loaded yet.</p>
          </div>
          <div class="today-hero-actions">
            ${caps.can_upload ? `<button class="primary" data-today-action="add">Add photos</button>` : ""}
            <button class="ghost" data-today-action="catalog">Open catalog</button>
          </div>
        </section>
      </div>`;
    bindTodayActions();
    return;
  }

  issueCounts = Object.fromEntries(REVIEW_QUEUE.map((key) => [
    key,
    rows.filter((it) => queueMatches(it, key)).length,
  ]));
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const intakeToday = rows.filter((it) => it.created_at && new Date(it.created_at) >= todayStart).length;
  const intakeWeek = rows.filter((it) => it.created_at && new Date(it.created_at) >= weekStart).length;
  const mirrorOf = (it) => (it.pos_variant_id ? byVariant.get(it.pos_variant_id) : undefined);
  const shopStateOf = (it) => libShopState(it, mirrorOf);
  const shopStates = rows.map(shopStateOf);
  const inShop = shopStates.filter((st) => ["In shop", "Low stock", "Sold out"].includes(st)).length;
  const lowStock = shopStates.filter((st) => st === "Low stock").length;
  const queued = shopStates.filter((st) => st === "Queued").length;
  const syncErrors = shopStates.filter((st) => st === "Sync error").length;
  const mirrorRows = [...byVariant.values()];
  const soldToday = mirrorRows.reduce((sum, row) => sum + Number(row.units_sold_today || row.sold_today || 0), 0);
  const soldWeek = mirrorRows.reduce((sum, row) => sum + Number(row.units_sold_7d || row.sold_7d || row.units_sold_week || 0), 0);
  const aiChecks = (issueCounts.doubt || 0) + (issueCounts.ai || 0);
  const missingRetail = rows.filter((it) => it.price == null).length;
  const missingCost = caps.can_view_cost ? rows.filter((it) => it.has_cost_price === false).length : 0;
  const priceSub = caps.can_view_cost && missingCost
    ? `${missingRetail.toLocaleString()} missing retail, ${missingCost.toLocaleString()} missing cost`
    : "Items blocked by missing prices";
  const syncSub = freshnessNeedsWork
    ? freshness.text
    : `${Number(syncCounts.queued || 0).toLocaleString()} queued, ${Number(syncCounts.dirty || 0).toLocaleString()} updates, ${Number(syncCounts.errors || 0).toLocaleString()} errors`;

  const photoRows = rows.filter((it) => it.image_path).slice(0, 5);
  const photoUrls = await Promise.all(photoRows.map((it) => signThumb(it.image_path)));
  if (mySeq !== renderTodaySeq) return;

  const activityRows = rows
    .filter((it) => it.activity?.latest_at)
    .sort((a, b) => new Date(b.activity.latest_at) - new Date(a.activity.latest_at))
    .slice(0, 4);
  let suppressTodayClick = false;

  view.innerHTML = `
    <div class="today-wrap">
      <section class="today-hero">
        <div class="today-hero-copy">
          <div class="today-kicker">Operations</div>
          <h2>Today</h2>
          <p>${esc(rows.length.toLocaleString())} catalog item${rows.length === 1 ? "" : "s"} loaded. ${esc(reviewCount.toLocaleString())} item${reviewCount === 1 ? "" : "s"} need${reviewCount === 1 ? "s" : ""} a decision.</p>
        </div>
        <div class="today-hero-actions">
          ${caps.can_upload ? `<button class="primary" data-today-action="add">${ICON.navAdd}<span>New intake</span></button>` : ""}
          <button class="ghost" data-today-action="catalog">${ICON.navGallery}<span>Catalog</span></button>
        </div>
      </section>

      <section class="today-decision-grid" aria-label="Work queues">
        ${todayQueueCard("price", "Price queue", issueCounts.price || 0, priceSub, "price", ICON.navShop)}
        ${todayQueueCard("ai", "AI check", aiChecks, "Confidence, failed fill, and missing AI work", "ai-check", ICON.sparkle)}
        ${todayQueueCard("ready", "Ready", issueCounts.ready || 0, "Priced items ready to approve", "ready", ICON.tick)}
        ${todayQueueCard("sync", "Shop sync", shopIssueCount, syncSub, "sync", ICON.refresh)}
      </section>

      <section class="today-main">
        <div class="today-panel today-intake">
          <div class="today-panel-head">
            <div>
              <h3>Intake</h3>
              <p>${intakeToday.toLocaleString()} today, ${intakeWeek.toLocaleString()} in the last 7 days</p>
            </div>
            ${caps.can_upload ? `<button class="iconbtn" data-today-action="add" aria-label="Add photos">${ICON.navAdd}</button>` : ""}
          </div>
          <div class="today-strip">
            ${photoRows.length ? photoRows.map((it, i) => todayThumbHtml(it, photoUrls[i])).join("") : `<div class="today-empty-inline">No product photos yet.</div>`}
          </div>
        </div>

        <div class="today-panel today-shop">
          <div class="today-panel-head">
            <div>
              <h3>Shop floor</h3>
              <p class="${freshness.cls}">${esc(freshness.text)}</p>
            </div>
            <button class="iconbtn" data-today-action="shop" aria-label="Open shop">${ICON.navShop}</button>
          </div>
          <div class="today-metrics">
            ${todayMetric("In shop", inShop)}
            ${todayMetric("Sold today", soldToday)}
            ${todayMetric("7 day sold", soldWeek)}
            ${todayMetric("Low stock", lowStock, lowStock ? "warn" : "")}
            ${todayMetric("Queued", queued)}
            ${todayMetric("Errors", Math.max(syncErrors, syncCounts.errors || 0), (syncErrors || syncCounts.errors) ? "bad" : "")}
          </div>
        </div>
      </section>

      <section class="today-panel today-activity">
        <div class="today-panel-head">
          <div>
            <h3>Recent activity</h3>
            <p>Latest catalog changes</p>
          </div>
          <button class="ghost small" data-today-action="activity">Open feed</button>
        </div>
        <div class="today-activity-list">
          ${activityRows.length ? activityRows.map(todayActivityHtml).join("") : `<div class="today-empty-inline">No recent activity.</div>`}
        </div>
      </section>
    </div>`;
  bindTodayActions();

  function bindTodayActions() {
    view.onclick = handleTodayClick;
    bindTodayPreview();
  }

  function handleTodayClick(e) {
    const actionBtn = e.target.closest("[data-today-action]");
    const reviewBtn = e.target.closest("[data-today-review]");
    const openBtn = e.target.closest("[data-today-open]");
    if (suppressTodayClick && reviewBtn) {
      suppressTodayClick = false;
      return;
    }
    if (reviewBtn) {
      const key = reviewBtn.dataset.todayReview;
      if (key === "ai-check") actions.openReviewQueue?.((issueCounts.doubt || 0) ? "doubt" : "ai");
      else if (key === "sync") {
        if (caps.can_manage_users) openSyncCenter(caps, actions.refreshCurrent, { focus: "errors" });
        else actions.setView?.("shop");
      } else {
        actions.openReviewQueue?.(key);
      }
      return;
    }
    if (openBtn) {
      const id = openBtn.dataset.todayOpen;
      openCatalogItem(id, caps, () => actions.refreshCurrent?.());
      return;
    }
    if (!actionBtn) return;
    const action = actionBtn.dataset.todayAction;
    if (action === "add") actions.setView?.("add");
    else if (action === "catalog") actions.setView?.("catalog");
    else if (action === "shop") actions.setView?.("shop");
    else if (action === "activity") openActivityFeed(caps);
  }

  function todayQueueCard(tone, title, count, sub, reviewKey, icon) {
    return `<button class="today-qcard ${tone}" data-today-review="${esc(reviewKey)}"
      data-preview-title="${esc(title)}" data-preview-count="${esc(Number(count || 0).toLocaleString())}" data-preview-detail="${esc(sub)}">
      <span class="today-qico">${icon || ""}</span>
      <span class="today-qcopy"><b>${esc(Number(count || 0).toLocaleString())}</b><span>${esc(title)}</span><small>${esc(sub)}</small></span>
    </button>`;
  }

  function bindTodayPreview() {
    let timer = null, start = null, previewed = false;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const openPreview = (btn, suppressClick = true) => {
      if (!btn) return;
      previewed = true;
      if (suppressClick) {
        suppressTodayClick = true;
        setTimeout(() => { suppressTodayClick = false; }, 900);
      }
      const title = btn.dataset.previewTitle || "Work queue";
      const count = btn.dataset.previewCount || "0";
      const detail = btn.dataset.previewDetail || "";
      const sh = openBottomSheet(title, `
        <div class="today-preview">
          <b>${esc(count)}</b>
          <span>${esc(detail)}</span>
          <button class="primary up-go" data-open-work>Open queue</button>
        </div>`);
      sh.body.querySelector("[data-open-work]").onclick = () => {
        sh.close();
        suppressTodayClick = false;
        handleTodayClick({ target: btn });
      };
    };
    view.querySelectorAll(".today-qcard").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (!suppressTodayClick) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressTodayClick = false;
      }, true);
      btn.addEventListener("contextmenu", (e) => { e.preventDefault(); openPreview(btn, false); });
      btn.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        start = { x: e.clientX, y: e.clientY };
        previewed = false;
        timer = setTimeout(() => openPreview(btn), 520);
      });
      btn.addEventListener("pointermove", (e) => {
        if (!timer || !start) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) clearTimer();
      });
      btn.addEventListener("pointerup", (e) => {
        clearTimer();
        if (previewed) {
          e.preventDefault();
          e.stopPropagation();
        }
      });
      btn.addEventListener("pointercancel", clearTimer);
    });
  }

  function todayThumbHtml(it, url) {
    const title = todayItemTitle(it);
    const sub = [it.categories?.name, it.price != null ? fmtPrice(it.price) : "Missing price"].filter(Boolean).join(" / ");
    return `<button class="today-thumb" data-today-open="${esc(it.id)}" title="${esc(title)}">
      ${url ? `<img src="${esc(url)}" alt="${esc(title)}">` : `<span>No image</span>`}
      <span><b>${esc(title)}</b><small>${esc(sub)}</small></span>
    </button>`;
  }

  function todayActivityHtml(it) {
    const activity = it.activity || {};
    const source = activitySourceLabel(activity.latest_source);
    const cls = activitySourceClass(activity.latest_source);
    const when = activity.latest_at ? new Date(activity.latest_at).toLocaleString() : "";
    const summary = activity.latest_summary || "Updated";
    return `<button class="today-act-row" data-today-open="${esc(it.id)}">
      <span class="source-pill src-${esc(cls)}">${esc(source)}</span>
      <span class="today-act-copy"><b>${esc(todayItemTitle(it))}</b><small>${esc(summary)}</small></span>
      <time>${esc(when)}</time>
    </button>`;
  }
}

function todayMetric(label, value, cls = "") {
  return `<span class="${esc(cls)}"><b>${esc(Number(value || 0).toLocaleString())}</b><small>${esc(label)}</small></span>`;
}

function todayItemTitle(it) {
  return [it.brand, it.name].filter(Boolean).join(" ") || it.sku || "Untitled item";
}

function todayFreshness(lastMirror) {
  if (!lastMirror?.finished_at) return { text: "Shop sync has not run", cls: "warn" };
  const t = new Date(lastMirror.finished_at);
  if (isNaN(t)) return { text: "Shop sync time unavailable", cls: "warn" };
  const mins = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
  const age = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} hr ago`;
  if (lastMirror.ok === false) return { text: `Sync failed ${age}`, cls: "bad" };
  return { text: `Shop data ${age}`, cls: mins > 30 ? "warn" : "" };
}


// The Review tab is the unified browse surface, pre-filtered to triage items
// (flagged / needs-review / low-confidence). Reuses renderGallery with review:true.
function renderReview(view, caps) { return renderGallery(view, caps, { review: true }); }

// Fallback for any unrouted nav id (all current tabs are implemented).
function renderComingSoon(view, id) {
  view.innerHTML = `<div class="empty"><div class="big">🚧</div>
    <div>${esc(id)} is coming soon.</div></div>`;
}

// (The lightbox now lives in ui.js — imported above — so the editor and
// calibration photos can open the same viewer.)
