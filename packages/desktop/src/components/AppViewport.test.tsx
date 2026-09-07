import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppViewport } from "./AppViewport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("tracks the mobile visual viewport and restores CSS variables on unmount", () => {
  vi.stubGlobal("matchMedia", () => ({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  const viewport = Object.assign(new EventTarget(), {height:480,offsetTop:0,scale:1});
  vi.stubGlobal("visualViewport", viewport);
  const {unmount} = render(<AppViewport>Chat</AppViewport>);
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("480px");
  act(() => {viewport.height=270;viewport.offsetTop=16;viewport.dispatchEvent(new Event("resize"));});
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("270px");
  expect(document.documentElement.style.getPropertyValue("--app-viewport-top")).toBe("16px");
  unmount();
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
});

it("does not shrink the app when the user pinch-zooms", () => {
  vi.stubGlobal("matchMedia", () => ({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  const viewport = Object.assign(new EventTarget(), {height:480,offsetTop:0,scale:1});
  vi.stubGlobal("visualViewport", viewport);
  render(<AppViewport/>);
  act(() => {viewport.height=240;viewport.scale=2;viewport.dispatchEvent(new Event("resize"));});
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("480px");
});
