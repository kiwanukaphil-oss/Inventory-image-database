// Pure readiness/review logic — no DOM, no Supabase, no app-state imports. The
// stateful dependencies (resolved category fields, the AI-blind-field set, the
// job-error help text) are passed IN as parameters so this module stays pure and
// unit-testable (test/readiness.test.js). src/readiness.js is the thin app-facing
// wrapper that injects those dependencies.

export const STATUS_LABELS = {
  draft: "New",
  "needs-review": "Needs review",
  approved: "Approved",
  flag: "Problem",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "";
}

export const STATUS_OPTIONS = ["draft", "needs-review", "approved", "flag"];

export const ISSUE_META = {
  work:    { label: "Needs work", short: "Work", empty: "work", cls: "iss-work", action: "Review" },
  ai:      { label: "Needs AI fill", short: "AI fill", empty: "AI-fill", cls: "iss-ai", action: "Run AI fill" },
  price:   { label: "Missing price", short: "Price", empty: "missing-price", cls: "iss-price", action: "Set price" },
  doubt:   { label: "Check AI", short: "Check", empty: "AI-check", cls: "iss-doubt", action: "Review AI fields" },
  missing: { label: "Missing details", short: "Missing", empty: "missing-detail", cls: "iss-missing", action: "Complete details" },
  flag:    { label: "Problem", short: "Problem", empty: "problem", cls: "iss-flag", action: "Fix problem" },
  sync:    { label: "Shop issue", short: "Shop", empty: "shop-issue", cls: "iss-sync", action: "Open shop sync" },
  edited:  { label: "Recently edited", short: "Edited", empty: "recently-edited", cls: "iss-edited", action: "Check recent edit" },
  ready:   { label: "Ready", short: "Ready", cls: "iss-ready", action: "Approve" },
};

export const REVIEW_QUEUE = ["work", "edited", "ai", "price", "doubt", "missing", "flag", "sync", "ready"];

function hasValue(v) {
  return v !== null && v !== undefined && v !== "";
}

function hasCostPrice(it) {
  if (it.cost_ready === true) return true;
  if (it.cost_ready === false) return false;
  if (hasValue(it.cost_price)) return true;
  if (it.has_cost_price === true) return true;
  if (it.has_cost_price === false) return false;
  return true;
}

function hasConfirmedLineAttribute(it, key) {
  if (it.stock_distribution_source !== "human_confirmed") return false;
  const lines = Array.isArray(it.variant_lines) && it.variant_lines.length
    ? it.variant_lines
    : it.stock_distribution;
  const positiveLines = (lines || []).filter((line) => Number(line?.quantity) > 0);
  return positiveLines.length > 0 && positiveLines.every(
    (line) => hasValue(line?.variant_attributes?.[key])
  );
}

function hasRetailPriceCoverage(it) {
  if (it.pricing_ready === true) return true;
  if (!Array.isArray(it.variant_lines) || !it.variant_lines.length) return it.price != null;
  const positiveLines = it.variant_lines.filter((line) => Number(line?.quantity) > 0);
  return positiveLines.length > 0 && positiveLines.every(
    (line) => Number(line?.effective_price ?? line?.price_override ?? it.price) > 0
  );
}

export function hasAiSignal(it) {
  if (hasValue(it.brand) || hasValue(it.name)) return true;
  if (Object.keys(it.attributes || {}).some((k) => hasValue(it.attributes?.[k]))) return true;
  return Object.keys(it.confidence || {}).length > 0;
}

// aiBlindFields: a Set of attribute keys the AI can't see (excluded from doubts).
export function aiDoubtFields(it, aiBlindFields = new Set()) {
  const conf = it.confidence || {};
  return Object.entries(conf)
    .filter(([key, level]) => (level === "Low" || level === "Medium") && !aiBlindFields.has(key))
    .map(([key, level]) => ({ key, level }));
}

// fields: the resolved category_fields array for this item (caller supplies it).
export function missingCoreFields(it, fields = []) {
  const missing = [];
  const attrs = it.attributes || {};
  if (!it.image_path) missing.push("photo");
  if (!it.category_id) missing.push("category");
  if (!hasValue(it.name)) missing.push("name");

  const required = (fields || []).filter((f) => f.required);
  for (const f of required) {
    if (!hasValue(attrs[f.key]) && !hasConfirmedLineAttribute(it, f.key)) {
      missing.push(f.label || f.key);
    }
  }

  if (!required.length && !Object.keys(attrs).some((k) => hasValue(attrs[k]))) {
    missing.push("details");
  }
  return [...new Set(missing)];
}

