import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandsStore } from "../commands";
import {
  scrollToPreviousMessageTop,
  useMessageTopCommand,
} from "./useMessageTopCommand";

const commandPaletteMocks = vi.hoisted(() => ({
  closePaletteAndRefocus: vi.fn(),
}));

vi.mock("../CommandPalette", () => ({
  closePaletteAndRefocus: commandPaletteMocks.closePaletteAndRefocus,
}));

function makeScroller(messageOffsetFromTop: number) {
  const scroller = document.createElement("div");
  const message = document.createElement("div");
  message.dataset.messageId = "message-1";
  scroller.appendChild(message);
  scroller.scrollTop = 120;
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
    top: 100,
  } as DOMRect);
  vi.spyOn(message, "getBoundingClientRect").mockReturnValue({
    top: 100 + messageOffsetFromTop,
  } as DOMRect);
  const scrollTo = vi.fn();
  Object.defineProperty(scroller, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return { message, scroller, scrollTo };
}

describe("useMessageTopCommand", () => {
  beforeEach(() => {
    useCommandsStore.setState({
      globalCommands: [],
      scopedCommands: {},
      commands: [],
    });
    commandPaletteMocks.closePaletteAndRefocus.mockReset();
  });

  it("registers the scoped command and removes it on unmount", () => {
    const scrollContainerRef = {
      current: document.createElement("div"),
    } as RefObject<HTMLDivElement>;
    const { unmount } = renderHook(() =>
      useMessageTopCommand(scrollContainerRef, true, vi.fn()),
    );

    expect(useCommandsStore.getState().commands).toEqual([
      expect.objectContaining({
        id: "chat.scroll-to-message-top",
        label: "Scroll to Message Top",
        shortcut: "C-x t",
        keybinding: { prefix: "C-x", key: "t" },
      }),
    ]);

    unmount();
    expect(useCommandsStore.getState().commands).toEqual([]);
  });

  it("does nothing when the first message is already aligned", () => {
    const { scroller, scrollTo } = makeScroller(0);
    const beforeScroll = vi.fn();

    expect(scrollToPreviousMessageTop(scroller, beforeScroll)).toBeNull();
    expect(beforeScroll).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each([1, 0.5])(
    "selects a message top %s px above the viewport",
    (offset) => {
      const { message, scroller, scrollTo } = makeScroller(-offset);
      const beforeScroll = vi.fn();

      expect(scrollToPreviousMessageTop(scroller, beforeScroll)).toBe(message);
      expect(beforeScroll).toHaveBeenCalledOnce();
      expect(scrollTo).toHaveBeenCalledWith({
        top: 120 - offset,
        behavior: "instant",
      });
    },
  );

  it("skips the last command target when fractional layout leaves it nearly aligned", () => {
    const { message, scroller, scrollTo } = makeScroller(-0.5);
    const beforeScroll = vi.fn();

    const firstTarget = scrollToPreviousMessageTop(scroller, beforeScroll);
    const secondTarget = scrollToPreviousMessageTop(
      scroller,
      beforeScroll,
      firstTarget,
    );

    expect(firstTarget).toBe(message);
    expect(secondTarget).toBeNull();
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("refocuses the composer and pauses auto-scroll before navigating", () => {
    const { scroller, scrollTo } = makeScroller(-100);
    const pauseAutoScroll = vi.fn();
    const scrollContainerRef = { current: scroller } as RefObject<HTMLDivElement>;
    renderHook(() =>
      useMessageTopCommand(scrollContainerRef, true, pauseAutoScroll),
    );

    const command = useCommandsStore.getState().commands[0];
    act(() => command.execute());

    expect(commandPaletteMocks.closePaletteAndRefocus).toHaveBeenCalledOnce();
    expect(pauseAutoScroll).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(pauseAutoScroll.mock.invocationCallOrder[0]).toBeLessThan(
      scrollTo.mock.invocationCallOrder[0],
    );
  });
});
