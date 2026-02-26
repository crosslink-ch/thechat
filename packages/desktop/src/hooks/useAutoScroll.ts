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
  // Set on wheel/touch-up events, cleared when user scrolls back to bottom.
  const userScrolledAwayRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const checkAtBottom = () =>
      el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;

    const handleScroll = () => {
      const atBottom = checkAtBottom();
      setIsAtBottom(atBottom);
      // User scrolled back to the bottom — re-enable auto-scroll
      if (atBottom) {
        userScrolledAwayRef.current = false;
      }
    };

    const handleWheel = (e: WheelEvent) => {
      // User scrolling up → disable auto-scroll
      if (e.deltaY < 0) {
        userScrolledAwayRef.current = true;
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
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    },
    [containerRef],
  );

  return { isAtBottom, scrollToBottom };
}
