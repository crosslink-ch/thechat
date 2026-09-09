import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

// Preload history well before the user hits the hard top so the edge of
// the loaded window is rarely visible (Telegram/Slack behavior).
const TOP_LOAD_THRESHOLD_PX = 600;

interface OlderHistoryScrollOptions {
  containerRef: RefObject<HTMLElement | null>;
  loading: boolean;
  loadingOlder: boolean;
  hasOlderMessages: boolean;
  onLoadOlderMessages?: () => boolean | void | Promise<boolean | void>;
  /** Changes whenever the rendered message window changes. */
  messageScrollSignature: string;
}

/**
 * Scroll-driven loading of older messages with anchored prepends.
 *
 * After every commit the hook records the first rendered message row
 * (`data-message-id`) and its position in content coordinates. When a
 * later commit prepends rows — the window's first id changes while the
 * previous first row is still rendered — it shifts scrollTop by exactly
 * how far that row moved, before paint. The viewport therefore never
 * jumps, no matter where the prepend came from, and scrolling the user
 * did while a load was in flight is preserved.
 */
export function useOlderHistoryScroll({
  containerRef,
  loading,
  loadingOlder,
  hasOlderMessages,
  onLoadOlderMessages,
  messageScrollSignature,
}: OlderHistoryScrollOptions) {
  const pendingRequestRef = useRef(false);
  const skipContentScrollRef = useRef(false);
  const anchorRef = useRef<{ id: string; contentTop: number } | null>(null);

  const requestOlderMessages = useCallback(() => {
    const el = containerRef.current;
    if (
      !el ||
      loading ||
      loadingOlder ||
      pendingRequestRef.current ||
      !hasOlderMessages ||
      !onLoadOlderMessages
    ) {
      return;
    }

    pendingRequestRef.current = true;
    skipContentScrollRef.current = true;

    void Promise.resolve()
      .then(onLoadOlderMessages)
      .catch(() => undefined)
      .then((loaded) => {
        if (loaded === false) skipContentScrollRef.current = false;
        pendingRequestRef.current = false;
      });
  }, [containerRef, hasOlderMessages, loading, loadingOlder, onLoadOlderMessages]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (el.scrollTop <= TOP_LOAD_THRESHOLD_PX) {
        requestOlderMessages();
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [containerRef, requestOlderMessages]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const firstRow = el.querySelector("[data-message-id]");
    const firstId = firstRow?.getAttribute("data-message-id") ?? null;
    const anchor = anchorRef.current;

    if (anchor && firstId && firstId !== anchor.id) {
      const anchorRow = el.querySelector(
        `[data-message-id="${CSS.escape(anchor.id)}"]`,
      );
      // The previous first row is still rendered further down: rows were
      // prepended above it. Keep it visually stationary.
      if (anchorRow) {
        const delta = contentTopOf(anchorRow, el) - anchor.contentTop;
        if (delta !== 0) {
          el.scrollTop += delta;
        }
      }
    }

    anchorRef.current =
      firstRow && firstId
        ? { id: firstId, contentTop: contentTopOf(firstRow, el) }
        : null;
  }, [containerRef, messageScrollSignature]);

  // Lets the views skip their scroll-to-bottom reaction for the commit
  // that prepends older messages.
  const consumeSkipContentScroll = useCallback(() => {
    const skip = skipContentScrollRef.current;
    skipContentScrollRef.current = false;
    return skip;
  }, []);

  return { requestOlderMessages, consumeSkipContentScroll };
}

/** Position of a row in the container's content coordinates (scroll-invariant). */
function contentTopOf(row: Element, container: HTMLElement) {
  return (
    row.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}
