import { act, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoScroll } from "./useAutoScroll";

interface HarnessApi {
  el: HTMLDivElement;
  scrollToBottom: ReturnType<typeof useAutoScroll>["scrollToBottom"];
  isAtBottom: boolean;
}

function Harness({ onReady }: { onReady: (api: HarnessApi) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const autoScroll = useAutoScroll(ref);

  useEffect(() => {
    if (ref.current) {
      onReady({ el: ref.current, ...autoScroll });
    }
  }, [autoScroll, onReady]);

  return <div data-testid="scroll-container" ref={ref} />;
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  el.scrollTop = metrics.scrollTop;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
}

describe("useAutoScroll", () => {
  let scrollToSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    scrollToSpy = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
      if (typeof options.top === "number") {
        this.scrollTop = options.top;
      }
    });
    Element.prototype.scrollTo = scrollToSpy as unknown as Element["scrollTo"];
  });

  it("does not snap back to the bottom after the user wheels upward near the bottom", () => {
    let api: HarnessApi | undefined;

    render(<Harness onReady={(nextApi) => { api = nextApi; }} />);
    const el = screen.getByTestId("scroll-container");
    setScrollMetrics(el, {
      scrollTop: 760,
      clientHeight: 200,
      scrollHeight: 1000,
    });

    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      el.dispatchEvent(new Event("scroll"));
    });

    act(() => {
      api?.scrollToBottom();
    });

    expect(scrollToSpy).not.toHaveBeenCalled();

    act(() => {
      api?.scrollToBottom({ force: true });
    });

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 1000,
      behavior: "instant",
    });
  });
});
