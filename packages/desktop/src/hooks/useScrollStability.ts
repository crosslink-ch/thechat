import { useLayoutEffect, type RefObject } from "react";

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
 * Preserves the pre-reflow bottom gap while the viewport is following the
 * latest message. The optional follow-intent callback distinguishes deliberate
 * near-bottom navigation from true bottom following. When the user has scrolled
 * away, height changes that began above the viewport keep the same visible
 * content anchored.
 */
export function useScrollStability(
  containerRef: RefObject<HTMLElement | null>,
  shouldFollowBottom?: () => boolean,
) {
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const heights = new WeakMap<Element, number>();
    const contentBottoms = new WeakMap<Element, number>();
    const readBottomGap = () =>
      Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
    let bottomGap = readBottomGap();
    let pinnedToBottom = bottomGap <= NEAR_BOTTOM_PX;
    let previousScrollHeight = el.scrollHeight;
    let previousClientHeight = el.clientHeight;
    let geometryDirty = true;

    const rememberScrollIntent = () => {
      bottomGap = readBottomGap();
      pinnedToBottom = bottomGap <= NEAR_BOTTOM_PX;
    };
    const rememberContentGeometry = (heightDeltas: Map<Element, number>) => {
      // Content-space coordinates survive ordinary scrolling. Propagate each
      // row's height delta to later rows without forcing a layout read for
      // every historical message on every streaming update.
      let cumulativeDelta = 0;
      let containerTop: number | undefined;
      for (const child of el.children) {
        cumulativeDelta += heightDeltas.get(child) ?? 0;
        const previousContentBottom = contentBottoms.get(child);
        if (!geometryDirty && previousContentBottom !== undefined) {
          contentBottoms.set(child, previousContentBottom + cumulativeDelta);
          continue;
        }
        containerTop ??= el.getBoundingClientRect().top;
        contentBottoms.set(
          child,
          child.getBoundingClientRect().bottom - containerTop + el.scrollTop,
        );
      }
      geometryDirty = false;
    };

    el.addEventListener("scroll", rememberScrollIntent, { passive: true });

    // ResizeObserver callbacks run after layout but before paint, so
    // scrollTop adjustments here are never visible as a flicker.
    const resizeObserver = new ResizeObserver((entries) => {
      let delta = 0;
      const heightDeltas = new Map<Element, number>();
      for (const entry of entries) {
        if (entry.target === el) continue;
        const bounds = entry.target.getBoundingClientRect();
        const height =
          entry.borderBoxSize?.[0]?.blockSize ??
          bounds.height;
        const previous = heights.get(entry.target);
        const previousContentBottom = contentBottoms.get(entry.target);
        heights.set(entry.target, height);
        // First observation is the baseline; newly inserted rows are
        // handled by the prepend anchor in useOlderHistoryScroll.
        if (previous === undefined) {
          geometryDirty = true;
          continue;
        }
        if (previous === height) continue;
        heightDeltas.set(entry.target, height - previous);
        // Use pre-reflow geometry. A large image can grow from entirely
        // above the viewport to intersecting it; classifying its new box
        // would miss the very shift that needs compensating.
        if (
          previousContentBottom !== undefined &&
          previousContentBottom <= el.scrollTop
        ) {
          delta += height - previous;
        }
      }

      const metricsChanged =
        el.scrollHeight !== previousScrollHeight ||
        el.clientHeight !== previousClientHeight;
      previousScrollHeight = el.scrollHeight;
      previousClientHeight = el.clientHeight;

      // Remember whether the user was pinned before this reflow. Checking
      // after a large image expands is too late: the new height can make a
      // previously bottom-pinned viewport appear hundreds of pixels away.
      if (shouldFollowBottom?.() ?? pinnedToBottom) {
        if (metricsChanged) {
          el.scrollTop = Math.max(
            0,
            el.scrollHeight - el.clientHeight - bottomGap,
          );
          rememberScrollIntent();
        }
        rememberContentGeometry(heightDeltas);
        return;
      }

      if (delta !== 0) el.scrollTop += delta;
      rememberContentGeometry(heightDeltas);
    });

    resizeObserver.observe(el);
    for (const child of el.children) {
      resizeObserver.observe(child);
    }

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          geometryDirty = true;
        }
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) resizeObserver.observe(node);
        }
        for (const node of mutation.removedNodes) {
          if (node instanceof Element) {
            resizeObserver.unobserve(node);
            heights.delete(node);
            contentBottoms.delete(node);
          }
        }
      }
    });
    mutationObserver.observe(el, { childList: true });

    return () => {
      el.removeEventListener("scroll", rememberScrollIntent);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef, shouldFollowBottom]);
}
