import { renderHook } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it } from "vitest";
import { useFontSizeStore } from "../stores/font-size";
import { useCtrlWheelZoom } from "./useCtrlWheelZoom";

const DEFAULT_FONT_SIZE = 14;

function dispatchWheel(init: WheelEventInit) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  mockIPC(() => null);
  useFontSizeStore.setState({ size: DEFAULT_FONT_SIZE });
  document.documentElement.style.fontSize = `${DEFAULT_FONT_SIZE}px`;
});

describe("useCtrlWheelZoom", () => {
  it("zooms in one level on Ctrl+scroll up", () => {
    renderHook(() => useCtrlWheelZoom());

    const event = dispatchWheel({ ctrlKey: true, deltaY: -100 });

    expect(event.defaultPrevented).toBe(true);
    expect(useFontSizeStore.getState().size).toBe(15);
    expect(document.documentElement.style.fontSize).toBe("15px");
  });

  it("zooms out one level on Ctrl+scroll down", () => {
    renderHook(() => useCtrlWheelZoom());

    const event = dispatchWheel({ ctrlKey: true, deltaY: 100 });

    expect(event.defaultPrevented).toBe(true);
    expect(useFontSizeStore.getState().size).toBe(13);
    expect(document.documentElement.style.fontSize).toBe("13px");
  });

  it("leaves regular scrolling alone", () => {
    renderHook(() => useCtrlWheelZoom());

    const event = dispatchWheel({ deltaY: -100 });

    expect(event.defaultPrevented).toBe(false);
    expect(useFontSizeStore.getState().size).toBe(DEFAULT_FONT_SIZE);
  });

  it("ignores horizontal Ctrl+scroll events", () => {
    renderHook(() => useCtrlWheelZoom());

    const event = dispatchWheel({ ctrlKey: true, deltaX: 100, deltaY: 0 });

    expect(event.defaultPrevented).toBe(false);
    expect(useFontSizeStore.getState().size).toBe(DEFAULT_FONT_SIZE);
  });

  it("removes the global listener on unmount", () => {
    const { unmount } = renderHook(() => useCtrlWheelZoom());
    unmount();

    const event = dispatchWheel({ ctrlKey: true, deltaY: -100 });

    expect(event.defaultPrevented).toBe(false);
    expect(useFontSizeStore.getState().size).toBe(DEFAULT_FONT_SIZE);
  });
});
