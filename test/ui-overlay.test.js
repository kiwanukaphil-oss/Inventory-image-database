import { afterEach, describe, expect, it } from "vitest";
import { anyOverlayOpen, isTopOverlay } from "../src/ui.js";

afterEach(() => {
  delete globalThis.document;
});
describe("overlay coordination", () => {
  it("treats Swipe Review as an open modal surface", () => {
    const swipe = {};
    globalThis.document = {
      querySelector(selector) {
        if (selector === "#lb.open") return null;
        return selector.includes(".swipe") ? swipe : null;
      },
      querySelectorAll() { return [swipe]; },
    };
    expect(anyOverlayOpen()).toBe(true);
    expect(isTopOverlay(swipe)).toBe(true);
  });

  it("gives a nested editor ownership over Swipe Review", () => {
    const swipe = {};
    const editor = {};
    globalThis.document = {
      querySelector(selector) { return selector === "#lb.open" ? null : null; },
      querySelectorAll() { return [swipe, editor]; },
    };
    expect(isTopOverlay(swipe)).toBe(false);
    expect(isTopOverlay(editor)).toBe(true);
  });
});
