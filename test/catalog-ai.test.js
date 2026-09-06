import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageValues = new Map();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_CATALOG_API_URL", "https://catalog-api.test/api");
  storageValues.clear();
  storageValues.set("kline.catalog.pos-token", "test-pos-jwt");
  storageValues.set("selected_branch_id", "branch-123");
  vi.stubGlobal("localStorage", {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: (key) => storageValues.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("catalog AI adapter", () => {
  it("uses the authenticated Railway item endpoint without client field authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            values: { name: "K-Line Oxford Shirt" },
            applied_fields: ["name"],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { extractCatalogItemWithAi } = await import("../src/catalogAi.js");

    const result = await extractCatalogItemWithAi({
      itemId: "item/with spaces",
      category: "Untrusted category",
      fields: [{ key: "untrusted", label: "Untrusted" }],
      branchId: "branch-ai-item",
    });

    expect(result.applied_fields).toEqual(["name"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://catalog-api.test/api/catalog/items/item%2Fwith%20spaces/ai-extract"
    );
    expect(options.headers.Authorization).toBe("Bearer test-pos-jwt");
    expect(options.headers["X-Branch-Id"]).toBe("branch-ai-item");
    expect(JSON.parse(options.body)).toEqual({ only_empty: true });
  });

  it("surfaces the Railway API message when extraction is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            message: "AI service is temporarily unavailable. Please try again.",
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "12" },
          }
        )
      )
    );
    const { extractCatalogItemWithAi } = await import("../src/catalogAi.js");

    await expect(
      extractCatalogItemWithAi({ itemId: "00000000-0000-4000-a000-000000000001" })
    ).rejects.toMatchObject({
      message: "AI service is temporarily unavailable. Please try again.",
      status: 503,
      retryAfterMs: 12_000,
    });
  });
});
