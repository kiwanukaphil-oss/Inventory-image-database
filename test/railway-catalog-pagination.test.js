import { describe, expect, it, vi } from "vitest";
import { fetchBoundedRailwayCatalog } from "../src/lib/railway-catalog-pagination.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

// Cover the concurrency contract separately from the gallery DOM so failures
// pinpoint request orchestration rather than rendering behavior.
describe("Railway catalog pagination", () => {
  // Hold the later responses open to prove both requests start before either
  // can complete, then resolve them out of order to verify stable item order.
  it("starts every remaining page together after page one reports the total", async () => {
    const secondPage = deferred();
    const thirdPage = deferred();
    const requestPage = vi.fn((page) => {
      if (page === 1) return Promise.resolve({ data: [1, 2], pagination: { total: 5 } });
      if (page === 2) return secondPage.promise;
      return thirdPage.promise;
    });

    const resultPromise = fetchBoundedRailwayCatalog({
      requestPage,
      pageSize: 2,
      itemLimit: 10,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(requestPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
    thirdPage.resolve({ data: [5], pagination: { total: 5 } });
    secondPage.resolve({ data: [3, 4], pagination: { total: 5 } });
    await expect(resultPromise).resolves.toEqual({ data: [1, 2, 3, 4, 5], total: 5 });
  });

  it("does not request pages beyond the caller's item cap", async () => {
    const requestPage = vi.fn((page) => Promise.resolve({
      data: [`page-${page}`],
      pagination: { total: 5000 },
    }));

    await fetchBoundedRailwayCatalog({ requestPage, pageSize: 200, itemLimit: 400 });

    expect(requestPage.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  });

  // Image URL caching depends on seeing every completed page, including page
  // one, rather than waiting for the combined catalog result.
  it("notifies the caller as each page resolves", async () => {
    const observedPages = [];
    const requestPage = vi.fn((page) => Promise.resolve({
      data: [page],
      pagination: { total: 2 },
    }));

    await fetchBoundedRailwayCatalog({
      requestPage,
      pageSize: 1,
      itemLimit: 10,
      onPageItems: (items) => observedPages.push(items),
    });

    expect(observedPages).toEqual([[1], [2]]);
  });
});
