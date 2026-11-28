import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { createElement } from "react";
import { afterEach, vi } from "vitest";

// thinking-orbs animates a canvas, which jsdom doesn't implement.
vi.mock("thinking-orbs", () => ({
  ThinkingOrb: ({ state }: { state?: string }) =>
    createElement("span", { "data-thinking-orb": state ?? "working", "aria-hidden": true }),
}));

// bot-avatars draws on a canvas too; the stand-in exposes what was asked for.
vi.mock("bot-avatars", () => {
  const BotAvatar = ({
    type,
    color,
    state,
    paused,
    interactive,
  }: {
    type?: string;
    color?: string;
    state?: string;
    paused?: boolean;
    interactive?: boolean;
  }) =>
    createElement("span", {
      "data-bot-avatar": type,
      "data-color": color,
      "data-state": state ?? "default",
      "data-paused": String(Boolean(paused)),
      "data-interactive": String(interactive ?? true),
      "aria-hidden": true,
    });
  return { default: BotAvatar, BotAvatar };
});

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

// Node 25+ defines its own localStorage and sessionStorage globals, and its
// localStorage is undefined unless Node runs with --localstorage-file. Vitest 4
// keeps a global that Node already defines instead of copying jsdom's, so tests
// on Node 25+ got Node's storage. Use jsdom's, as Vitest 5 does
// (vitest-dev/vitest#10293); remove this after upgrading to Vitest 5.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, enumerable: true, writable: true });
  }
}

afterEach(() => {
  clearMocks();
});
