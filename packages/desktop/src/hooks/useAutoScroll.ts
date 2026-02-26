import { useState, useCallback, useEffect, type RefObject } from "react";

const BOTTOM_THRESHOLD = 150;

export function useAutoScroll(containerRef: RefObject<HTMLElement | null>) {
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
      setIsAtBottom(atBottom);
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [containerRef]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [containerRef]);

  return { isAtBottom, scrollToBottom };
}