function makeIssue(issue, label, detail = "", critical = true) {
  const meta = ISSUE_META[issue] || ISSUE_META.work;
  return { issue, label: label || meta.label, detail, critical, action: meta.action, cls: meta.cls };
}

// Compute an item's readiness. Dependencies injected via deps:
//   fields        – resolved category fields (for missing-detail checks)
//   aiBlindFields – Set of AI-blind attribute keys
//   jobErrorHelp  – fn(errorCategory) -> help string for a failed AI job
//   forApproval   – evaluating for an approve action (vs ambient status)
//   canViewCost   – tailor the cost blocker message for non-cost users
export function getItemReadiness(it, deps = {}) {
  const {
    fields = [],
    aiBlindFields = new Set(),
    jobErrorHelp = () => "",
    forApproval = false,
    canViewCost = true,
  } = deps;
  const blockers = [];
  const warnings = [];

  if (!forApproval && it.status === "approved") {
    if (it.pos_sync_status === "error" || it.pos_dirty) {
      blockers.push(makeIssue("sync", ISSUE_META.sync.label, it.pos_sync_error || "Shop sync needs attention."));
      return summarizeReadiness("sync", blockers, warnings);
    }
    return summarizeReadiness(null, blockers, warnings);
  }

  if (it.status === "flag") {
    blockers.push(makeIssue("flag", ISSUE_META.flag.label, "Marked as a problem."));
  }

  if (it.pos_sync_status === "error") {
    blockers.push(makeIssue("sync", ISSUE_META.sync.label, it.pos_sync_error || "Shop sync needs attention."));
  }

  if (it.latest_ai_job?.status === "failed") {
    const detail = it.latest_ai_job.error_category
      ? `${it.latest_ai_job.error_category}. ${jobErrorHelp(it.latest_ai_job.error_category)}`
      : (it.latest_ai_job.error_message || "AI fill failed. Retry when ready.");
    blockers.push(makeIssue("ai", ISSUE_META.ai.label, detail));
  }

  if (it.image_path && !hasAiSignal(it)) {
    blockers.push(makeIssue("ai", ISSUE_META.ai.label, "Photo has not been read by AI yet."));
  }

  const missing = missingCoreFields(it, fields);
  if (missing.length) {
    blockers.push(makeIssue("missing", ISSUE_META.missing.label, `Missing ${missing.join(", ")}.`));
  }

  if (!hasRetailPriceCoverage(it)) {
    blockers.push(makeIssue("price", ISSUE_META.price.label, "Set a retail price before approval."));
  }

  if (!hasCostPrice(it)) {
    blockers.push(canViewCost
      ? makeIssue("price", "Missing cost price", "Set a cost price before approval.")
      : makeIssue("price", "Cost price needed", "A cost price is needed before approval — ask an admin to add it."));
  }

  const doubts = aiDoubtFields(it, aiBlindFields);
  if (doubts.length) {
    warnings.push(makeIssue(
      "doubt",
      ISSUE_META.doubt.label,
      `${doubts.length} AI confidence value${doubts.length === 1 ? "" : "s"} need a check.`,
      false
    ));
  }

  const issue = blockers[0]?.issue || warnings[0]?.issue || "ready";
  return summarizeReadiness(issue, blockers, warnings);
}

/** Match overlapping work queues instead of hiding secondary blockers. */
export function matchesReadinessQueue(readiness, issue) {
  if (issue === "work") return readiness.blockers.length > 0;
  if (issue === "ready") return readiness.isReady;
  return [...readiness.blockers, ...readiness.warnings]
    .some((entry) => entry.issue === issue);
}

function summarizeReadiness(issue, blockers, warnings) {
  const meta = issue ? (ISSUE_META[issue] || ISSUE_META.work) : null;
  return {
    issue,
    meta,
    blockers,
    warnings,
    canApprove: blockers.length === 0,
    isReady: issue === "ready",
    primary: blockers[0] || warnings[0] || (meta ? makeIssue(issue, meta.label, "", false) : null),
  };
}
