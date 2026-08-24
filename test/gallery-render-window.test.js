import { describe, expect, it } from "vitest";
import {
  DEFAULT_GALLERY_RENDER_BATCH_SIZE,
  initialGalleryRenderLimit,
  nextGalleryRenderLimit,
} from "../src/lib/gallery-render-window.js";

describe("gallery render window", () => {
  it("renders a small result set in full", () => {
    expect(initialGalleryRenderLimit(25)).toBe(25);
  });

  it("caps the first render at one batch", () => {
    expect(initialGalleryRenderLimit(355)).toBe(DEFAULT_GALLERY_RENDER_BATCH_SIZE);
  });

  it("reveals another batch without exceeding the result count", () => {
    expect(nextGalleryRenderLimit(60, 355)).toBe(120);
    expect(nextGalleryRenderLimit(340, 355)).toBe(355);
  });
});
