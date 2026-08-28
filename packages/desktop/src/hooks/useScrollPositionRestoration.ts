import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type RefObject,
} from "react";

interface ScrollAnchor {
  messageId: string;
  viewportOffsetTop: number;
}

interface ScrollPosition {
  top: number;
  atBottom: boolean;
  anchor: ScrollAnchor | null;
}

interface ScrollPositionRestorationOptions {
  containerRef: RefObject<HTMLElement | null>;
  scrollKey: string;
  loading: boolean;
  loadingOlder: boolean;
  hasOlderMessages: boolean;
  messageScrollSignature: string;
  requestOlderMessages: () => Promise<boolean>;
  pauseAutoScroll: () => void;
  scrollToBottom: (options?: { force?: boolean }) => void;
}

const MESSAGE_ROW_SELECTOR = "[data-message-id]";

/**
 * Remembers chat scroll positions while one view switches between scopes.
 *
 * History pages are intentionally unloaded when a scope is left. A raw pixel
 * offset therefore cannot restore a position that lived in one of those
 * pages. Alongside the fallback offset, this hook stores the first visible
 * message and its viewport offset. On revisit it reloads older pages until
 * that row exists again, then restores the row before paint.
 */
export function useScrollPositionRestoration({
  containerRef,
  scrollKey,
  loading,
  loadingOlder,
  hasOlderMessages,
  messageScrollSignature,
  requestOlderMessages,
  pauseAutoScroll,
  scrollToBottom,
}: ScrollPositionRestorationOptions) {
  const positionsRef = useRef(new Map<string, ScrollPosition>());
  const activeKeyRef = useRef<string | null>(null);
  const renderedKeyRef = useRef(scrollKey);
  const pendingRestoreKeyRef = useRef<string | null>(null);
  const requestedWindowRef = useRef<string | null>(null);
  const failedWindowRef = useRef<string | null>(null);
  const [restoreRetryVersion, retryAfterFailedLoad] = useReducer(
    (version: number) => version + 1,
    0,
  );

  // Render updates the rows before layout effects run. Ignore any scroll event
  // delivered in that gap so rows from the new scope cannot overwrite the old
  // scope's saved position.
  renderedKeyRef.current = scrollKey;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const savePosition = () => {
      const activeKey = activeKeyRef.current;
      if (
        !activeKey ||
        activeKey !== renderedKeyRef.current ||
        pendingRestoreKeyRef.current === activeKey
      ) {
        return;
      }
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      positionsRef.current.set(activeKey, {
        top: el.scrollTop,
        atBottom: maxScrollTop - el.scrollTop <= 1,
        anchor: visibleMessageAnchor(el),
      });
    };

    el.addEventListener("scroll", savePosition, { passive: true });
    return () => el.removeEventListener("scroll", savePosition);
  }, [containerRef]);

  useLayoutEffect(() => {
    if (activeKeyRef.current !== scrollKey) {
      activeKeyRef.current = scrollKey;
      pendingRestoreKeyRef.current = scrollKey;
      requestedWindowRef.current = null;
      failedWindowRef.current = null;
    }
    if (loading || pendingRestoreKeyRef.current !== scrollKey) return;

    const el = containerRef.current;
    if (!el) return;
    const savedPosition = positionsRef.current.get(scrollKey);

    if (!savedPosition || savedPosition.atBottom) {
      finishRestore(scrollKey);
      scrollToBottom({ force: true });
      return;
    }

    pauseAutoScroll();
    const savedAnchor = savedPosition.anchor;
    if (savedAnchor) {
      const anchorRow = findMessageRow(el, savedAnchor.messageId);
      if (anchorRow) {
        const currentOffsetTop =
          anchorRow.getBoundingClientRect().top - el.getBoundingClientRect().top;
        const delta = currentOffsetTop - savedAnchor.viewportOffsetTop;
        finishRestore(scrollKey);
        if (delta !== 0) {
          el.scrollTo({
            top: el.scrollTop + delta,
            behavior: "instant",
          });
        }
        return;
      }

      const windowKey = `${scrollKey}\u0000${messageScrollSignature}`;
      if (hasOlderMessages) {
        if (loadingOlder) return;
        if (failedWindowRef.current !== windowKey) {
          if (requestedWindowRef.current !== windowKey) {
            requestedWindowRef.current = windowKey;
            const request = requestOlderMessages();
            void request.then((loaded) => {
              if (
                !loaded &&
                pendingRestoreKeyRef.current === scrollKey &&
                renderedKeyRef.current === scrollKey
              ) {
                failedWindowRef.current = windowKey;
                retryAfterFailedLoad();
              }
            });
          }
          return;
        }
      }
    }

    finishRestore(scrollKey);
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({
      top: Math.min(Math.max(0, savedPosition.top), maxScrollTop),
      behavior: "instant",
    });

    function finishRestore(key: string) {
      if (pendingRestoreKeyRef.current === key) {
        pendingRestoreKeyRef.current = null;
      }
      requestedWindowRef.current = null;
      failedWindowRef.current = null;
    }
  }, [
    containerRef,
    hasOlderMessages,
    loading,
    loadingOlder,
    messageScrollSignature,
    pauseAutoScroll,
    requestOlderMessages,
    restoreRetryVersion,
    scrollKey,
    scrollToBottom,
  ]);
}

function visibleMessageAnchor(container: HTMLElement): ScrollAnchor | null {
  const containerRect = container.getBoundingClientRect();
  if (containerRect.height <= 0) return null;

  for (const row of container.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR)) {
    const rowRect = row.getBoundingClientRect();
    if (
      rowRect.height <= 0 ||
      rowRect.bottom <= containerRect.top ||
      rowRect.top >= containerRect.bottom
    ) {
      continue;
    }
    const messageId = row.getAttribute("data-message-id");
    if (!messageId) continue;
    return {
      messageId,
      viewportOffsetTop: rowRect.top - containerRect.top,
    };
  }

  return null;
}

function findMessageRow(container: HTMLElement, messageId: string) {
  for (const row of container.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR)) {
    if (row.getAttribute("data-message-id") === messageId) return row;
  }
  return null;
}
