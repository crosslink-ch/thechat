import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { createElement } from "react";
import { afterEach, vi } from "vitest";

// thinking-orbs animates a canvas, which jsdom doesn't implement.
vi.mock("thinking-orbs", () => ({
  ThinkingOrb: ({ state }: { state?: string }) =>
    createElement("span", { "data-thinking-orb": state ?? "working", "aria-hidden": true }),
}));

// jsdom doesn't implement browser geometry APIs used by scrolling editors.
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number, y?: number) {
  const top = typeof options === "object" ? options.top : y;
  if (typeof top === "number") {
    this.scrollTop = top;
  }
};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

afterEach(() => {
  clearMocks();
});
