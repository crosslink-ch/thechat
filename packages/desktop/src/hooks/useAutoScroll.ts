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
  // Tracks whether the user has intentionally scrolled away from the bottom.
  // Set on wheel/touch events, cleared when user scrolls back to bottom.
  const userScrolledAwayRef = useRef(false);
  // Timestamp of the last wheel-up event, used to debounce the scroll handler
  // so it doesn't immediately re-enable auto-scroll after the user wheels up.
  const lastWheelUpRef = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const checkAtBottom = () =>
      el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;

    const handleScroll = () => {
      const atBottom = checkAtBottom();
      setIsAtBottom(atBottom);
      // Re-enable auto-scroll when user reaches the bottom, but not
      // immediately after a wheel-up event. Without this debounce the
      // scroll event that fires right after wheel-up (while still within
      // the threshold) would clear userScrolledAwayRef and snap back.
      if (atBottom && Date.now() - lastWheelUpRef.current > 200) {
        userScrolledAwayRef.current = false;
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User scrolling up → disable auto-scroll
        userScrolledAwayRef.current = true;
        lastWheelUpRef.current = Date.now();
      }
    };

    const handleTouchStart = () => {
      // Any touch interaction means the user is taking control of scroll
      if (!checkAtBottom()) {
        userScrolledAwayRef.current = true;
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
  }, [containerRef]);

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

  return { isAtBottom, scrollToBottom };
}
