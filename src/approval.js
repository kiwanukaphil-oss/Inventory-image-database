import { confirmSheet } from "./ui.js";

export function approvalReasonText(entries, key = "blockers") {
  const counts = {};
  for (const entry of entries || []) {
    for (const issue of entry.readiness?.[key] || []) {
      counts[issue.label] = (counts[issue.label] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([label, n]) => `${n} ${label.toLowerCase()}`)
    .join(", ");
}

export function approvalBlockerText(readiness, limit = 3) {
  return (readiness?.blockers || [])
    .slice(0, limit)
    .map((b) => b.detail || b.label)
    .filter(Boolean)
    .join(" ");
}

export async function confirmApprovalWarnings(readiness, {
  title = "Approve with AI checks?",
  confirmText = "I checked, approve",
  cancelText = "Review first",
  message,
} = {}) {
  const warnings = readiness?.warnings || [];
  if (!warnings.length) return true;
  const body = message || warnings.map((w) => w.detail || w.label).filter(Boolean).join(" ");
  return confirmSheet({ title, message: body, confirmText, cancelText });
}

export async function confirmApprovalSummaryWarnings(summary) {
  const warned = summary?.warned || [];
  if (!warned.length) return true;
  const reasons = approvalReasonText(warned, "warnings") || "AI fields need a check";
  return confirmSheet({
    title: "Approve with AI checks?",
    message: `${warned.length} item${warned.length === 1 ? " has" : "s have"} warnings: ${reasons}. Approve only if you have checked them.`,
    confirmText: "Approve",
    cancelText: "Review first",
  });
}
