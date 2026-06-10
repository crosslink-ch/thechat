import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { useScrollStability } from "./useScrollStability";

type ResizeCallback = (entries: Array<{ target: Element; borderBoxSize?: Array<{ blockSize: number }> }>) => void;

let resizeCallback: ResizeCallback | null = null;
let observed: Element[] = [];

class FakeResizeObserver {
  constructor(callback: ResizeCallback) {
    resizeCallback = callback;
  }
  observe(target: Element) {
    observed.push(target);
  }
  unobserve(target: Element) {
    observed = observed.filter((el) => el !== target);
  }
  disconnect() {
    observed = [];
  }
}

function buildContainer({ scrollTop, clientHeight, scrollHeight }: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(container, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: scrollTop });
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: clientHeight, height: clientHeight } as DOMRect);
  return container;
}

function addRow(container: HTMLElement, { bottom }: { bottom: number }) {
  const row = document.createElement("div");
  row.getBoundingClientRect = () => ({ top: bottom - 100, bottom, height: 100 } as DOMRect);
  container.appendChild(row);
  return row;
}

function resize(target: Element, blockSize: number) {
  resizeCallback?.([{ target, borderBoxSize: [{ blockSize }] }]);
}

describe("useScrollStability", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resizeCallback = null;
    observed = [];
  });

  it("compensates scrollTop when a row above the viewport changes height", () => {
    const container = buildContainer({ scrollTop: 2000, clientHeight: 300, scrollHeight: 5000 });
    const rowAbove = addRow(container, { bottom: -50 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(rowAbove, 200); // baseline
    resize(rowAbove, 155); // shrinks by 45 above the viewport

    expect(container.scrollTop).toBe(1955);
  });

  it("records a baseline on first observation without adjusting", () => {
    const container = buildContainer({ scrollTop: 2000, clientHeight: 300, scrollHeight: 5000 });
    const rowAbove = addRow(container, { bottom: -50 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(rowAbove, 200);

    expect(container.scrollTop).toBe(2000);
  });

  it("ignores rows below or intersecting the viewport top", () => {
    const container = buildContainer({ scrollTop: 2000, clientHeight: 300, scrollHeight: 5000 });
    const rowInView = addRow(container, { bottom: 150 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(rowInView, 200);
    resize(rowInView, 120);

    expect(container.scrollTop).toBe(2000);
  });

  it("leaves the scroll position alone when pinned near the bottom", () => {
    const container = buildContainer({ scrollTop: 4750, clientHeight: 300, scrollHeight: 5000 });
    const rowAbove = addRow(container, { bottom: -50 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(rowAbove, 200);
    resize(rowAbove, 155);

    expect(container.scrollTop).toBe(4750);
  });
});
