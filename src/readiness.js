// App-facing readiness API. The pure logic lives in src/lib/readiness-core.js
// (unit-tested); this wrapper injects the stateful dependencies — resolved
// category fields, the AI-blind-field set, and the job-error help text — so
// callers keep the same simple signatures they always had.
import { AI_BLIND_FIELDS, resolveFields } from "./data.js";
import { hasRecentEdit } from "./activity.js";
import { jobErrorHelp } from "./joblog.js";
import * as core from "./lib/readiness-core.js";

// Re-export the pure constants + dependency-free helpers unchanged.
export const STATUS_LABELS = core.STATUS_LABELS;
export const STATUS_OPTIONS = core.STATUS_OPTIONS;
export const ISSUE_META = core.ISSUE_META;
export const REVIEW_QUEUE = core.REVIEW_QUEUE;
export const statusLabel = core.statusLabel;
export const hasAiSignal = core.hasAiSignal;

export function aiDoubtFields(it) {
  return core.aiDoubtFields(it, AI_BLIND_FIELDS);
}

export function hasAiDoubt(it) {
  return aiDoubtFields(it).length > 0;
}

export function missingCoreFields(it) {
  return core.missingCoreFields(it, resolveFields(it.category_id));
}

// canViewCost lets the caller tailor the cost blocker (see core); the field
// resolver + AI-blind set + job-error help are injected here.
export function getItemReadiness(it, { forApproval = false, canViewCost = true } = {}) {
  return core.getItemReadiness(it, {
    fields: resolveFields(it.category_id),
    aiBlindFields: AI_BLIND_FIELDS,
    jobErrorHelp,
    forApproval,
    canViewCost,
  });
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

export function approvalSummary(items, { canViewCost = true } = {}) {
  const blocked = [];
  const warned = [];
  const approvable = [];

  for (const it of items) {
    const readiness = getItemReadiness(it, { forApproval: true, canViewCost });
    if (readiness.blockers.length) blocked.push({ item: it, readiness });
    else {
      approvable.push({ item: it, readiness });
      if (readiness.warnings.length) warned.push({ item: it, readiness });
    }
  }

  return { blocked, warned, approvable };
}
