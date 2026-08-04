import { describe, expect, it } from "vitest";
import {
  classifyPhotoQuality,
  isExistingStorageObjectError,
  preferredUploadConcurrency,
} from "../src/uploadQueue.js";

describe("classifyPhotoQuality", () => {
  it("accepts a normal, inspectable product photo", () => {
    expect(classifyPhotoQuality({
      width: 1600,
      height: 1200,
      originalBytes: 2_000_000,
    })).toEqual({
      state: "ok",
      label: "Looks ok",
      detail: "1600x1200",
    });
  });

  it("explains that an original large file has already been compressed", () => {
    const quality = classifyPhotoQuality({
      width: 4032,
      height: 3024,
      originalBytes: 9_000_000,
    });
    expect(quality.state).toBe("ok");
    expect(quality.label).toBe("Compressed");
    expect(quality.detail).toContain("Large original compressed");
  });

  it("falls back to a capture warning when dimensions are unavailable", () => {
    expect(classifyPhotoQuality({
      width: 0,
      height: 0,
      originalBytes: 200_000,
    }).label).toBe("Check photo");
  });
});

describe("preferredUploadConcurrency", () => {
  it("uses two workers on lower-memory or touch-first devices", () => {
    expect(preferredUploadConcurrency({ deviceMemory: 4, coarsePointer: false })).toBe(2);
    expect(preferredUploadConcurrency({ deviceMemory: 8, coarsePointer: true })).toBe(2);
  });

  it("uses three workers on higher-memory desktop devices", () => {
    expect(preferredUploadConcurrency({ deviceMemory: 8, coarsePointer: false })).toBe(3);
  });
});

describe("isExistingStorageObjectError", () => {
  it("recognizes retry-safe duplicate object responses", () => {
    expect(isExistingStorageObjectError({
      statusCode: 400,
      message: "The resource already exists",
    })).toBe(true);
    expect(isExistingStorageObjectError({
      status: 409,
      error: "Duplicate",
    })).toBe(true);
  });

  it("does not hide unrelated storage failures", () => {
    expect(isExistingStorageObjectError({
      statusCode: 403,
      message: "Permission denied",
    })).toBe(false);
  });
});
