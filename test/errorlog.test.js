import { describe, expect, it } from "vitest";
import { safeTelemetryUrl } from "../src/errorlog.js";

describe("safeTelemetryUrl", () => {
  it("removes query strings and fragments that may contain credentials", () => {
    expect(safeTelemetryUrl("https://example.test/auth?code=secret#access_token=token"))
      .toBe("https://example.test/auth");
  });

  it("returns null for invalid or absent URLs", () => {
    expect(safeTelemetryUrl("not a url")).toBeNull();
    expect(safeTelemetryUrl(null)).toBeNull();
  });
});
