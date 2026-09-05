const ACTIVITY_SOURCE_LABELS = {
  upload: "Uploaded",
  ai: "AI filled",
  manual: "Manual edit",
  bulk: "Bulk edit",
  pricing: "Priced",
  approval: "Approved",
  undo: "Undo",
  shop: "Shop sync",
  system: "System",
  history: "Edited",
};

export function hasRecentEdit(item) {
  return !!item?.activity?.recent_edit;
}

export function activitySourceLabel(source) {
  return ACTIVITY_SOURCE_LABELS[source] || source || "Updated";
}

export function activitySourceClass(source) {
  return ACTIVITY_SOURCE_LABELS[source] ? source : "system";
}
