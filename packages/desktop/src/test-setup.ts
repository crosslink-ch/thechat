import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

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
