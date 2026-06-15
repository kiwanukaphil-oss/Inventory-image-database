import { AI_BLIND_FIELDS, resolveFields } from "./data.js";
import { hasRecentEdit } from "./activity.js";
import { jobErrorHelp } from "./joblog.js";

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
  ai:      { label: "Needs AI", short: "AI", empty: "AI", cls: "iss-ai", action: "Run AI fill" },
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
  if (hasValue(it.cost_price)) return true;
  if (it.has_cost_price === true) return true;
  if (it.has_cost_price === false) return false;
  return true;
}

export function hasAiSignal(it) {
  if (hasValue(it.brand) || hasValue(it.name)) return true;
  if (Object.keys(it.attributes || {}).some((k) => hasValue(it.attributes?.[k]))) return true;
  return Object.keys(it.confidence || {}).length > 0;
}

export function aiDoubtFields(it) {
  const conf = it.confidence || {};
  return Object.entries(conf)
    .filter(([key, level]) =>
      (level === "Low" || level === "Medium") && !AI_BLIND_FIELDS.has(key)
    )
    .map(([key, level]) => ({ key, level }));
}

export function hasAiDoubt(it) {
  return aiDoubtFields(it).length > 0;
}

export function missingCoreFields(it) {
  const missing = [];
  const attrs = it.attributes || {};
  if (!it.image_path) missing.push("photo");
  if (!hasValue(it.name)) missing.push("name");

  const fields = resolveFields(it.category_id);
  const required = fields.filter((f) => f.required);
  for (const f of required) {
    if (!hasValue(attrs[f.key])) missing.push(f.label || f.key);
  }

  if (!required.length && !Object.keys(attrs).some((k) => hasValue(attrs[k]))) {
    missing.push("details");
  }
  return [...new Set(missing)];
}

function makeIssue(issue, label, detail = "", critical = true) {
  const meta = ISSUE_META[issue] || ISSUE_META.work;
  return {
    issue,
    label: label || meta.label,
    detail,
    critical,
    action: meta.action,
    cls: meta.cls,
  };
}

export function getItemReadiness(it, { forApproval = false } = {}) {
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

  const missing = missingCoreFields(it);
  if (missing.length) {
    blockers.push(makeIssue("missing", ISSUE_META.missing.label, `Missing ${missing.join(", ")}.`));
  }

  if (it.price == null) {
    blockers.push(makeIssue("price", ISSUE_META.price.label, "Set a retail price before approval."));
  }

  if (!hasCostPrice(it)) {
    blockers.push(makeIssue("price", "Missing cost price", "Set a cost price before approval."));
  }

  const doubts = aiDoubtFields(it);
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

export function issueState(it) {
  return getItemReadiness(it).issue;
}

export function queueMatches(it, issue) {
  if (issue === "edited") return hasRecentEdit(it);
  const st = issueState(it);
  if (issue === "work") return !!st && st !== "ready";
  return st === issue;
}

export function needsReviewItem(it) {
  const st = issueState(it);
  return !!st && st !== "ready";
}

export function readyItem(it) {
  return issueState(it) === "ready";
}

export function approvalSummary(items) {
  const blocked = [];
  const warned = [];
  const approvable = [];

  for (const it of items) {
    const readiness = getItemReadiness(it, { forApproval: true });
    if (readiness.blockers.length) blocked.push({ item: it, readiness });
    else {
      approvable.push({ item: it, readiness });
      if (readiness.warnings.length) warned.push({ item: it, readiness });
    }
  }

  return { blocked, warned, approvable };
}
