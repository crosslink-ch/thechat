import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";

const BOTTOM_THRESHOLD = 150;

export function useAutoScroll(containerRef: RefObject<HTMLElement | null>) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Tracks whether auto-scroll was explicitly paused, either by user input or
  // by a command that intentionally moves away from the bottom.
  const userScrolledAwayRef = useRef(false);
  // Timestamp of the most recent explicit pause. The ensuing programmatic or
  // wheel-driven scroll event must not immediately re-enable auto-scroll.
  const lastPauseRef = useRef(0);

  const pauseAutoScroll = useCallback(() => {
    userScrolledAwayRef.current = true;
    lastPauseRef.current = Date.now();
  }, []);
  const shouldFollowBottom = useCallback(
    () => !userScrolledAwayRef.current,
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let previousScrollTop = el.scrollTop;
    let previousScrollHeight = el.scrollHeight;
    let previousClientHeight = el.clientHeight;

    const checkAtBottom = () =>
      el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;

    const handleScroll = () => {
      const atBottom = checkAtBottom();
      const movedUp = el.scrollTop < previousScrollTop;
      const layoutChanged =
        el.scrollHeight !== previousScrollHeight ||
        el.clientHeight !== previousClientHeight;
      previousScrollTop = el.scrollTop;
      previousScrollHeight = el.scrollHeight;
      previousClientHeight = el.clientHeight;
      setIsAtBottom(atBottom);
      if (!atBottom) {
        userScrolledAwayRef.current = true;
        return;
      }
      if (movedUp && !layoutChanged) {
        // Covers scrollbar drags and keyboard scrolling that stay inside the
        // geometric bottom threshold and therefore emit no upward wheel.
        pauseAutoScroll();
        return;
      }
      // Re-enable auto-scroll when user reaches the bottom, but not
      // immediately after an explicit pause. Without this debounce the
      // ensuing scroll event could clear userScrolledAwayRef and snap back.
      if (Date.now() - lastPauseRef.current > 200) {
        userScrolledAwayRef.current = false;
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User scrolling up → disable auto-scroll
        pauseAutoScroll();
      }
    };

    const handleTouchStart = () => {
      // Any touch interaction means the user is taking control of scroll
      if (!checkAtBottom()) {
        pauseAutoScroll();
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("wheel", handleWheel, { passive: true });
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("touchstart", handleTouchStart);
    };
  }, [containerRef, pauseAutoScroll]);

  const scrollToBottom = useCallback(
    (opts?: { force?: boolean }) => {
      const el = containerRef.current;
      if (!el) return;
      // Skip if user has scrolled away, unless forced
      if (userScrolledAwayRef.current && !opts?.force) return;
      if (opts?.force) {
        userScrolledAwayRef.current = false;
      }
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    },
    [containerRef],
  );

  return { isAtBottom, pauseAutoScroll, scrollToBottom, shouldFollowBottom };
}
