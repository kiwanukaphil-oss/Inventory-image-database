import { describe, expect, it, vi } from "vitest";
import {
  catalogAiRetryDelayMs,
  isRetryableCatalogAiError,
  runCatalogAiWithRetry,
} from "../src/lib/catalog-ai-retry.js";

describe("catalog AI retry policy", () => {
  it("recognizes transport, rate-limit, and temporary service failures", () => {
    expect(isRetryableCatalogAiError({ message: "Failed to fetch", status: 0 })).toBe(true);
    expect(isRetryableCatalogAiError({ message: "Too many requests", status: 429 })).toBe(true);
    expect(isRetryableCatalogAiError({ message: "Unavailable", status: 503 })).toBe(true);
    expect(isRetryableCatalogAiError({ message: "Bad request", status: 400 })).toBe(false);
  });

  it("uses a longer backoff for rate limits and honors a server retry delay", () => {
    expect(catalogAiRetryDelayMs({ status: 0 }, 1, 0)).toBe(1_500);
    expect(catalogAiRetryDelayMs({ status: 429 }, 1, 0)).toBe(10_000);
    expect(catalogAiRetryDelayMs({ status: 503, retryAfterMs: 8_000 }, 1, 0)).toBe(8_000);
  });

  it("retries a network failure and returns the later successful result", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Failed to fetch"), { status: 0 }))
      .mockResolvedValue({ applied_fields: ["name"] });
    const wait = vi.fn().mockResolvedValue(true);

    await expect(runCatalogAiWithRetry(operation, { wait, random: () => 0 }))
      .resolves.toEqual({ applied_fields: ["name"] });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_500, expect.any(Function));
  });

  it("does not retry a permanent item error", async () => {
    const itemError = Object.assign(new Error("Image format is invalid"), { status: 400 });
    const operation = vi.fn().mockRejectedValue(itemError);
    const wait = vi.fn();

    await expect(runCatalogAiWithRetry(operation, { wait })).rejects.toBe(itemError);
    expect(operation).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops retrying when the batch circuit opens during a wait", async () => {
    const networkError = Object.assign(new Error("Failed to fetch"), { status: 0 });
    const operation = vi.fn().mockRejectedValue(networkError);
    const wait = vi.fn().mockResolvedValue(false);

    await expect(runCatalogAiWithRetry(operation, { wait, random: () => 0 }))
      .rejects.toMatchObject({ catalogAiRetryCancelled: true });
    expect(operation).toHaveBeenCalledOnce();
  });
});
