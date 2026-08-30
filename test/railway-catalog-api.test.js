import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageValues = new Map();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_CATALOG_API_URL", "https://catalog-api.test/api");
  storageValues.set("kline.catalog.pos-token", "test-pos-jwt");
  storageValues.set("selected_branch_id", "branch-123");
  vi.stubGlobal("localStorage", {
    getItem: (key) => storageValues.get(key) ?? null,
  });
});

afterEach(() => {
  storageValues.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Railway catalog API client", () => {
  it("sends multipart intake without overriding the browser content boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { id: "item-1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { requestRailwayCatalog } = await import("../src/railwayCatalogApi.js");
    const formData = new FormData();
    formData.append("id", "item-1");
    formData.append("image", new Blob(["image"], { type: "image/webp" }), "item.webp");

    await requestRailwayCatalog("/catalog/items", {
      method: "POST",
      body: formData,
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://catalog-api.test/api/catalog/items");
    expect(options.body).toBe(formData);
    expect(options.headers).not.toHaveProperty("Content-Type");
    expect(options.headers.Authorization).toBe("Bearer test-pos-jwt");
    expect(options.headers["X-Branch-Id"]).toBe("branch-123");
  });
});
