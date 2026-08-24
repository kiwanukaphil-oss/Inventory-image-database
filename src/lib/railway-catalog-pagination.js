const pageItems = (payload) => (Array.isArray(payload?.data) ? payload.data : []);

/**
 * Fetch page one to learn the server-reported total, then request every other
 * bounded page concurrently. Promise.all preserves page order even when later
 * pages finish first, so callers receive the same deterministic item sequence
 * as the former sequential loop.
 */
export async function fetchBoundedRailwayCatalog({
  requestPage,
  pageSize,
  itemLimit,
  onPageItems = () => {},
}) {
  const firstPayload = await requestPage(1, pageSize);
  const firstPageItems = pageItems(firstPayload);
  onPageItems(firstPageItems);

  const reportedTotal = Number(firstPayload?.pagination?.total);
  const total = Number.isFinite(reportedTotal) && reportedTotal >= 0
    ? reportedTotal
    : firstPageItems.length;
  const boundedPageCount = Math.max(
    1,
    Math.min(Math.ceil(total / pageSize), Math.ceil(itemLimit / pageSize))
  );
  const remainingPageNumbers = Array.from(
    { length: boundedPageCount - 1 },
    (_, index) => index + 2
  );
  const remainingPages = await Promise.all(
    remainingPageNumbers.map(async (page) => {
      const payload = await requestPage(page, pageSize);
      const items = pageItems(payload);
      onPageItems(items);
      return items;
    })
  );

  return {
    data: [firstPageItems, ...remainingPages].flat().slice(0, itemLimit),
    total,
  };
}
