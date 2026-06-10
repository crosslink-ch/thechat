import { useEffect, type RefObject } from "react";

const NEAR_BOTTOM_PX = 150;

/**
 * Keeps visible chat content stable when rows above the viewport change
 * height (deferred markdown formatting, late image loads, etc.) by
 * compensating scrollTop before paint.
 *
 * Chromium does this natively via CSS scroll anchoring, but WebKitGTK —
 * the production Tauri webview on Linux — does not support it at all.
 * The chat scroll containers set `overflow-anchor: none` so that this
 * hook is the single anchoring implementation on every engine.
 *
 * Skips compensation when pinned near the bottom; the views' own
 * stick-to-bottom logic owns that case.
 */
export function useScrollStability(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const heights = new WeakMap<Element, number>();

    // ResizeObserver callbacks run after layout but before paint, so
    // scrollTop adjustments here are never visible as a flicker.
    const resizeObserver = new ResizeObserver((entries) => {
      let delta = 0;
      const containerTop = el.getBoundingClientRect().top;
      for (const entry of entries) {
        const height =
          entry.borderBoxSize?.[0]?.blockSize ??
          entry.target.getBoundingClientRect().height;
        const previous = heights.get(entry.target);
        heights.set(entry.target, height);
        // First observation is the baseline; newly inserted rows are
        // handled by the prepend anchor in useOlderHistoryScroll.
        if (previous === undefined || previous === height) continue;
        const isAboveViewport =
          entry.target.getBoundingClientRect().bottom <= containerTop;
        if (isAboveViewport) {
          delta += height - previous;
        }
      }
      if (delta === 0) return;
      const nearBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
      if (nearBottom) return;
      el.scrollTop += delta;
    });

    for (const child of el.children) {
      resizeObserver.observe(child);
    }

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) resizeObserver.observe(node);
        }
        for (const node of mutation.removedNodes) {
          if (node instanceof Element) {
            resizeObserver.unobserve(node);
            heights.delete(node);
          }
        }
      }
    });
    mutationObserver.observe(el, { childList: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef]);
}
