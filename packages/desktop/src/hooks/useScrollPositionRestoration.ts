import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

interface ScrollPosition {
  top: number;
  atBottom: boolean;
}

interface ScrollPositionRestorationOptions {
  containerRef: RefObject<HTMLElement | null>;
  scrollKey: string;
  loading: boolean;
  pauseAutoScroll: () => void;
  scrollToBottom: (options?: { force?: boolean }) => void;
}

/**
 * Remembers chat scroll positions while one view switches between scopes.
 * First visits open at the bottom; revisits restore the last position before paint.
 */
export function useScrollPositionRestoration({
  containerRef,
  scrollKey,
  loading,
  pauseAutoScroll,
  scrollToBottom,
}: ScrollPositionRestorationOptions) {
  const positionsRef = useRef(new Map<string, ScrollPosition>());
  const activeKeyRef = useRef<string | null>(null);
  const pendingRestoreKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const savePosition = () => {
      const activeKey = activeKeyRef.current;
      if (!activeKey) return;
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      positionsRef.current.set(activeKey, {
        top: el.scrollTop,
        atBottom: maxScrollTop - el.scrollTop <= 1,
      });
    };

    el.addEventListener("scroll", savePosition, { passive: true });
    return () => el.removeEventListener("scroll", savePosition);
  }, [containerRef]);

  useLayoutEffect(() => {
    if (activeKeyRef.current !== scrollKey) {
      activeKeyRef.current = scrollKey;
      pendingRestoreKeyRef.current = scrollKey;
    }
    if (loading || pendingRestoreKeyRef.current !== scrollKey) return;

    pendingRestoreKeyRef.current = null;
    const el = containerRef.current;
    const savedPosition = positionsRef.current.get(scrollKey);
    if (!el || !savedPosition || savedPosition.atBottom) {
      scrollToBottom({ force: true });
      return;
    }

    pauseAutoScroll();
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({
      top: Math.min(savedPosition.top, maxScrollTop),
      behavior: "instant",
    });
  }, [containerRef, loading, pauseAutoScroll, scrollKey, scrollToBottom]);
}
