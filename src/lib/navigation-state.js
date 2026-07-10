export const APP_VIEWS = ["today", "catalog", "add", "review", "shop", "export"];
export const REVIEW_STAGES = ["fix", "verify", "approve"];
export const REVIEW_FILTERS = [
  "work",
  "verify",
  "edited",
  "ai",
  "price",
  "doubt",
  "missing",
  "flag",
  "sync",
  "ready",
];

export function reviewStageForFilter(filter) {
  if (filter === "ready") return "approve";
  if (filter === "verify" || filter === "edited" || filter === "doubt") return "verify";
  return "fix";
}
export function defaultFilterForStage(stage) {
  if (stage === "approve") return "ready";
  if (stage === "verify") return "verify";
  return "work";
}

export function parseAppRoute(search = "", fallback = {}) {
  const params = new URLSearchParams(search);
  const requestedView = params.get("view") === "gallery" ? "catalog" : params.get("view");
  const view = APP_VIEWS.includes(requestedView)
    ? requestedView
    : APP_VIEWS.includes(fallback.view)
      ? fallback.view
      : "today";
  const requestedFilter = params.get("queue");
  const reviewFilter = REVIEW_FILTERS.includes(requestedFilter)
    ? requestedFilter
    : REVIEW_FILTERS.includes(fallback.reviewFilter)
      ? fallback.reviewFilter
      : "work";
  return {
    view,
    reviewFilter,
    itemId: params.get("item") || "",
    shared: params.get("share") === "1",
  };
}

export function buildAppUrl(href, { view, reviewFilter, itemId = "", dropShare = true } = {}) {
  const url = new URL(href, "https://app.invalid");
  if (APP_VIEWS.includes(view)) url.searchParams.set("view", view);
  else url.searchParams.delete("view");
  if (view === "review" && REVIEW_FILTERS.includes(reviewFilter)) {
    url.searchParams.set("queue", reviewFilter);
  } else {
    url.searchParams.delete("queue");
  }
  if (itemId) url.searchParams.set("item", itemId);
  else url.searchParams.delete("item");
  if (dropShare) url.searchParams.delete("share");
  return `${url.pathname}${url.search}${url.hash}`;
}
