export function classifyVerificationRisk(doubts = [], { recentlyEdited = false } = {}) {
  const low = doubts.filter((field) => field.level === "Low").length;
  const medium = doubts.filter((field) => field.level === "Medium").length;
  if (low > 0 || doubts.length >= 3) {
    return { level: "critical", low, medium, count: doubts.length, bulkEligible: false };
  }
  if (doubts.length > 0 && low === 0 && doubts.length <= 2) {
    return { level: "quick", low, medium, count: doubts.length, bulkEligible: true };
  }
  if (recentlyEdited) {
    return { level: "recent", low: 0, medium: 0, count: 0, bulkEligible: false };
  }
  return { level: "clear", low: 0, medium: 0, count: 0, bulkEligible: false };
}
export function verificationRiskRank(risk) {
  return ({ critical: 0, quick: 1, recent: 2, clear: 3 })[risk?.level] ?? 3;
}
