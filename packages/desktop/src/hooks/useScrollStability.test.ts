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

  it("anchors content when a growing row crosses the viewport top", () => {
    const container = buildContainer({
      scrollTop: 2000,
      clientHeight: 300,
      scrollHeight: 5000,
    });
    let bottom = -20;
    const row = document.createElement("div");
    row.getBoundingClientRect = () =>
      ({ top: bottom - 100, bottom, height: 100 } as DOMRect);
    container.appendChild(row);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(row, 100); // baseline just above the viewport
    bottom = 180;
    resize(row, 300); // growth now makes its post-layout box intersect

    expect(container.scrollTop).toBe(2200);
  });

  it("keeps its pre-reflow geometry valid after the user scrolls", () => {
    const container = buildContainer({
      scrollTop: 2000,
      clientHeight: 300,
      scrollHeight: 5000,
    });
    let contentBottom = 2250;
    const row = document.createElement("div");
    row.getBoundingClientRect = () => {
      const bottom = contentBottom - container.scrollTop;
      return { top: bottom - 100, bottom, height: 100 } as DOMRect;
    };
    container.appendChild(row);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(row, 100); // baseline while visible
    container.scrollTop = 2300; // the row is now just above the viewport
    container.dispatchEvent(new Event("scroll"));
    contentBottom += 200;
    resize(row, 300); // late growth crosses the viewport top

    expect(container.scrollTop).toBe(2500);
  });

  it("propagates earlier reflows to later row geometry", () => {
    const container = buildContainer({
      scrollTop: 2000,
      clientHeight: 300,
      scrollHeight: 5000,
    });
    let firstContentBottom = 1950;
    let secondContentBottom = 2250;
    const firstRow = document.createElement("div");
    firstRow.getBoundingClientRect = () => {
      const bottom = firstContentBottom - container.scrollTop;
      return { top: bottom - 100, bottom, height: 100 } as DOMRect;
    };
    const secondRow = document.createElement("div");
    secondRow.getBoundingClientRect = () => {
      const bottom = secondContentBottom - container.scrollTop;
      return { top: bottom - 100, bottom, height: 100 } as DOMRect;
    };
    container.append(firstRow, secondRow);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(firstRow, 100);
    resize(secondRow, 100);
    firstContentBottom += 200;
    secondContentBottom += 200;
    resize(firstRow, 300);
    expect(container.scrollTop).toBe(2200);

    container.scrollTop = 2300;
    container.dispatchEvent(new Event("scroll"));
    secondContentBottom += 100;
    resize(secondRow, 200);

    expect(container.scrollTop).toBe(2300);
  });

  it("preserves the bottom gap when visible content grows after opening", () => {
    const container = buildContainer({
      scrollTop: 4625,
      clientHeight: 300,
      scrollHeight: 5000,
    });
    const visibleRow = addRow(container, { bottom: 250 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(visibleRow, 100); // baseline
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 5400,
    });
    resize(visibleRow, 500); // a late image or formatter adds 400px

    expect(container.scrollTop).toBe(5025);
  });

  it("honors explicit follow intent instead of geometric proximity", () => {
    const container = buildContainer({
      scrollTop: 4650,
      clientHeight: 300,
      scrollHeight: 5000,
    });
    const visibleRow = addRow(container, { bottom: 250 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref, () => false));
    resize(visibleRow, 100);
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 5400,
    });
    resize(visibleRow, 500);

    expect(container.scrollTop).toBe(4650);
  });

  it("stops pinning after the user scrolls away from the latest message", () => {
    const container = buildContainer({
      scrollTop: 4700,
      clientHeight: 300,
      scrollHeight: 5000,
    });
    const visibleRow = addRow(container, { bottom: 250 });
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = container;

    renderHook(() => useScrollStability(ref));
    resize(visibleRow, 100);
    container.scrollTop = 2000;
    container.dispatchEvent(new Event("scroll"));
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 5400,
    });
    resize(visibleRow, 500);

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
